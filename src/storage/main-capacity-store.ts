import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  MAIN_CAPACITY_QUEUE_LIMIT,
  type MainCapacityExternalTask,
  type MainCapacityQueueEntry,
  type MainCapacitySlot,
  type MainCapacityState
} from "../domain/main-capacity.js";
import { withFileLock } from "./file-lock.js";

/** Local execution facts live beside the backend identity, not in shared project data. */
export function mainCapacityStatePath(dataRoot: string): string {
  return join(dataRoot, "main-capacity", "state.json");
}

export class MainCapacityStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MainCapacityStateError";
  }
}

function emptyState(): MainCapacityState {
  return { version: 1, externalTasks: [], slots: [], queue: [], updatedAt: new Date().toISOString() };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function slotOf(value: unknown): MainCapacitySlot {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MainCapacityStateError("容量记录中的运行占用格式无效");
  const entry = value as Record<string, unknown>;
  const required = ["requestId", "projectId", "sessionId", "taskId", "runId", "kind", "host", "startedAt"];
  if (required.some((key) => !text(entry[key])))
    throw new MainCapacityStateError("容量记录中的运行占用缺少归属字段");
  if (entry.kind !== "regular" && entry.kind !== "continuation")
    throw new MainCapacityStateError("容量记录中的运行类型无效");
  return {
    requestId: String(entry.requestId),
    projectId: String(entry.projectId),
    sessionId: String(entry.sessionId),
    taskId: String(entry.taskId),
    runId: String(entry.runId),
    kind: entry.kind,
    ...(text(entry.requirementId) ? { requirementId: String(entry.requirementId) } : {}),
    host: String(entry.host),
    ...(typeof entry.pid === "number" && Number.isSafeInteger(entry.pid) && entry.pid > 0
      ? { pid: entry.pid }
      : {}),
    startedAt: String(entry.startedAt)
  };
}

function submissionOf(value: unknown): MainCapacityQueueEntry["submission"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const submission: NonNullable<MainCapacityQueueEntry["submission"]> = {};
  if (typeof input.body === "string") submission.body = input.body;
  if (typeof input.thinkingLevel === "string") submission.thinkingLevel = input.thinkingLevel;
  if (Array.isArray(input.attachmentIds))
    submission.attachmentIds = input.attachmentIds.filter((item): item is string => typeof item === "string");
  if (Array.isArray(input.textAttachments))
    submission.textAttachments = input.textAttachments
      .filter(
        (item): item is { name: string; text: string; size: number } =>
          Boolean(item) && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
      )
      .map((item) => ({
        name: item.name,
        text: typeof item.text === "string" ? item.text : "",
        size: typeof item.size === "number" ? item.size : 0
      }));
  if (input.source === "composer" || input.source === "human" || input.source === "inbox")
    submission.source = input.source;
  return Object.keys(submission).length ? submission : undefined;
}

function queuedOf(value: unknown): MainCapacityQueueEntry {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MainCapacityStateError("容量记录中的排队项格式无效");
  const entry = value as Record<string, unknown>;
  const required = [
    "requestId",
    "projectId",
    "sessionId",
    "taskId",
    "runId",
    "kind",
    "host",
    "prompt",
    "origin",
    "enqueuedAt",
    "state"
  ];
  if (required.some((key) => !text(entry[key])))
    throw new MainCapacityStateError("容量记录中的排队项缺少归属字段");
  if (entry.kind !== "regular" && entry.kind !== "continuation")
    throw new MainCapacityStateError("容量记录中的排队类型无效");
  if (entry.state !== "queued" && entry.state !== "starting")
    throw new MainCapacityStateError("容量记录中的排队状态无效");
  return {
    requestId: String(entry.requestId),
    projectId: String(entry.projectId),
    sessionId: String(entry.sessionId),
    taskId: String(entry.taskId),
    runId: String(entry.runId),
    kind: entry.kind,
    ...(text(entry.requirementId) ? { requirementId: String(entry.requirementId) } : {}),
    host: String(entry.host),
    resume: entry.resume === true,
    ...(text(entry.model) ? { model: String(entry.model) } : {}),
    ...(text(entry.retryRequestId) ? { retryRequestId: String(entry.retryRequestId) } : {}),
    prompt: String(entry.prompt),
    ...(submissionOf(entry.submission) ? { submission: submissionOf(entry.submission) } : {}),
    origin:
      entry.origin === "worker" || entry.origin === "cli" || entry.origin === "internal"
        ? entry.origin
        : "http",
    enqueuedAt: String(entry.enqueuedAt),
    state: entry.state
  };
}

function externalTaskOf(value: unknown): MainCapacityExternalTask {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MainCapacityStateError("容量记录中的外部会话格式无效");
  const entry = value as Record<string, unknown>;
  if (["taskId", "projectId", "sessionId"].some((key) => !text(entry[key])))
    throw new MainCapacityStateError("容量记录中的外部会话缺少归属字段");
  if (entry.kind !== "regular" && entry.kind !== "continuation")
    throw new MainCapacityStateError("容量记录中的外部会话类型无效");
  return {
    taskId: String(entry.taskId),
    projectId: String(entry.projectId),
    sessionId: String(entry.sessionId),
    kind: entry.kind
  };
}

/**
 * The local capacity state file.
 *
 * Every write replaces the file atomically and is serialized with the runtime's
 * file lock, so the Dashboard and a CLI or worker never reserve the same slot.
 * A damaged record is refused and left untouched: guessing would let a start
 * bypass a budget another process still owns.
 */
export class MainCapacityStore {
  constructor(readonly path: string) {}

  private async load(): Promise<MainCapacityState> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new MainCapacityStateError(`外部 Main 容量记录不是合法 JSON：${this.path}（原文件已保留）`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new MainCapacityStateError(`外部 Main 容量记录格式无效：${this.path}（原文件已保留）`);
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || !Array.isArray(record.slots) || !Array.isArray(record.queue))
      throw new MainCapacityStateError(`外部 Main 容量记录版本无效：${this.path}（原文件已保留）`);
    const queue = record.queue.map(queuedOf);
    if (queue.length > MAIN_CAPACITY_QUEUE_LIMIT)
      throw new MainCapacityStateError(`外部 Main 排队记录超出上限：${this.path}（原文件已保留）`);
    return {
      version: 1,
      externalTasks: Array.isArray(record.externalTasks) ? record.externalTasks.map(externalTaskOf) : [],
      slots: record.slots.map(slotOf),
      queue,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString()
    };
  }

  /** Read a consistent snapshot without writing. */
  async read(): Promise<MainCapacityState> {
    return withFileLock(this.path, () => this.load(), { recoverDeadOwner: true, timeoutMs: 10_000 });
  }

  /**
   * Apply one change under the lock. The file is written only when the change
   * returns, so a refused admission leaves the previous state in place.
   */
  async update<T>(change: (state: MainCapacityState) => T | Promise<T>): Promise<T> {
    return withFileLock(
      this.path,
      async () => {
        const state = await this.load();
        const result = await change(state);
        state.updatedAt = new Date().toISOString();
        await mkdir(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.tmp-${process.pid}-${Date.now()}`;
        await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.path);
        return result;
      },
      { recoverDeadOwner: true, timeoutMs: 10_000 }
    );
  }
}
