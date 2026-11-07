import { randomUUID } from "node:crypto";
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
  now = () => new Date().toISOString()
}: {
  store: MainCapacityStore;
  host: string;
  settings: () => MainCapacitySettings | undefined;
  now?: () => string;
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
    if (typeof value.thinkingLevel === "string") submission.thinkingLevel = value.thinkingLevel;
    if (Array.isArray(value.attachmentIds)) submission.attachmentIds = [...value.attachmentIds];
    if (Array.isArray(value.textAttachments)) submission.textAttachments = [...value.textAttachments];
    if (value.source) submission.source = value.source;
    return Object.keys(submission).length ? submission : undefined;
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
      state: "queued"
    };
  }

  function duplicateOf(
    state: MainCapacityState,
    request: MainCapacityRequest
  ): MainCapacityDecision | undefined {
    const requirementId = request.requirementId;
    const slot = state.slots.find(
      (entry) =>
        entry.taskId === request.taskId ||
        (requirementId !== undefined &&
          entry.projectId === request.projectId &&
          entry.requirementId === requirementId)
    );
    if (slot) return { state: "duplicate", requestId: slot.requestId, runId: slot.runId, reason: "running" };
    const queue = state.queue.find(
      (entry) =>
        entry.taskId === request.taskId ||
        (requirementId !== undefined &&
          entry.projectId === request.projectId &&
          entry.requirementId === requirementId)
    );
    if (queue)
      return {
        state: "duplicate",
        requestId: queue.requestId,
        position: positionOf(state, queue.requestId),
        reason: "queued"
      };
    return undefined;
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
      return store.update((state) => {
        const duplicate = duplicateOf(state, request);
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

    /** Remove the claim for one request; a missing claim is not an error. */
    release(requestId: string): Promise<boolean> {
      return store.update((state) => {
        const index = state.slots.findIndex((entry) => entry.requestId === requestId);
        if (index >= 0) state.slots.splice(index, 1);
        const queued = state.queue.findIndex((entry) => entry.requestId === requestId);
        if (queued >= 0) state.queue.splice(queued, 1);
        return index >= 0 || queued >= 0;
      });
    },

    /** Drop every waiting demand for one Task; a cancelled demand never starts. */
    cancelTask(taskId: string): Promise<number> {
      return store.update((state) => {
        const before = state.queue.length;
        state.queue = state.queue.filter((entry) => entry.taskId !== taskId);
        return before - state.queue.length;
      });
    },

    /** Drop a queued or starting demand without starting it. */
    abandon(requestId: string): Promise<void> {
      return store.update((state) => {
        const index = state.slots.findIndex((entry) => entry.requestId === requestId);
        if (index >= 0) state.slots.splice(index, 1);
        const queued = state.queue.findIndex((entry) => entry.requestId === requestId);
        if (queued >= 0) state.queue.splice(queued, 1);
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
        const next = ordered.find(
          ({ entry }) => entry.state === "queued" && used(state, entry.kind) < limitOf(current, entry.kind)
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

    /** The start callback failed: the demand owns nothing and the queue moves on. */
    failStart(requestId: string): Promise<void> {
      return store.update((state) => {
        const slot = state.slots.findIndex((entry) => entry.requestId === requestId);
        if (slot >= 0) state.slots.splice(slot, 1);
        const queued = state.queue.findIndex((entry) => entry.requestId === requestId);
        if (queued >= 0) state.queue.splice(queued, 1);
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

    setExternalTasks(entries: MainCapacityExternalTask[]): Promise<void> {
      return store.update((state) => {
        state.externalTasks = [...entries].sort((left, right) => left.taskId.localeCompare(right.taskId));
      });
    }
  };
}

export type MainCapacityLedger = ReturnType<typeof createMainCapacityLedger>;
