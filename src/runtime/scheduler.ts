import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { id, now, type Importance, type InboxMessage } from "../domain/types.js";
import { withFileLock } from "../storage/file-lock.js";
import { verifyProcessIdentity, type ProcessIdentity } from "./process-identity.js";

export type WorkStatus = "queued" | "leased" | "completed" | "failed" | "cancelled";

export interface WorkItem {
  stepId: string;
  taskId: string;
  runId: string;
  agentId: string;
  importance: Importance;
  payload: unknown;
  status: WorkStatus;
  attempts: number;
  maxAttempts?: number;
  /** The earliest time this queued retry may be claimed; absent means now. */
  notBefore?: string;
  createdAt: string;
  updatedAt: string;
  lease?: { workerId: string; token: string; expiresAt: string };
  error?: string;
}

export interface Checkpoint {
  runId: string;
  sequence: number;
  state: unknown;
  savedAt: string;
}

const priority: Record<Importance, number> = { critical: 0, high: 1, normal: 2, background: 3 };

/** Durable JSON-file scheduler for the first single-process P2 runtime. */
export class DurableScheduler {
  private mutex: Promise<void> = Promise.resolve();
  constructor(private readonly queuePath: string) {}

  async enqueue(input: Omit<WorkItem, "status" | "attempts" | "createdAt" | "updatedAt">): Promise<WorkItem> {
    return this.withLock(async () => {
      const items = await this.readItems();
      const existing = items.find((item) => item.stepId === input.stepId);
      if (existing) return existing;
      const item: WorkItem = {
        ...input,
        maxAttempts: Math.max(1, input.maxAttempts ?? 1),
        status: "queued",
        attempts: 0,
        createdAt: now(),
        updatedAt: now()
      };
      items.push(item);
      await this.writeItems(items);
      return item;
    });
  }

  async claim(workerId: string, leaseMs = 60_000, stepId?: string): Promise<WorkItem | undefined> {
    return this.withLock(async () => {
      const items = await this.readItems();
      const at = Date.now();
      this.reclaimExpiredInMemory(items, at);
      const candidate = items
        .filter(
          (item) =>
            item.status === "queued" &&
            (!stepId || item.stepId === stepId) &&
            // A retry waits for its scheduled time; claiming it early would
            // repeat the attempt that just failed before its backoff ended.
            (!item.notBefore || Date.parse(item.notBefore) <= at)
        )
        .sort(
          (a, b) => priority[a.importance] - priority[b.importance] || a.createdAt.localeCompare(b.createdAt)
        )[0];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 没有排队的工作项时过滤结果为空，索引 [0] 在运行期返回 undefined
      if (!candidate) {
        await this.writeItems(items);
        return undefined;
      }
      const token = id("lease");
      candidate.status = "leased";
      candidate.attempts += 1;
      candidate.notBefore = undefined;
      candidate.lease = { workerId, token, expiresAt: new Date(at + leaseMs).toISOString() };
      candidate.updatedAt = now();
      await this.writeItems(items);
      return candidate;
    });
  }

  /** Requeue expired leases, or dead-letter them after maxAttempts. */
  async reclaimExpired(): Promise<WorkItem[]> {
    return this.withLock(async () => {
      const items = await this.readItems();
      const changed = this.reclaimExpiredInMemory(items, Date.now());
      if (changed.length > 0) await this.writeItems(items);
      return changed;
    });
  }

  /** Extend a live lease while a model/tool call is still running. */
  async renew(stepId: string, token: string, leaseMs = 60_000): Promise<WorkItem> {
    return this.withLock(async () => {
      const items = await this.readItems();
      const item = items.find((candidate) => candidate.stepId === stepId);
      if (!item) throw new Error(`unknown step: ${stepId}`);
      if (item.status !== "leased" || item.lease?.token !== token)
        throw new Error(`lease mismatch for step: ${stepId}`);
      item.lease.expiresAt = new Date(Date.now() + Math.max(1_000, leaseMs)).toISOString();
      item.updatedAt = now();
      await this.writeItems(items);
      return item;
    });
  }

  async complete(stepId: string, token: string): Promise<WorkItem> {
    return this.finish(stepId, token, "completed");
  }

  /**
   * Record a failed attempt.
   *
   * A retryable attempt is requeued at once with its next allowed time, so the
   * caller can schedule the next start instead of leaving the item leased until
   * the lease expires.
   */
  async fail(stepId: string, token: string, error: string, retryAfterMs = 0): Promise<WorkItem> {
    return this.withLock(async () => {
      const items = await this.readItems();
      const item = items.find((candidate) => candidate.stepId === stepId);
      if (!item) throw new Error(`unknown step: ${stepId}`);
      if (item.status === "failed" || item.status === "completed" || item.status === "cancelled") return item;
      if (item.status !== "leased" || item.lease?.token !== token)
        throw new Error(`lease mismatch for step: ${stepId}`);
      const retry = item.attempts < (item.maxAttempts ?? 1);
      item.error = error;
      item.lease = undefined;
      item.status = retry ? "queued" : "failed";
      item.notBefore =
        retry && retryAfterMs > 0 ? new Date(Date.now() + retryAfterMs).toISOString() : undefined;
      item.updatedAt = now();
      await this.writeItems(items);
      return item;
    });
  }

  /**
   * Record a terminal failure for an item that never started.
   *
   * Recovery can refuse a queued item before any worker owns it — its stored
   * role request no longer resolves, for example — so there is no lease token to
   * match. Without this the refusal would be dropped and the same item would be
   * re-driven on every pass while the Task waits for it forever.
   */
  async failUnstarted(stepId: string, error: string): Promise<WorkItem> {
    return this.withLock(async () => {
      const items = await this.readItems();
      const item = items.find((candidate) => candidate.stepId === stepId);
      if (!item) throw new Error(`unknown step: ${stepId}`);
      if (item.status === "completed" || item.status === "failed" || item.status === "cancelled") return item;
      // A lease means another owner is already executing this item. Its own
      // settlement is the outcome; a caller that failed to start it must not
      // overwrite a run it never held — that would hide the real result and
      // report a failure for work that later succeeds.
      if (item.status === "leased" || item.lease) return item;
      item.status = "failed";
      item.error = error;
      item.lease = undefined;
      item.updatedAt = now();
      await this.writeItems(items);
      return item;
    });
  }

  async cancel(stepId: string): Promise<WorkItem> {
    return this.withLock(async () => {
      const items = await this.readItems();
      const item = items.find((candidate) => candidate.stepId === stepId);
      if (!item) throw new Error(`unknown step: ${stepId}`);
      if (item.status === "completed" || item.status === "failed" || item.status === "cancelled") return item;
      item.status = "cancelled";
      item.lease = undefined;
      item.updatedAt = now();
      await this.writeItems(items);
      return item;
    });
  }

  async list(): Promise<WorkItem[]> {
    return this.withLock(() => this.readItems());
  }

  private async finish(
    stepId: string,
    token: string,
    status: "completed" | "failed",
    error?: string
  ): Promise<WorkItem> {
    return this.withLock(async () => {
      const items = await this.readItems();
      const item = items.find((candidate) => candidate.stepId === stepId);
      if (!item) throw new Error(`unknown step: ${stepId}`);
      if (item.status === status) return item;
      if (item.status !== "leased" || item.lease?.token !== token)
        throw new Error(`lease mismatch for step: ${stepId}`);
      item.status = status;
      item.error = error;
      item.lease = undefined;
      item.updatedAt = now();
      await this.writeItems(items);
      return item;
    });
  }

  private async readItems(): Promise<WorkItem[]> {
    try {
      return JSON.parse(await readFile(this.queuePath, "utf8")) as WorkItem[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeItems(items: WorkItem[]): Promise<void> {
    await mkdir(dirname(this.queuePath), { recursive: true });
    const temporary = `${this.queuePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(items, null, 2)}\n`, "utf8");
    await rename(temporary, this.queuePath);
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await withFileLock(this.queuePath, fn);
    } finally {
      release();
    }
  }

  private reclaimExpiredInMemory(items: WorkItem[], at: number): WorkItem[] {
    const changed: WorkItem[] = [];
    for (const item of items) {
      if (item.status !== "leased" || !item.lease || Date.parse(item.lease.expiresAt) > at) continue;
      item.lease = undefined;
      // A lease can expire after a worker has made no terminal progress. Give
      // that attempt one chance to be reclaimed before dead-lettering; an
      // explicit fail still follows the normal maxAttempts boundary.
      if (item.attempts <= (item.maxAttempts ?? 1)) {
        item.status = "queued";
        item.error = `lease expired after attempt ${item.attempts}`;
      } else {
        item.status = "failed";
        item.error = `lease expired after ${item.attempts} attempt(s)`;
      }
      item.updatedAt = now();
      changed.push(item);
    }
    return changed;
  }
}

export class CheckpointStore {
  private mutex: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string) {}

  async save(checkpoint: Checkpoint): Promise<void> {
    await this.withLock(async () => {
      const records = await this.read();
      const previous = records[checkpoint.runId];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 该 run 首次保存时文件里没有记录，Record 索引在运行期返回 undefined
      if (previous && previous.sequence >= checkpoint.sequence) return;
      records[checkpoint.runId] = checkpoint;
      await this.write(records);
    });
  }

  async load(runId: string): Promise<Checkpoint | undefined> {
    return this.withLock(async () => (await this.read())[runId]);
  }

  private async read(): Promise<Record<string, Checkpoint>> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as Record<string, Checkpoint>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
  private async write(records: Record<string, Checkpoint>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      // The owner is this host's process: a Main that was killed between
      // taking the lock and releasing it must not stall the next reader for the
      // whole timeout. Recovery only reclaims an owner whose pid is gone.
      return await withFileLock(this.filePath, fn, { recoverDeadOwner: true });
    } finally {
      release();
    }
  }
}

/** How long a leased Inbox message stays with its consumer before another may take it. */
export const INBOX_MESSAGE_LEASE_MS = 60_000;

/** Durable Inbox with lease/consume semantics and duplicate enqueue protection. */
export class InboxStore {
  private mutex: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string) {}

  async enqueue(message: InboxMessage): Promise<InboxMessage> {
    return this.withLock(async () => {
      const messages = await this.read();
      const existing = messages.find((candidate) => candidate.messageId === message.messageId);
      if (existing) return existing;
      messages.push(message);
      await this.write(messages);
      return message;
    });
  }

  async lease(
    recipientAgentId: string,
    leaseMs = INBOX_MESSAGE_LEASE_MS,
    consumerId = `consumer-${process.pid}`,
    owner?: ProcessIdentity
  ): Promise<InboxMessage | undefined> {
    return this.withLock(async () => {
      const messages = await this.read();
      const reclaimed = await this.reclaimExpiredInMemory(messages);
      const message = messages
        .filter((candidate) => candidate.recipientAgentId === recipientAgentId && candidate.state === "ready")
        .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))[0];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 没有可租用的消息时过滤结果为空，索引 [0] 在运行期返回 undefined
      if (!message) {
        // Nothing was leased and reclaiming changed nothing: rewriting an
        // unchanged Inbox would wake a file-watching reader for no reason.
        if (reclaimed) await this.write(messages);
        return undefined;
      }
      message.state = "leased";
      message.lease = {
        consumerId,
        expiresAt: new Date(Date.now() + Math.max(1_000, leaseMs)).toISOString(),
        ...(owner ? { owner } : {})
      };
      await this.write(messages);
      return message;
    });
  }

  /** Lease one specific ready message, used to acknowledge a callback that
   * was delivered directly to an active Pi session. */
  async leaseMessage(
    recipientAgentId: string,
    messageId: string,
    leaseMs = INBOX_MESSAGE_LEASE_MS,
    consumerId = `consumer-${process.pid}`,
    owner?: ProcessIdentity
  ): Promise<InboxMessage | undefined> {
    return this.withLock(async () => {
      const messages = await this.read();
      await this.reclaimExpiredInMemory(messages);
      const message = messages.find(
        (candidate) => candidate.recipientAgentId === recipientAgentId && candidate.messageId === messageId
      );
      if (!message || message.state !== "ready") {
        await this.write(messages);
        return message;
      }
      message.state = "leased";
      message.lease = {
        consumerId,
        expiresAt: new Date(Date.now() + Math.max(1_000, leaseMs)).toISOString(),
        ...(owner ? { owner } : {})
      };
      await this.write(messages);
      return message;
    });
  }

  /** Wait owns the body until its tool result is saved, or its process exits. */
  async claimReadyCallbackForWait(
    callId: string,
    consumerId: string,
    owner?: ProcessIdentity
  ): Promise<InboxMessage | undefined> {
    return this.withLock(async () => {
      const messages = await this.read();
      await this.reclaimExpiredInMemory(messages);
      const message = messages.find(
        (candidate) =>
          candidate.recipientAgentId === "main" &&
          candidate.kind === "callback" &&
          candidate.callId === callId &&
          candidate.state === "ready"
      );
      if (!message) return undefined;
      message.state = "leased";
      message.lease = {
        consumerId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...(owner ? { owner } : {})
      };
      await this.write(messages);
      return message;
    });
  }

  /** A wait result that never reached durable Main context must be redelivered after a crash. */
  async recoverAbandonedWaitCallbacks(): Promise<void> {
    await this.withLock(async () => {
      const messages = await this.read();
      let changed = false;
      for (const message of messages) {
        if (message.state !== "leased" || !waitOwner(message) || (await waitOwnerIsAlive(message))) continue;
        message.state = "ready";
        message.lease = undefined;
        changed = true;
      }
      if (changed) await this.write(messages);
    });
  }

  /** Release an unsuccessful wait from this process; never release another live owner's work. */
  async releaseCurrentWaitCallbacks(consumerId?: string): Promise<void> {
    await this.withLock(async () => {
      const messages = await this.read();
      let changed = false;
      for (const message of messages) {
        if (
          message.state !== "leased" ||
          waitOwner(message) !== process.pid ||
          (consumerId !== undefined && message.lease?.consumerId !== consumerId)
        )
          continue;
        message.state = "ready";
        message.lease = undefined;
        changed = true;
      }
      if (changed) await this.write(messages);
    });
  }

  /** Promote only an unclaimed follow-up; leasing and promotion share the same lock. */
  async promoteUserMessage(messageId: string): Promise<InboxMessage | undefined> {
    return this.withLock(async () => {
      const messages = await this.read();
      const message = messages.find(
        (candidate) => candidate.messageId === messageId && candidate.recipientAgentId === "main"
      );
      const payload = message?.payload as { type?: string; delivery?: string } | undefined;
      if (!message || message.kind !== "human_command" || payload?.type !== "human.message") return undefined;
      if (payload.delivery === "steer") return message;
      if (message.state !== "ready" || payload.delivery !== "followUp") return undefined;
      payload.delivery = "steer";
      await this.write(messages);
      return message;
    });
  }

  /** Cancellation and delivery contend for the same ready message under the file lock. */
  async cancelUserMessage(messageId: string): Promise<boolean> {
    return this.withLock(async () => {
      const messages = await this.read();
      const message = messages.find(
        (item) => item.messageId === messageId && item.recipientAgentId === "main"
      );
      const payload = message?.payload as
        { type?: string; delivery?: string; cancelled?: boolean } | undefined;
      if (!message || message.kind !== "human_command" || payload?.type !== "human.message") return false;
      if (payload.cancelled) return true;
      if (message.state !== "ready" || payload.delivery !== "followUp") return false;
      payload.cancelled = true;
      message.state = "consumed";
      await this.write(messages);
      return true;
    });
  }

  async consume(messageId: string): Promise<InboxMessage> {
    return this.withLock(async () => {
      const messages = await this.read();
      const message = messages.find((candidate) => candidate.messageId === messageId);
      if (!message) throw new Error(`unknown inbox message: ${messageId}`);
      if (message.state === "consumed") return message;
      if (message.state !== "leased") throw new Error(`message is not leased: ${messageId}`);
      message.state = "consumed";
      message.lease = undefined;
      await this.write(messages);
      return message;
    });
  }

  /** Return a leased message to ready state after a retryable handler failure. */
  async release(messageId: string): Promise<InboxMessage> {
    return this.withLock(async () => {
      const messages = await this.read();
      const message = messages.find((candidate) => candidate.messageId === messageId);
      if (!message) throw new Error(`unknown inbox message: ${messageId}`);
      if (message.state === "consumed" || message.state === "ready") return message;
      message.state = "ready";
      message.lease = undefined;
      await this.write(messages);
      return message;
    });
  }

  async list(recipientAgentId?: string): Promise<InboxMessage[]> {
    return this.withLock(async () => {
      const messages = await this.read();
      return recipientAgentId
        ? messages.filter((message) => message.recipientAgentId === recipientAgentId)
        : messages;
    });
  }

  private async read(): Promise<InboxMessage[]> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as InboxMessage[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  private async write(messages: InboxMessage[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(messages, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      // The owner is this host's process: a Main that was killed between
      // taking the lock and releasing it must not stall the next reader for the
      // whole timeout. Recovery only reclaims an owner whose pid is gone.
      return await withFileLock(this.filePath, fn, { recoverDeadOwner: true });
    } finally {
      release();
    }
  }

  /** Returns whether an expired lease had to be reclaimed. */
  private async reclaimExpiredInMemory(messages: InboxMessage[]): Promise<boolean> {
    const at = Date.now();
    let changed = false;
    for (const message of messages) {
      if (message.state !== "leased" || !message.lease || Date.parse(message.lease.expiresAt) > at) continue;
      // A lease held by a live consumer is not late. The message may already be
      // queued in that process and still waiting for its context, and giving it
      // to that same consumer again would deliver it twice. This applies to
      // every message kind, not only the wait callbacks. A lease that recorded
      // the holder's OS start time is checked by identity, so a reused pid is
      // never mistaken for the process that took it.
      if (await consumerOwnerIsAlive(message.lease.consumerId, message.lease.owner)) continue;
      message.state = "ready";
      message.lease = undefined;
      changed = true;
    }
    return changed;
  }
}

/**
 * The process a consumer id names, for ids written as `<kind>-<pid>-<rest>`.
 *
 * Main's own consumers do not carry a pid and therefore keep the ordinary lease
 * expiry; a consumer that does carry one keeps its messages while it runs.
 */
function consumerOwnerPid(consumerId: string | undefined): number | undefined {
  const match = consumerId?.match(/^(?:wait|agent)-(\d+)-/);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

async function consumerOwnerIsAlive(
  consumerId: string | undefined,
  owner?: { pid: number; startedAt: string }
): Promise<boolean> {
  if (owner?.startedAt) return verifyProcessIdentity(owner);
  const pid = owner?.pid ?? consumerOwnerPid(consumerId);
  return pid !== undefined && processIsAlive(pid);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function waitOwner(message: InboxMessage): number | undefined {
  if (message.kind !== "callback") return;
  return consumerOwnerPid(message.lease?.consumerId);
}

async function waitOwnerIsAlive(message: InboxMessage): Promise<boolean> {
  if (message.lease?.owner?.startedAt) return verifyProcessIdentity(message.lease.owner);
  const pid = waitOwner(message);
  return pid !== undefined && processIsAlive(pid);
}
