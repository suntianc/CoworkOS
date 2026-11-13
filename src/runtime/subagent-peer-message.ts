import { join } from "node:path";
import { id, now, type Event } from "../domain/types.js";
import { JsonlEventStore } from "../storage/event-store.js";
import { DurableScheduler, InboxStore } from "./scheduler.js";

/**
 * One running Subagent's message to another, queued in the target's Inbox.
 *
 * The sender and target are read from this Run's durable queue, so a callId the
 * model names is only ever resolved to a call this Run actually owns. Delivery
 * is one-way and non-blocking: the message reaches the peer at its next safe
 * turn and the sender continues.
 */
export interface PeerMessageInput {
  taskId: string;
  runId: string;
  workspaceRoot: string;
  senderCallId: string;
  targetCallId: string;
  message: string;
  priority?: number;
}

export interface PeerMessageResult {
  messageId: string;
  senderCallId: string;
  targetCallId: string;
  senderAgentId: string;
  targetAgentId: string;
  status: "queued";
}

export async function sendPeerMessage(input: PeerMessageInput): Promise<PeerMessageResult> {
  const message = input.message.trim();
  if (!message) throw new Error("message must not be empty");
  if (message.length > 8_000) throw new Error("peer message must be at most 8000 characters");
  if (input.senderCallId === input.targetCallId)
    throw new Error("peer message target must be a different Subagent");
  const scheduler = new DurableScheduler(
    join(input.workspaceRoot, input.taskId, "runs", input.runId, "queue.json")
  );
  const items = await scheduler.list();
  const sender = items.find((candidate) => candidate.stepId === input.senderCallId);
  if (!sender) throw new Error(`unknown sender call: ${input.senderCallId}`);
  if (sender.status !== "leased") throw new Error(`sender call ${input.senderCallId} is not active`);
  const target = items.find((candidate) => candidate.stepId === input.targetCallId);
  if (!target) throw new Error(`unknown peer call: ${input.targetCallId}`);
  if (!["queued", "leased"].includes(target.status))
    throw new Error(`peer call ${input.targetCallId} is already ${target.status}`);
  const messageId = id("peer-message");
  const inbox = new InboxStore(
    join(
      input.workspaceRoot,
      input.taskId,
      "runs",
      input.runId,
      "agents",
      "subagents",
      target.agentId,
      "inbox-store.json"
    )
  );
  await inbox.enqueue({
    messageId,
    recipientAgentId: target.agentId,
    senderAgentId: sender.agentId,
    senderCallId: input.senderCallId,
    kind: "peer_message",
    callId: input.targetCallId,
    eventId: id("event"),
    priority: input.priority ?? 1,
    state: "ready",
    payload: {
      message,
      from: "subagent",
      senderAgentId: sender.agentId,
      senderCallId: input.senderCallId,
      targetAgentId: target.agentId,
      priority: input.priority ?? 1
    },
    createdAt: now()
  });
  const events = new JsonlEventStore(
    join(input.workspaceRoot, input.taskId, "runs", input.runId, "run_events.jsonl")
  );
  await events.append(
    event(input, input.targetCallId, "peer_message.queued", sender.agentId, {
      messageId,
      senderCallId: input.senderCallId,
      senderAgentId: sender.agentId,
      targetCallId: input.targetCallId,
      targetAgentId: target.agentId,
      priority: input.priority ?? 1
    })
  );
  return {
    messageId,
    senderCallId: input.senderCallId,
    targetCallId: input.targetCallId,
    senderAgentId: sender.agentId,
    targetAgentId: target.agentId,
    status: "queued"
  };
}

function event(
  input: Pick<PeerMessageInput, "taskId" | "runId">,
  callId: string,
  type: string,
  agentId: string,
  payload: unknown
): Event {
  return {
    eventId: id("event"),
    type,
    taskId: input.taskId,
    runId: input.runId,
    agentId,
    callId,
    occurredAt: now(),
    payload
  };
}
