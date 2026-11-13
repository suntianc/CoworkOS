import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Event, InboxMessage } from "../domain/types.js";
import { JsonlEventStore } from "../storage/event-store.js";
import { withFileLock } from "../storage/file-lock.js";
import { agentDisplayName } from "./agent-identity.js";
import { readProcessIdentity, type ProcessIdentity } from "./process-identity.js";
import { INBOX_MESSAGE_LEASE_MS, InboxStore } from "./scheduler.js";

/**
 * The read half of an Agent's durable Inbox, shared by Main and delegated
 * processes.
 *
 * Everything an external producer sends a running process — Main's guidance,
 * a peer's message, a callback — is written to that process's Inbox first. The
 * process reads it from there at a safe turn boundary, so delivery does not
 * depend on the sender or the backend still being alive, and a restart before
 * the read loses nothing.
 *
 * Queuing is not acknowledgement: the message stays leased until it appears in
 * this process's saved context. A crash in between redelivers it rather than
 * dropping it, and a read records one durable `inbox.consumed` receipt.
 */

/** Where a process's Inbox lives and who it reads for. */
export interface AgentInboxDeliveryInput {
  /** The agent's own directory inside the Run, e.g. `…/agents/subagents/<id>`. */
  directory: string;
  taskId: string;
  runId: string;
  /** The Inbox recipient identity; a process only reads its own messages. */
  recipientAgentId: string;
  /** The Run event log that records consumption. */
  eventsPath: string;
}

/** `discard` records a message with nothing to deliver as consumed. */
export type AgentInboxSendResult = "delivered" | "discard";

export type AgentInboxSend = (message: InboxMessage) => AgentInboxSendResult | Promise<AgentInboxSendResult>;

interface ContextMessage {
  role?: string;
  type?: string;
  message?: ContextMessage;
  details?: { _coworkInbox?: InboxIdentity };
}

interface InboxIdentity {
  taskId?: string;
  runId?: string;
  messageId?: string;
}

export class AgentInboxDelivery {
  private readonly inbox: InboxStore;
  private readonly events: JsonlEventStore;
  private readonly receiptLock: string;
  private readonly consumerId: string;
  private readonly queued = new Set<string>();
  private readonly recorded = new Set<string>();
  private identity?: Promise<ProcessIdentity | undefined>;
  private delivery = Promise.resolve();

  constructor(private readonly input: AgentInboxDeliveryInput) {
    this.inbox = new InboxStore(join(input.directory, "inbox-store.json"));
    this.events = new JsonlEventStore(input.eventsPath);
    this.receiptLock = join(input.directory, ".inbox-consumed");
    // The pid lets the Inbox keep this process's unread messages across a lease
    // expiry while it is still running.
    this.consumerId = `agent-${process.pid}-${randomUUID()}`;
  }

  /**
   * This process's own OS identity.
   *
   * A lease records it so a later reader can tell this consumer from an
   * unrelated process that inherited its pid. Read once; a host without `ps`
   * falls back to the pid check.
   */
  private ownerIdentity(): Promise<ProcessIdentity | undefined> {
    this.identity ??= readProcessIdentity(process.pid)
      // eslint-disable-next-line no-restricted-syntax -- 无法读取本机进程启动时间时退回 pid 判断，租约仍然可用
      .catch(() => undefined);
    return this.identity;
  }

  /** How many messages this process has queued but not yet confirmed. */
  get queuedCount(): number {
    return this.queued.size;
  }

  /**
   * Hand every ready message to `send` once, in priority order.
   *
   * A message stays leased to this process until `acknowledge` sees it in the
   * saved context, so a second call does not resend it. A failed send releases
   * the lease and is retried by the next call or after lease expiry.
   */
  deliver(send: AgentInboxSend): Promise<void> {
    const delivery = this.delivery.then(async () => {
      const owner = await this.ownerIdentity();
      for (;;) {
        const message = await this.inbox.lease(
          this.input.recipientAgentId,
          INBOX_MESSAGE_LEASE_MS,
          this.consumerId,
          owner
        );
        if (!message) return;
        // Already handed to this session and waiting for the context that
        // confirms it. Sending it again would show the model the same guidance
        // twice, whether this process re-leased it or another consumer released
        // it back to ready.
        if (this.queued.has(message.messageId)) continue;
        this.queued.add(message.messageId);
        try {
          if ((await send(message)) !== "discard") continue;
          await this.consume(message, "discard");
        } catch (error) {
          // A send that failed leaves the message ready for the next call; it
          // must not stay leased to a delivery that never reached the session.
          this.queued.delete(message.messageId);
          await this.inbox.release(message.messageId);
          throw error;
        }
      }
    });
    // eslint-disable-next-line no-restricted-syntax -- 上一次投递的拒绝已经由返回的 delivery 交给调用方，串行链只需保持可继续排队
    this.delivery = delivery.catch(() => {});
    return delivery;
  }

  /**
   * Record as consumed every message that has reached this session's context.
   *
   * `context` is the process's own saved messages: a queued message is not
   * consumed merely because it was sent, only once the session carries it, so
   * a process that dies before its next request does not lose it.
   */
  async acknowledge(context: readonly unknown[]): Promise<void> {
    const seen = this.identitiesIn(context);
    if (seen.size === 0) return;
    for (const message of await this.inbox.list(this.input.recipientAgentId)) {
      if (!seen.has(message.messageId)) continue;
      let current: InboxMessage | undefined = message;
      if (current.state === "ready")
        current = await this.inbox.leaseMessage(
          this.input.recipientAgentId,
          current.messageId,
          INBOX_MESSAGE_LEASE_MS,
          this.consumerId,
          await this.ownerIdentity()
        );
      if (!current) continue;
      if (current.state === "leased" && current.lease?.consumerId === this.consumerId)
        current = await this.inbox.consume(current.messageId);
      if (current.state !== "consumed") continue;
      try {
        await this.recordConsumed(current);
      } finally {
        this.queued.delete(current.messageId);
      }
    }
  }

  /**
   * Return messages this process queued but never confirmed.
   *
   * A process can end between queueing a message and reading it. Releasing
   * those leases makes the message readable now instead of after the lease
   * expires, and the next process for this agent still reads it exactly once.
   */
  async releaseUnconfirmed(): Promise<void> {
    if (this.queued.size === 0) return;
    // Let an in-flight hand-over finish first; releasing a message whose send
    // is still running would make the next process read it a second time.
    await this.delivery;
    for (const message of await this.inbox.list(this.input.recipientAgentId)) {
      if (!this.queued.has(message.messageId)) continue;
      if (message.state !== "leased" || message.lease?.consumerId !== this.consumerId) continue;
      await this.inbox.release(message.messageId);
      this.queued.delete(message.messageId);
    }
  }

  private identitiesIn(context: readonly unknown[]): Set<string> {
    const ids = new Set<string>();
    for (const value of context) {
      if (!value || typeof value !== "object") continue;
      const entry = value as ContextMessage;
      const message = entry.type === "message" && entry.message ? entry.message : entry;
      if (message.role !== "custom" && entry.type !== "custom_message") continue;
      const identity = message.details?._coworkInbox;
      if (
        identity?.taskId !== this.input.taskId ||
        identity.runId !== this.input.runId ||
        typeof identity.messageId !== "string"
      )
        continue;
      ids.add(identity.messageId);
    }
    return ids;
  }

  private async consume(message: InboxMessage, delivery: "discard"): Promise<void> {
    if (message.state !== "consumed") await this.inbox.consume(message.messageId);
    await this.recordConsumed(message, delivery);
    this.queued.delete(message.messageId);
  }

  /**
   * Persist the consumption position.
   *
   * The Inbox state says the message is gone; the event says when and for whom,
   * so diagnostics and a later reader do not have to infer it. The receipt lock
   * makes the check-and-append idempotent across a restart or a repeated read.
   */
  private async recordConsumed(message: InboxMessage, delivery?: "discard"): Promise<void> {
    if (this.recorded.has(message.messageId)) return;
    await withFileLock(
      this.receiptLock,
      async () => {
        const events = await this.events.list(this.input.runId);
        if (
          events.some(
            (event) =>
              event.type === "inbox.consumed" &&
              event.agentId === this.input.recipientAgentId &&
              (event.payload as { messageId?: string } | undefined)?.messageId === message.messageId
          )
        )
          return;
        const event: Event = {
          eventId: `event_inbox_consumed_${message.messageId}`,
          type: "inbox.consumed",
          taskId: this.input.taskId,
          runId: this.input.runId,
          agentId: this.input.recipientAgentId,
          ...(message.callId ? { callId: message.callId } : {}),
          occurredAt: new Date().toISOString(),
          payload: {
            messageId: message.messageId,
            kind: message.kind,
            recipientAgentId: this.input.recipientAgentId,
            ...(delivery ? { delivery } : {})
          }
        };
        await this.events.append(event);
      },
      { recoverDeadOwner: true }
    );
    this.recorded.add(message.messageId);
  }
}

/**
 * The text a delegated process reads for a queued message.
 *
 * Main's guidance and a peer's message are both plain advice from another
 * agent, so they are labelled by sender and never mistake themselves for the
 * user speaking. A message with no body has nothing to say and is discarded.
 */
export function formatAgentInboxMessage(message: InboxMessage): string | undefined {
  const payload =
    message.payload && typeof message.payload === "object"
      ? (message.payload as Record<string, unknown>)
      : {};
  const text = typeof payload.message === "string" ? payload.message.trim() : "";
  if (!text) return undefined;
  const peer = message.kind === "peer_message";
  const senderName =
    peer && typeof payload.senderAgentId === "string" ? agentDisplayName(payload.senderAgentId) : "Main";
  const senderLabel =
    peer && typeof payload.senderCallId === "string" ? `${senderName} (${payload.senderCallId})` : senderName;
  return `[Message from ${senderLabel}]\n${text}\n\nContinue the assigned task with this guidance. Acknowledge or incorporate it in your next response when relevant.`;
}
