import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { id, now, type Importance, type InboxMessage } from "../domain/types.js";
import { withFileLock } from "../storage/file-lock.js";

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
        .filter((item) => item.status === "queued" && (!stepId || item.stepId === stepId))
        .sort(
          (a, b) => priority[a.importance] - priority[b.importance] || a.createdAt.localeCompare(b.createdAt)
        )[0];
      if (!candidate) {
        await this.writeItems(items);
        return undefined;
      }
      const token = id("lease");
      candidate.status = "leased";
      candidate.attempts += 1;
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

  async fail(stepId: string, token: string, error: string): Promise<WorkItem> {
    return this.withLock(async () => {
      const items = await this.readItems();
      const item = items.find((candidate) => candidate.stepId === stepId);
      if (!item) throw new Error(`unknown step: ${stepId}`);
      if (item.status === "failed" || item.status === "completed" || item.status === "cancelled") return item;
      if (item.status !== "leased" || item.lease?.token !== token)
        throw new Error(`lease mismatch for step: ${stepId}`);
      item.error = error;
      item.lease = undefined;
      item.status = item.attempts < (item.maxAttempts ?? 1) ? "queued" : "failed";
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
      return await withFileLock(this.filePath, fn);
    } finally {
      release();
    }
  }
}

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
    leaseMs = 60_000,
    consumerId = `consumer-${process.pid}`
  ): Promise<InboxMessage | undefined> {
    return this.withLock(async () => {
      const messages = await this.read();
      this.reclaimExpiredInMemory(messages);
      const message = messages
        .filter((candidate) => candidate.recipientAgentId === recipientAgentId && candidate.state === "ready")
        .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))[0];
      if (!message) {
        await this.write(messages);
        return undefined;
      }
      message.state = "leased";
      message.lease = {
        consumerId,
        expiresAt: new Date(Date.now() + Math.max(1_000, leaseMs)).toISOString()
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
    leaseMs = 60_000,
    consumerId = `consumer-${process.pid}`
  ): Promise<InboxMessage | undefined> {
    return this.withLock(async () => {
      const messages = await this.read();
      this.reclaimExpiredInMemory(messages);
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
        expiresAt: new Date(Date.now() + Math.max(1_000, leaseMs)).toISOString()
      };
      await this.write(messages);
      return message;
    });
  }

  /** Wait owns the body until its tool result is saved, or its process exits. */
  async claimReadyCallbackForWait(callId: string, consumerId: string): Promise<InboxMessage | undefined> {
    return this.withLock(async () => {
      const messages = await this.read();
      this.reclaimExpiredInMemory(messages);
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
        expiresAt: new Date(Date.now() + 60_000).toISOString()
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
        if (message.state !== "leased" || !waitOwner(message) || waitOwnerIsAlive(message)) continue;
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
      return await withFileLock(this.filePath, fn);
    } finally {
      release();
    }
  }

  private reclaimExpiredInMemory(messages: InboxMessage[]): void {
    const at = Date.now();
    for (const message of messages) {
      if (message.state === "leased" && message.lease && Date.parse(message.lease.expiresAt) <= at) {
        // A long sibling tool can delay persistence/acknowledgement. Do not
        // give a live wait's body to another channel merely because time passed.
        if (waitOwner(message) && waitOwnerIsAlive(message)) continue;
        message.state = "ready";
        message.lease = undefined;
      }
    }
  }
}

function waitOwner(message: InboxMessage): number | undefined {
  if (message.kind !== "callback") return;
  const consumer = message.lease?.consumerId;
  if (typeof consumer !== "string") return;
  const match = consumer.match(/^wait-(\d+)-/);
  return match ? Number(match[1]) : undefined;
}

function waitOwnerIsAlive(message: InboxMessage): boolean {
  const pid = waitOwner(message);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
