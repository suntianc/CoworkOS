import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createDashboardRunService } from "../dist/src/dashboard/run-service.js";
import { readJsonFile } from "../dist/src/dashboard/event-stream.js";
import { RunService } from "../dist/src/runtime/run-service.js";
import { UserMemoryStore } from "../dist/src/runtime/user-memory-store.js";
import { createUserMemoryTool } from "../dist/src/runtime/user-memory-tools.js";
import { CheckpointStore } from "../dist/src/runtime/scheduler.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { emptyCompaction } from "../dist/src/runtime/agent-checkpoint.js";
import { createUserMemoryLearningService } from "../dist/src/runtime/user-memory-learning.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { singleConnectionMainModel } from "./role-model-fixture.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-memory-lifecycle-"));
  const previous = process.env.ATRIA_HOME;
  process.env.ATRIA_HOME = join(root, "home");
  t.after(async () => {
    if (previous === undefined) delete process.env.ATRIA_HOME;
    else process.env.ATRIA_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  const store = new UserMemoryStore();
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  return { root, store, workspace: join(root, "workspace") };
}

const input = (extra = {}) => ({
  taskId: "task",
  runId: "run",
  prompt: "我平时偏好简洁的中文回复。",
  baseUrl: "http://127.0.0.1:1/v1",
  apiKey: "fixture",
  tools: () => new Map(),
  ...extra
});

test("RunService releases accepted memory input when prepare fails and preserves the original error", async (t) => {
  const f = await fixture(t);
  const failure = new Error("prepare failed before the Pi session exists");
  await assert.rejects(
    new RunService(f.workspace).runPi(
      input({
        prepare: async () => {
          throw failure;
        }
      })
    ),
    (error) => error === failure
  );
  assert.equal(await f.store.isForegroundActive(), false);
  assert.equal((await f.store.read()).pending.length, 0, "foreground intake stays out of private metadata");
  const inbox = (await readdir(`${f.store.path}.inbox`)).filter((name) => name.endsWith(".json"));
  assert.equal(inbox.length, 1);
  const queued = JSON.parse(await readFile(join(`${f.store.path}.inbox`, inbox[0]), "utf8"));
  assert.match(queued.inputs[0].text, /简洁的中文回复/);
  await f.store.drainForegroundLearning(queued.availableAt + 1);
  const pending = (await f.store.read()).pending;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].active, false);
  assert.equal(pending[0].activeOwnerPid, undefined);
  assert.match(pending[0].text, /简洁的中文回复/);
});

test("RunService early checkpoint rejection releases an older pending Run of the Task", async (t) => {
  const f = await fixture(t);
  const workspace = new LocalWorkspaceStore(f.workspace);
  await workspace.createTask("task", { goal: "completed fixture" });
  const run = await workspace.createRun("task", "run");
  await new CheckpointStore(join(run, "checkpoint.json")).save({
    runId: "run",
    sequence: 1,
    savedAt: new Date().toISOString(),
    state: {
      version: 1,
      status: "succeeded",
      prompt: "already completed",
      messages: [],
      compaction: emptyCompaction()
    }
  });
  await f.store.enqueueLearning({ taskId: "task", runId: "older-run", text: "我平时喜欢简短回答。" });
  await assert.rejects(new RunService(f.workspace).runPi(input()), /already completed/);
  const pending = (await f.store.read()).pending[0];
  assert.equal(pending.runId, "older-run");
  assert.equal(pending.active, false);
  assert.equal(pending.activeOwnerPid, undefined);
});

test("memory tool changes use and learning independently and reports the stored flags", async (t) => {
  const f = await fixture(t);
  await f.store.setLearningEnabled(false);
  await f.store.setEnabled(false);
  const tool = createUserMemoryTool({
    store: f.store,
    taskId: "task",
    runId: "run",
    userText: () => "请开启使用记忆，然后单独开启自动学习，再关闭使用，最后关闭学习。"
  });
  const change = (action, quote) => tool.execute({ action, quote });
  assert.deepEqual(await change("enable", "开启使用记忆"), { enabled: true, learningEnabled: false });
  assert.deepEqual(await change("enable_learning", "开启自动学习"), {
    enabled: true,
    learningEnabled: true
  });
  assert.deepEqual(await change("disable", "关闭使用"), { enabled: false, learningEnabled: true });
  assert.deepEqual(await change("disable_learning", "关闭学习"), {
    enabled: false,
    learningEnabled: false
  });
  assert.deepEqual(await change("enable_learning", "开启自动学习"), {
    enabled: false,
    learningEnabled: true
  });
  const document = await f.store.read();
  assert.equal(document.enabled, false);
  assert.equal(document.learningEnabled, true);
});

test(
  "programmatic Main keeps older memory extraction off the foreground connection",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await f.store.enqueueLearning(
      { taskId: "older-task", runId: "older-run", text: "我平时喜欢简洁的中文工作邮件。" },
      0
    );
    let extractions = 0;
    const provider = await modelProtocolFixture("openai-completions", (body) => {
      if (JSON.stringify(body.messages).includes("Extract durable USER memory")) {
        extractions += 1;
        return { text: '{"changes":[]}' };
      }
      return { text: "当前任务完成" };
    });
    t.after(() => provider.close());
    const result = await new RunService(f.workspace).runPi(
      input({
        baseUrl: provider.baseUrl,
        model: "protocol-fixture",
        api: "openai-completions",
        thinkingLevel: "off",
        supportsReasoningEffort: false,
        timeoutMs: 5000
      })
    );
    assert.match(JSON.stringify(result.assistant), /当前任务完成/);
    assert.equal(extractions, 0);
    const pending = (await f.store.read()).pending.find((item) => item.taskId === "older-task");
    assert.ok(pending, "foreground execution must leave the older input queued");
    assert.equal(pending.attempts, 0);
  }
);

test(
  "Dashboard startup interrupts a background request before awaiting setup without counting a failure",
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-memory-foreground-"));
    const memory = new UserMemoryStore(join(root, "user-memory.json"));
    await memory.setEnabled(true);
    await memory.setLearningEnabled(true);
    await memory.enqueueLearning(
      { taskId: "older", runId: "older-run", text: "我平时喜欢简洁的中文回复。" },
      0
    );
    const workspaceRoot = join(root, "workspace");
    const workspace = new LocalWorkspaceStore(workspaceRoot);
    await workspace.createTask("task", { goal: "foreground fixture" });
    const before = await workspace.readTask("task");
    let extracting;
    const extractionStarted = new Promise((resolve) => {
      extracting = resolve;
    });
    let cancelled;
    const extractionCancelled = new Promise((resolve) => {
      cancelled = resolve;
    });
    const server = createServer(async (request, response) => {
      for await (const chunk of request) void chunk;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      response.once("close", () => {
        if (!response.writableEnded) cancelled();
      });
      extracting();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    let releaseLocation;
    const locationGate = new Promise((resolve) => {
      releaseLocation = resolve;
    });
    let enteredLocation;
    const locating = new Promise((resolve) => {
      enteredLocation = resolve;
    });
    let learning;
    const runs = createDashboardRunService({
      userMemory: memory,
      projectRoot: root,
      tabStorePath: join(root, "tabs.json"),
      dashboardUrl: "http://127.0.0.1:1",
      coordinator: { waitForSubagents: async () => ({ pending: [], callbackPending: [] }) },
      locateTask: async () => {
        enteredLocation();
        await locationGate;
        return { workspaceRoot, store: workspace, task: await workspace.readTask("task") };
      },
      resolveMainModel: singleConnectionMainModel({ baseUrl, model: "protocol-fixture" }),
      onRunStarting: () => learning.pause(),
      normalizeModel: (value) => (typeof value === "string" ? value : undefined),
      appendRunEvent: async () => {},
      readJsonFile
    });
    learning = createUserMemoryLearningService({
      store: memory,
      connection: () => ({
        baseUrl,
        apiKey: "fixture",
        model: "protocol-fixture",
        api: "openai-completions",
        thinkingLevel: "off",
        supportsReasoningEffort: false
      }),
      isTaskActive: () => false,
      isForegroundActive: () => runs.isBusy()
    });
    t.after(async () => {
      releaseLocation();
      await learning.stop();
      await runs.stop();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    learning.start();
    await extractionStarted;
    const starting = runs.startMainRun("task", "\0", "run");
    // Attach the rejection handler before releasing asynchronous validation.
    const rejected = assert.rejects(starting, /二进制字符/);
    await locating;
    assert.equal(runs.activeRuns.size, 0);
    assert.equal(runs.isBusy(), true, "startup is foreground work before a child exists");
    await Promise.race([
      extractionCancelled,
      delay(1000).then(() => {
        throw new Error("foreground startup did not cancel the model request");
      })
    ]);
    releaseLocation();
    await rejected;
    await learning.stop();
    assert.equal(runs.isBusy(), false);
    const after = await workspace.readTask("task");
    assert.equal(after.status, before.status, "invalid input must not change Task state");
    assert.equal(after.activeRunId, before.activeRunId);
    const pending = (await memory.read()).pending[0];
    assert.equal(pending.taskId, "older");
    assert.equal(pending.attempts, 0);
    assert.equal(pending.lastError, undefined);
  }
);
