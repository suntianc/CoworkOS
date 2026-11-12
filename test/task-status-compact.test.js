import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { ExperimentProgramStore } from "../dist/src/runtime/experiment-program-store.js";
import { MainInboxDelivery } from "../dist/src/runtime/main-inbox-delivery.js";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { DurableScheduler, InboxStore } from "../dist/src/runtime/scheduler.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const coordinationPath = resolve(".pi/runtime/tools/coordination.ts");
const responseBody = `OLD_RESPONSE_NOT_FOR_STATUS:${"r".repeat(6000)}`;
const taskBody = `OLD_CALL_TASK_NOT_FOR_STATUS:${"t".repeat(4000)}`;
const errorBody = `OLD_ERROR_NOT_FOR_STATUS:${"e".repeat(4000)}`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-task-status-compact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new LocalWorkspaceStore(root);
  await workspace.createTask("task", { goal: "inspect isolated fixture state" });
  await workspace.createRun("task", "run");
  const inbox = new InboxStore(join(root, "task", "runs", "run", "agents", "main", "inbox-store.json"));
  const scheduler = new DurableScheduler(join(root, "task", "runs", "run", "queue.json"));
  const coordinator = new CoordinatorRuntime();
  const bridge = new MainInboxDelivery(root, "task", "run");
  const tools = new Map();
  const delivered = [];
  const { createJiti } = await import(requirePi.resolve("jiti"));
  const jiti = createJiti(pathToFileURL(coordinationPath).href, { interopDefault: true });
  const { registerCoordinationTools } = await jiti.import(coordinationPath);
  registerCoordinationTools(
    { registerTool: (tool) => tools.set(tool.name, tool) },
    {
      workspaceRoot: root,
      taskId: "task",
      mainRunId: "run",
      coordinator,
      inboxDelivery: bridge,
      deliverCallbacks: () => bridge.deliver((message) => delivered.push(message)),
      experimentStore: new ExperimentProgramStore(root)
    }
  );
  return { root, workspace, inbox, scheduler, coordinator, bridge, tools, delivered };
}

async function completedCall(
  f,
  { callId = "one", state = "ready", callback = true, resultFile = true } = {}
) {
  const agentId = `worker-${callId}`;
  await f.scheduler.enqueue({
    stepId: callId,
    taskId: "task",
    runId: "run",
    agentId,
    importance: "normal",
    payload: { task: taskBody }
  });
  const work = await f.scheduler.claim("fixture-worker", 60_000, callId);
  await f.scheduler.complete(callId, work.lease.token);
  const diagnostics = {
    tracePath: `sessions/${agentId}/run.jsonl`,
    resultPath: `runs/run/agents/subagents/${agentId}/result.json`
  };
  if (resultFile) {
    const path = join(f.root, "task", diagnostics.resultPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ termination: "completed", messages: [], response: responseBody }));
  }
  if (callback) {
    const messageId = `callback-${callId}`;
    await f.inbox.enqueue({
      messageId,
      recipientAgentId: "main",
      callId,
      kind: "callback",
      eventId: `event-${callId}`,
      priority: 1,
      state: "ready",
      payload: {
        callId,
        agentId,
        status: "succeeded",
        response: responseBody,
        error: errorBody,
        outputFiles: Array.from({ length: 100 }, (_, index) => `OUTPUT_NOT_FOR_STATUS_${index}.txt`),
        diagnostics
      },
      createdAt: new Date().toISOString()
    });
    if (state !== "ready") await f.inbox.leaseMessage("main", messageId, 60_000, "fixture-consumer");
    if (state === "consumed") await f.inbox.consume(messageId);
  }
  return { callId, agentId, diagnostics };
}

function assertCompact(result, expected) {
  const call = result.details.coordination.calls.find((item) => item.callId === expected.callId);
  assert.ok(call);
  assert.equal(call.agentId, expected.agentId);
  assert.equal(call.status, "completed");
  for (const key of ["task", "response", "error", "outputFiles"]) {
    assert.ok(call[key] === undefined, `${key} must not accompany a status lookup`);
  }
  assert.equal(
    /OLD_RESPONSE_NOT_FOR_STATUS|OLD_CALL_TASK_NOT_FOR_STATUS|OLD_ERROR_NOT_FOR_STATUS|OUTPUT_NOT_FOR_STATUS/.test(
      JSON.stringify(result)
    ),
    false,
    "status text and details must omit stored result, brief, error and output bodies"
  );
  return call;
}

for (const state of ["ready", "leased", "consumed"]) {
  test(`get_task_status reports ${state} result availability without replaying or consuming the result`, async (t) => {
    const f = await fixture(t);
    const expected = await completedCall(f, { state });
    const before = await f.inbox.list("main");
    for (let query = 0; query < 2; query++) {
      const result = await f.tools.get("get_task_status").execute();
      const call = assertCompact(result, expected);
      assert.equal(call.callbackState, state);
      assert.equal(call.resultAvailable, true);
      assert.equal(call.resultDelivered, state === "consumed");
      assert.deepEqual(call.diagnostics, expected.diagnostics);
      assert.deepEqual(
        result.details.coordination.callbackPending,
        state === "consumed" ? [] : [expected.callId]
      );
      assert.deepEqual(
        await f.inbox.list("main"),
        before,
        "a status lookup must not acquire, renew or consume a lease"
      );
      assert.equal(f.delivered.length, 0);
    }
    const persisted = await readFile(join(f.root, "task", expected.diagnostics.resultPath), "utf8");
    assert.ok(
      persisted.includes(responseBody),
      "the full result remains available at the returned reference"
    );
  });
}

test("status inspection preserves a ready result for the wait tool's first complete delivery", async (t) => {
  const f = await fixture(t);
  const expected = await completedCall(f);
  assertCompact(await f.tools.get("get_task_status").execute(), expected);
  const wait = f.tools.get("wait_for_subagents");
  const first = await wait.execute("first-wait", { callIds: [expected.callId], timeoutMs: 0 });
  assert.equal(first.details.calls[0].response, responseBody);
  assert.deepEqual(
    first.details._coworkInboxMessages.map((receipt) => receipt.messageId),
    ["callback-one"]
  );
  assert.equal((await f.inbox.list("main"))[0].state, "leased");
  await f.bridge.acknowledge([
    { role: "toolResult", toolName: "wait_for_subagents", isError: false, details: first.details }
  ]);
  const second = await wait.execute("second-wait", { callIds: [expected.callId], timeoutMs: 0 });
  assert.equal(
    second.details.calls[0].response,
    undefined,
    "a later wait must not replay acknowledged evidence"
  );
  assert.deepEqual(second.details._coworkInboxMessages, []);
  const status = assertCompact(await f.tools.get("get_task_status").execute(), expected);
  assert.equal(status.resultDelivered, true);
  assert.equal(status.callbackState, "consumed");
  assert.equal(
    f.delivered.length,
    0,
    "status and wait must not also enqueue the same result for callback injection"
  );
});

test("compact status cannot claim a callback without delivering its evidence", async (t) => {
  const f = await fixture(t);
  const expected = await completedCall(f);
  const before = await f.inbox.list("main");
  await assert.rejects(
    f.coordinator.waitForSubagents({
      taskId: "task",
      runId: "run",
      workspaceRoot: f.root,
      timeoutMs: 0,
      waitForCallbackConsumption: false,
      includeCallDetails: false,
      consumeCompletedCallbacks: true
    }),
    /compact.*claim|compact.*consum/i
  );
  assert.deepEqual(
    await f.inbox.list("main"),
    before,
    "a rejected compact claim must not touch the Inbox lease or state"
  );
  const delivered = await f.tools
    .get("wait_for_subagents")
    .execute("complete-wait", { callIds: [expected.callId], timeoutMs: 0 });
  assert.equal(
    delivered.details.calls[0].response,
    responseBody,
    "the first valid wait must retain the complete result"
  );
  assert.deepEqual(
    delivered.details._coworkInboxMessages.map((receipt) => receipt.messageId),
    ["callback-one"]
  );
});

test("a result file without a callback is available but has no inferred delivery receipt", async (t) => {
  const f = await fixture(t);
  const expected = await completedCall(f, { callback: false });
  const call = assertCompact(await f.tools.get("get_task_status").execute(), expected);
  assert.equal(call.callbackState, "none");
  assert.equal(call.resultAvailable, true);
  assert.equal(
    call.resultDelivered,
    undefined,
    "absence of an async callback cannot prove a sync result was delivered"
  );
  assert.deepEqual(call.diagnostics, expected.diagnostics);
});

test("a terminal call without a callback or result file does not claim a result is available", async (t) => {
  const f = await fixture(t);
  const expected = await completedCall(f, { callback: false, resultFile: false });
  const call = assertCompact(await f.tools.get("get_task_status").execute(), expected);
  assert.equal(call.callbackState, "none");
  assert.equal(call.resultAvailable, false);
  assert.equal(call.resultDelivered, undefined);
});

test("an upward question cannot replace the callback's result and delivery metadata", async (t) => {
  const f = await fixture(t);
  const expected = await completedCall(f, { state: "consumed" });
  await f.inbox.enqueue({
    messageId: "later-question",
    recipientAgentId: "main",
    callId: expected.callId,
    kind: "subagent_question",
    eventId: "question-event",
    priority: 50,
    state: "ready",
    payload: { questionId: "question-one", question: "fixture question", response: "QUESTION_NOT_A_RESULT" },
    createdAt: new Date().toISOString()
  });
  const status = await f.tools.get("get_task_status").execute();
  const call = assertCompact(status, expected);
  assert.equal(call.resultAvailable, true);
  assert.equal(call.resultDelivered, true);
  assert.equal(call.callbackState, "consumed");
  assert.deepEqual(call.diagnostics, expected.diagnostics);
  assert.doesNotMatch(JSON.stringify(status), /QUESTION_NOT_A_RESULT/);
});

test("an explicit result request returns only the selected call body without changing delivery state", async (t) => {
  const f = await fixture(t);
  const first = await completedCall(f, { callId: "first", state: "consumed" });
  const second = await completedCall(f, { callId: "second", state: "consumed" });
  const before = await f.inbox.list("main");
  const tool = f.tools.get("get_task_status");
  const initial = await tool.execute("initial-status", {});
  assertCompact(initial, first);
  assertCompact(initial, second);
  const selected = await tool.execute("explicit-result", { resultCallIds: [second.callId] });
  const calls = selected.details.coordination.calls;
  const unrequested = calls.find((call) => call.callId === first.callId);
  const requested = calls.find((call) => call.callId === second.callId);
  assert.ok(unrequested.response === undefined, "unrequested results stay compact");
  assert.ok(unrequested.error === undefined);
  assert.ok(unrequested.outputFiles === undefined);
  assert.equal(requested.response, responseBody, "an explicit request restores the persisted result body");
  assert.equal(requested.error, errorBody);
  assert.equal(requested.outputFiles.length, 100);
  assert.ok(
    calls.every((call) => call.task === undefined),
    "the original delegation brief is never a result body"
  );
  assert.deepEqual(await f.inbox.list("main"), before, "rereading must not consume or reacquire a result");
  const again = await tool.execute("status-again", {});
  assertCompact(again, first);
  assertCompact(again, second);
  assert.equal(f.delivered.length, 0);
});

test(
  "two status checks in the actual Pi loop send no consumed result body back to the model",
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    await completedCall(f, { state: "consumed" });
    const model = await modelProtocolFixture("openai-completions", (_body, requests) =>
      requests.length <= 2 ? { name: "get_task_status", arguments: {} } : { text: "STATUS_CHECKED_TWICE" }
    );
    t.after(() => model.close());
    const tool = f.tools.get("get_task_status");
    const result = await new PiSession({
      baseUrl: model.baseUrl,
      apiKey: "isolated-local-fixture",
      api: "openai-completions",
      model: "protocol-fixture",
      thinkingLevel: "off",
      supportsReasoningEffort: false,
      supportsPromptCacheKey: false,
      supportsImages: false,
      tools: new Map(),
      agentTools: [{ ...tool, execute: (id, params, signal) => tool.execute(id, params, signal) }],
      maxTurns: 3,
      maxErrorRetries: 0,
      timeoutMs: 5_000
    }).run("Check the isolated task status twice, then finish.");
    assert.equal(result.termination, "completed");
    assert.equal(model.requests.length, 3);
    const messages = model.requests.at(-1).body.messages;
    const outputs = messages.filter((message) => message.role === "tool");
    assert.equal(outputs.length, 2, "both real tool results must reach the third model request");
    assert.equal(
      /OLD_RESPONSE_NOT_FOR_STATUS|OLD_CALL_TASK_NOT_FOR_STATUS|OLD_ERROR_NOT_FOR_STATUS|OUTPUT_NOT_FOR_STATUS/.test(
        JSON.stringify(messages)
      ),
      false,
      "the real model request must not contain stored result, brief, error and output bodies"
    );
    assert.ok(
      outputs.every((message) => message.content.length < 3_000),
      "status results must remain compact despite the large persisted result"
    );
    assert.equal((await f.inbox.list("main"))[0].state, "consumed");
  }
);
