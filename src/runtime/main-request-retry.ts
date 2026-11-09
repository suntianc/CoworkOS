import {
  getCurrentSystemMessage,
  getCurrentTools,
  getSystemMessageText,
  normalizeContext,
  renderSystemMessageUpdate,
  resolveTranscript,
  type Model,
  type Api,
  type TranscriptContext
} from "@earendil-works/pi-ai";
import {
  MainRequestStore,
  MainRequestSnapshotError,
  type MainRequestSnapshot,
  type MainRequestEnvironment
} from "../storage/main-request-store.js";
import { applicationServiceForTask } from "../applications/task-service.js";
import { realpath } from "node:fs/promises";
import {
  assertMainRequestExecutionScope,
  currentMainRequestExecutionScope,
  type MainRequestExecutionScope
} from "./main-request-execution-scope.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { optionalContextSectionWithinBudget } from "./user-memory-context.js";

export interface MainRequestExecutionEnvironment extends MainRequestEnvironment {
  executionScope?: MainRequestExecutionScope;
}

export class MainRequestConflictError extends Error {
  readonly status = 409;
  readonly code = "main_retry_context_changed";
}

/** Keep archived request semantics, refreshing host-owned optional memory sections. */
function refreshReplayMemory(
  snapshot: MainRequestSnapshot,
  current: TranscriptContext,
  reserveTokens: number
) {
  const original = normalizeContext(snapshot.context);
  const body = JSON.parse(snapshot.body);
  const output = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
  const sectionNames = ["user_memory", "project_experience", "project_skills"] as const;
  let projected: AgentMessage[] = original.messages.map((message) =>
    message.role === "system"
      ? {
          ...message,
          sections: { ...message.sections, user_memory: "", project_experience: "", project_skills: "" }
        }
      : message
  );
  for (const section of sectionNames) {
    projected = optionalContextSectionWithinBudget(
      projected,
      section,
      getCurrentSystemMessage(current.messages)?.sections?.[section] ?? "",
      {
        contextWindow: snapshot.model.contextWindow,
        reserveTokens,
        maxTokens: typeof output === "number" && output > 0 ? output : snapshot.model.maxTokens
      }
    );
  }
  let changed = false;
  const refreshed = original.messages.map((message, index) => {
    const next = projected[index];
    if (
      message.role !== "system" ||
      next.role !== "system" ||
      sectionNames.every(
        (section) => (message.sections?.[section] ?? "") === (next.sections?.[section] ?? "")
      )
    )
      return message;
    changed = true;
    return next;
  });
  const context = normalizeContext({ messages: refreshed });
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- changed 在 map 回调里赋值，TS 在读取处看不到回调内的写入
  if (!changed) return { context: original, body: snapshot.body };
  const rendered = (value: TranscriptContext) =>
    resolveTranscript(value, snapshot.model.compat?.supportsMidConvoSystemMessages).messages.flatMap(
      (message, index) => {
        if (message.role !== "system") return [];
        const text = index === 0 ? getSystemMessageText(message) : renderSystemMessageUpdate(message);
        return text ? [text] : [];
      }
    );
  const before = rendered(original);
  const after = rendered(context);
  const field = snapshot.model.api === "openai-responses" ? "input" : "messages";
  const messages: { role?: string; content?: unknown }[] | undefined = Array.isArray(body[field])
    ? body[field]
    : undefined;
  const instructions = messages?.filter((message) =>
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 消息数组来自归档请求体 JSON，元素不一定是带 role 的对象
    ["system", "developer"].includes(message?.role ?? "")
  );
  if (
    !Array.isArray(messages) ||
    before.length !== after.length ||
    instructions?.length !== before.length ||
    instructions.some((message, index) => message.content !== before[index])
  )
    // A legacy/custom payload cannot be regenerated safely. Retain the failed
    // request and refuse transmission rather than resend revoked memory.
    throw new MainRequestConflictError(
      "记忆或项目经验已变化，原请求的系统正文无法安全刷新。原请求和历史已保留，请发送新消息。"
    );
  instructions.forEach((message, index) => {
    message.content = after[index];
  });
  return { context, body: JSON.stringify(body) };
}

export async function mainRequestEnvironment(
  storageRoot: string,
  taskId: string,
  projectDirectory: string
): Promise<MainRequestExecutionEnvironment> {
  const service = await applicationServiceForTask(storageRoot, taskId);
  const manifest = await service.instances.readManifest(taskId);
  return {
    projectDirectory: await realpath(projectDirectory),
    binding: JSON.stringify({
      workspaceRoot: await realpath(service.resourceWorkspaceRoot),
      loadedInstanceId: manifest.loadedInstanceId ?? null,
      boundResourceId: manifest.boundResourceId ?? null
    }),
    executionScope: await currentMainRequestExecutionScope({
      taskStorageRoot: storageRoot,
      taskId,
      projectDirectory
    })
  };
}

/** One failed Main request is replayed until it succeeds; subsequent calls run normally. */
export class MainRequestRetry {
  private loaded = false;
  private replay?: MainRequestSnapshot;
  private deferredContext = false;
  private slot?: { runId: string; requestId: string };

  constructor(
    readonly store: MainRequestStore,
    readonly runId: string,
    private readonly environment: () => Promise<MainRequestExecutionEnvironment>,
    private readonly requestId?: string,
    private readonly restoreTools?: (names: string[]) => Promise<void>,
    private readonly afterReplay?: (deferredContext: boolean) => Promise<void>,
    private readonly execution?: {
      beginTurn(): void;
      protectReplayScope(scope: MainRequestExecutionScope): void;
      goalDelegation?: {
        read(): Promise<string | undefined>;
        restore(requestId: string | undefined, messages: readonly unknown[]): Promise<void>;
      };
      memoryReserveTokens?(model: Pick<Model<Api>, "id" | "provider">): number;
    }
  ) {}

  get isReplaying(): boolean {
    return Boolean(this.requestId && (!this.loaded || this.replay));
  }

  async prepare(model: Model<Api>, context: TranscriptContext) {
    // Pi summary calls carry no tools. Never replay a chat response as a compaction result.
    const main = getCurrentTools(context.messages).length > 0;
    if (!main) return { model, context, main };
    this.execution?.beginTurn();
    await this.restore();
    if (this.replay) {
      this.execution?.protectReplayScope(this.replay.executionScope!);
      const input = (messages: TranscriptContext["messages"]) =>
        messages
          .filter(
            (message) =>
              message.role !== "system" &&
              !(message.role === "assistant" && ["error", "aborted"].includes(message.stopReason))
          )
          .map((message) => ({
            role: message.role,
            content:
              typeof message.content === "string"
                ? [{ type: "text", text: message.content }]
                : message.content,
            ...(message.role === "toolResult" ? { toolCallId: message.toolCallId } : {})
          }));
      this.deferredContext ||=
        JSON.stringify(input(context.messages)) !== JSON.stringify(input(this.replay.context.messages));
      const refreshed = refreshReplayMemory(
        this.replay,
        context,
        this.execution?.memoryReserveTokens?.(this.replay.model) ?? 16_384
      );
      return {
        model: this.replay.model,
        context: refreshed.context,
        main,
        replay: this.replay,
        replayBody: refreshed.body
      };
    }
    return { model, context, main };
  }

  async restore(): Promise<void> {
    if (!this.loaded) {
      this.replay = this.requestId
        ? await this.store.inspectPending(async (snapshot) => snapshot)
        : undefined;
      if (this.requestId && this.replay?.requestId !== this.requestId)
        throw new MainRequestSnapshotError("要重试的原请求已变化，已有内容仍保留。请刷新后重试。");
      if (this.replay) this.slot = { runId: this.replay.runId, requestId: this.replay.requestId };
      this.loaded = true;
    }
    if (this.replay) {
      await this.execution?.goalDelegation?.restore(
        this.replay.goalDelegationRequestId,
        this.replay.context.messages
      );
      if (!this.replay.executionScope || !this.replay.endpoint)
        throw new MainRequestSnapshotError(
          "原请求缺少执行归属记录，无法安全重试。原请求、历史和草稿已保留，请主动发送新消息。"
        );
      const current = await this.environment();
      if (
        current.projectDirectory !== this.replay.environment.projectDirectory ||
        current.binding !== this.replay.environment.binding
      )
        throw new MainRequestConflictError(
          "原请求的项目目录或应用绑定已变化，已有内容仍保留。请恢复原设置后重试，或发送新消息。"
        );
      try {
        assertMainRequestExecutionScope(this.replay.executionScope, current.executionScope!);
      } catch (error) {
        throw new MainRequestConflictError(error instanceof Error ? error.message : String(error));
      }
      await this.restoreTools?.(getCurrentTools(this.replay.context.messages).map((tool) => tool.name));
    }
  }

  async capture(
    input: Omit<
      MainRequestSnapshot,
      | "version"
      | "taskId"
      | "state"
      | "bodySha256"
      | "checksum"
      | "environment"
      | "runId"
      | "executionScope"
      | "goalDelegationRequestId"
    >
  ) {
    const { executionScope, ...environment } = await this.environment();
    if (!executionScope) throw new MainRequestSnapshotError("模型请求没有执行归属记录，未发送请求。");
    if (this.replay && JSON.stringify(environment) !== JSON.stringify(this.replay.environment))
      throw new MainRequestConflictError("原请求的执行环境已变化，未发送请求。已有内容仍保留。");
    if (this.replay) {
      try {
        assertMainRequestExecutionScope(this.replay.executionScope, executionScope);
      } catch (error) {
        throw new MainRequestConflictError(error instanceof Error ? error.message : String(error));
      }
      if (input.endpoint !== this.replay.endpoint)
        throw new MainRequestConflictError("原请求的模型发送地址已变化，未发送请求。已有内容仍保留。");
    }
    await this.store.begin(
      {
        ...input,
        runId: this.runId,
        environment,
        executionScope,
        goalDelegationRequestId: this.replay
          ? this.replay.goalDelegationRequestId
          : await this.execution?.goalDelegation?.read()
      },
      this.replay ? this.slot : undefined
    );
    this.slot = { runId: this.runId, requestId: input.requestId };
  }

  async settle(requestId: string, success: boolean): Promise<void> {
    await this.store.settle(requestId, success ? "completed" : "failed");
    if (success && this.replay) {
      this.replay = undefined;
      await this.afterReplay?.(this.deferredContext);
    }
  }
}
