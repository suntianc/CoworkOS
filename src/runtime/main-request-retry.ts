import {
  getCurrentTools,
  normalizeContext,
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
import { retiredSectionReplayRefusal, retiredSectionsWithText } from "./retired-system-sections.js";

export interface MainRequestExecutionEnvironment extends MainRequestEnvironment {
  executionScope?: MainRequestExecutionScope;
}

export class MainRequestConflictError extends Error {
  readonly status = 409;
  readonly code = "main_retry_context_changed";
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
      const archived = normalizeContext(this.replay.context);
      // An archive written before user memory and project experience were
      // removed still holds their rendered text. Refuse the exact replay
      // instead of resending it; the caller sends a new message, which rebuilds
      // the context without those sections.
      const retired = retiredSectionsWithText(archived.messages);
      if (retired.length) throw new MainRequestConflictError(retiredSectionReplayRefusal(retired));
      return {
        model: this.replay.model,
        context: archived,
        main,
        replay: this.replay,
        replayBody: this.replay.body
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
      "version" | "taskId" | "state" | "bodySha256" | "checksum" | "environment" | "runId" | "executionScope"
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
        executionScope
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
