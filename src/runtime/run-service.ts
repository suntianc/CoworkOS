import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { atriaRoleIdentity } from "../domain/agent-identity.js";
import { dirname, join, resolve } from "node:path";
import {
  id,
  now,
  type CompletionPolicy,
  type Event,
  type TaskCompletion,
  type TaskStatus
} from "../domain/types.js";
import { JsonlEventStore } from "../storage/event-store.js";
import { TraceRecorder } from "../storage/trace-recorder.js";
import { LocalWorkspaceStore, type Artifact } from "../workspace/workspace-store.js";
import type { RuntimeTool } from "./tool.js";
import type { ModelSampling } from "./model-profile.js";
import type { ContextCompactionSettings } from "./context-compaction.js";
import { PiSession, type PiSessionResult, type PiThinkingLevel } from "./pi-session.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { CheckpointStore } from "./scheduler.js";
import { emptyCompaction, readAgentCheckpoint, type PersistedAgentState } from "./agent-checkpoint.js";
import { createSubagentStatusTool } from "./progress.js";
import { ensureMainContext, mainContextPaths, persistMainContext, readMainMemory } from "./main-context.js";
import { listTaskArtifacts } from "../workspace/artifact-store.js";
import {
  configuredModelApi,
  configuredThinkingFormat,
  type CoworkModelApi,
  type CoworkThinkingFormat,
  configuredReasoningEffort,
  configuredSupportsReasoningEffort,
  configuredSupportsPromptCacheKey,
  configuredSupportsImages,
  normalizeReasoningEffort
} from "./runtime-settings.js";

export interface PiRunInput {
  taskId: string;
  runId: string;
  agentId?: string;
  prompt: string;
  baseUrl: string;
  apiKey: string;
  model?: string;
  thinkingLevel?: PiThinkingLevel;
  api?: CoworkModelApi;
  thinkingFormat?: CoworkThinkingFormat;
  supportsReasoningEffort?: boolean;
  supportsPromptCacheKey?: boolean;
  supportsImages?: boolean;
  maxTurns?: number;
  maxTokens?: number;
  contextWindow?: number;
  sampling?: ModelSampling;
  compaction?: Partial<ContextCompactionSettings>;
  maxToolResponseChars?: number;
  /** Bound provider stream retries independently of completed model turns. */
  maxErrorRetries?: number;
  maxLengthContinuations?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Legacy metadata; a completed model response no longer requires finish_task. */
  completionPolicy?: CompletionPolicy;
  /** Resume a running checkpoint instead of appending the prompt again. */
  resume?: boolean;
  tools: (
    workingDirectory: string,
    workspaceDirectory?: string,
    artifactDirectory?: string
  ) => ReadonlyMap<string, RuntimeTool>;
  prepare?: (workingDirectory: string) => Promise<void>;
  systemPrompt?: string;
  agentTools?: AgentTool[];
  toolExecution?: "sequential" | "parallel";
  /** Project-scoped memories are omitted unless the caller identifies the project. */
  projectDirectory?: string;
}

export interface PiRunResult extends PiSessionResult {
  taskId: string;
  runId: string;
  workingDirectory: string;
  artifacts: Artifact[];
  diagnostics?: { tracePath: string; resultPath: string };
  taskStatus: TaskStatus;
  completion: TaskCompletion;
}

/** Owns the formal Task/Run boundary around a native Pi session. */
export class RunService {
  private readonly workspace: LocalWorkspaceStore;

  constructor(private readonly workspaceRoot: string) {
    this.workspace = new LocalWorkspaceStore(workspaceRoot);
  }

  async runPi(input: PiRunInput): Promise<PiRunResult> {
    const thinkingLevel = normalizeReasoningEffort(input.thinkingLevel ?? configuredReasoningEffort());
    const api = input.api ?? configuredModelApi();
    const thinkingFormat = input.thinkingFormat ?? configuredThinkingFormat();
    const supportsReasoningEffort = input.supportsReasoningEffort ?? configuredSupportsReasoningEffort();
    const supportsPromptCacheKey = input.supportsPromptCacheKey ?? configuredSupportsPromptCacheKey();
    const supportsImages = input.supportsImages ?? configuredSupportsImages();
    const agentId = input.agentId ?? "main";
    await this.workspace.createTask(input.taskId, {
      ...(agentId === "main" && input.projectDirectory
        ? { projectDirectory: resolve(input.projectDirectory) }
        : {}),
      goal: input.prompt,
      completion: { policy: input.completionPolicy ?? "natural", signal: "none" }
    });
    if (input.completionPolicy) {
      await this.workspace.updateTask(input.taskId, { completion: { policy: input.completionPolicy } });
    }
    const runPath = await this.workspace.createRun(input.taskId, input.runId);
    const workingDirectory = await this.workspace.prepareAgentWorkDir(input.taskId, input.runId, agentId);
    const mainContext = agentId === "main" ? mainContextPaths(this.workspaceRoot, input.taskId) : undefined;
    if (mainContext) await ensureMainContext(mainContext);
    const durableMemory = mainContext ? await readMainMemory(mainContext) : "";
    const events = new JsonlEventStore(join(runPath, "run_events.jsonl"));
    const checkpointStore = new CheckpointStore(join(runPath, "checkpoint.json"));
    const previous = await checkpointStore.load(input.runId);
    const restored = readAgentCheckpoint(previous?.state);
    if (restored?.status === "succeeded" && input.resume !== false) {
      throw new Error(`run ${input.runId} is already completed; choose a new run id`);
    }
    const shouldResume = input.resume ?? Boolean(restored && restored.status === "running");
    let checkpointSequence = previous?.sequence ?? 0;
    const saveCheckpoint = async (state: PersistedAgentState): Promise<void> => {
      checkpointSequence += 1;
      await checkpointStore.save({ runId: input.runId, sequence: checkpointSequence, state, savedAt: now() });
      if (mainContext) await persistMainContext(mainContext, state.messages);
    };
    await this.appendEvent(events, input, agentId, "run.started", {
      model: input.model ?? "glm-5.3",
      thinkingLevel,
      api,
      thinkingFormat,
      supportsReasoningEffort,
      supportsPromptCacheKey,
      supportsImages,
      resumed: shouldResume
    });
    if (shouldResume) {
      await this.appendEvent(events, input, agentId, "run.resumed", {
        checkpointSequence: previous?.sequence ?? 0,
        restoredStatus: restored?.status
      });
    }
    if (!shouldResume) {
      await saveCheckpoint({
        version: 1,
        status: "running",
        prompt: input.prompt,
        messages: [],
        compaction: emptyCompaction()
      });
      await input.prepare?.(workingDirectory);
    }
    const tracePath = this.workspace.sessionPath(input.taskId, input.runId, agentId);
    const trace = new TraceRecorder(tracePath);
    const diagnostics = {
      tracePath: `sessions/${agentId}/${input.runId}.jsonl`,
      resultPath: `runs/${input.runId}/agents/${agentId === "main" || agentId === "coordinator" ? agentId : `subagents/${agentId}`}/result.json`
    };
    const resultPath = join(this.workspaceRoot, input.taskId, diagnostics.resultPath);
    const artifactDirectory =
      agentId === "main" ? resolve(this.workspaceRoot, input.taskId, "artifacts") : undefined;
    let session: PiSession | undefined;
    let recoverableInterruption = false;
    try {
      const agentTools = input.agentTools ?? [];
      const hasStatusTool = agentTools.some((tool) => tool.name === "get_subagent_status");
      const tools = new Map(
        input.tools(workingDirectory, join(this.workspaceRoot, input.taskId), artifactDirectory)
      );
      session = new PiSession({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        model: input.model,
        thinkingLevel,
        api,
        thinkingFormat,
        supportsReasoningEffort,
        supportsPromptCacheKey,
        supportsImages,
        systemPrompt:
          agentId === "main"
            ? withMainMemoryInstructions(input.systemPrompt, durableMemory, artifactDirectory!)
            : input.systemPrompt,
        tools,
        agentTools: hasStatusTool
          ? agentTools
          : [
              createSubagentStatusTool({
                workspaceRoot: this.workspaceRoot,
                taskId: input.taskId,
                runId: input.runId
              }),
              ...agentTools
            ],
        toolExecution: input.toolExecution,
        maxTurns: input.maxTurns,
        maxTokens: input.maxTokens,
        contextWindow: input.contextWindow,
        sampling: input.sampling,
        compaction: input.compaction,
        maxToolResponseChars: input.maxToolResponseChars,
        maxErrorRetries: input.maxErrorRetries,
        maxLengthContinuations: input.maxLengthContinuations,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        initialMessages: restored?.messages,
        initialCompaction: restored?.compaction,
        onCheckpoint: async (checkpoint) =>
          saveCheckpoint({
            version: 1,
            status: checkpoint.status,
            prompt: restored?.prompt ?? input.prompt,
            messages: checkpoint.messages,
            compaction: checkpoint.compaction
          }),
        trace: { recorder: trace, taskId: input.taskId, runId: input.runId, agentId }
      });
      const result = await session.run(input.prompt, { resume: shouldResume });
      await this.saveSessionResult(resultPath, result);
      const artifacts = await listTaskArtifacts({
        workspaceRoot: this.workspaceRoot,
        taskId: input.taskId,
        runId: input.runId
      });
      if (result.termination !== "completed") {
        // Keep the checkpoint resumable and retain diagnostics even when
        // the wall-clock deadline or provider abort fires after useful work.
        // The caller still receives a non-zero error, but the Task remains in
        // `waiting` instead of being converted into an unrecoverable failure.
        recoverableInterruption = true;
        await saveCheckpoint({
          version: 1,
          status: "running",
          prompt: restored?.prompt ?? input.prompt,
          messages: result.messages,
          compaction: result.compaction
        });
        await this.appendEvent(events, input, agentId, "run.interrupted", {
          termination: result.termination,
          error: result.error,
          artifacts: artifacts.map((artifact) => artifact.artifactId),
          diagnostics,
          resumable: true
        });
        if (agentId === "main") {
          try {
            await this.workspace.transitionTask(input.taskId, "waiting", {
              runId: input.runId,
              reason: `main_run_${result.termination}_resumable`,
              completion: { signal: "interrupted" }
            });
            // eslint-disable-next-line no-restricted-syntax -- 紧接着要抛出携带终止原因的 interruption 错误，任务状态写入失败不能替换它
          } catch {
            /* preserve the original interruption */
          }
        }
        throw new Error(
          `main agent ${result.termination} before completing the run${result.error ? `: ${result.error}` : ""}; checkpoint retained for --resume (diagnostics: ${diagnostics.tracePath}, ${diagnostics.resultPath}; artifacts: ${artifacts.map((artifact) => artifact.relativePath).join(", ")})`
        );
      }
      const task = await this.workspace.readTask(input.taskId);
      const completion = task.completion ?? { policy: input.completionPolicy ?? "natural", signal: "none" };
      const completedTask =
        agentId === "main"
          ? await this.workspace.transitionTask(input.taskId, "completed", {
              runId: input.runId,
              reason: completion.signal === "finish_task" ? "finish_task" : "main_run_completed",
              completion: {
                signal: completion.signal === "finish_task" ? "finish_task" : "natural_stop",
                verifiedAt:
                  completion.signal === "finish_task"
                    ? (completion.verifiedAt ?? now())
                    : completion.verifiedAt
              }
            })
          : task;
      await saveCheckpoint({
        version: 1,
        status: "succeeded",
        prompt: restored?.prompt ?? input.prompt,
        messages: result.messages,
        compaction: result.compaction
      });
      await this.appendEvent(events, input, agentId, "run.completed", {
        artifacts: artifacts.map((artifact) => artifact.artifactId),
        stopReason: result.assistant?.stopReason,
        diagnostics,
        completionSignal: completedTask.completion?.signal
      });
      return {
        ...result,
        taskId: input.taskId,
        runId: input.runId,
        workingDirectory,
        artifacts,
        diagnostics,
        taskStatus: completedTask.status,
        completion: completedTask.completion!
      };
    } catch (error) {
      if (recoverableInterruption) throw error;
      await this.saveSessionResult(resultPath, {
        termination: "failed",
        messages: session?.agent.state.messages ?? [],
        error: error instanceof Error ? error.message : String(error)
        // eslint-disable-next-line no-restricted-syntax -- 正在上抛原始执行失败，诊断结果写不进去不能替换或吞掉这个错误
      }).catch(() => {
        /* Preserve the original execution failure if diagnostics cannot be written. */
      });
      if (session) {
        await saveCheckpoint({
          version: 1,
          status: "failed",
          prompt: restored?.prompt ?? input.prompt,
          messages: session.agent.state.messages,
          compaction: session.compactionState
        });
      }
      await this.appendEvent(events, input, agentId, "run.failed", {
        error: error instanceof Error ? error.message : String(error),
        diagnostics
      });
      if (agentId === "main") {
        try {
          await this.workspace.transitionTask(input.taskId, "failed", {
            runId: input.runId,
            error: error instanceof Error ? error.message : String(error),
            reason: "main_run_failed"
          });
          // eslint-disable-next-line no-restricted-syntax -- 正在上抛原始 Run 失败，任务状态写入失败不能替换它
        } catch {
          /* preserve the original run failure */
        }
      }
      throw error;
    }
  }

  private async saveSessionResult(
    path: string,
    result: {
      messages: unknown[];
      assistant?: { stopReason?: unknown };
      termination?: string;
      lastStopReason?: PiSessionResult["lastStopReason"];
      continuations?: PiSessionResult["continuations"];
      error?: string;
    }
  ): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${id("tmp")}`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ termination: result.termination, stopReason: result.lastStopReason ?? result.assistant?.stopReason, continuations: result.continuations, error: result.error, messages: result.messages }, null, 2)}\n`,
        "utf8"
      );
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async appendEvent(
    events: JsonlEventStore,
    input: PiRunInput,
    agentId: string,
    type: string,
    payload: unknown
  ): Promise<void> {
    const event: Event = {
      eventId: id("event"),
      type,
      taskId: input.taskId,
      runId: input.runId,
      agentId,
      occurredAt: now(),
      payload
    };
    await events.append(event);
  }
}

function withMainMemoryInstructions(
  systemPrompt: string | undefined,
  memory: string,
  artifactDirectory: string
): string {
  const durableState = memory.trim()
    ? memory.slice(0, 32_000)
    : "(empty — initialize it when this task has durable state worth carrying forward)";
  return [
    systemPrompt ??
      `${atriaRoleIdentity("Main")} Inspect the workspace, make minimal changes, and run tests.`,
    "",
    "Final deliverables (Main only):",
    "- Only files in the Task artifacts/ directory are user-facing deliverables. Put accepted final files there using the normal file tools with artifacts/<filename> and a clear human-readable filename.",
    `- The absolute Task artifacts directory is ${artifactDirectory}. Command tools run in your private working directory; use this absolute destination when copying or generating final files with commands.`,
    "- Subagent outputFiles are candidate files in their private deliverables/ directories, accessible through browse_workspace. Review or integrate them, then copy accepted final files into Task artifacts/ with existing file/command tools.",
    "- Keep briefs, drafts, scripts, renders, intermediate logs and other working files in your private work/, deliverables/ or logs/ directories unless the user requested them as deliverables. Runtime diagnostics are stored separately under sessions/ and runs/.",
    "",
    "Durable task state (Main only):",
    "- Maintain context/memory.md directly with the normal write_file or apply_patch tools.",
    "- Keep it concise: Goal, Completed, Next, and Important information/constraints.",
    "- Update it after a meaningful milestone, before handing off a multi-stage task, or before finishing work that may need to be resumed. Do not turn it into a verbose process log.",
    "- context/messages.json is the framework's complete transcript backup and context/state.json is framework bookkeeping; do not edit either file.",
    "- The current durable task state is below. Treat it as working notes, verify it against the workspace, and update it when it becomes stale:",
    "```markdown",
    durableState,
    "```"
  ].join("\n");
}
