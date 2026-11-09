import { createHash } from "node:crypto";
import { join } from "node:path";
import { id, now, type Event, type InboxMessage } from "../domain/types.js";
import { JsonlEventStore } from "../storage/event-store.js";
import { InboxStore } from "./scheduler.js";

/** A normalized event emitted by a timer, file/log watcher, webhook, or plugin. */
export interface WatcherEvent {
  watcherId: string;
  source: string;
  type: string;
  /** Stable within a watcher. Reusing it makes ingestion idempotent. */
  dedupeKey: string;
  payload: unknown;
  occurredAt?: string;
  priority?: number;
}

export interface WatcherPoller {
  watcherId: string;
  poll: () => Promise<WatcherEvent[]>;
  acknowledge?: (events: WatcherEvent[]) => Promise<void>;
}

export interface WatcherRuntimeInput {
  workspaceRoot: string;
  taskId: string;
  runId: string;
  /** Optional product-level Watch Program projection to mirror accepted events into. */
  programId?: string;
  recipientAgentId?: string;
}

export interface WatcherIngestResult {
  accepted: boolean;
  duplicate: boolean;
  messageId: string;
  eventId: string;
}

export interface WatcherPollResult {
  accepted: number;
  duplicates: number;
  failed?: string;
  results: WatcherIngestResult[];
}

/**
 * Durable boundary between external events and the Main inbox.
 *
 * Watchers never call the model directly. They normalize an observation,
 * append one event to the run log, and enqueue an idempotent Inbox message.
 * A future supervisor can consume that message and wake/resume Main.
 */
export class WatcherRuntime {
  private readonly recipientAgentId: string;

  constructor(private readonly input: WatcherRuntimeInput) {
    this.recipientAgentId = input.recipientAgentId ?? "main";
  }

  async ingest(observation: WatcherEvent): Promise<WatcherIngestResult> {
    validateObservation(observation);
    const stableKey = `${observation.watcherId}\u0000${observation.dedupeKey}`;
    const digest = createHash("sha256").update(stableKey).digest("hex").slice(0, 32);
    const messageId = `external-${digest}`;
    const eventId = `watcher-event-${digest}`;
    const inbox = new InboxStore(
      join(
        this.input.workspaceRoot,
        this.input.taskId,
        "runs",
        this.input.runId,
        "agents",
        this.recipientAgentId,
        "inbox-store.json"
      )
    );
    const existing = (await inbox.list(this.recipientAgentId)).find(
      (message) => message.messageId === messageId
    );
    if (existing) return { accepted: false, duplicate: true, messageId, eventId };

    const event: Event = {
      eventId,
      type: "watcher.event_received",
      taskId: this.input.taskId,
      runId: this.input.runId,
      agentId: this.recipientAgentId,
      occurredAt: observation.occurredAt ?? now(),
      payload: {
        watcherId: observation.watcherId,
        source: observation.source,
        type: observation.type,
        dedupeKey: observation.dedupeKey,
        payload: observation.payload
      }
    };
    await new JsonlEventStore(
      join(this.input.workspaceRoot, this.input.taskId, "runs", this.input.runId, "run_events.jsonl")
    ).append(event);
    if (this.input.programId) {
      await new JsonlEventStore(
        join(
          this.input.workspaceRoot,
          this.input.taskId,
          "watch",
          "programs",
          this.input.programId,
          "events",
          "events.jsonl"
        )
      ).append({
        ...event,
        type: "watch.program_event_received",
        payload: {
          monitorId: observation.watcherId,
          ...(event.payload && typeof event.payload === "object" ? event.payload : { value: event.payload })
        }
      });
    }
    const message: InboxMessage = {
      messageId,
      recipientAgentId: this.recipientAgentId,
      kind: "external_event",
      eventId,
      priority: observation.priority ?? 0,
      state: "ready",
      payload: event.payload,
      createdAt: event.occurredAt
    };
    const queued = await inbox.enqueue(message);
    return {
      accepted: queued.messageId === messageId && queued.state === "ready",
      duplicate: queued !== message,
      messageId,
      eventId
    };
  }

  async poll(poller: WatcherPoller): Promise<WatcherPollResult> {
    try {
      const observations = await poller.poll();
      const results = [] as WatcherIngestResult[];
      for (const observation of observations)
        results.push(
          await this.ingest({ ...observation, watcherId: observation.watcherId || poller.watcherId })
        );
      await poller.acknowledge?.(observations);
      return {
        accepted: results.filter((result) => result.accepted).length,
        duplicates: results.filter((result) => result.duplicate).length,
        results
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.appendWatcherFailure(poller.watcherId, message);
      return { accepted: 0, duplicates: 0, failed: message, results: [] };
    }
  }

  private async appendWatcherFailure(watcherId: string, error: string): Promise<void> {
    await new JsonlEventStore(
      join(this.input.workspaceRoot, this.input.taskId, "runs", this.input.runId, "run_events.jsonl")
    ).append({
      eventId: id("watcher-error"),
      type: "watcher.failed",
      taskId: this.input.taskId,
      runId: this.input.runId,
      agentId: this.recipientAgentId,
      occurredAt: now(),
      payload: { watcherId, error }
    });
  }
}

export function validateObservation(observation: WatcherEvent): void {
  if (observation.occurredAt !== undefined && !Number.isFinite(Date.parse(observation.occurredAt)))
    throw new Error("watcher occurredAt must be a valid timestamp");
  if (observation.priority !== undefined && !Number.isFinite(observation.priority))
    throw new Error("watcher priority must be finite");
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- payload 是 unknown，为 undefined 时 JSON.stringify 返回 undefined，必须先回退成 "null" 才能算字节数
  if (Buffer.byteLength(JSON.stringify(observation.payload) ?? "null") > 65_536)
    throw new Error("watcher evidence exceeds 64 KiB");
  for (const [name, value] of Object.entries({
    watcherId: observation.watcherId,
    source: observation.source,
    type: observation.type,
    dedupeKey: observation.dedupeKey
  })) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 512)
      throw new Error(`watcher ${name} must be a non-empty string <= 512 characters`);
  }
}
