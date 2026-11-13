import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentInboxDelivery, formatAgentInboxMessage } from "../dist/src/runtime/agent-inbox-delivery.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { JsonlEventStore } from "../dist/src/storage/event-store.js";

const TASK_ID = "p46-inbox-task";
const RUN_ID = "p46-inbox-run";
const AGENT_ID = "subagent_1";

/**
 * The durable read half of an agent Inbox.
 *
 * Delivery is observable where a process sees it: a message is handed over
 * once, stays leased until it reaches the session context, and leaves one
 * durable receipt when it is consumed.
 */

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "p46-inbox-delivery-"));
  const runRoot = join(root, TASK_ID, "runs", RUN_ID);
  const directory = join(runRoot, "agents", "subagents", AGENT_ID);
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    runRoot,
    directory,
    eventsPath: join(runRoot, "run_events.jsonl"),
    inbox: new InboxStore(join(directory, "inbox-store.json"))
  };
}

function delivery(f) {
  return new AgentInboxDelivery({
    directory: f.directory,
    taskId: TASK_ID,
    runId: RUN_ID,
    recipientAgentId: AGENT_ID,
    eventsPath: f.eventsPath
  });
}

async function enqueue(f, { messageId, kind, payload }) {
  await f.inbox.enqueue({
    messageId,
    recipientAgentId: AGENT_ID,
    kind,
    eventId: `event_${messageId}`,
    priority: 1,
    state: "ready",
    payload,
    createdAt: new Date().toISOString()
  });
}

function inContext(messageId) {
  return [
    {
      role: "custom",
      customType: "cowork-agent-message",
      content: "guidance",
      details: { _coworkInbox: { taskId: TASK_ID, runId: RUN_ID, messageId } }
    }
  ];
}

test("a message is delivered once and consumed only after it reaches the context", async (t) => {
  const f = await fixture(t);
  await enqueue(f, {
    messageId: "main-guidance",
    kind: "human_command",
    payload: { message: "Use the shared config flag.", from: "main" }
  });
  const inboxDelivery = delivery(f);
  const sent = [];
  const send = (message) => {
    sent.push(message.messageId);
    return "delivered";
  };

  await inboxDelivery.deliver(send);
  await inboxDelivery.deliver(send);
  assert.deepEqual(sent, ["main-guidance"], "a leased message is not handed over twice");
  assert.equal((await f.inbox.list(AGENT_ID))[0].state, "leased", "queuing is not acknowledgement");

  await inboxDelivery.acknowledge(inContext("main-guidance"));
  assert.equal((await f.inbox.list(AGENT_ID))[0].state, "consumed");
  assert.equal(inboxDelivery.queuedCount, 0);

  const receipts = (await new JsonlEventStore(f.eventsPath).list(RUN_ID)).filter(
    (event) => event.type === "inbox.consumed"
  );
  assert.equal(receipts.length, 1, "consumption is recorded once");
  assert.equal(receipts[0].agentId, AGENT_ID);
  assert.equal(receipts[0].payload.messageId, "main-guidance");

  await inboxDelivery.acknowledge(inContext("main-guidance"));
  assert.equal(
    (await new JsonlEventStore(f.eventsPath).list(RUN_ID)).filter((event) => event.type === "inbox.consumed")
      .length,
    1,
    "re-reading the same context does not duplicate the receipt"
  );
});

test("a message the process never read is handed to its next process instead of waiting out the lease", async (t) => {
  const f = await fixture(t);
  await enqueue(f, {
    messageId: "unread-guidance",
    kind: "human_command",
    payload: { message: "Read this before finishing.", from: "main" }
  });
  const first = delivery(f);
  await first.deliver(() => "delivered");
  assert.equal((await f.inbox.list(AGENT_ID))[0].state, "leased");

  await first.releaseUnconfirmed();
  assert.equal((await f.inbox.list(AGENT_ID))[0].state, "ready");

  const sent = [];
  const second = delivery(f);
  await second.deliver((message) => {
    sent.push(message.messageId);
    return "delivered";
  });
  assert.deepEqual(sent, ["unread-guidance"], "the next process reads it once");
  await second.acknowledge(inContext("unread-guidance"));
  assert.equal((await f.inbox.list(AGENT_ID))[0].state, "consumed");
});

test("an idle delivery attempt does not rewrite the Inbox", async (t) => {
  const f = await fixture(t);
  await enqueue(f, {
    messageId: "only-message",
    kind: "human_command",
    payload: { message: "Do the work.", from: "main" }
  });
  const storePath = join(f.directory, "inbox-store.json");
  const inboxDelivery = delivery(f);
  await inboxDelivery.deliver(() => "delivered");
  await inboxDelivery.acknowledge(inContext("only-message"));
  const before = await stat(storePath);

  await inboxDelivery.deliver(() => "delivered");
  const after = await stat(storePath);
  assert.equal(
    after.ino,
    before.ino,
    "a reader woken with nothing to do must not rewrite the file and wake itself"
  );
});

test("a message addressed to another Run is not consumed by this process", async (t) => {
  const f = await fixture(t);
  await enqueue(f, {
    messageId: "other-run-message",
    kind: "peer_message",
    payload: { message: "not mine", senderAgentId: "subagent_2", senderCallId: "call-2" }
  });
  const inboxDelivery = delivery(f);
  await inboxDelivery.acknowledge([
    {
      type: "custom_message",
      content: "guidance",
      details: { _coworkInbox: { taskId: TASK_ID, runId: "another-run", messageId: "other-run-message" } }
    }
  ]);
  assert.equal((await f.inbox.list(AGENT_ID))[0].state, "ready");
});

test("a message with no body is consumed without reaching the model", async (t) => {
  const f = await fixture(t);
  await enqueue(f, { messageId: "empty", kind: "human_command", payload: { from: "main" } });
  const inboxDelivery = delivery(f);
  await inboxDelivery.deliver((message) => {
    assert.equal(formatAgentInboxMessage(message), undefined);
    return "discard";
  });
  assert.equal((await f.inbox.list(AGENT_ID))[0].state, "consumed");
});

test("the delivered text names its sender and keeps the advice distinct from the user", async (t) => {
  const f = await fixture(t);
  const peer = {
    messageId: "peer",
    recipientAgentId: AGENT_ID,
    kind: "peer_message",
    senderAgentId: "subagent_2",
    senderCallId: "call-peer",
    eventId: "event_peer",
    priority: 1,
    state: "ready",
    payload: { message: "The column is nullable.", senderAgentId: "subagent_2", senderCallId: "call-peer" },
    createdAt: new Date().toISOString()
  };
  const main = { ...peer, messageId: "main", kind: "human_command", payload: { message: "Shift scope." } };
  const peerText = formatAgentInboxMessage(peer);
  assert.match(peerText, /\[Message from .+ \(call-peer\)\]\nThe column is nullable\./);
  assert.match(peerText, /Continue the assigned task/);
  assert.match(formatAgentInboxMessage(main), /\[Message from Main\]\nShift scope\./);
});
