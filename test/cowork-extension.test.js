import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { DurableScheduler, InboxStore } from "../dist/src/runtime/scheduler.js";
import { WatchProgramStore } from "../dist/src/runtime/watch-program-store.js";
import { ExperimentProgramStore } from "../dist/src/runtime/experiment-program-store.js";
import { VirtualAgentStore } from "../dist/src/runtime/virtual-agent-store.js";
import { mainContextPaths, readMainContextState } from "../dist/src/runtime/main-context.js";
import { SubagentQuestionStore } from "../dist/src/runtime/subagent-questions.js";

const extensionPath = resolve(".pi/extensions/cowork.ts");
const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));

function fakePi() {
  const tools = new Map();
  const handlers = new Map();
  return {
    tools,
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerProvider() {},
    registerCommand() {},
    getActiveTools() {
      return [...tools.keys()];
    },
    setActiveTools() {},
    sendMessage: async () => {},
    handlers
  };
}

async function loadExtension() {
  const { createJiti } = await import(requirePi.resolve("jiti"));
  const jiti = createJiti(pathToFileURL(extensionPath).href, { interopDefault: true });
  const module = await jiti.import(extensionPath, { default: true });
  return module.default ?? module;
}

function resultFromDispatch(input) {
  return {
    callId: input.callId,
    taskId: input.taskId,
    runId: input.runId,
    agentId: input.agentId,
    status: "succeeded",
    response: `completed: ${input.task}`,
    workingDirectory: "/tmp/subagent",
    artifacts: []
  };
}

test("restored selections retain core discovery without exposing ungranted computer actions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-computer-tool-selection-"));
  const previous = { ...process.env };
  t.after(async () => {
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  });
  Object.assign(process.env, {
    COWORK_API_BASE: "https://example.test",
    COWORK_API_KEY: "local-fixture",
    COWORK_CONFIG: join(root, "config.json"),
    COWORK_WORKSPACE: root,
    COWORK_TASK_ID: "selection-task",
    COWORK_RUN_ID: "main-selection",
    COWORK_DASHBOARD_URL: "http://127.0.0.1:1"
  });
  await writeFile(process.env.COWORK_CONFIG, "{}");
  await new LocalWorkspaceStore(root).createTask("selection-task", { goal: "Use task capabilities" });
  const pi = fakePi();
  let selected = ["read"];
  pi.getActiveTools = () => selected;
  pi.setActiveTools = (names) => {
    selected = names;
  };
  (await loadExtension())(pi);
  // Stop after activation to keep this capability-selection fixture free of background polling.
  await assert.rejects(
    pi.handlers.get("session_start")(
      { reason: "resume" },
      {
        ui: { notify() {} },
        sessionManager: Object.assign(SessionManager.inMemory(root), {
          getEntries() {
            throw new Error("fixture activation complete");
          }
        })
      }
    ),
    /fixture activation complete/
  );
  for (const name of ["computer_status", "computer_observe", "computer_act"])
    assert.equal(selected.includes(name), false);
  assert.ok(selected.includes("enable_tools"));
  const discovery = await pi.tools.get("enable_tools").execute("enable", { groups: ["computer"] });
  assert.equal(discovery.details.groups.computer.enabled, true);
  assert.ok(selected.includes("computer_status"));
  assert.equal(selected.includes("computer_observe"), false);
  assert.equal(selected.includes("computer_act"), false);
  assert.ok(selected.includes("read"));
});

test("call_subagent keeps task/mode required, scopes resources optionally, and tasks stay one-shot", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-extension-"));
  const previous = {
    COWORK_API_BASE: process.env.COWORK_API_BASE,
    COWORK_API_KEY: process.env.COWORK_API_KEY,
    COWORK_CONFIG: process.env.COWORK_CONFIG,
    COWORK_WORKSPACE: process.env.COWORK_WORKSPACE,
    COWORK_TASK_ID: process.env.COWORK_TASK_ID,
    COWORK_RUN_ID: process.env.COWORK_RUN_ID
  };
  const taskId = "extension-task";
  const runId = "main-extension";
  const dispatches = [];
  let asyncResolve;
  let asyncFinished = false;
  const originalDispatch = CoordinatorRuntime.prototype.dispatch;
  try {
    process.env.COWORK_API_BASE = "https://example.test";
    process.env.COWORK_API_KEY = "test-key";
    process.env.COWORK_CONFIG = join(root, "config.json");
    await writeFile(process.env.COWORK_CONFIG, "{}\n");
    process.env.COWORK_WORKSPACE = root;
    process.env.COWORK_TASK_ID = taskId;
    process.env.COWORK_RUN_ID = runId;
    const workspace = new LocalWorkspaceStore(root);
    await workspace.createTask(taskId, { goal: "extension regression" });
    await workspace.createRun(taskId, runId);
    CoordinatorRuntime.prototype.dispatch = function (input) {
      dispatches.push(input);
      input.onQueued?.();
      if (input.mode === "async") {
        return new Promise((resolvePromise) => {
          asyncResolve = (value) => {
            asyncFinished = true;
            resolvePromise(value);
          };
        });
      }
      return Promise.resolve(resultFromDispatch(input));
    };

    const pi = fakePi();
    const extension = await loadExtension();
    extension(pi);
    const request = { role: "user", content: "A follow-up after a context reset" };
    const callback = {
      role: "custom",
      customType: "cowork-callback",
      content: "Existing delegated evidence"
    };
    const context = await pi.handlers.get("context")(
      {
        messages: [
          request,
          {
            role: "custom",
            customType: "cowork-completion-check",
            content: "Treat the previous reply as a progress update."
          },
          callback
        ]
      },
      { sessionManager: SessionManager.inMemory(root) }
    );
    assert.deepEqual(
      context.messages,
      [request, callback],
      "retired completion reminders must not be replayed from old conversations"
    );
    assert.equal(
      (await workspace.readTask(taskId)).goal,
      "extension regression",
      "follow-ups must preserve the conversation title"
    );
    const injected = await pi.handlers.get("before_agent_start")({ systemPrompt: "Original system rules" });
    assert.ok(injected.systemPrompt.startsWith("Original system rules"));
    assert.ok(injected.systemPrompt.includes(join(root, taskId, "artifacts")));
    assert.ok(injected.systemPrompt.includes("用户选择的项目目录"));
    assert.ok(injected.systemPrompt.includes("read/edit/write/bash"));
    assert.ok(injected.systemPrompt.includes(join(root, taskId, "agents", "main", "work")));
    assert.ok(injected.systemPrompt.includes("outputFiles"));
    const tool = pi.tools.get("call_subagent");
    assert.ok(tool, "extension must register call_subagent");
    assert.deepEqual(Object.keys(tool.parameters.properties), ["task", "attachments", "resources", "mode"]);
    assert.deepEqual(tool.parameters.required, ["task", "mode"]);
    assert.equal(tool.parameters.additionalProperties, false);

    let status;
    const ctx = {
      sessionManager: SessionManager.inMemory(root),
      ui: {
        setStatus(_key, value) {
          status = value;
        },
        notify() {}
      }
    };
    const keywordTask =
      "调研 Cowork harness；长期关注 research papers、monitor Virtual Agent/watch program，并执行 experiment benchmark 记录 ledger";
    const asyncOutput = await tool.execute(
      "tool-async",
      { task: keywordTask, mode: "async" },
      undefined,
      undefined,
      ctx
    );
    assert.equal(asyncOutput.details.accepted, true);
    const accepted = JSON.parse(asyncOutput.content[0].text);
    assert.equal(accepted.mode, "async");
    assert.equal(accepted.name, "Ara");
    assert.equal(accepted.kind, undefined);
    assert.equal(accepted.lifecycle, undefined);
    assert.equal(accepted.programId, undefined);
    assert.equal(accepted.monitorId, undefined);
    assert.equal(asyncFinished, false, "async must return before dispatch settles");

    const asyncCall = dispatches[0];
    const inbox = new InboxStore(join(root, taskId, "runs", runId, "agents", "main", "inbox-store.json"));
    await inbox.enqueue({
      messageId: `callback-${asyncCall.callId}-succeeded`,
      recipientAgentId: "main",
      kind: "callback",
      callId: asyncCall.callId,
      eventId: "event-callback",
      priority: 1,
      state: "ready",
      payload: { callId: asyncCall.callId, status: "succeeded", response: "callback delivered" },
      createdAt: new Date().toISOString()
    });
    const sent = [];
    pi.sendMessage = (message, options) => {
      sent.push({ ...message, options });
    };
    asyncResolve(resultFromDispatch(asyncCall));
    await waitUntil(() => status === "" && sent.length === 1);
    assert.equal(
      (await inbox.list("main"))[0].state,
      "leased",
      "queuing must not count as Main receiving the callback"
    );
    assert.equal(
      sent[0].options.deliverAs,
      "steer",
      "callbacks must arrive before the next inference, not after the final answer"
    );
    const prematureFinish = await pi.tools.get("finish_task").execute("finish-early", {});
    assert.equal(prematureFinish.details.completed, false);
    assert.equal(prematureFinish.details.reason, "pending_callbacks");
    await pi.handlers.get("context")({ messages: [{ role: "custom", ...sent[0] }] }, ctx);
    await waitUntil(async () => {
      const state = await readMainContextState(mainContextPaths(root, taskId));
      return status === "" && state.runtimePendingDelegations === 0;
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].details.callId, asyncCall.callId);
    assert.equal((await inbox.list("main"))[0].state, "consumed");

    const syncTask = "同步执行 experiment benchmark 并研究监控结果";
    const sync = await tool.execute("tool-sync", { task: syncTask, mode: "sync" }, undefined, undefined, ctx);
    assert.equal(sync.details.status, "succeeded");
    assert.equal(sync.details.name, "Norma");
    await waitUntil(async () => {
      const state = await readMainContextState(mainContextPaths(root, taskId));
      return (
        state.runtimeLastEvent?.type === "subagent_completed" &&
        state.runtimeLastEvent.summary.includes(sync.details.callId)
      );
    });
    assert.equal(dispatches.length, 2);
    assert.deepEqual(
      dispatches.map((call) => call.mode),
      ["async", "sync"]
    );
    assert.deepEqual(
      dispatches.map((call) => call.task),
      [keywordTask, syncTask]
    );
    assert.deepEqual(await new WatchProgramStore(root).listPrograms(taskId), []);
    assert.deepEqual(await new VirtualAgentStore(root).listPrograms(taskId), []);
    // Task wording must not create a persistent program or a monitor — the two
    // assertions above. The experiment ledger is not one of those: it is
    // Runtime bookkeeping that every Task gets, with no lifecycle for Main to
    // operate and no effect on delegation semantics. What it must not do is
    // change how a call was routed.
    const ledgers = await new ExperimentProgramStore(root).listPrograms(taskId);
    assert.equal(ledgers.length, 1, "bookkeeping is one ledger per Task, not one per keyword");
    assert.equal(ledgers[0].decisionOwner, "main");
    assert.equal(ledgers[0].nextAction, undefined, "the ledger records without directing Main");
    assert.deepEqual(
      dispatches.map((call) => call.mode),
      ["async", "sync"],
      "recording must not alter routing"
    );
  } finally {
    CoordinatorRuntime.prototype.dispatch = originalDispatch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeAfterAsyncWrites(root);
  }
});

test("Main waits for a recovered call's terminal callback to be persisted before finishing", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-recovery-completion-"));
  const taskId = "recovery-task";
  const runId = "main-recovery";
  await writeFile(join(root, "config.json"), "{}\n");
  const env = {
    COWORK_API_BASE: "https://example.test",
    COWORK_API_KEY: "test-key",
    COWORK_CONFIG: join(root, "config.json"),
    COWORK_WORKSPACE: root,
    COWORK_TASK_ID: taskId,
    COWORK_RUN_ID: runId
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const originalRecover = CoordinatorRuntime.prototype.recoverRun;
  const controller = new AbortController();
  let releaseRecovery;
  const recoveryGate = new Promise((resolvePromise) => {
    releaseRecovery = resolvePromise;
  });
  let ending;
  let recovery;
  try {
    Object.assign(process.env, env);
    const workspace = new LocalWorkspaceStore(root);
    await workspace.createTask(taskId, { goal: "Handle a recovered failure" });
    await workspace.createRun(taskId, runId);
    await workspace.updateTask(taskId, { completion: { policy: "explicit" } });
    const scheduler = new DurableScheduler(join(root, taskId, "runs", runId, "queue.json"));
    const inbox = new InboxStore(join(root, taskId, "runs", runId, "agents", "main", "inbox-store.json"));
    await scheduler.enqueue({
      stepId: "retry",
      taskId,
      runId,
      agentId: "subagent_1",
      importance: "normal",
      payload: { task: "Retry evidence collection" },
      maxAttempts: 1
    });
    let terminal = false;
    CoordinatorRuntime.prototype.recoverRun = function () {
      recovery = (async () => {
        const item = await scheduler.claim("recovery", 60000, "retry");
        await scheduler.fail("retry", item.lease.token, "Retry exhausted");
        terminal = true;
        // A failed queue entry becomes terminal before its callback is written.
        await recoveryGate;
        await inbox.enqueue({
          messageId: "callback-retry-failed",
          recipientAgentId: "main",
          kind: "callback",
          callId: "retry",
          eventId: "retry-failed",
          priority: 1,
          state: "ready",
          createdAt: new Date().toISOString(),
          payload: { callId: "retry", status: "failed", response: "Retry exhausted" }
        });
        return [];
      })();
      return recovery;
    };
    const pi = fakePi();
    const sent = [];
    pi.sendMessage = (message) => {
      sent.push(message);
    };
    (await loadExtension())(pi);
    const ctx = {
      sessionManager: SessionManager.inMemory(root),
      signal: controller.signal,
      hasPendingMessages: () => false,
      ui: { notify() {} }
    };
    let settled = false;
    ending = pi.handlers
      .get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx)
      .then(() => {
        settled = true;
      });
    await waitUntil(() => terminal);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
    assert.equal(settled, false, "Main must stay alive while recovery is still recording its callback");
    const early = await pi.tools.get("finish_task").execute("finish-early", {});
    assert.equal(early.details.completed, false);
    assert.equal(early.details.reason, "pending_subagents");
    releaseRecovery();
    await ending;
    await waitUntil(() => sent.length === 1);
    assert.equal(sent[0].customType, "cowork-callback");
    await pi.handlers.get("context")({ messages: [{ role: "custom", ...sent[0] }] }, ctx);
    const finished = await pi.tools.get("finish_task").execute("finish", {});
    assert.equal(finished.details.completed, true);
  } finally {
    controller.abort();
    releaseRecovery();
    await recovery;
    await ending;
    CoordinatorRuntime.prototype.recoverRun = originalRecover;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeAfterAsyncWrites(root);
  }
});

test("Main answers a Subagent question through send_subagent_message and cannot finish while one is open", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-subagent-question-"));
  const taskId = "question-task";
  const runId = "main-question";
  await writeFile(join(root, "config.json"), "{}\n");
  const env = {
    COWORK_API_BASE: "https://example.test",
    COWORK_API_KEY: "test-key",
    COWORK_CONFIG: join(root, "config.json"),
    COWORK_WORKSPACE: root,
    COWORK_TASK_ID: taskId,
    COWORK_RUN_ID: runId
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const originalSendMessage = CoordinatorRuntime.prototype.sendMessage;
  const steered = [];
  try {
    Object.assign(process.env, env);
    const workspace = new LocalWorkspaceStore(root);
    await workspace.createTask(taskId, { goal: "Answer a collaborator" });
    await workspace.createRun(taskId, runId);
    // Ordinary guidance still goes through the Coordinator; the question path
    // must not be routed there while the question is answerable.
    CoordinatorRuntime.prototype.sendMessage = async function (input) {
      steered.push(input);
      return { messageId: "message-1", callId: input.callId, agentId: "subagent_1", status: "queued" };
    };
    const questions = new SubagentQuestionStore(root);
    const raised = await questions.create({
      questionId: "question-1",
      taskId,
      runId,
      callId: "call-1",
      agentId: "subagent_1",
      agentName: "Ada",
      question: "哪个评测脚本是权威的？",
      assumption: "用 scripts/eval.py"
    });
    const pi = fakePi();
    (await loadExtension())(pi);
    const send = pi.tools.get("send_subagent_message");

    // A pending question blocks completion: the collaborator is waiting on Main.
    const early = await pi.tools.get("finish_task").execute("finish-early", {});
    assert.equal(early.details.completed, false);
    assert.equal(early.details.reason, "pending_subagent_questions");

    // An answer aimed at the wrong call is a real mistake, not something to deliver.
    await assert.rejects(
      send.execute("answer-wrong", { callId: "call-9", questionId: "question-1", message: "x" }),
      /belongs to call call-1/
    );
    await assert.rejects(
      send.execute("answer-missing", { callId: "call-1", questionId: "question-404", message: "x" }),
      /unknown question/
    );

    const answered = await send.execute("answer", {
      callId: "call-1",
      questionId: raised.questionId,
      message: "configs/eval.py 是权威的"
    });
    assert.equal(answered.details.status, "answered");
    assert.equal(answered.details.name, "Ada");
    assert.equal(
      steered.length,
      0,
      "answering a live question must unblock it directly, not queue ordinary guidance"
    );
    assert.equal((await questions.read(taskId, raised.questionId)).answer, "configs/eval.py 是权威的");
    const finished = await pi.tools.get("finish_task").execute("finish", {});
    assert.equal(finished.details.completed, true);

    // A decision arriving after the Subagent gave up waiting is still worth
    // having while that Agent is running: it lands as ordinary guidance.
    const expired = await questions.create({
      questionId: "question-2",
      taskId,
      runId,
      callId: "call-1",
      agentId: "subagent_1",
      agentName: "Ada",
      question: "还要继续吗？",
      assumption: "继续"
    });
    await questions.expire(taskId, expired.questionId);
    const scheduler = new DurableScheduler(join(root, taskId, "runs", runId, "queue.json"));
    await scheduler.enqueue({
      stepId: "call-1",
      taskId,
      runId,
      agentId: "subagent_1",
      importance: "normal",
      payload: { task: "x" },
      maxAttempts: 1
    });
    const late = await send.execute("answer-late", {
      callId: "call-1",
      questionId: expired.questionId,
      message: "停下来"
    });
    assert.equal(steered.length, 1, "a late answer must still reach a Subagent that is still working");
    assert.equal(steered[0].message, "停下来");
    assert.match(late.details.note, /already expired/);

    // Once that Agent is gone there is nobody to steer. Main gets told what
    // assumption the work was done under, instead of an exception it cannot act on.
    await scheduler.cancel("call-1");
    const tooLate = await send.execute("answer-too-late", {
      callId: "call-1",
      questionId: expired.questionId,
      message: "还是停下来"
    });
    assert.equal(steered.length, 1, "a finished Subagent must not be steered");
    assert.equal(tooLate.details.delivered, "not_delivered");
    assert.match(tooLate.details.note, /already finished/);
    assert.match(tooLate.details.note, /继续/, "Main must be told which assumption the result rests on");
  } finally {
    CoordinatorRuntime.prototype.sendMessage = originalSendMessage;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeAfterAsyncWrites(root);
  }
});

test("a delegated workspace without the run credential still registers the extension", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-extension-delegated-"));
  const previous = { ...process.env };
  t.after(async () => {
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  });
  Object.assign(process.env, {
    COWORK_API_BASE: "https://example.test",
    COWORK_API_KEY: "fixture-model-key",
    COWORK_CONFIG: join(root, "config.json"),
    COWORK_WORKSPACE: root,
    COWORK_PROJECT_DIR: root,
    COWORK_TASK_ID: "delegated-task",
    COWORK_RUN_ID: "main-delegated",
    // What businessCommandEnvironment leaves a delegated subprocess: the address
    // stays and the run credential is deliberately removed.
    COWORK_DASHBOARD_URL: "http://127.0.0.1:1"
  });
  delete process.env.COWORK_API_TOKEN;
  await writeFile(process.env.COWORK_CONFIG, "{}\n");
  await new LocalWorkspaceStore(root).createTask("delegated-task", { goal: "delegated" });
  const pi = fakePi();
  await (
    await loadExtension()
  )(pi);
  for (const handler of ["session_start", "agent_end", "tool_call"])
    assert.equal(typeof pi.handlers.get(handler), "function", handler);
  // The ledger tool registers before the workspace, computer and capability
  // groups; every one of them must still arrive.
  for (const name of [
    "call_subagent",
    "project_ledger",
    "read_attachment",
    "computer_status",
    "enable_tools"
  ])
    assert.ok(pi.tools.has(name), name);
  await assert.rejects(
    pi.tools.get("project_ledger").execute("ledger-call", { action: "query" }),
    (error) => {
      assert.match(error.message, /项目台账工具不可用：本次运行没有本地服务凭据/);
      assert.ok(!error.message.includes("http://127.0.0.1:1"));
      assert.ok(!error.message.includes("fixture-model-key"));
      return true;
    }
  );
});

test("the registered ledger tool reaches the configured backend with the run credential", async (t) => {
  const token = "fixture-run-credential";
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        url: request.url,
        token: request.headers["x-atria-token"],
        body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          projectId: "project_a",
          requirements: [{ requirementId: "requirement_a", title: "来自后端的台账" }]
        })
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const root = await mkdtemp(join(tmpdir(), "atria-extension-ledger-"));
  const previous = { ...process.env };
  t.after(async () => {
    await new Promise((done) => server.close(done));
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  });
  Object.assign(process.env, {
    COWORK_API_BASE: "https://example.test",
    COWORK_API_KEY: "fixture-model-key",
    COWORK_CONFIG: join(root, "config.json"),
    COWORK_WORKSPACE: root,
    COWORK_PROJECT_DIR: root,
    COWORK_TASK_ID: "ledger-task",
    COWORK_RUN_ID: "main-ledger",
    COWORK_DASHBOARD_URL: `http://127.0.0.1:${port}`,
    COWORK_API_TOKEN: token
  });
  await writeFile(process.env.COWORK_CONFIG, "{}\n");
  await new LocalWorkspaceStore(root).createTask("ledger-task", { goal: "ledger" });
  const pi = fakePi();
  await (
    await loadExtension()
  )(pi);
  assert.equal(typeof pi.handlers.get("session_start"), "function");
  const result = await pi.tools.get("project_ledger").execute("ledger-call", {
    action: "query",
    q: "台账"
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/tasks/ledger-task/ledger");
  assert.equal(requests[0].token, token);
  assert.deepEqual(requests[0].body, { action: "query", q: "台账" });
  assert.deepEqual(JSON.parse(result.content[0].text), {
    projectId: "project_a",
    requirements: [{ requirementId: "requirement_a", title: "来自后端的台账" }]
  });
});

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  assert.fail("timed out waiting for asynchronous callback delivery");
}

async function removeAfterAsyncWrites(path) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "ENOTEMPTY" && error?.code !== "EBUSY") throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  await rm(path, { recursive: true, force: true });
}
