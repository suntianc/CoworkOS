import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createDashboardRunService } from "../dist/src/dashboard/run-service.js";
import { UserMemoryStore } from "../dist/src/runtime/user-memory-store.js";
import { readJsonFile } from "../dist/src/dashboard/event-stream.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { WatchProgramStore } from "../dist/src/runtime/watch-program-store.js";
import { readSleep, writeSleep } from "../dist/src/runtime/main-sleep.js";
import { singleConnectionMainModel } from "./role-model-fixture.mjs";

const assistant = (stopReason, errorMessage) => ({
  role: "assistant",
  content: [{ type: "text", text: "隔离测试正文。" }],
  stopReason,
  ...(errorMessage ? { errorMessage } : {}),
  timestamp: 1
});
const event = (message) => `${JSON.stringify({ type: "message_end", message })}\n`;

test("project reassignment and run startup are serialized and cannot change a running session", async (t) => {
  const f = await fixture(t, { running: true });
  await f.service.withIdleProjectTasks(["task"], () =>
    f.store.updateTask("task", { projectDirectory: "/tmp/selected-project" })
  );
  assert.equal((await f.store.readTask("task")).projectDirectory, "/tmp/selected-project");
  const started = f.service.startMainRun("task", "保持运行", "project-run");
  const changed = f.service.withIdleProjectTasks(["task"], () =>
    f.store.updateTask("task", { projectDirectory: "/tmp/other-project" })
  );
  await assert.rejects(changed, /先停止项目/);
  await started;
  assert.equal((await f.store.readTask("task")).projectDirectory, "/tmp/selected-project");
});

test("a human resumption captured before message editing cannot launch into the replacement Run", async (t) => {
  const f = await fixture(t, {});
  await f.store.updateTask("task", { activeRunId: "replacement-run" });
  await assert.rejects(
    f.service.startMainRun("task", "late answer for old branch", "old-run", true, undefined, undefined, {
      source: "human"
    }),
    /所属运行已变更/
  );
  assert.equal(f.service.activeRuns.size, 0);
  assert.equal((await f.store.readTask("task")).activeRunId, "replacement-run");
  assert.equal(f.records.length, 0);
});

async function fixture(
  t,
  {
    previous,
    output = "",
    exitCode = 0,
    missingCwd = false,
    running = false,
    gate = false,
    onRunEvent,
    coordinator
  }
) {
  const root = await mkdtemp(join(tmpdir(), "atria-run-outcome-"));
  const memory = new UserMemoryStore(join(root, "user-memory.json"));
  const workspaceRoot = join(root, "workspace");
  const store = new LocalWorkspaceStore(workspaceRoot);
  await store.createTask("task", { goal: "只验证隔离子进程的状态归属。" });
  const contextPath = join(workspaceRoot, "task", "agents", "main", "context", "messages.json");
  await mkdir(join(contextPath, ".."), { recursive: true });
  await writeFile(contextPath, JSON.stringify(previous ? [previous] : []));
  await mkdir(join(root, "scripts"));
  const gatePath = join(root, "allow-exit");
  await writeFile(
    join(root, "scripts", "start-pi.mjs"),
    `import { access } from 'node:fs/promises';
     const data = Buffer.from(${JSON.stringify(output)});
     for (let index = 0; index < data.length; index += 1)
       await new Promise((done) => process.stdout.write(data.subarray(index, index + 1), done));
     process.exitCode = ${exitCode};
     ${gate ? `for (;;) { try { await access(${JSON.stringify(gatePath)}); break; } catch { await new Promise((done) => setTimeout(done, 10)); } }` : ""}
     ${running ? "setInterval(() => {}, 1000);" : ""}`
  );
  const records = [];
  const service = createDashboardRunService({
    userMemory: memory,
    projectRoot: missingCwd ? join(root, "does-not-exist") : root,
    tabStorePath: join(root, "tabs.json"),
    dashboardUrl: "http://127.0.0.1:1",
    coordinator: coordinator ?? {
      waitForSubagents: async () => ({ pending: [], callbackPending: [] })
    },
    locateTask: async () => ({ workspaceRoot, store, task: await store.readTask("task") }),
    resolveMainModel: singleConnectionMainModel(),
    normalizeModel: (value) => (typeof value === "string" ? value : undefined),
    appendRunEvent: async (_workspace, _task, _run, type, payload) => {
      records.push({ type, payload });
      await onRunEvent?.(type, payload);
    },
    readJsonFile
  });
  t.after(async () => {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  });
  async function settle() {
    for (let i = 0; i < 500; i += 1) {
      if (!service.activeRuns.size) return store.readTask("task");
      await delay(10);
    }
    assert.fail("The isolated subprocess did not settle");
  }
  return {
    service,
    memory,
    records,
    contextPath,
    settle,
    store,
    workspaceRoot,
    release: () => writeFile(gatePath, "")
  };
}

test("a process with no new assistant response cannot complete from a historical success", async (t) => {
  const f = await fixture(t, { previous: assistant("stop") });
  await f.service.startMainRun("task", "继续本次隔离请求。", "new-run");
  assert.equal((await f.settle()).status, "waiting");
  assert.equal(f.records.at(-1).type, "main.run_waiting");
  assert.equal(f.records.at(-1).payload.reason, "incomplete_response");
});

for (const stopReason of ["error", "aborted"])
  test(`a new process exit is not misclassified by a historical ${stopReason} response`, async (t) => {
    const f = await fixture(t, { previous: assistant(stopReason, "历史上游错误。"), exitCode: 2 });
    await f.service.startMainRun("task", "继续本次隔离请求。", "new-run");
    const task = await f.settle();
    assert.equal(task.status, "failed");
    assert.match(task.lastError, /code=2/);
    assert.doesNotMatch(task.lastError, /历史上游错误/);
    assert.equal(f.records.at(-1).payload.failure.kind, "main_process");
  });

test("current model error remains failed even when the durable snapshot still holds an old success", async (t) => {
  const previous = assistant("stop");
  const message = assistant("error", "服务暂不可用。诊断包含中文😀。");
  const f = await fixture(t, { previous, output: event(message) });
  await f.service.startMainRun("task", "继续本次隔离请求。", "new-run");
  const task = await f.settle();
  assert.equal(task.status, "failed");
  assert.equal(task.lastError, message.errorMessage);
  assert.equal(f.records.at(-1).payload.failure.kind, "model_request");
  assert.equal(f.records.at(-1).payload.failure.stopReason, "error");
  assert.deepEqual(
    JSON.parse(await readFile(f.contextPath, "utf8")),
    [previous],
    "classification preserves raw context"
  );
});

test("successful current retry is not rejected by its historical failed snapshot", async (t) => {
  const previous = assistant("error", "历史失败。");
  const output = event(assistant("error", "500 临时上游错误。")) + event(assistant("stop"));
  const f = await fixture(t, { previous, output });
  await f.store.updateTask("task", { activeRunId: "historical-run" });
  await f.service.startMainRun("task", "", "retry", true);
  assert.equal((await f.settle()).status, "completed");
  assert.equal(f.records.at(-1).type, "main.run_completed");
  assert.equal(
    f.records.some((record) => record.type === "main.run_failed"),
    false
  );
  assert.deepEqual(
    JSON.parse(await readFile(f.contextPath, "utf8")),
    [previous],
    "previous diagnostics are retained"
  );
});

test("empty input starts no new request and continuation requires a prior run", async (t) => {
  const f = await fixture(t, {});
  await assert.rejects(f.service.startMainRun("task", ""), /prompt must not be empty/);
  await assert.rejects(f.service.startMainRun("task", "", undefined, true), /没有可继续的请求/);
  assert.equal(f.service.activeRuns.size, 0);
  assert.equal(f.records.length, 0);
});

test("only an explicit provider status prefix enters the model failure diagnostic", async (t) => {
  const f = await fixture(t, { output: event(assistant("error", "429 请求频率超限。")) });
  await f.service.startMainRun("task", "继续本次隔离请求。", "rate-limited");
  assert.equal((await f.settle()).status, "failed");
  assert.equal(f.records.at(-1).payload.failure.httpStatus, 429);
});

test("ambiguous provider text does not acquire a guessed HTTP status or request ID", async (t) => {
  const f = await fixture(t, {
    output: event(assistant("error", "服务可能出现问题，或者参数不对，重试一下。"))
  });
  await f.service.startMainRun("task", "继续本次隔离请求。", "ambiguous");
  assert.equal((await f.settle()).status, "failed");
  assert.equal(Object.hasOwn(f.records.at(-1).payload.failure, "httpStatus"), false);
  assert.equal(Object.hasOwn(f.records.at(-1).payload.failure, "requestId"), false);
});

test("a spawn failure produces one durable failure with its actual cause", async (t) => {
  const f = await fixture(t, { missingCwd: true, previous: assistant("error", "历史失败。") });
  await f.service.startMainRun("task", "继续本次隔离请求。", "spawn-failure");
  const task = await f.settle();
  const failures = f.records.filter((record) => record.type === "main.run_failed");
  assert.equal(task.status, "failed");
  assert.equal(failures.length, 1);
  assert.match(task.lastError, /ENOENT/);
  assert.equal(failures[0].payload.failure.kind, "main_process");
});

test("a current interrupted response waits instead of completing its partial text", async (t) => {
  const f = await fixture(t, {
    previous: assistant("stop"),
    output: event(assistant("aborted")),
    exitCode: 1
  });
  await f.service.startMainRun("task", "继续本次隔离请求。", "interrupted");
  assert.equal((await f.settle()).status, "waiting");
  assert.equal(f.records.at(-1).payload.reason, "incomplete_response");
});

test("a new unfinished assistant response invalidates an earlier successful stop in the same process", async (t) => {
  const output =
    event(assistant("stop")) + `${JSON.stringify({ type: "message_start", message: assistant("stop") })}\n`;
  const f = await fixture(t, { previous: assistant("stop"), output });
  await f.service.startMainRun("task", "继续本次隔离请求。", "partial-stream");
  assert.equal((await f.settle()).status, "waiting");
});

test("explicit user cancellation remains cancelled without model failure finalization", async (t) => {
  const f = await fixture(t, { previous: assistant("error", "历史失败。"), running: true });
  await f.service.startMainRun("task", "继续本次隔离请求。", "cancelled");
  await f.service.cancelTask("task");
  assert.equal((await f.settle()).status, "cancelled");
  assert.equal(
    f.records.some((record) => record.type === "main.run_failed"),
    false
  );
});

test("cancellation still reaps its process when the cancellation event cannot be persisted", async (t) => {
  const cancelled = [];
  const f = await fixture(t, {
    running: true,
    coordinator: {
      waitForSubagents: async () => ({ pending: ["cleanup-error", "other-call"], callbackPending: [] }),
      cancelSubagent: async ({ callId }) => {
        cancelled.push(callId);
        if (callId === "cleanup-error") throw new Error("isolated subagent cancellation failure");
      }
    },
    onRunEvent: async (type) => {
      if (type === "main.run_cancelled") throw new Error("isolated cancellation event write failure");
    }
  });
  const watches = new WatchProgramStore(f.workspaceRoot);
  const program = await watches.createProgram({ taskId: "task", subject: "fixture", objective: "observe" });
  const monitor = await watches.createVirtualAgent({
    programId: program.programId,
    task: "observe",
    activate: true
  });
  await f.service.startMainRun("task", "等待用户停止。", "cancel-event-failure");
  await writeSleep(f.workspaceRoot, "task", {
    runId: "cancel-event-failure",
    reason: "observe",
    monitorIds: [monitor.monitorId],
    parkedAt: new Date().toISOString()
  });
  const child = f.service.activeRuns.get("task");
  await assert.rejects(f.service.cancelTask("task"), /isolated cancellation event write failure/);
  assert.deepEqual(
    cancelled.sort(),
    ["cleanup-error", "other-call"],
    "all pending calls receive cancellation"
  );
  assert.equal(f.service.activeRuns.has("task"), false, "stop failure must not leave the model running");
  assert.ok(child.exitCode !== null || child.signalCode !== null, "the child was reaped before returning");
  assert.equal((await f.store.readTask("task")).status, "cancelled");
  assert.equal(await readSleep(f.workspaceRoot, "task"), undefined);
  assert.equal(
    (await watches.readVirtualAgent("task", program.programId, monitor.monitorId)).status,
    "paused"
  );
  assert.equal(
    f.records.some((record) => record.type === "main.run_failed"),
    false
  );
});

test("shutdown drains an in-flight startup and rejects it without leaving a running Task", async (t) => {
  let releaseStartup;
  const startupGate = new Promise((resolve) => {
    releaseStartup = resolve;
  });
  let startupReached;
  const reached = new Promise((resolve) => {
    startupReached = resolve;
  });
  const f = await fixture(t, {
    running: true,
    onRunEvent: async (type) => {
      if (type !== "main.run_spawned") return;
      startupReached();
      await startupGate;
    }
  });
  const starting = f.service.startMainRun("task", "关闭过程中正在启动的请求。", "shutdown-startup");
  const rejected = assert.rejects(starting, /shutting down/);
  await reached;
  let stopped = false;
  const stopping = f.service.stop().then(() => {
    stopped = true;
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false, "shutdown waits for the already accepted startup operation");
  } finally {
    releaseStartup();
    await rejected;
    await stopping;
  }
  assert.equal(f.service.activeRuns.size, 0);
  assert.equal((await f.store.readTask("task")).status, "waiting");
});

test("shutdown drains a queued restart waiting on finalization without deadlocking", async (t) => {
  const { InboxStore } = await import("../dist/src/runtime/scheduler.js");
  let releaseFinalization;
  const finalizationGate = new Promise((resolve) => {
    releaseFinalization = resolve;
  });
  let finalizationReached;
  const reached = new Promise((resolve) => {
    finalizationReached = resolve;
  });
  const f = await fixture(t, {
    output: event(assistant("stop")),
    coordinator: {
      waitForSubagents: async () => {
        finalizationReached();
        await finalizationGate;
        return { pending: [], callbackPending: [] };
      }
    }
  });
  const run = await f.service.startMainRun("task", "先完成本轮。", "finalizing-run");
  await reached;
  const inbox = new InboxStore(join(f.store.root, "task", "runs", run.runId, "agents/main/inbox-store.json"));
  await inbox.enqueue({
    messageId: "waiting-restart",
    recipientAgentId: "main",
    kind: "human_command",
    eventId: "waiting-restart",
    priority: 120,
    state: "ready",
    createdAt: new Date().toISOString(),
    payload: { type: "human.message", message: "在当前回合结束后继续。", delivery: "followUp" }
  });
  const sending = f.service.queuedMessageAction("task", "waiting-restart", "send");
  const rejected = assert.rejects(sending, /shutting down/);
  const stopping = f.service.stop();
  releaseFinalization();
  await rejected;
  await stopping;
  assert.equal(f.service.activeRuns.size, 0);
  assert.notEqual((await f.store.readTask("task")).status, "running");
  assert.equal((await inbox.list())[0].state, "ready", "the rejected restart releases its message lease");
});

async function finishBeforeResponse(f) {
  await f.store.transitionTask("task", "completed", {
    runId: "finish-run",
    reason: "isolated_finish_task",
    completion: { signal: "finish_task", summary: "已有工具结果已核对。" }
  });
}

for (const [stopReason, status, exitCode] of [
  ["error", "failed", 0],
  ["aborted", "waiting", 1],
  ["stop", "completed", 0]
])
  test(`provisional finish_task followed by a current ${stopReason} settles as ${status}`, async (t) => {
    const f = await fixture(t, {
      output: event(assistant(stopReason, stopReason === "error" ? "真实的最终回复失败。" : undefined)),
      exitCode,
      gate: true
    });
    await f.service.startMainRun("task", "等待最终回复。", "finish-run");
    await finishBeforeResponse(f);
    await f.release();
    const task = await f.settle();
    assert.equal(task.status, status);
    assert.equal(
      f.records.at(-1).type,
      `main.run_${status === "completed" ? "completed" : status === "failed" ? "failed" : "waiting"}`
    );
    if (status === "completed") {
      assert.equal(task.completion.signal, "finish_task");
      assert.equal(task.completion.summary, "已有工具结果已核对。");
    } else assert.notEqual(task.completion.signal, "finish_task");
  });

test("cancelling a still-active provisional finish_task clears completion and settles as cancelled", async (t) => {
  const f = await fixture(t, { running: true });
  await f.service.startMainRun("task", "等待最终回复。", "finish-run");
  await finishBeforeResponse(f);
  await f.service.cancelTask("task");
  const task = await f.settle();
  assert.equal(task.status, "cancelled");
  assert.notEqual(task.completion.signal, "finish_task");
  assert.equal(
    f.records.some((record) => record.type === "main.run_failed"),
    false
  );
});

test("desktop shutdown leaves a still-active provisional finish_task waiting for continuation", async (t) => {
  const f = await fixture(t, { running: true });
  await f.service.startMainRun("task", "等待最终回复。", "finish-run");
  await finishBeforeResponse(f);
  await f.service.stop();
  const task = await f.settle();
  assert.equal(task.status, "waiting");
  assert.notEqual(task.completion.signal, "finish_task");
});

test("an older exiting process cannot reopen or fail another run's completed Task", async (t) => {
  const f = await fixture(t, { output: event(assistant("error", "旧运行的模型错误。")), gate: true });
  await f.service.startMainRun("task", "旧运行等待最终回复。", "old-run");
  await f.store.transitionTask("task", "completed", {
    runId: "newer-run",
    completion: { signal: "finish_task", summary: "新运行已完成。" }
  });
  const snapshot = await f.store.readTask("task");
  await f.release();
  assert.deepEqual(await f.settle(), snapshot);
  assert.equal(
    f.records.some((record) => record.type === "main.run_failed"),
    false
  );
});

for (const running of [true, false])
  test(`a final assistant response with a ${running ? "live" : "exited"} background job settles correctly`, async (t) => {
    const f = await fixture(t, { output: event(assistant("stop")), gate: true });
    await f.service.startMainRun("task", "后台任务状态验收", "job-run");
    const directory = join(f.store.root, "task", "runs", "job-run", "agents", "main", "jobs");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "job-1.json"),
      JSON.stringify({
        jobId: "job-1",
        pid: process.pid,
        command: "fixture",
        logPath: join(directory, "job-1.log"),
        startedAt: new Date().toISOString(),
        ...(running ? {} : { finishedAt: new Date().toISOString(), exitCode: 0 })
      })
    );
    await f.release();
    assert.equal((await f.settle()).status, running ? "waiting" : "completed");
    assert.equal(f.records.at(-1).payload.reason, running ? "pending_jobs" : "ready");
  });

test("a rejected queued-message restart releases its lease and leaves the message cancellable", async (t) => {
  const { InboxStore } = await import("../dist/src/runtime/scheduler.js");
  const f = await fixture(t, {});
  const run = await f.service.startMainRun("task", "first", "queue-retry");
  await f.settle();
  const inbox = new InboxStore(join(f.store.root, "task", "runs", run.runId, "agents/main/inbox-store.json"));
  await inbox.enqueue({
    messageId: "retry",
    recipientAgentId: "main",
    kind: "human_command",
    eventId: "retry",
    priority: 120,
    state: "ready",
    createdAt: new Date().toISOString(),
    payload: { type: "human.message", message: "keep this message", delivery: "followUp" }
  });
  await f.service.stop();
  await assert.rejects(f.service.queuedMessageAction("task", "retry", "send"), /shutting down/);
  assert.equal((await inbox.list())[0].state, "ready");
  assert.equal((await f.service.queuedMessageAction("task", "retry", "cancel")).cancelled, true);
});

test("accepted user input survives dashboard shutdown even when its task never completes", async (t) => {
  const f = await fixture(t, { running: true });
  await f.memory.setEnabled(true);
  await f.memory.setLearningEnabled(true);
  const text = "我平时喜欢简洁的工作邮件，帮我写一封组会通知。";
  await f.service.startMainRun("task", text, "unfinished-memory-run", false, undefined, undefined, {
    body: text
  });
  const beforeStore = new UserMemoryStore(f.memory.path);
  const before = await beforeStore.read();
  const inbox = (await readdir(`${f.memory.path}.inbox`)).filter((name) => name.endsWith(".json"));
  assert.equal(inbox.length, 1, "accepted speech is durable before the Main finishes");
  const intakePath = join(`${f.memory.path}.inbox`, inbox[0]);
  assert.equal(JSON.parse(await readFile(intakePath, "utf8")).inputs[0].text, text);
  assert.equal(await beforeStore.isForegroundActive(), true);
  assert.equal(before.pending.length, 0, "foreground leaves the private learning queue untouched");
  assert.equal(before.entries.length, 0);
  await f.service.stop();
  const restarted = new UserMemoryStore(f.memory.path);
  assert.equal(await restarted.isForegroundActive(), false);
  const intake = JSON.parse(await readFile(intakePath, "utf8"));
  assert.equal(intake.inputs[0].text, text, "shutdown preserves the accepted input");
  const quiet = JSON.parse(await readFile(`${f.memory.path}.quiet.json`, "utf8"));
  await restarted.drainForegroundLearning(quiet.availableAt - 1);
  assert.equal((await restarted.read()).pending.length, 0, "the idle minute still applies after restart");
  await restarted.drainForegroundLearning(Math.max(quiet.availableAt, intake.availableAt) + 1);
  const after = await restarted.read();
  assert.equal(after.pending.length, 1);
  assert.equal(after.pending[0].text, text);
  assert.equal(after.pending[0].active, false);
  assert.notEqual((await f.store.readTask("task")).status, "completed");
});
