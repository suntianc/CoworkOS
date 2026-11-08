import { createHttpTransport, withHttpTransport } from "./http-transport.js";
import { randomUUID } from "node:crypto";
import { atriaRoleIdentity } from "../domain/agent-identity.js";
import {
  createModels,
  createProvider,
  contentText,
  Type,
  type AssistantMessage,
  type ImageContent,
  type Provider,
  type TextContent
} from "@earendil-works/pi-ai";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { RuntimeTool } from "./tool.js";
import { TraceRecorder } from "../storage/trace-recorder.js";
import {
  ContextCompactor,
  DEFAULT_CONTEXT_COMPACTION,
  type ContextCompactionSettings,
  type ContextCompactionState
} from "./context-compaction.js";
import {
  configuredModelApi,
  configuredThinkingFormat,
  type CoworkModelApi,
  type CoworkThinkingFormat,
  configuredReasoningEffort,
  configuredSupportsReasoningEffort,
  configuredSupportsPromptCacheKey,
  configuredSupportsImages,
  normalizeReasoningEffort,
  type PiThinkingLevel
} from "./runtime-settings.js";
import { createCoworkModel, modelSamplingOptions, type ModelSampling } from "./model-profile.js";
import { DEFAULT_MODEL_ERROR_RETRIES } from "./model-retry.js";
import { ModelRequestRecorder } from "../storage/model-request-recorder.js";
import { createModelStreams, modelThinkingLevel } from "./model-provider.js";
import { recordModelRequests } from "./model-request-recording.js";
import { withCompactionSummaryPolicy } from "./compaction-summary-policy.js";
import { DEFAULT_TOOL_RESPONSE_CHARS, limitToolContent } from "./tool-output.js";
import { commandOutputFeedback } from "./command-output-feedback.js";
import { userMemoryWithinContextBudget, optionalContextSectionWithinBudget } from "./user-memory-context.js";
export type { PiThinkingLevel } from "./runtime-settings.js";

export interface PiSessionOptions {
  api?: CoworkModelApi;
  thinkingFormat?: CoworkThinkingFormat;
  baseUrl: string;
  connectionId?: string;
  apiKey: string;
  model?: string;
  /** Reasoning level forwarded to the OpenAI-compatible provider. */
  thinkingLevel?: PiThinkingLevel;
  /** Provider capability override; enabled by default for the Cowork gateway. */
  supportsReasoningEffort?: boolean;
  /** Explicit image-input capability for an OpenAI-compatible connection. */
  supportsImages?: boolean;
  supportsPromptCacheKey?: boolean;
  /** Stable across tool turns and restored formal runs. */
  sessionId?: string;
  systemPrompt?: string;
  /** Host-owned, refreshed on every request; never stored in the conversation checkpoint. */
  prepareUserMemory?: () => Promise<string>;
  prepareProjectExperience?: () => Promise<string>;
  tools: ReadonlyMap<string, RuntimeTool>;
  /** Additional model-visible tools, e.g. orchestration/delegation tools. */
  agentTools?: AgentTool[];
  /** Called as Pi emits streaming and tool lifecycle events. */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  /** Main can execute independent tool calls from one model turn concurrently. */
  toolExecution?: "sequential" | "parallel";
  maxTurns?: number;
  maxTokens?: number;
  /** Known provider capacity, used by context compaction rather than sent as a request field. */
  contextWindow?: number;
  sampling?: ModelSampling;
  /** Model-visible text budget per result (default 16000 except full load_skill instructions); retains head/tail and native images. */
  maxToolResponseChars?: number;
  /** Retry a provider-side stream error by asking the model to continue. */
  maxErrorRetries?: number;
  /** Additional continuations after Pi's tool loop returns; disabled by default. */
  maxLengthContinuations?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Messages restored from a previous checkpoint. */
  initialMessages?: AgentMessage[];
  /** Compaction cursor restored from a previous checkpoint. */
  initialCompaction?: Partial<ContextCompactionState>;
  /** Persist turn boundaries and compaction state for crash recovery. */
  onCheckpoint?: (checkpoint: {
    messages: AgentMessage[];
    compaction: ContextCompactionState;
    status: "running" | "succeeded" | "failed";
  }) => Promise<void> | void;
  compaction?: Partial<ContextCompactionSettings>;
  trace?: { recorder: TraceRecorder; taskId: string; runId: string; agentId: string };
}

export interface PiSessionResult {
  messages: AgentMessage[];
  assistant?: AssistantMessage;
  compaction: ContextCompactionState;
  /** Why the loop returned; an abort must never be mistaken for normal completion. */
  termination: "completed" | "timed_out" | "cancelled" | "aborted";
  /** Final provider failure; historical errors do not describe a recovered run. */
  error?: string;
  lastStopReason?: AssistantMessage["stopReason"];
  /** Extra recovery requests from this wrapper, excluding Pi's normal tool-loop turns. */
  continuations: { providerErrors: number; outputLimits: number };
}

/** Return tool calls which have no corresponding tool result in the transcript. */
export function unresolvedToolCallIds(messages: AgentMessage[]): string[] {
  const pending = new Map<string, number>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") pending.set(block.id, (pending.get(block.id) ?? 0) + 1);
      }
    } else if (message.role === "toolResult") {
      // Providers may reuse IDs across turns. A result only settles a call
      // already present at this point, never a later call with the same ID.
      const count = pending.get(message.toolCallId) ?? 0;
      if (count === 1) pending.delete(message.toolCallId);
      else if (count > 1) pending.set(message.toolCallId, count - 1);
    }
  }
  return [...pending.keys()];
}

/**
 * A Pi session is complete only when the final transcript item is a textual,
 * explicit stop response.  This prevents a max-turn/abort after a tool call
 * from being reported as a successful run merely because an earlier message
 * contained some visible text.
 */
export function hasCompletedAssistantResponse(messages: AgentMessage[]): boolean {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || last.stopReason !== "stop") return false;
  if (last.content.some((block) => block.type === "toolCall")) return false;
  return contentText(last.content).trim().length > 0 && unresolvedToolCallIds(messages).length === 0;
}

/**
 * Native pi-agent-core session bridge. Pi owns the model/tool-calling loop;
 * Cowork supplies the role-specific tools and runtime callbacks.
 */
export class PiSession {
  readonly agent: Agent;
  private readonly timeoutMs?: number;
  private readonly maxErrorRetries: number;
  private readonly maxLengthContinuations: number;
  private readonly signal?: AbortSignal;
  private readonly onCheckpoint?: PiSessionOptions["onCheckpoint"];

  constructor(options: PiSessionOptions) {
    if (!options.apiKey) throw new Error("PiSession requires apiKey from the environment");
    this.timeoutMs = options.timeoutMs;
    this.maxErrorRetries = options.maxErrorRetries ?? DEFAULT_MODEL_ERROR_RETRIES;
    this.maxLengthContinuations = options.maxLengthContinuations ?? 0;
    if (
      !Number.isSafeInteger(this.maxLengthContinuations) ||
      this.maxLengthContinuations < 0 ||
      this.maxLengthContinuations > 100
    )
      throw new Error("maxLengthContinuations must be an integer between 0 and 100");
    const sampling = modelSamplingOptions(options.sampling);
    const maxTurns = options.maxTurns ?? 200;
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 0)
      throw new Error("maxTurns must be a non-negative integer; 0 disables the turn limit");
    if (
      options.maxToolResponseChars !== undefined &&
      (!Number.isSafeInteger(options.maxToolResponseChars) ||
        options.maxToolResponseChars < 64 ||
        options.maxToolResponseChars > 16_000_000)
    )
      throw new Error("maxToolResponseChars must be an integer between 64 and 16000000");
    this.signal = options.signal;
    this.onCheckpoint = options.onCheckpoint;
    const model = createCoworkModel({
      ...options,
      api: options.api ?? configuredModelApi(),
      thinkingFormat: options.thinkingFormat ?? configuredThinkingFormat(),
      supportsImages: options.supportsImages ?? configuredSupportsImages(),
      supportsReasoningEffort: options.supportsReasoningEffort ?? configuredSupportsReasoningEffort()
    });
    const sessionId =
      options.sessionId ??
      (options.trace ? `atria:${options.trace.taskId}:${options.trace.agentId}` : randomUUID());
    const apiStreams = createModelStreams(model.api, {
      supportsPromptCacheKey: options.supportsPromptCacheKey ?? configuredSupportsPromptCacheKey(),
      sessionId
    });
    const provider: Provider<CoworkModelApi> = createProvider({
      id: model.provider,
      name: "Cowork GLM gateway",
      baseUrl: model.baseUrl,
      auth: {
        apiKey: { name: "Cowork API key", resolve: async () => ({ auth: { apiKey: options.apiKey } }) }
      },
      models: [model],
      api: withHttpTransport(
        withCompactionSummaryPolicy(
          options.trace
            ? recordModelRequests(
                apiStreams,
                new ModelRequestRecorder(
                  options.trace.recorder.modelRequestPath,
                  {
                    taskId: options.trace.taskId,
                    runId: options.trace.runId,
                    agentId: options.trace.agentId
                  },
                  [options.apiKey]
                )
              )
            : apiStreams
        ),
        this.transport
      )
    });
    const models = createModels();
    models.setProvider(provider);
    const compaction = new ContextCompactor(
      models,
      model,
      { ...DEFAULT_CONTEXT_COMPACTION, ...(options.compaction ?? {}) },
      options.initialCompaction,
      async (state) =>
        options.onCheckpoint?.({
          messages: this.agent?.state.messages ?? options.initialMessages ?? [],
          compaction: state,
          status: "running"
        })
    );
    // Skills are the instruction source and may live outside the file tools' roots.
    // An explicit caller limit still applies, including to load_skill.
    const toolResponseBudget = (name: string) =>
      options.maxToolResponseChars ?? (name === "load_skill" ? undefined : DEFAULT_TOOL_RESPONSE_CHARS);
    const tools = [
      ...[...options.tools.entries()].map(([name, runtimeTool]) =>
        toAgentTool(name, runtimeTool, model.input.includes("image"), toolResponseBudget(name))
      ),
      ...(options.agentTools ?? []).map((tool) => ({
        ...tool,
        executionMode: tool.executionMode ?? "sequential"
      }))
    ];
    let turns = 0;
    this.agent = new Agent({
      sessionId,
      initialState: {
        systemPrompt:
          options.systemPrompt ??
          `${atriaRoleIdentity("Agent")} Inspect the workspace, make minimal changes, and run tests.`,
        model,
        tools,
        thinkingLevel: modelThinkingLevel(
          model,
          normalizeReasoningEffort(options.thinkingLevel ?? configuredReasoningEffort())
        ),
        messages: options.initialMessages ?? []
      },
      transformContext: async (messages, signal) => {
        const compacted = await compaction.transform(messages, signal);
        const budget = {
          contextWindow: model.contextWindow,
          reserveTokens: options.compaction?.reserveTokens ?? DEFAULT_CONTEXT_COMPACTION.reserveTokens,
          maxTokens: model.maxTokens
        };
        const personal = options.prepareUserMemory
          ? userMemoryWithinContextBudget(compacted, await options.prepareUserMemory(), budget)
          : compacted;
        return options.prepareProjectExperience
          ? optionalContextSectionWithinBudget(
              personal,
              "project_experience",
              await options.prepareProjectExperience(),
              budget
            )
          : personal;
      },
      streamFn: (model, context, streamOptions) =>
        models.streamSimple(model, context, {
          ...streamOptions,
          ...sampling,
          samplingParams: { ...streamOptions?.samplingParams, ...sampling.samplingParams }
        }),
      getApiKey: async () => options.apiKey,
      toolExecution: options.toolExecution ?? "parallel",
      // This boundary also sees Pi's error envelope when execute throws. Keep
      // images/details intact and preserve both native and adapter error flags.
      afterToolCall: async ({ toolCall, result, isError }) => ({
        content: limitToolContent(result.content, toolResponseBudget(toolCall.name)),
        isError: isError || hasErrorFlag(result)
      }),
      finishTurn: async () => {
        turns += 1;
        return maxTurns > 0 && turns >= maxTurns ? { action: "end" } : undefined;
      }
    });
    this.compaction = compaction;
    this.agent.subscribe(async (event) => {
      if (options.trace) {
        await options.trace.recorder.record({
          traceId: `trace_${randomUUID()}`,
          kind: "runtime",
          taskId: options.trace.taskId,
          runId: options.trace.runId,
          agentId: options.trace.agentId,
          payload: event
        });
      }
      if (event.type === "turn_end") {
        await this.onCheckpoint?.({
          messages: this.agent.state.messages,
          compaction: this.compaction.state,
          status: "running"
        });
      }
      await options.onEvent?.(event);
    });
  }

  private readonly transport = createHttpTransport();
  private readonly compaction: ContextCompactor;

  get compactionState(): ContextCompactionState {
    return this.compaction.state;
  }

  async run(
    prompt: string,
    options: { resume?: boolean; continueConversation?: boolean } = {}
  ): Promise<PiSessionResult> {
    // Agent.abort() only affects an active loop. Calling it before prompt()
    // would still start inference with a fresh signal and execute tools.
    if (this.signal?.aborted) {
      const messages = this.agent.state.messages;
      return {
        messages,
        assistant: [...messages]
          .reverse()
          .find((message): message is AssistantMessage => message.role === "assistant"),
        compaction: this.compaction.state,
        termination: "cancelled",
        lastStopReason: [...messages].reverse().find((message) => message.role === "assistant")?.stopReason,
        continuations: { providerErrors: 0, outputLimits: 0 }
      };
    }
    if (
      options.resume &&
      !options.continueConversation &&
      hasCompletedAssistantResponse(this.agent.state.messages)
    ) {
      const messages = this.agent.state.messages;
      return {
        messages,
        assistant: messages.at(-1) as AssistantMessage,
        compaction: this.compaction.state,
        termination: "completed",
        lastStopReason: "stop",
        continuations: { providerErrors: 0, outputLimits: 0 }
      };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let errorRetries = 0;
    let lengthContinuations = 0;
    let previousStopReason: AssistantMessage["stopReason"] | undefined;
    let firstRequest = true;
    const abort = () => this.agent.abort();
    this.signal?.addEventListener("abort", abort, { once: true });
    if (this.timeoutMs)
      timer = setTimeout(() => {
        timedOut = true;
        this.agent.abort();
      }, this.timeoutMs);
    try {
      for (;;) {
        if (firstRequest && options.continueConversation && this.agent.state.messages.length > 0) {
          // An explicit continuation adds one turn to a finished transcript.
          // The earlier answers stay in context; only the new instruction is
          // appended, so a rework cannot be mistaken for a fresh Agent.
          await this.agent.prompt(prompt);
        } else if (firstRequest && options.resume && this.agent.state.messages.length > 0) {
          const last = this.agent.state.messages.at(-1);
          if (last?.role === "user" || last?.role === "toolResult") await this.agent.continue();
          else
            await this.agent.prompt(
              "Resume the interrupted task from the checkpoint and continue from the last completed action."
            );
        } else if (firstRequest) {
          await this.agent.prompt(prompt);
        } else if (previousStopReason === "error") {
          await this.agent.prompt(
            "The previous model response was interrupted by a transient provider/stream error. Continue from the current transcript, verify which tool calls completed, and retry only unfinished actions. Do not repeat successful side effects; re-read current state when needed. Do not stop at a progress report; complete the task."
          );
        } else {
          await this.agent.prompt(
            "Your previous response reached the output-token limit. Continue from the current transcript. Do not repeat completed tool calls or successful side effects. Re-issue only unfinished or rejected tool calls with complete arguments. Finish the remaining work and give a concise final response."
          );
        }
        firstRequest = false;
        const latest = [...this.agent.state.messages]
          .reverse()
          .find((message): message is AssistantMessage => message.role === "assistant");
        previousStopReason = latest?.stopReason;
        if (timedOut || this.signal?.aborted) break;
        if (previousStopReason === "error" && errorRetries < this.maxErrorRetries) {
          errorRetries += 1;
          continue;
        }
        if (previousStopReason === "length" && lengthContinuations < this.maxLengthContinuations) {
          lengthContinuations += 1;
          continue;
        }
        break;
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.signal?.removeEventListener("abort", abort);
      await this.transport.close();
    }
    const messages = this.agent.state.messages;
    // A turn may end on a tool call when maxTurns/timeout is reached. Prefer
    // the latest assistant message that contains visible text so callers do
    // not mistake an intermediate tool-call envelope for the final answer.
    const assistant =
      [...messages]
        .reverse()
        .find(
          (message): message is AssistantMessage =>
            message.role === "assistant" && contentText(message.content).trim().length > 0
        ) ??
      [...messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
    await this.onCheckpoint?.({ messages, compaction: this.compaction.state, status: "running" });
    // Retries and checkpoint recovery retain failed attempts in the transcript.
    // Only the final response and unresolved tool calls determine whether this
    // run completed; a historical error must not veto a later successful stop.
    const complete = hasCompletedAssistantResponse(messages);
    const latest = [...messages]
      .reverse()
      .find((message): message is AssistantMessage => message.role === "assistant");
    return {
      messages,
      assistant,
      compaction: this.compaction.state,
      termination: timedOut
        ? "timed_out"
        : this.signal?.aborted
          ? "cancelled"
          : !complete
            ? "aborted"
            : "completed",
      error:
        !complete && !timedOut && !this.signal?.aborted && latest?.stopReason === "error"
          ? latest.errorMessage
          : undefined,
      lastStopReason: latest?.stopReason,
      continuations: { providerErrors: errorRetries, outputLimits: lengthContinuations }
    };
  }
}

function toAgentTool(
  name: string,
  runtimeTool: RuntimeTool,
  supportsImages: boolean,
  maxChars?: number
): AgentTool {
  const parameters = runtimeTool.parameters ? Type.Unsafe(runtimeTool.parameters) : toolSchema(name);
  return {
    name,
    label: name,
    description: runtimeTool.description ?? description(name),
    executionMode: runtimeTool.executionMode ?? "sequential",
    parameters,
    execute: async (_toolCallId, params, signal) => {
      const result = await runtimeTool.execute(params, signal);
      if (hasImageContent(result) && !isContentResult(result))
        throw new Error("工具返回了无效的图片内容；请重新观察或检查图像工具，不能据此判断任务已完成。");
      if (isContentResult(result)) {
        const images = result.content.some((block) => block.type === "image");
        const content = supportsImages
          ? result.content
          : result.content.filter((block) => block.type !== "image");
        return {
          ...result,
          content:
            !supportsImages && images
              ? [
                  ...content,
                  {
                    type: "text" as const,
                    text: "当前模型连接未启用图像输入；图像未发送，请使用可用的文字反馈或启用视觉能力。"
                  }
                ]
              : content
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              (maxChars === undefined ? undefined : commandOutputFeedback(name, result, maxChars)) ??
              stringifyResult(result)
          }
        ],
        details: result,
        ...(hasErrorFlag(result) ? { isError: true } : {})
      };
    }
  } as AgentTool;
}

function hasErrorFlag(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "isError" in value && value.isError === true);
}

function hasImageContent(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    "content" in value &&
    Array.isArray(value.content) &&
    value.content.some(
      (block: unknown) => block && typeof block === "object" && "type" in block && block.type === "image"
    )
  );
}

/** Accept native tool-result envelopes while retaining plain-data tool compatibility. */
function isContentResult(value: unknown): value is {
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
} {
  if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content))
    return false;
  return value.content.every((block: unknown) => {
    if (!block || typeof block !== "object" || !("type" in block)) return false;
    if (block.type === "text") return "text" in block && typeof block.text === "string";
    return (
      block.type === "image" &&
      "data" in block &&
      typeof block.data === "string" &&
      block.data.trim().length > 0 &&
      "mimeType" in block &&
      typeof block.mimeType === "string" &&
      /^image\/[a-z0-9.+-]+$/i.test(block.mimeType)
    );
  });
}

function toolSchema(name: string) {
  if (name === "search")
    return Type.Object({ query: Type.String(), numResults: Type.Optional(Type.Number()) });
  if (name === "visit") return Type.Object({ url: Type.String(), goal: Type.Optional(Type.String()) });
  if (name === "read_file") return Type.Object({ path: Type.String() });
  if (name === "write_file") return Type.Object({ path: Type.String(), content: Type.String() });
  if (name === "apply_patch")
    return Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() });
  if (name === "run_command")
    return Type.Object({
      command: Type.String(),
      args: Type.Optional(Type.Array(Type.String())),
      cwd: Type.Optional(
        Type.String({
          description:
            "Relative directory to run in. Defaults to the project when project writes are enabled, otherwise this Agent's working directory."
        })
      )
    });
  if (name === "run_tests")
    return Type.Object({
      command: Type.Optional(Type.String()),
      args: Type.Optional(Type.Array(Type.String())),
      cwd: Type.Optional(
        Type.String({
          description:
            "Relative directory to run in. Defaults to the project when project writes are enabled, otherwise this Agent's working directory. Omit cwd to use that default; absolute paths are rejected."
        })
      )
    });
  if (name === "browse_workspace")
    return Type.Object({
      mode: Type.Optional(Type.Union([Type.Literal("tree"), Type.Literal("read"), Type.Literal("search")])),
      path: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      offset: Type.Optional(
        Type.Number({ description: "Byte offset for read mode; continue with nextOffset when truncated." })
      ),
      depth: Type.Optional(Type.Number()),
      maxEntries: Type.Optional(Type.Number())
    });
  if (name === "start_job")
    return Type.Object({
      command: Type.String({ description: "Shell command to run in the background." }),
      cwd: Type.Optional(Type.String({ description: "Relative directory to run in." }))
    });
  if (name === "check_job")
    return Type.Object({
      jobId: Type.String(),
      tailBytes: Type.Optional(
        Type.Number({ description: "How much of the log tail to return. Default 4000." })
      )
    });
  if (name === "kill_job") return Type.Object({ jobId: Type.String() });
  if (name === "get_subagent_status") return Type.Object({ agentId: Type.Optional(Type.String()) });
  if (name === "load_skill") return Type.Object({ name: Type.String() });
  return Type.Object({ input: Type.Optional(Type.Unknown()) });
}

function description(name: string): string {
  if (name === "search")
    return "Search the public web and return result titles, URLs and source excerpts. Cite sources; tool failure is unavailable evidence, never zero results.";
  if (name === "visit")
    return "Read a public HTTP(S) source URL and return readable evidence with provenance.";
  if (name === "read_file")
    return "Read a UTF-8 file inside this Agent's own working directory. To inspect other Agents or shared Task state, use browse_workspace instead.";
  if (name === "write_file")
    return "Create or replace a UTF-8 file inside this Agent's own working directory. Main can write accepted user files through its configured artifacts/ route to the Task final directory; Subagents keep candidate outputs in their own deliverables/. For Main, context/memory.md is durable task state. context/messages.json and context/state.json are framework-managed and cannot be edited.";
  if (name === "apply_patch")
    return "Prefer apply_patch for small edits to a workspace file. oldText must match exactly once. If matching fails, use read_file to inspect the current file, then copy its exact text and add surrounding context before retrying. Do not switch to rewriting the whole file through bash, Python or a heredoc merely because matching failed; use write_file for intentional whole-file replacement. Main should use this to make small updates to context/memory.md; context/messages.json and context/state.json are framework-managed.";
  if (name === "run_command")
    return "Run a foreground command. When project writes are enabled it runs in the project directory through a shell, supporting pipes and redirection; otherwise it runs in this Agent's working directory without a shell. On Unix, completion, cancellation and timeout also stop ordinary descendants. Use start_job for commands that must continue after this call returns.";
  if (name === "run_tests")
    return "Run a test command. Defaults to npm in the project when project writes are enabled, otherwise in this Agent's working directory. Pass command and args to use another test runner; cwd must be relative to those allowed roots.";
  if (name === "browse_workspace")
    return "Read-only browser for the whole Task workspace, including its structure, other Agents' working files and progress, artifacts, sessions, run events, queue and manifests. Use mode=tree, read or search; it cannot modify files or run commands.";
  if (name === "start_job")
    return "Start a long command in the background and return a jobId. Use this instead of run_command for work measured in minutes or hours — training, large synthesis, long evaluations — since run_command holds this Agent open until the command exits. Output is written to a log you poll with check_job.";
  if (name === "check_job")
    return "Report a background job: whether it is still running, how long it has run, how long since its log last grew, and the tail of that log. Poll it to judge progress. A job producing output is working; one silent far longer than its normal rhythm is likely stuck, and quietMs is evidence for that judgment, not a verdict.";
  if (name === "kill_job")
    return "Stop a background job and its child processes. Use it when check_job shows the job is wedged, has failed, or is no longer worth waiting for. It sends SIGTERM first so the job can clean up, then SIGKILL if it does not exit.";
  if (name === "get_subagent_status")
    return "Return compact structured progress for Subagents in the current Task Run, including task, mode, status, latest event, last trace activity, artifacts and pending callbacks.";
  if (name === "load_skill")
    return "Load the full instructions for a matching project skill. Use only after the skill catalog shows that it applies to the current task.";
  return `Execute the ${name} runtime tool.`;
}

function stringifyResult(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
