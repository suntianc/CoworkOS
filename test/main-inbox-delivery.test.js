import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { MainInboxDelivery } from "../dist/src/runtime/main-inbox-delivery.js";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { DurableScheduler, InboxStore } from "../dist/src/runtime/scheduler.js";
import { HumanRequestStore } from "../dist/src/runtime/human.js";
import { readSleep, writeSleep } from "../dist/src/runtime/main-sleep.js";
import { JsonlEventStore } from "../dist/src/storage/event-store.js";
import { messagesWithRuntimeHistory } from "../dist/src/runtime/conversation-history.js";
import { withFileLock } from "../dist/src/storage/file-lock.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-main-inbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await new LocalWorkspaceStore(root).createRun("task", "run");
  const path = join(root, "task", "runs", "run", "agents", "main", "inbox-store.json");
  const inbox = new InboxStore(path);
  await inbox.enqueue({
    messageId: "callback-one",
    recipientAgentId: "main",
    callId: "one",
    kind: "callback",
    eventId: "e1",
    priority: 1,
    state: "ready",
    payload: { callId: "one", response: "verified evidence" },
    createdAt: new Date().toISOString()
  });
  return { root, path, inbox, bridge: new MainInboxDelivery(root, "task", "run") };
}

async function completeFixtureCall(root) {
  const scheduler = new DurableScheduler(join(root, "task", "runs", "run", "queue.json"));
  await scheduler.enqueue({
    stepId: "one",
    taskId: "task",
    runId: "run",
    agentId: "subagent-one",
    importance: "normal",
    payload: { task: "inspect" }
  });
  const leased = await scheduler.claim("worker");
  await scheduler.complete("one", leased.lease.token);
}

function waitToolResult(result, isError = false) {
  return {
    role: "toolResult",
    toolName: "wait_for_subagents",
    isError,
    details: { _coworkInboxMessages: result.claimedCallbacks }
  };
}

test("wait consumes a ready callback and delivery cannot inject it again", async (t) => {
  const { root, inbox, bridge } = await fixture(t);
  await completeFixtureCall(root);
  const result = await new CoordinatorRuntime().waitForSubagents({
    taskId: "task",
    runId: "run",
    workspaceRoot: root,
    timeoutMs: 0,
    waitForCallbackConsumption: false,
    consumeCompletedCallbacks: true
  });
  assert.equal(result.calls[0].response, "verified evidence");
  assert.deepEqual(result.callbackPending, []);
  await bridge.deliver(() => assert.fail("wait already returned this callback"));
  assert.equal((await inbox.list("main"))[0].state, "leased", "do not acknowledge unsaved tool output");
  await bridge.acknowledge([waitToolResult(result)]);
  assert.equal((await inbox.list("main"))[0].state, "consumed");
  const receipts = await new JsonlEventStore(join(root, "task", "runs", "run", "run_events.jsonl")).list(
    "run"
  );
  assert.equal(receipts.filter((event) => event.type === "callback.consumed").length, 1);
  assert.equal(receipts.find((event) => event.type === "callback.consumed").payload.delivery, "wait");
});

test("wait does not return a callback already leased for Main delivery", async (t) => {
  const { root, inbox, bridge } = await fixture(t);
  await completeFixtureCall(root);
  let delivered;
  await bridge.deliver((message) => {
    delivered = message;
  });
  const result = await new CoordinatorRuntime().waitForSubagents({
    taskId: "task",
    runId: "run",
    workspaceRoot: root,
    timeoutMs: 0,
    waitForCallbackConsumption: false,
    consumeCompletedCallbacks: true
  });
  assert.equal(result.calls[0].response, undefined);
  assert.deepEqual(result.callbackPending, ["one"]);
  await bridge.acknowledge([{ role: "custom", ...delivered }]);
  assert.equal((await inbox.list("main"))[0].state, "consumed");
});

test("wait leaves a callback queued in Pi alone after its delivery lease expires", async (t) => {
  const { root, path, inbox, bridge } = await fixture(t);
  await completeFixtureCall(root);
  let delivered;
  await bridge.deliver((message) => {
    delivered = message;
  });
  assert.equal(bridge.isQueued("callback-one"), true);
  const messages = JSON.parse(await readFile(path, "utf8"));
  messages[0].lease.expiresAt = new Date(0).toISOString();
  await writeFile(path, JSON.stringify(messages));
  const result = await new CoordinatorRuntime().waitForSubagents({
    taskId: "task",
    runId: "run",
    workspaceRoot: root,
    timeoutMs: 0,
    waitForCallbackConsumption: false,
    consumeCompletedCallbacks: true,
    isCallbackQueued: (messageId) => bridge.isQueued(messageId)
  });
  assert.equal(result.calls[0].response, undefined);
  assert.deepEqual(result.callbackPending, ["one"]);
  assert.deepEqual(result.claimedCallbacks, []);
  await bridge.acknowledge([{ role: "custom", ...delivered }]);
  assert.equal((await inbox.list("main"))[0].state, "consumed");
});

test("a process exit before the wait result is saved leaves its callback recoverable", async (t) => {
  const { root, inbox } = await fixture(t);
  await completeFixtureCall(root);
  const module = new URL("../dist/src/runtime/coordinator-runtime.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const { CoordinatorRuntime } = await import(${JSON.stringify(module)});
    await new CoordinatorRuntime().waitForSubagents({
      taskId: "task", runId: "run", workspaceRoot: ${JSON.stringify(root)},
      timeoutMs: 0, waitForCallbackConsumption: false, consumeCompletedCallbacks: true
    });
    // Exit before Pi records or acknowledges the tool result.
  `
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  const recovered = new MainInboxDelivery(root, "task", "run");
  const messages = [];
  await recovered.deliver((message) => {
    messages.push(message);
  });
  assert.equal(messages.length, 1, "unsaved wait evidence must be delivered after restart");
  assert.match(messages[0].content, /verified evidence/);
  await recovered.acknowledge([{ role: "custom", ...messages[0] }]);
  assert.equal((await inbox.list("main"))[0].state, "consumed");
});

test("concurrent wait and delivery give the callback body to one channel", async (t) => {
  const { root, inbox, bridge } = await fixture(t);
  await completeFixtureCall(root);
  const delivered = [];
  const [result] = await Promise.all([
    new CoordinatorRuntime().waitForSubagents({
      taskId: "task",
      runId: "run",
      workspaceRoot: root,
      timeoutMs: 0,
      waitForCallbackConsumption: false,
      consumeCompletedCallbacks: true
    }),
    bridge.deliver((message) => {
      delivered.push(message);
    })
  ]);
  assert.equal(Number(Boolean(result.calls[0].response)) + delivered.length, 1);
  if (delivered.length) await bridge.acknowledge([{ role: "custom", ...delivered[0] }]);
  else await bridge.acknowledge([waitToolResult(result)]);
  assert.equal((await inbox.list("main"))[0].state, "consumed");
});

test("a saved wait result is acknowledged from restored entries without redelivery, including across runs", async (t) => {
  const { root, inbox } = await fixture(t);
  await completeFixtureCall(root);
  const result = await new CoordinatorRuntime().waitForSubagents({
    taskId: "task",
    runId: "run",
    workspaceRoot: root,
    timeoutMs: 0,
    waitForCallbackConsumption: false,
    consumeCompletedCallbacks: true
  });
  const restored = new MainInboxDelivery(root, "task", "later-run");
  await restored.acknowledge([{ type: "message", message: waitToolResult(result) }]);
  const original = new MainInboxDelivery(root, "task", "run");
  await original.deliver(() => assert.fail("saved wait evidence must not be injected again"));
  assert.equal((await inbox.list("main"))[0].state, "consumed");
});

test("an expired wait lease cannot duplicate evidence while its process is still active", async (t) => {
  const { root, path, inbox, bridge } = await fixture(t);
  await completeFixtureCall(root);
  const result = await new CoordinatorRuntime().waitForSubagents({
    taskId: "task",
    runId: "run",
    workspaceRoot: root,
    timeoutMs: 0,
    waitForCallbackConsumption: false,
    consumeCompletedCallbacks: true
  });
  const messages = await inbox.list("main");
  messages[0].lease.expiresAt = new Date(0).toISOString();
  await writeFile(path, JSON.stringify(messages));
  await bridge.deliver(() => assert.fail("a long sibling tool must not duplicate this wait result"));
  const status = await new CoordinatorRuntime().waitForSubagents({
    taskId: "task",
    runId: "run",
    workspaceRoot: root,
    timeoutMs: 0
  });
  assert.deepEqual(
    status.callbackPending,
    ["one"],
    "status remains read-only until saved evidence is acknowledged"
  );
  assert.equal((await inbox.list("main"))[0].state, "leased");
  await bridge.settle([{ type: "message", message: waitToolResult(result) }]);
  assert.equal((await inbox.list("main"))[0].state, "consumed");
});

test("settlement releases a failed wait result without consuming its callback", async (t) => {
  const { root, inbox, bridge } = await fixture(t);
  await completeFixtureCall(root);
  const result = await new CoordinatorRuntime().waitForSubagents({
    taskId: "task",
    runId: "run",
    workspaceRoot: root,
    timeoutMs: 0,
    waitForCallbackConsumption: false,
    consumeCompletedCallbacks: true
  });
  await bridge.settle([waitToolResult(result, true)]);
  assert.equal((await inbox.list("main"))[0].state, "ready");
  const delivered = [];
  await bridge.deliver((message) => {
    delivered.push(message);
  });
  assert.equal(delivered.length, 1);
  await bridge.acknowledge([{ role: "custom", ...delivered[0] }]);
  assert.equal((await inbox.list("main"))[0].state, "consumed");
});

test("legacy expired callback leases without a consumer identity remain recoverable", async (t) => {
  const { path, inbox, bridge } = await fixture(t);
  const messages = await inbox.list("main");
  messages[0].state = "leased";
  messages[0].lease = { expiresAt: new Date(0).toISOString() };
  await writeFile(path, JSON.stringify(messages));
  const delivered = [];
  await bridge.deliver((message) => {
    delivered.push(message);
  });
  assert.equal(delivered.length, 1);
  await bridge.acknowledge([{ role: "custom", ...delivered[0] }]);
  assert.equal((await inbox.list("main"))[0].state, "consumed");
});

test("wait wakes a parked Main but acknowledgement preserves a later standing wake", async (t) => {
  const { root, bridge } = await fixture(t);
  await completeFixtureCall(root);
  const park = {
    runId: "run",
    reason: "wait for new evidence",
    wakeAt: new Date(Date.now() + 60_000).toISOString(),
    parkedAt: new Date().toISOString()
  };
  await writeSleep(root, "task", park);
  const result = await new CoordinatorRuntime().waitForSubagents({
    taskId: "task",
    runId: "run",
    workspaceRoot: root,
    timeoutMs: 0,
    waitForCallbackConsumption: false,
    consumeCompletedCallbacks: true
  });
  assert.equal(await readSleep(root, "task"), undefined, "wait evidence is also a Main wake");
  await writeSleep(root, "task", { ...park, reason: "a new condition after receiving evidence" });
  await bridge.acknowledge([waitToolResult(result)]);
  assert.equal((await readSleep(root, "task")).reason, "a new condition after receiving evidence");
});

test("a waiting question gets its answer only through the tool while callbacks still arrive", async (t) => {
  const { root, inbox, bridge } = await fixture(t);
  const human = new HumanRequestStore(root);
  const release = bridge.holdHumanAnswers();
  t.after(release);
  const request = await human.create({ taskId: "task", runId: "run", question: "报告格式？" });
  await human.submitAnswer("task", request.requestId, "Markdown");
  const sent = [];
  await bridge.deliver((message) => {
    sent.push(message);
  });
  assert.deepEqual(
    sent.map((message) => message.customType),
    ["cowork-callback"]
  );
  assert.equal(
    (await inbox.list("main")).find((message) => message.messageId.startsWith("human-answer-")).state,
    "ready"
  );
  await human.consumeAnswerMessage("task", request.requestId);
  release();
  release();
  await bridge.deliver((message) => {
    sent.push(message);
  });
  assert.equal(sent.length, 1, "the tool already delivered this decision, so it must not also steer Main");

  // A late answer after the question stopped waiting must remain deliverable.
  const late = await human.create({ taskId: "task", runId: "run", question: "语言？" });
  await human.markUnanswered("task", late.requestId);
  await human.submitAnswer("task", late.requestId, "中文");
  await bridge.deliver((message) => {
    sent.push(message);
  });
  assert.equal(sent[1].customType, "cowork-human-answer");
});

test("callback is pending until it reaches Main context, with no replay during slow tools", async (t) => {
  const { root, path, inbox, bridge } = await fixture(t);
  const sent = [];
  const send = (message, options) => {
    sent.push({ message, options });
  };
  await Promise.all([bridge.deliver(send), bridge.deliver(send)]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options.deliverAs, "steer");
  assert.equal(bridge.queuedCount, 1);
  assert.equal((await inbox.list("main"))[0].state, "leased");
  const coordinator = new CoordinatorRuntime();
  const pending = await coordinator.waitForSubagents({
    taskId: "task",
    runId: "run",
    workspaceRoot: root,
    timeoutMs: 0
  });
  assert.deepEqual(
    pending.callbackPending,
    ["one"],
    "callbacks count even when old queue entries are absent"
  );
  assert.equal(pending.timedOut, true);
  const queued = await coordinator.waitForSubagents({
    taskId: "task",
    runId: "run",
    workspaceRoot: root,
    timeoutMs: 5000,
    waitForCallbackConsumption: false
  });
  assert.equal(queued.timedOut, false, "a wait tool must return before Main can read queued callbacks");
  const messages = JSON.parse(await readFile(path, "utf8"));
  messages[0].lease.expiresAt = "2000-01-01T00:00:00.000Z";
  await writeFile(path, JSON.stringify(messages));
  await bridge.deliver(send);
  assert.equal(sent.length, 1, "an expired lease must not enqueue the same callback twice in a live session");
  await bridge.acknowledge([{ role: "custom", ...sent[0].message }]);
  await bridge.acknowledge([{ role: "custom", ...sent[0].message }]);
  assert.equal((await inbox.list("main"))[0].state, "consumed");
  assert.equal(bridge.queuedCount, 0);
  assert.deepEqual(
    (await coordinator.waitForSubagents({ taskId: "task", runId: "run", workspaceRoot: root, timeoutMs: 0 }))
      .callbackPending,
    []
  );
  const events = (await readFile(join(root, "task", "runs", "run", "run_events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(events.filter((event) => event.type === "callback.consumed").length, 1);
});

test("restored Pi history acknowledges persisted callbacks without sending them again", async (t) => {
  const { root, inbox, bridge } = await fixture(t);
  let delivered;
  await bridge.deliver((message) => {
    delivered = message;
  });
  const restored = new MainInboxDelivery(root, "task", "run");
  await restored.acknowledge([{ type: "custom_message", ...delivered }]);
  await restored.deliver(() => assert.fail("persisted callback must not be replayed"));
  assert.equal((await inbox.list("main"))[0].state, "consumed");
});

test("a consumed follow-up recovers its failed receipt once without replaying the input", async (t) => {
  const { root, inbox, bridge } = await fixture(t);
  const messageId = "receipt-recovery";
  await inbox.enqueue({
    messageId,
    recipientAgentId: "main",
    kind: "human_command",
    eventId: messageId,
    priority: 120,
    state: "ready",
    createdAt: new Date().toISOString(),
    payload: { type: "human.message", message: "process this once", delivery: "followUp" }
  });
  const eventPath = join(root, "task", "runs", "run", "run_events.jsonl");
  const events = new JsonlEventStore(eventPath);
  await events.append({
    eventId: "queued-input",
    type: "user.interjected",
    taskId: "task",
    runId: "run",
    agentId: "main",
    occurredAt: new Date().toISOString(),
    payload: { messageId, message: "process this once", delivery: "followUp" }
  });
  let delivered;
  await bridge.deliver((message) => {
    if (message.details._coworkInbox.messageId === messageId) delivered = message;
  });
  const context = [{ type: "custom_message", ...delivered }];

  // The input is durable in Pi's context. Fail the separate event write after
  // Inbox consumption, as a disk error or exit between the two writes would.
  await rename(eventPath, `${eventPath}.held`);
  await mkdir(eventPath);
  await assert.rejects(bridge.acknowledge(context), { code: "EISDIR" });
  assert.equal((await inbox.list()).find((message) => message.messageId === messageId).state, "consumed");
  await rm(eventPath, { recursive: true });
  await rename(`${eventPath}.held`, eventPath);

  const restored = new MainInboxDelivery(root, "task", "run");
  const concurrent = new MainInboxDelivery(root, "task", "run");
  await Promise.all([
    bridge.acknowledge(context),
    restored.acknowledge(context),
    concurrent.acknowledge(context)
  ]);
  await restored.acknowledge(context);
  await restored.deliver((message) => {
    assert.notEqual(message.details._coworkInbox.messageId, messageId, "consumed input must not be resent");
  });
  const ledger = await events.list("run");
  assert.equal(
    ledger.filter((event) => event.type === "inbox.consumed" && event.payload.messageId === messageId).length,
    1,
    "concurrent recovery must produce exactly one durable receipt"
  );
  const conversation = messagesWithRuntimeHistory([], ledger);
  assert.equal(conversation.find((message) => message.id === messageId).pending, false);
});

test("restored contexts retain a legacy callback receipt without duplicating it", async (t) => {
  const { root, inbox, bridge } = await fixture(t);
  let delivered;
  await bridge.deliver((message) => {
    delivered = message;
  });
  await inbox.consume("callback-one");
  const events = new JsonlEventStore(join(root, "task", "runs", "run", "run_events.jsonl"));
  await events.append({
    eventId: "legacy-random-receipt",
    type: "callback.consumed",
    taskId: "task",
    runId: "run",
    agentId: "main",
    callId: "one",
    occurredAt: new Date().toISOString(),
    payload: { messageId: "callback-one", kind: "callback" }
  });
  const restored = new MainInboxDelivery(root, "task", "run");
  const context = [{ type: "custom_message", ...delivered }];
  await Promise.all([bridge.acknowledge(context), restored.acknowledge(context)]);
  await restored.acknowledge(context);
  await restored.deliver(() => assert.fail("the saved callback must not be resent"));
  const receipts = (await events.list("run")).filter((event) => event.type === "callback.consumed");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].eventId, "legacy-random-receipt");
  assert.equal(bridge.queuedCount, 0);
});

test(
  "receipt recovery reclaims a departed local process without waiting for lock TTL",
  { timeout: 5000 },
  async (t) => {
    const { root, inbox, bridge } = await fixture(t);
    let delivered;
    await bridge.deliver((message) => {
      delivered = message;
    });
    await inbox.consume("callback-one");
    const target = join(root, "task", "runs", "run", "agents", "main", ".inbox-consumed");
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { withFileLock } from ${JSON.stringify(new URL("../dist/src/storage/file-lock.js", import.meta.url).href)};
       await withFileLock(${JSON.stringify(target)}, async () => process.exit(0), { recoverDeadOwner: true });`
      ],
      {
        cwd: root,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !/^(?:COWORK_|ATRIA_|PI_|SERPER_)/.test(key))
        ),
        stdio: "ignore"
      }
    );
    t.after(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    });
    await once(child, "close");
    assert.equal(child.exitCode, 0);
    const ownerPath = `${target}.lock/owner.json`;
    assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).pid, child.pid);

    await bridge.acknowledge([{ type: "custom_message", ...delivered }]);
    await assert.rejects(readFile(ownerPath), { code: "ENOENT" });
    const events = new JsonlEventStore(join(root, "task", "runs", "run", "run_events.jsonl"));
    assert.equal((await events.list("run")).filter((event) => event.type === "callback.consumed").length, 1);
  }
);

test("receipt recovery waits for a live local owner even when its lock looks old", async (t) => {
  const { root, bridge } = await fixture(t);
  let delivered;
  await bridge.deliver((message) => {
    delivered = message;
  });
  const target = join(root, "task", "runs", "run", "agents", "main", ".inbox-consumed");
  let enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  const liveOwner = withFileLock(
    target,
    async () => {
      enter();
      await released;
    },
    { recoverDeadOwner: true }
  );
  t.after(async () => {
    release();
    await liveOwner;
  });
  await entered;
  const ownerPath = `${target}.lock/owner.json`;
  const owner = await readFile(ownerPath, "utf8");
  await utimes(`${target}.lock`, new Date(0), new Date(0));
  const acknowledgement = bridge.acknowledge([{ type: "custom_message", ...delivered }]);
  const acquiredEarly = await Promise.race([acknowledgement.then(() => true), delay(100).then(() => false)]);
  assert.equal(acquiredEarly, false, "receipt repair must not run while the owner is still alive");
  assert.equal(await readFile(ownerPath, "utf8"), owner);
  release();
  await liveOwner;
  await acknowledgement;
});

test("delivery failures keep callbacks recoverable and unrelated contexts cannot consume them", async (t) => {
  const { inbox, bridge } = await fixture(t);
  await assert.rejects(
    bridge.deliver(() => {
      throw new Error("send failed");
    }),
    /send failed/
  );
  assert.equal((await inbox.list("main"))[0].state, "ready");
  let delivered;
  await bridge.deliver((message) => {
    delivered = message;
  });
  await bridge.acknowledge([
    {
      role: "custom",
      ...delivered,
      details: { _coworkInbox: { taskId: "other", runId: "run", messageId: "callback-one" } }
    }
  ]);
  assert.equal((await inbox.list("main"))[0].state, "leased");
  await bridge.acknowledge([{ role: "custom", ...delivered }]);
  assert.equal((await inbox.list("main"))[0].state, "consumed");
});

test("a Subagent question reaches Main as its own kind, not as a callback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-main-inbox-question-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await new LocalWorkspaceStore(root).createRun("task", "run");
  const inbox = new InboxStore(join(root, "task", "runs", "run", "agents", "main", "inbox-store.json"));
  await inbox.enqueue({
    messageId: "subagent-question-q1",
    recipientAgentId: "main",
    callId: "one",
    kind: "subagent_question",
    eventId: "e1",
    priority: 50,
    state: "ready",
    payload: {
      type: "subagent.question",
      questionId: "q1",
      callId: "one",
      question: "哪个评测脚本是权威的？",
      assumption: "用 scripts/eval.py"
    },
    createdAt: new Date().toISOString()
  });
  const bridge = new MainInboxDelivery(root, "task", "run");
  const sent = [];
  await bridge.deliver((message, options) => {
    sent.push({ message, options });
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.customType, "cowork-subagent-question");
  assert.match(sent[0].message.content, /subagent question/);
  assert.equal(sent[0].options.deliverAs, "steer");
  assert.equal(sent[0].options.triggerTurn, true);
  assert.equal(sent[0].message.details.questionId, "q1");
  // A question is not a callback, so it must not gate on the callback path.
  const coordinator = new CoordinatorRuntime();
  const pending = await coordinator.waitForSubagents({
    taskId: "task",
    runId: "run",
    workspaceRoot: root,
    timeoutMs: 0
  });
  assert.deepEqual(pending.callbackPending, []);
  await bridge.acknowledge([{ role: "custom", ...sent[0].message }]);
  assert.equal((await inbox.list("main"))[0].state, "consumed");
  const events = (await readFile(join(root, "task", "runs", "run", "run_events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(events.filter((event) => event.type === "inbox.consumed").length, 1);
  assert.equal(events.filter((event) => event.type === "callback.consumed").length, 0);
});

for (const status of ["waiting", "failed", "cancelled", "completed"]) {
  test(`a stale callback sender cannot reopen a ${status} Task or erase its completion receipt`, async (t) => {
    const { root, inbox, bridge } = await fixture(t);
    const store = new LocalWorkspaceStore(root);
    await store.transitionTask("task", status, {
      runId: "run",
      ...(status === "failed" ? { error: "Main's recorded provider failure." } : {}),
      completion: {
        signal: status === "completed" ? "natural_stop" : "interrupted",
        summary: "已验证收据保留。"
      }
    });
    const before = await store.readTask("task");
    await assert.rejects(
      bridge.deliver(() => {
        throw new Error("extension ctx is stale after Main shutdown");
      }),
      /ctx is stale/
    );
    assert.deepEqual(await store.readTask("task"), before);
    assert.equal(bridge.queuedCount, 0);
    assert.equal((await inbox.list("main"))[0].state, "ready");
  });
}

test("a callback-triggered turn can create a new standing wake without delivery clearing it", async (t) => {
  const { root, bridge } = await fixture(t);
  const store = new LocalWorkspaceStore(root);
  await store.transitionTask("task", "waiting", { runId: "run", completion: { signal: "interrupted" } });
  await writeSleep(root, "task", {
    runId: "run",
    reason: "旧的等待条件。",
    wakeAt: new Date(Date.now() + 60_000).toISOString(),
    parkedAt: new Date().toISOString()
  });
  const park = {
    runId: "run",
    reason: "这次回调处理后的新等待条件。",
    parkedAt: new Date().toISOString(),
    wakeAt: "2099-01-01T00:00:00Z"
  };
  await bridge.deliver(async () => {
    assert.equal(await readSleep(root, "task"), undefined);
    await store.transitionTask("task", "running", { runId: "run", reason: "main_turn_started" });
    await writeSleep(root, "task", park);
    await store.transitionTask("task", "waiting", { runId: "run", completion: { signal: "interrupted" } });
  });
  assert.deepEqual(await readSleep(root, "task"), { ...park, wakeFiredAt: undefined });
  assert.equal((await store.readTask("task")).status, "waiting");
});

test("an accepted callback waits for an actual Main start to reopen its Task", async (t) => {
  const { root, inbox, bridge } = await fixture(t);
  const store = new LocalWorkspaceStore(root);
  await store.transitionTask("task", "waiting", { runId: "run", completion: { signal: "interrupted" } });
  let queued;
  await bridge.deliver((message) => {
    queued = message;
  });
  assert.equal(
    (await store.readTask("task")).status,
    "waiting",
    "queue acceptance alone does not prove Main inference has started"
  );
  assert.equal(bridge.queuedCount, 1);
  assert.equal((await inbox.list("main"))[0].state, "leased");
  await store.transitionTask("task", "running", { runId: "run", reason: "main_turn_started" });
  assert.equal((await store.readTask("task")).status, "running");
  assert.equal((await store.readTask("task")).completion.signal, "none");
  await bridge.acknowledge([{ role: "custom", ...queued }]);
  assert.equal((await inbox.list("main"))[0].state, "consumed");
});

test("callback delivery cannot reopen a Main turn that has already started and settled", async (t) => {
  const { root, bridge } = await fixture(t);
  const store = new LocalWorkspaceStore(root);
  await store.transitionTask("task", "waiting", { runId: "run", completion: { signal: "interrupted" } });
  let settled;
  await bridge.deliver(async () => {
    await store.transitionTask("task", "running", { runId: "run", reason: "main_turn_started" });
    settled = await store.transitionTask("task", "waiting", {
      runId: "run",
      reason: "incomplete_response",
      completion: { signal: "interrupted" }
    });
  });
  assert.deepEqual(await store.readTask("task"), settled);
});

test("a previous Run's accepted callback does not take Task ownership from its newer Main", async (t) => {
  const { root, bridge } = await fixture(t);
  const store = new LocalWorkspaceStore(root);
  await store.createRun("task", "new-run");
  const before = await store.readTask("task");
  await bridge.deliver(() => {});
  assert.deepEqual(await store.readTask("task"), before);
  assert.equal((await store.readTask("task")).activeRunId, "new-run");
});

test("user message delivery preserves the selected steer or follow-up queue across retries", async (t) => {
  const { inbox, bridge } = await fixture(t);
  for (const delivery of ["steer", "followUp"]) {
    await inbox.enqueue({
      messageId: delivery,
      recipientAgentId: "main",
      kind: "human_command",
      eventId: delivery,
      priority: 120,
      state: "ready",
      payload: { type: "human.message", message: `request-${delivery}`, delivery },
      createdAt: new Date().toISOString()
    });
  }
  const sent = [];
  await bridge.deliver((message, options) => {
    sent.push({ message, options });
  });
  await bridge.deliver((message, options) => {
    sent.push({ message, options });
  });
  for (const delivery of ["steer", "followUp"]) {
    const entries = sent.filter(({ message }) => message.details.delivery === delivery);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].options.deliverAs, delivery);
    assert.match(entries[0].message.content, new RegExp(`request-${delivery}`));
  }
  await bridge.acknowledge(sent.map(({ message }) => ({ role: "custom", ...message })));
  assert.ok((await inbox.list("main")).every((message) => message.state === "consumed"));
});

test("follow-ups remain durable until completion and one can be promoted without duplicate delivery", async (t) => {
  const { inbox, bridge, path } = await fixture(t);
  for (const messageId of ["later", "now"])
    await inbox.enqueue({
      messageId,
      recipientAgentId: "main",
      kind: "human_command",
      eventId: messageId,
      priority: 120,
      state: "ready",
      createdAt: new Date().toISOString(),
      payload: { type: "human.message", message: messageId, delivery: "followUp" }
    });
  const sent = [];
  const send = (message, options) => sent.push({ message, options });
  await bridge.deliver(send, { includeFollowUps: false });
  assert.equal(sent.filter(({ message }) => message.customType === "cowork-user-message").length, 0);
  const reloaded = new InboxStore(path);
  assert.equal((await reloaded.list()).find((m) => m.messageId === "later").state, "ready");
  await reloaded.promoteUserMessage("now");
  await reloaded.promoteUserMessage("now");
  await bridge.deliver(send, { includeFollowUps: false });
  await bridge.deliver(send, { includeFollowUps: false });
  assert.deepEqual(
    sent
      .filter(({ message }) => message.customType === "cowork-user-message")
      .map(({ message, options }) => [message.details.message, options.deliverAs]),
    [["now", "steer"]]
  );
  await bridge.deliver(send, { includeFollowUps: true });
  assert.equal(
    await reloaded.promoteUserMessage("later"),
    undefined,
    "claimed messages cannot be injected again"
  );
  assert.equal(await reloaded.promoteUserMessage("callback-one"), undefined);
  assert.equal(await reloaded.promoteUserMessage("missing"), undefined);
  assert.equal(sent.filter(({ options }) => options.deliverAs === "followUp").length, 1);
  await bridge.acknowledge(sent.map(({ message }) => ({ role: "custom", ...message })));
  assert.ok((await inbox.list()).every((message) => message.state === "consumed"));
});

test("cancellation cannot remove a leased or promoted message and wins atomically against delivery", async (t) => {
  const { inbox } = await fixture(t);
  const enqueue = async (messageId) =>
    inbox.enqueue({
      messageId,
      recipientAgentId: "main",
      kind: "human_command",
      eventId: messageId,
      priority: 120,
      state: "ready",
      createdAt: new Date().toISOString(),
      payload: { type: "human.message", message: messageId, delivery: "followUp" }
    });
  await enqueue("cancelled");
  assert.equal(await inbox.cancelUserMessage("cancelled"), true);
  assert.equal(await inbox.cancelUserMessage("cancelled"), true);
  assert.equal(await inbox.promoteUserMessage("cancelled"), undefined);
  await enqueue("leased");
  await inbox.leaseMessage("main", "leased");
  assert.equal(await inbox.cancelUserMessage("leased"), false);
  await enqueue("promoted");
  await inbox.promoteUserMessage("promoted");
  assert.equal(await inbox.cancelUserMessage("promoted"), false);
  await enqueue("race");
  const [cancelled, promoted] = await Promise.all([
    inbox.cancelUserMessage("race"),
    inbox.promoteUserMessage("race")
  ]);
  assert.notEqual(cancelled, Boolean(promoted), "exactly one action wins");
  assert.equal(await inbox.cancelUserMessage("callback-one"), false);
});

test("resumed queued input is acknowledged from its durable identity, including across run boundaries", async (t) => {
  const { queuedUserTurn } = await import("../dist/src/runtime/queued-user-turn.js");
  const { inbox, root } = await fixture(t);
  await inbox.enqueue({
    messageId: "resume-one",
    recipientAgentId: "main",
    kind: "human_command",
    eventId: "resume-one",
    priority: 120,
    state: "ready",
    createdAt: new Date().toISOString(),
    payload: { type: "human.message", message: "the actual queued message", delivery: "followUp" }
  });
  await inbox.leaseMessage("main", "resume-one", 60000, "queue-resume-resume-one");
  const bridge = new MainInboxDelivery(root, "task", "later-run");
  const entry = {
    type: "message",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: queuedUserTurn({
            taskId: "task",
            runId: "run",
            messageId: "resume-one",
            text: "the actual queued message"
          })
        }
      ]
    }
  };
  await bridge.acknowledge([entry]);
  await bridge.acknowledge([entry]);
  assert.equal((await inbox.list()).find((m) => m.messageId === "resume-one").state, "consumed");
  const events = (await readFile(join(root, "task/runs/run/run_events.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert.equal(
    events.filter((e) => e.type === "inbox.consumed" && e.payload.messageId === "resume-one").length,
    1
  );
});
