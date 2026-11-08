import { createHash, randomUUID } from "node:crypto";
import {
  MAIN_CAPACITY_QUEUE_LIMIT,
  type MainCapacityDecision,
  type MainCapacityExternalTask,
  type MainCapacityQueueEntry,
  type MainCapacityRequest,
  type MainCapacitySettings,
  type MainCapacitySlot,
  type MainCapacityState,
  type MainCapacitySubmission
} from "../domain/main-capacity.js";
import { ProjectDataConflictError, ProjectDataInvalidError } from "../domain/project-ledger.js";
import type { MainCapacityStore } from "../storage/main-capacity-store.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value) || value.length > 300)
    throw new ProjectDataInvalidError(`${label}无效`);
  return value;
}

/**
 * The single admission authority for external Main Runs on this host.
 *
 * It runs the same code for the Dashboard, the worker and the CLI: one file,
 * one lock, one place that decides whether a demand runs now or waits. The
 * ledger knows nothing about processes or HTTP; it hands the caller a reserved
 * slot or a durable queue entry and lets the caller start the Run.
 */
export function createMainCapacityLedger({
  store,
  host,
  settings,
  now = () => new Date().toISOString(),
  retryBaseMs = 2_000,
  maxAttempts = 5
}: {
  store: MainCapacityStore;
  host: string;
  settings: () => MainCapacitySettings | undefined;
  now?: () => string;
  retryBaseMs?: number;
  maxAttempts?: number;
}) {
  function required(): MainCapacitySettings {
    const value = settings();
    if (!value)
      throw new ProjectDataConflictError(
        "外部 Main 尚未启用：请先在外部服务配置 resident 与 continuation",
        undefined,
        "main_capacity_unconfigured"
      );
    return value;
  }

  const limitOf = (value: MainCapacitySettings, kind: MainCapacitySlot["kind"]) =>
    kind === "regular" ? value.resident : value.continuation;
  const used = (state: MainCapacityState, kind: MainCapacitySlot["kind"]) =>
    state.slots.filter((slot) => slot.kind === kind).length;

  function validate(request: MainCapacityRequest) {
    const requestId = request.requestId ? identifier(request.requestId, "请求 ID") : randomUUID();
    identifier(request.projectId, "项目 ID");
    identifier(request.sessionId, "会话 ID");
    identifier(request.taskId, "Task ID");
    identifier(request.runId, "Run ID");
    if (request.kind !== "regular" && request.kind !== "continuation")
      throw new ProjectDataInvalidError("外部 Main 类型须为 regular 或 continuation");
    if (typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.includes("\0"))
      throw new ProjectDataInvalidError("外部 Main 请求缺少有效输入");
    if (Buffer.byteLength(request.prompt, "utf8") > 512 * 1024)
      throw new ProjectDataInvalidError("外部 Main 输入不能超过 512 KB");
    return requestId;
  }

  function submissionOf(value: MainCapacitySubmission | undefined): MainCapacitySubmission | undefined {
    if (!value) return undefined;
    const submission: MainCapacitySubmission = {};
    if (typeof value.body === "string") submission.body = value.body;
    if (typeof value.profileId === "string" && value.profileId) submission.profileId = value.profileId;
    if (typeof value.thinkingLevel === "string") submission.thinkingLevel = value.thinkingLevel;
    if (Array.isArray(value.attachmentIds)) submission.attachmentIds = [...value.attachmentIds];
    if (Array.isArray(value.textAttachments)) submission.textAttachments = [...value.textAttachments];
    if (value.source) submission.source = value.source;
    return Object.keys(submission).length ? submission : undefined;
  }

  /**
   * The identity of an accepted input.
   *
   * A resubmission is idempotent only when everything the user chose matches:
   * the text, the body, the attachments, the explicit connection/model/thinking
   * choice and whether the request continues or retries. A second message with
   * different content is a different demand and must not be reported as sent.
   */
  function inputHashOf(fields: {
    prompt: string;
    submission?: MainCapacitySubmission;
    model?: string;
    resume?: boolean;
    retryRequestId?: string;
  }): string {
    const submission = fields.submission ?? {};
    const identity = JSON.stringify([
      fields.prompt,
      submission.body ?? "",
      [...(submission.attachmentIds ?? [])].sort(),
      (submission.textAttachments ?? []).map((file) => [file.name, file.text, file.size]),
      submission.profileId ?? "",
      submission.thinkingLevel ?? "",
      fields.model ?? "",
      fields.resume === true,
      fields.retryRequestId ?? "",
      submission.source ?? ""
    ]);
    return createHash("sha256").update(identity).digest("hex");
  }

  function retryDelayMs(attempts: number): number {
    const base = Math.max(50, retryBaseMs);
    return Math.min(60_000, base * 2 ** Math.max(0, attempts - 1));
  }

  function queuedEntry(
    request: MainCapacityRequest,
    requestId: string,
    timestamp: string
  ): MainCapacityQueueEntry {
    return {
      requestId,
      projectId: request.projectId,
      sessionId: request.sessionId,
      taskId: request.taskId,
      runId: request.runId,
      kind: request.kind,
      ...(request.requirementId ? { requirementId: identifier(request.requirementId, "需求 ID") } : {}),
      host,
      resume: request.resume === true,
      ...(request.model ? { model: request.model } : {}),
      ...(request.retryRequestId ? { retryRequestId: request.retryRequestId } : {}),
      prompt: request.prompt,
      ...(submissionOf(request.submission) ? { submission: submissionOf(request.submission) } : {}),
      origin: request.origin,
      enqueuedAt: timestamp,
      state: "queued",
      inputHash: inputHashOf(request),
      attempts: 0
    };
  }

  /**
   * The demand that already owns this Task or requirement.
   *
   * Identical input is an idempotent resubmission; different input must not be
   * swallowed under a success status, so it is refused for the caller to keep
   * (the UI keeps the draft, the worker/CLI report the conflict).
   */
  function duplicateOf(
    state: MainCapacityState,
    request: MainCapacityRequest,
    requestHash: string
  ): MainCapacityDecision | undefined {
    const requirementId = request.requirementId;
    const matches = (entry: { taskId: string; projectId: string; requirementId?: string }) =>
      entry.taskId === request.taskId ||
      (requirementId !== undefined &&
        entry.projectId === request.projectId &&
        entry.requirementId === requirementId);
    const slot = state.slots.find(matches);
    if (slot) {
      if (slot.inputHash !== requestHash)
        throw new ProjectDataConflictError(
          "该任务已有运行中的 Main 消息；请使用补充消息，或等待本次运行结束后再发送",
          undefined,
          "main_capacity_conflict"
        );
      return {
        state: "duplicate",
        requestId: slot.requestId,
        runId: slot.runId,
        reason: "running"
      };
    }
    const queue = state.queue.find(matches);
    if (queue) {
      if (queue.inputHash !== requestHash)
        throw new ProjectDataConflictError(
          "该任务已有排队中的其他输入；请等待它开始运行后再发送，草稿已保留",
          undefined,
          "main_capacity_conflict"
        );
      return {
        state: "duplicate",
        requestId: queue.requestId,
        runId: queue.runId,
        position: positionOf(state, queue.requestId),
        reason: "queued"
      };
    }
    return undefined;
  }

  function dropSlot(requestId: string): Promise<boolean> {
    return store.update((state) => {
      const index = state.slots.findIndex((entry) => entry.requestId === requestId);
      if (index >= 0) state.slots.splice(index, 1);
      return index >= 0;
    });
  }

  function positionOf(state: MainCapacityState, requestId: string): number {
    const index = state.queue.findIndex((entry) => entry.requestId === requestId);
    return index < 0 ? state.queue.length + 1 : index + 1;
  }

  return {
    state: () => store.read(),

    /** Reserve a slot, queue the demand, or report the demand that already owns one. */
    async admit(request: MainCapacityRequest): Promise<MainCapacityDecision> {
      const current = required();
      const requestId = validate(request);
      const requestHash = inputHashOf(request);
      return store.update((state) => {
        const duplicate = duplicateOf(state, request, requestHash);
        if (duplicate) return duplicate;
        if (used(state, request.kind) < limitOf(current, request.kind)) {
          state.slots.push({
            requestId,
            projectId: request.projectId,
            sessionId: request.sessionId,
            taskId: request.taskId,
            runId: request.runId,
            kind: request.kind,
            ...(request.requirementId ? { requirementId: identifier(request.requirementId, "需求 ID") } : {}),
            host,
            inputHash: requestHash,
            startedAt: now()
          });
          return { state: "running" as const, requestId };
        }
        if (!request.queueWhenFull)
          throw new ProjectDataConflictError(
            `外部 Main ${request.kind === "regular" ? "常规" : "接续"}名额已满（${
              request.kind === "regular" ? "resident" : "continuation"
            }=${limitOf(current, request.kind)}），请稍后重试`,
            undefined,
            "main_capacity_full"
          );
        if (state.queue.length >= MAIN_CAPACITY_QUEUE_LIMIT)
          throw new ProjectDataConflictError(
            "外部 Main 排队已满，请等待现有需求运行",
            undefined,
            "main_capacity_queue_full"
          );
        state.queue.push(queuedEntry(request, requestId, now()));
        return { state: "queued" as const, requestId, position: positionOf(state, requestId) };
      });
    },

    /** Remember the pid the spawn returned; a pid from another host is never treated as ours. */
    bindProcess(requestId: string, pid: number): Promise<void> {
      return store.update((state) => {
        const slot = state.slots.find((entry) => entry.requestId === requestId);
        if (slot) slot.pid = pid;
      });
    },

    /**
     * Remove the running claim for one request; a missing claim is not an error.
     *
     * The accepted demand is not touched here: a Run that never spawned must
     * keep its input for the dispatch retry, and a Run that ran already removed
     * its own queue entry when it started.
     */
    release: dropSlot,

    /** Drop every waiting demand for one Task; a cancelled demand never starts. */
    cancelTask(taskId: string): Promise<number> {
      return store.update((state) => {
        const before = state.queue.length;
        state.queue = state.queue.filter((entry) => entry.taskId !== taskId);
        return before - state.queue.length;
      });
    },

    /** Take the first waiting demand whose kind has a free slot, and reserve it. */
    reserveNext(): Promise<MainCapacityQueueEntry | undefined> {
      return store.update((state) => {
        const current = settings();
        if (!current) return undefined;
        const ordered = state.queue
          .map((entry, index) => ({ entry, index }))
          .sort(
            (left, right) =>
              Date.parse(left.entry.enqueuedAt) - Date.parse(right.entry.enqueuedAt) ||
              left.index - right.index
          );
        const at = Date.parse(now());
        const next = ordered.find(
          ({ entry }) =>
            entry.state === "queued" &&
            !(entry.retryAt && Date.parse(entry.retryAt) > at) &&
            used(state, entry.kind) < limitOf(current, entry.kind)
        );
        if (!next) return undefined;
        const { entry } = next;
        entry.state = "starting";
        state.slots.push({
          requestId: entry.requestId,
          projectId: entry.projectId,
          sessionId: entry.sessionId,
          taskId: entry.taskId,
          runId: entry.runId,
          kind: entry.kind,
          ...(entry.requirementId ? { requirementId: entry.requirementId } : {}),
          host,
          ...(entry.inputHash ? { inputHash: entry.inputHash } : {}),
          startedAt: now()
        });
        return { ...entry };
      });
    },

    /** The start callback returned: the demand is now a running slot. */
    completeStart(requestId: string): Promise<void> {
      return store.update((state) => {
        const index = state.queue.findIndex((entry) => entry.requestId === requestId);
        if (index >= 0) state.queue.splice(index, 1);
      });
    },

    /** The start callback failed permanently: the demand owns nothing and the queue moves on. */
    failStart(requestId: string): Promise<void> {
      return store.update((state) => {
        const slot = state.slots.findIndex((entry) => entry.requestId === requestId);
        if (slot >= 0) state.slots.splice(slot, 1);
        const queued = state.queue.findIndex((entry) => entry.requestId === requestId);
        if (queued >= 0) state.queue.splice(queued, 1);
      });
    },

    /** Remove one slot but keep its accepted demand where it is. */
    releaseSlot: dropSlot,

    /**
     * A recoverable dispatch failure: release the unused slot and keep the
     * accepted input, retried with backoff until bounded attempts run out.
     * After that the demand stays visible as `failed` with its input intact.
     */
    retryStart(requestId: string, error: string): Promise<void> {
      return store.update((state) => {
        const slot = state.slots.findIndex((entry) => entry.requestId === requestId);
        if (slot >= 0) state.slots.splice(slot, 1);
        const entry = state.queue.find((item) => item.requestId === requestId);
        if (!entry) return;
        const attempts = (entry.attempts ?? 0) + 1;
        entry.attempts = attempts;
        entry.lastError = error.slice(0, 500);
        if (attempts >= maxAttempts) {
          entry.state = "failed";
          delete entry.retryAt;
          return;
        }
        entry.state = "queued";
        entry.retryAt = new Date(Date.parse(now()) + retryDelayMs(attempts)).toISOString();
      });
    },

    /** Put a failed accepted demand back in line. Returns false when it is not retryable. */
    retry(requestId: string): Promise<boolean> {
      return store.update((state) => {
        const entry = state.queue.find((item) => item.requestId === requestId);
        if (!entry || entry.state !== "failed") return false;
        entry.state = "queued";
        entry.attempts = 0;
        delete entry.lastError;
        delete entry.retryAt;
        return true;
      });
    },

    async externalTask(taskId: string): Promise<MainCapacityExternalTask | undefined> {
      return (await store.read()).externalTasks.find((entry) => entry.taskId === taskId);
    },

    noteExternalTask(entry: MainCapacityExternalTask): Promise<void> {
      return store.update((state) => {
        const index = state.externalTasks.findIndex((item) => item.taskId === entry.taskId);
        if (index >= 0) state.externalTasks[index] = entry;
        else state.externalTasks.push(entry);
      });
    },

    /** Keep every identity already known and add the ones just read. */
    mergeExternalTasks(entries: MainCapacityExternalTask[]): Promise<void> {
      return store.update((state) => {
        for (const entry of entries) {
          const index = state.externalTasks.findIndex((item) => item.taskId === entry.taskId);
          if (index >= 0) state.externalTasks[index] = entry;
          else state.externalTasks.push(entry);
        }
        state.externalTasks.sort((left, right) => left.taskId.localeCompare(right.taskId));
      });
    },

    setExternalTasks(entries: MainCapacityExternalTask[]): Promise<void> {
      return store.update((state) => {
        state.externalTasks = [...entries].sort((left, right) => left.taskId.localeCompare(right.taskId));
      });
    }
  };
}

export type MainCapacityLedger = ReturnType<typeof createMainCapacityLedger>;
