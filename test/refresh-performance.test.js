import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoalescedRead } from "../web/assets/controllers/coalesced-read.js";
import { createConversationProjection } from "../web/assets/controllers/conversation-projection.js";
import { buildConversationExchanges } from "../web/assets/conversation.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("a slow read shares polling and queues one fresh read for explicit mutations", async () => {
  const gates = [deferred(), deferred()];
  const calls = [];
  const current = [];
  const read = createCoalescedRead(async (key, options) => {
    calls.push([key, options.poll]);
    current.push(options.isCurrent);
    await gates[calls.length - 1].promise;
  });
  const first = read("task", { poll: true });
  assert.equal(read("task", { poll: true }), first);
  assert.equal(read("task"), first);
  assert.equal(read("task"), first);
  assert.equal(calls.length, 1);
  assert.equal(current[0](), false, "the superseded response must not update the view");
  gates[0].resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, [
    ["task", true],
    ["task", false]
  ]);
  assert.equal(current[1](), true);
  gates[1].resolve();
  await first;
});

test("independent tasks can load while a stale task is pending and failures can retry", async () => {
  const gate = deferred();
  let fail = true;
  const seen = [];
  const read = createCoalescedRead(async (id) => {
    seen.push(id);
    if (id === "old") await gate.promise;
    if (id === "new" && fail) throw new Error("offline");
  });
  const old = read("old");
  await assert.rejects(read("new"), /offline/);
  fail = false;
  await read("new");
  assert.deepEqual(seen, ["old", "new", "new"]);
  gate.resolve();
  await old;
});

const user = (id) => ({ role: "user", id, timestamp: id, content: `request ${id}` });
const start = (message) => ({ type: "message_start", message });

test("stream deltas reuse historical groups; delivery, rewritten history and replay rebuild ownership", () => {
  const project = createConversationProjection();
  const messages = [user(1), { role: "assistant", timestamp: 2, content: "done" }, user(3)];
  const events = [start(messages[0]), { type: "main.run_completed" }, start(messages[2])];
  const first = project(messages, [], events);
  events.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "next" } });
  const delta = project(messages, [], events);
  assert.equal(delta, first, "append-only deltas retain the settled grouping");
  assert.equal(delta[0], first[0]);
  assert.deepEqual(delta, buildConversationExchanges(messages, events));
  const steering = { ...user(4), interjected: true };
  messages.push(steering);
  events.push(start(steering));
  const delivered = project(messages, [], events);
  assert.notEqual(delivered, delta);
  assert.deepEqual(delivered, buildConversationExchanges(messages, events));
  const replayed = events.slice();
  assert.notEqual(project(messages, [], replayed), delivered);
  messages[0] = { ...messages[0], content: "edited" };
  assert.deepEqual(project(messages, [], replayed), buildConversationExchanges(messages, replayed));
  assert.deepEqual(project([], [], []), []);
});

test("indexed matching retains first-unmatched order for repeated text and colliding timestamps", () => {
  const messages = [
    { role: "user", content: "same", timestamp: 1 },
    { role: "user", content: "same", timestamp: 1 },
    { role: "user", content: "same", timestamp: 2 }
  ];
  const events = messages.map((message, index) => ({ ...start(message), marker: index }));
  const exchanges = buildConversationExchanges(messages, events);
  assert.deepEqual(
    exchanges.map((entry) => entry.events[0].marker),
    [0, 1, 2]
  );
});
