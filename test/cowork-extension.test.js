import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { DurableScheduler, InboxStore } from "../dist/src/runtime/scheduler.js";
import { SubagentQuestionStore } from "../dist/src/runtime/subagent-questions.js";
import { queuedUserTurn } from "../dist/src/runtime/queued-user-turn.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { fakeEventHandlers } from "./fixtures/fake-pi-events.mjs";
import { startSubagentBackend } from "./fixtures/subagent-backend-fixture.mjs";

const extensionPath = resolve(".pi/extensions/cowork.ts");
const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));

function fakePi() {
  const tools = new Map();
  const events = fakeEventHandlers();
  const levels = [];
  let thinkingLevel = "off";
  return {
    tools,
    levels,
    on: events.on,
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
    setModel: async () => true,
    getThinkingLevel() {
      return thinkingLevel;
    },
    setThinkingLevel(level) {
      levels.push(level);
      thinkingLevel = level;
    },
    handlers: events.handlers
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
    // Desktop, browser and CUA tools are offered only to a Main connection
    // that accepts image input.
    COWORK_SUPPORTS_IMAGES: "1",
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

test("call_subagent keeps task/mode required and dispatches one work item per call", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-extension-"));
  const previous = {
    COWORK_API_BASE: process.env.COWORK_API_BASE,
    COWORK_API_KEY: process.env.COWORK_API_KEY,
    COWORK_CONFIG: process.env.COWORK_CONFIG,
    COWORK_WORKSPACE: process.env.COWORK_WORKSPACE,
    COWORK_TASK_ID: process.env.COWORK_TASK_ID,
    COWORK_RUN_ID: process.env.COWORK_RUN_ID,
    COWORK_SUBAGENT_BACKEND_URL: process.env.COWORK_SUBAGENT_BACKEND_URL,
    COWORK_SUBAGENT_BACKEND_TOKEN: process.env.COWORK_SUBAGENT_BACKEND_TOKEN
  };
  const taskId = "extension-task";
  const runId = "main-extension";
  const backend = await startSubagentBackend({ workspaceRoot: root, taskId, runId });
  try {
    process.env.COWORK_API_BASE = "https://example.test";
    process.env.COWORK_API_KEY = "test-key";
    process.env.COWORK_CONFIG = join(root, "config.json");
    await writeFile(process.env.COWORK_CONFIG, "{}\n");
    process.env.COWORK_WORKSPACE = root;
    process.env.COWORK_TASK_ID = taskId;
    process.env.COWORK_RUN_ID = runId;
    process.env.COWORK_SUBAGENT_BACKEND_URL = backend.url;
    process.env.COWORK_SUBAGENT_BACKEND_TOKEN = backend.token;
    const workspace = new LocalWorkspaceStore(root);
    await workspace.createTask(taskId, { goal: "extension regression" });
    await workspace.createRun(taskId, runId);

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
      { messages: [request, callback] },
      { sessionManager: SessionManager.inMemory(root) }
    );
    assert.deepEqual(context.messages, [request, callback], "existing evidence is replayed unchanged");
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
    assert.deepEqual(Object.keys(tool.parameters.properties), [
      "task",
      "attachments",
      "mode",
      "role",
      "dependsOn",
      "developmentId",
      "continueCallId",
      "reviewId",
      "profileId",
      "model"
    ]);
    assert.deepEqual(
      tool.parameters.required,
      ["task", "mode"],
      "the role, dependency and site stay optional"
    );
    assert.equal(tool.parameters.additionalProperties, false);

    const ctx = {
      sessionManager: SessionManager.inMemory(root),
      ui: { setStatus() {}, notify() {} }
    };
    await assert.rejects(
      () => tool.execute("missing-task", { mode: "async" }, undefined, undefined, ctx),
      /requires task/
    );
    await assert.rejects(
      () => tool.execute("bad-mode", { task: "anything", mode: "later" }, undefined, undefined, ctx),
      /mode must be sync or async/
    );

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
    assert.equal(accepted.role, "executor");
    assert.equal(backend.requests.length, 1, "async returns after registering one work item");
    assert.equal(backend.requests[0].task, keywordTask);
    assert.equal(backend.requests[0].mode, "async");
    assert.equal(backend.requests[0].role, "executor");

    const sync = await tool.execute(
      "tool-sync",
      { task: "同步执行 experiment benchmark 并研究监控结果", mode: "sync" },
      undefined,
      undefined,
      ctx
    );
    assert.equal(sync.details.status, "succeeded");
    assert.equal(backend.requests.length, 2);
    assert.equal(backend.requests[1].mode, "sync");
    assert.deepEqual(
      backend.requests.map((call) => call.mode),
      ["async", "sync"],
      "one dispatch per call and none rewritten"
    );
  } finally {
    await backend.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeAfterAsyncWrites(root);
  }
});

test("Pi prompt-cache warming stays off for the CoworkOS Main session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-extension-warming-"));
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
    COWORK_PROJECT_DIR: root,
    COWORK_TASK_ID: "warming-task",
    COWORK_RUN_ID: "main-warming"
  });
  await writeFile(process.env.COWORK_CONFIG, "{}\n");
  await new LocalWorkspaceStore(root).createTask("warming-task", { goal: "warming" });
  const pi = fakePi();
  await (
    await loadExtension()
  )(pi);
  const decide = pi.handlers.get("cache_warming_decision");
  assert.equal(typeof decide, "function", "Main must answer Pi's cache-warming decision hook");
  // Pi 1.5 warms the prompt cache by default; this upgrade keeps the new
  // capability off, so every refresh is stopped instead of costing a model call.
  assert.deepEqual(
    await decide({
      type: "cache_warming_decision",
      action: "warm",
      warmCost: 0.01,
      missCost: 0.3,
      continuationProbability: 0.5
    }),
    { action: "stop" }
  );
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

test("a turn takes the level of the message that opened it, not of a newer accepted message", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-turn-level-"));
  const provider = await modelProtocolFixture("openai-completions", () => ({ text: "unused" }), {
    models: [{ id: "turn-model" }]
  });
  const previous = { ...process.env };
  t.after(async () => {
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await provider.close();
    await rm(root, { recursive: true, force: true });
  });
  const taskId = "turn-level-task";
  const runId = "main-turn-level";
  Object.assign(process.env, {
    COWORK_API_BASE: provider.baseUrl,
    COWORK_API_KEY: "{{SECRET_kdvqcozt}}",
    COWORK_MODEL: "turn-model",
    COWORK_CONFIG: join(root, "config.json"),
    COWORK_WORKSPACE: root,
    COWORK_TASK_ID: taskId,
    COWORK_RUN_ID: runId,
    COWORK_REASONING_EFFORT: "max",
    COWORK_SUPPORTS_REASONING_EFFORT: "1",
    COWORK_MAIN_MODEL_FROM_CONFIG: "1"
  });
  await writeFile(
    process.env.COWORK_CONFIG,
    JSON.stringify({
      modelConnections: {
        version: 1,
        activeId: "a",
        profiles: [
          {
            id: "a",
            contextId: "ctx-a",
            name: "连接",
            baseUrl: provider.baseUrl,
            model: "turn-model",
            api: "openai-completions",
            apiKey: "{{SECRET_kdvqcozt}}",
            supportsImages: false,
            supportsReasoningEffort: true,
            supportsPromptCacheKey: false,
            reasoningEffort: "max",
            mainMaxTokens: 8192,
            subagentMaxTokens: 8192,
            contextWindow: 256000
          }
        ]
      }
    })
  );
  await new LocalWorkspaceStore(root).createTask(taskId, { goal: "打开回合的消息决定档位" });
  await new LocalWorkspaceStore(root).createRun(taskId, runId);
  // Two accepted messages: the later one rewrote the Run's input file before
  // the earlier one opened its turn.
  const records = join(root, taskId, "sessions", "main", "user-inputs");
  await mkdir(records, { recursive: true });
  const accepted = (messageId, prompt, thinkingLevel) =>
    JSON.stringify({
      version: 1,
      prompt,
      submittedAt: Date.now(),
      taskId,
      runId,
      thinkingLevel,
      messageId,
      source: "composer",
      accepted: true
    });
  await writeFile(join(records, "message-a.json"), accepted("message-a", "A", "low"));
  await writeFile(join(records, "message-b.json"), accepted("message-b", "B", "high"));
  await writeFile(
    join(root, taskId, "runs", runId, "main-input.json"),
    JSON.stringify({
      version: 1,
      prompt: "B",
      submittedAt: Date.now(),
      taskId,
      runId,
      thinkingLevel: "high",
      messageId: "message-b",
      source: "composer"
    })
  );

  const pi = fakePi();
  await (
    await loadExtension()
  )(pi);
  const start = pi.handlers.get("before_agent_start");
  await start({
    systemPrompt: "Baseline rules",
    messageType: "user",
    prompt: queuedUserTurn({ taskId, runId, messageId: "message-a", text: "A" })
  });
  assert.deepEqual(pi.levels, ["low"], "message A opened the turn with its own level");
  await start({
    systemPrompt: "Baseline rules",
    messageType: "user",
    prompt: queuedUserTurn({ taskId, runId, messageId: "message-b", text: "B" })
  });
  assert.deepEqual(pi.levels, ["low", "high"], "message B keeps its own level when its turn opens");
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
