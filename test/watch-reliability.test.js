import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ScriptWatcher } from "../dist/src/runtime/script-watcher.js";
import { WatcherRuntime } from "../dist/src/runtime/watcher.js";
import { WatchSupervisor } from "../dist/src/runtime/watch-supervisor.js";
import { WatchManagement } from "../dist/src/runtime/watch-management.js";
import { WatchProgramStore } from "../dist/src/runtime/watch-program-store.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-watch-reliable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalWorkspaceStore(root);
  await store.createTask("task", { goal: "monitor" });
  await store.createRun("task", "main-task");
  return {
    root,
    store,
    programs: new WatchProgramStore(root),
    management: new WatchManagement(root, resolve("."))
  };
}
async function script(t, rule) {
  const fixtureValue = await fixture(t);
  const directory = join(fixtureValue.root, "task", "agents", "subagents", "probe");
  await mkdir(join(directory, "watcher"), { recursive: true });
  await writeFile(join(directory, "watcher", "rule.mjs"), rule);
  return {
    ...fixtureValue,
    directory,
    watcher: new ScriptWatcher({
      watcherId: "probe",
      monitor: { task: "observe" },
      workDirectory: directory,
      timeoutMs: 300
    })
  };
}
const eventRule =
  'export default (c) => ({state:{n:(c.previousState.n??0)+1},events:[{source:"fixture",type:"changed",dedupeKey:"event-1",payload:{value:1}}]});';

test("cursor and outbox survive a process restart before Inbox delivery", async (t) => {
  const { root, directory, watcher } = await script(t, eventRule);
  const first = await watcher.poll();
  await rm(join(directory, "watcher", "rule.mjs"));
  const restarted = new ScriptWatcher({
    watcherId: "probe",
    monitor: { task: "observe" },
    workDirectory: directory
  });
  assert.deepEqual(
    await restarted.poll(),
    first,
    "pending evidence is delivered without rerunning the missing source"
  );
  const runtime = new WatcherRuntime({ workspaceRoot: root, taskId: "task", runId: "main-task" });
  assert.equal((await runtime.poll(restarted)).accepted, 1);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "watcher", "checkpoint.json"), "utf8")).events,
    []
  );
  const inbox = new InboxStore(join(root, "task", "runs", "main-task", "agents", "main", "inbox-store.json"));
  assert.equal((await inbox.list("main")).length, 1);
});

test("failed delivery leaves evidence in the outbox for retry", async (t) => {
  const { directory, watcher } = await script(t, eventRule);
  const event = (await watcher.poll())[0];
  const runtime = new WatcherRuntime({ workspaceRoot: directory, taskId: "task", runId: "main-task" });
  runtime.ingest = async () => {
    throw new Error("disk unavailable");
  };
  assert.match((await runtime.poll(watcher)).failed, /disk unavailable/);
  assert.equal((await watcher.poll())[0].dedupeKey, event.dedupeKey);
});

test("malformed events and staged writeState cannot advance the cursor", async (t) => {
  const { directory, watcher } = await script(
    t,
    'export default async c => { await c.writeState({lost:true}); return {state:{lost:true},events:[{source:"x".repeat(513),dedupeKey:"bad"}]}; };'
  );
  await assert.rejects(watcher.poll(), /source must/);
  await assert.rejects(readFile(join(directory, "watcher", "checkpoint.json")), { code: "ENOENT" });
});

test("a CPU-bound rule is killed and cannot stall the supervisor", async (t) => {
  const { watcher } = await script(t, "export default () => { for (;;) {} }; ");
  const start = Date.now();
  await assert.rejects(watcher.poll(), /timed out/);
  assert.ok(Date.now() - start < 3000);
});

test("both scopes are durable and direct thresholds have zero observer model calls", async (t) => {
  const { root, programs, management, store } = await fixture(t);
  const source = join(root, "metric.json");
  const write = async (value) =>
    writeFile(
      source,
      JSON.stringify({ metric: "loss", unit: "ratio", value, observedAt: new Date().toISOString() })
    );
  await write(0);
  const input = {
    task: "loss above 2",
    template: "metric-threshold",
    source,
    config: { metric: "loss", unit: "ratio", threshold: 2, consecutiveSamples: 1 },
    cadenceSeconds: 60
  };
  const session = await management.create("task", "main-task", input);
  const background = await management.create("task", "main-task", { ...input, scope: "background" });
  assert.equal(session.activated, true);
  assert.equal(background.activated, true);
  assert.notEqual(background.taskId, session.taskId);
  assert.equal((await store.readTask(background.taskId)).status, "waiting");
  assert.deepEqual((await store.readTask(background.taskId)).monitoring, {
    scope: "background",
    sourceTaskId: "task"
  });
  let calls = 0;
  const supervisor = new WatchSupervisor({
    workspaceRoot: root,
    baseUrl: "fixture",
    apiKey: "k",
    executor: async () => {
      calls++;
      throw new Error("direct event cannot call an observer model");
    }
  });
  for (const result of [session, background])
    await programs.updateVirtualAgentState(result.taskId, result.programId, result.monitorId, {
      lastCheckedAt: "1970-01-01T00:00:00Z"
    });
  const quiet = await supervisor.runCycle();
  assert.equal(quiet.accepted, 0);
  assert.equal(calls, 0);
  await write(3);
  for (const result of [session, background])
    await programs.updateVirtualAgentState(result.taskId, result.programId, result.monitorId, {
      lastCheckedAt: "1970-01-01T00:00:00Z"
    });
  const changed = await supervisor.runCycle();
  assert.equal(changed.accepted, 2);
  assert.equal(changed.wakeRequests, 2);
  assert.equal(calls, 0);
  assert.equal((await supervisor.runCycle()).accepted, 0);
});

test("closed tasks, paused monitors and expired monitors stop polling", async (t) => {
  const { root, store, programs } = await fixture(t);
  const program = await programs.createProgram({ taskId: "task", subject: "x", objective: "x" });
  const monitor = await programs.createVirtualAgent({
    programId: program.programId,
    task: "x",
    activate: true,
    expiresAt: "2000-01-01T00:00:00Z"
  });
  let polls = 0;
  const supervisor = new WatchSupervisor({
    workspaceRoot: root,
    baseUrl: "fixture",
    apiKey: "k",
    pollerFactory: () => ({
      watcherId: monitor.monitorId,
      poll: async () => {
        polls++;
        return [];
      }
    })
  });
  await supervisor.runCycle();
  assert.equal(polls, 0);
  assert.equal((await programs.findVirtualAgent("task", monitor.monitorId)).monitor.status, "retired");
  await programs.updateVirtualAgent("task", program.programId, monitor.monitorId, {
    status: "paused",
    expiresAt: undefined
  });
  await supervisor.runCycle();
  assert.equal(polls, 0);
  await programs.updateVirtualAgent("task", program.programId, monitor.monitorId, { status: "active" });
  await store.transitionTask("task", "cancelled");
  await supervisor.runCycle();
  assert.equal(polls, 0);
});

test("daily observer budget retains deferred evidence and successful analysis is cached", async (t) => {
  const { root, programs } = await fixture(t);
  const program = await programs.createProgram({
    taskId: "task",
    subject: "topic",
    objective: "find changes"
  });
  const monitor = await programs.createVirtualAgent({
    programId: program.programId,
    task: "x",
    activate: true,
    cadenceSeconds: 60,
    maxModelRunsPerDay: 1
  });
  let sequence = 0,
    calls = 0;
  const supervisor = new WatchSupervisor({
    workspaceRoot: root,
    baseUrl: "fixture",
    apiKey: "k",
    pollerFactory: () => ({
      watcherId: monitor.monitorId,
      poll: async () => [
        {
          watcherId: monitor.monitorId,
          source: "fixture",
          type: "changed",
          dedupeKey: `item-${++sequence}`,
          payload: { sequence }
        }
      ]
    }),
    executor: async () => {
      calls++;
      return { status: "succeeded", response: "classification: relevant_change", artifacts: [] };
    }
  });
  await supervisor.runCycle();
  assert.equal(calls, 1);
  await programs.updateVirtualAgentState("task", program.programId, monitor.monitorId, {
    lastCheckedAt: "1970-01-01T00:00:00Z"
  });
  await supervisor.runCycle();
  assert.equal(calls, 1);
  const inbox = new InboxStore(
    join(root, "task", "runs", `watch-${program.programId}`, "agents", monitor.monitorId, "inbox-store.json")
  );
  assert.equal((await inbox.list(monitor.monitorId)).filter((entry) => entry.state !== "consumed").length, 1);
  const state = await programs.readVirtualAgentState("task", program.programId, monitor.monitorId);
  assert.equal(state.modelRunsToday, 1);
  assert.ok(state.retryAt);
});

test("concurrent supervisors serialize one task and respect cadence", async (t) => {
  const { root, programs } = await fixture(t);
  const program = await programs.createProgram({ taskId: "task", subject: "topic", objective: "x" });
  const monitor = await programs.createVirtualAgent({
    programId: program.programId,
    task: "x",
    activate: true,
    cadenceSeconds: 60
  });
  let polls = 0;
  const options = {
    workspaceRoot: root,
    baseUrl: "fixture",
    apiKey: "k",
    pollerFactory: () => ({
      watcherId: monitor.monitorId,
      poll: async () => {
        polls++;
        await new Promise((done) => setTimeout(done, 60));
        return [];
      }
    })
  };
  await Promise.all([new WatchSupervisor(options).runCycle(), new WatchSupervisor(options).runCycle()]);
  assert.equal(polls, 1);
});

test("retrying a background template creation resolves to one durable instance", async (t) => {
  const { root, management, store } = await fixture(t);
  const source = join(root, "receipt.txt");
  await writeFile(source, "ready");
  const input = {
    task: "watch receipt",
    template: "resource-version",
    source,
    cadenceSeconds: 60,
    scope: "background"
  };
  const first = await management.create("task", "main-task", input);
  const retry = await management.create("task", "main-task", input);
  assert.equal(first.monitorId, retry.monitorId);
  assert.equal(first.taskId, retry.taskId);
  assert.equal((await store.listTasks()).length, 2);
});

test("direct events also respect the Main wake budget and retain excess evidence", async (t) => {
  const { root, programs } = await fixture(t);
  const program = await programs.createProgram({ taskId: "task", subject: "topic", objective: "x" });
  const monitor = await programs.createVirtualAgent({
    programId: program.programId,
    task: "x",
    activate: true,
    cadenceSeconds: 60,
    eventMode: "direct",
    maxWakeRequestsPerDay: 1
  });
  let sequence = 0;
  const supervisor = new WatchSupervisor({
    workspaceRoot: root,
    baseUrl: "fixture",
    apiKey: "k",
    pollerFactory: () => ({
      watcherId: monitor.monitorId,
      poll: async () => [
        {
          watcherId: monitor.monitorId,
          source: "fixture",
          type: "changed",
          dedupeKey: `item-${++sequence}`,
          payload: { sequence }
        }
      ]
    })
  });
  assert.equal((await supervisor.runCycle()).wakeRequests, 1);
  await programs.updateVirtualAgentState("task", program.programId, monitor.monitorId, {
    lastCheckedAt: "1970-01-01T00:00:00Z"
  });
  assert.equal((await supervisor.runCycle()).wakeRequests, 0);
  const state = await programs.readVirtualAgentState("task", program.programId, monitor.monitorId);
  assert.equal(state.wakeRequestsToday, 1);
  assert.match(state.lastSummary, /唤醒预算/);
  const inbox = new InboxStore(
    join(root, "task", "runs", `watch-${program.programId}`, "agents", monitor.monitorId, "inbox-store.json")
  );
  assert.equal((await inbox.list(monitor.monitorId)).filter((entry) => entry.state !== "consumed").length, 1);
});

test("a cached successful analysis survives failure to enqueue the Main wake", async (t) => {
  const { root, programs, store } = await fixture(t);
  const program = await programs.createProgram({ taskId: "task", subject: "topic", objective: "x" });
  const monitor = await programs.createVirtualAgent({
    programId: program.programId,
    task: "x",
    activate: true,
    cadenceSeconds: 60
  });
  const mainRunId = "main-task";
  const mainPath = join(root, "task", "runs", mainRunId, "agents", "main", "inbox-store.json");
  let calls = 0;
  const options = {
    workspaceRoot: root,
    baseUrl: "fixture",
    apiKey: "k",
    pollerFactory: () => ({
      watcherId: monitor.monitorId,
      poll: async () => [
        {
          watcherId: monitor.monitorId,
          source: "fixture",
          type: "changed",
          dedupeKey: "stable-event",
          payload: { title: "new" }
        }
      ]
    }),
    executor: async () => {
      calls++;
      // Fail at the actual durable Inbox write, after the calculation has
      // completed. The old private enqueue helper no longer owns this path.
      await mkdir(mainPath, { recursive: true });
      return { status: "succeeded", response: "classification: relevant_change", artifacts: [] };
    }
  };
  const failed = await new WatchSupervisor(options).runCycle();
  assert.equal(failed.failures.length, 1);
  assert.match(failed.failures[0].error, /EISDIR/);
  assert.equal(calls, 1);
  const saved = await programs.readVirtualAgentState("task", program.programId, monitor.monitorId);
  assert.equal(saved.pendingWake.runId, mainRunId);
  assert.equal(saved.pendingWake.message.payload.summary, "classification: relevant_change");
  const sourceInbox = new InboxStore(
    join(root, "task", "runs", `watch-${program.programId}`, "agents", monitor.monitorId, "inbox-store.json")
  );
  assert.equal((await sourceInbox.list(monitor.monitorId))[0].state, "ready");
  await rm(mainPath, { recursive: true });
  await store.updateTask("task", { activeRunId: "main-newer" });
  const restarted = new WatchSupervisor({
    ...options,
    executor: async () => assert.fail("a committed analysis must survive supervisor replacement")
  });
  const recovered = await restarted.runCycle();
  assert.deepEqual(recovered.failures, []);
  assert.equal(recovered.wakeRequests, 1);
  assert.equal(calls, 1, "the model result was not regenerated");
  const mainInbox = new InboxStore(mainPath);
  const [wake] = await mainInbox.list("main");
  assert.equal(wake.messageId, saved.pendingWake.message.messageId);
  assert.deepEqual(wake.payload, saved.pendingWake.message.payload);
  assert.deepEqual(
    await new InboxStore(join(root, "task", "runs", "main-newer", "agents", "main", "inbox-store.json")).list(
      "main"
    ),
    [],
    "a later active Run cannot steal the committed notification"
  );
  assert.equal((await sourceInbox.list(monitor.monitorId))[0].state, "consumed");
  const final = await programs.readVirtualAgentState("task", program.programId, monitor.monitorId);
  assert.equal(final.pendingWake, undefined);
  assert.equal(final.modelRunCount, 1);
  assert.equal(final.wakeRequestsToday, 1, "retrying the same wake keeps its original reservation");
  await restarted.runCycle();
  assert.equal((await mainInbox.list("main")).length, 1);
  assert.equal(calls, 1);
});

test("a source failure is visible and retries back off without model calls", async (t) => {
  const { root, programs } = await fixture(t);
  const program = await programs.createProgram({ taskId: "task", subject: "topic", objective: "x" });
  const monitor = await programs.createVirtualAgent({
    programId: program.programId,
    task: "x",
    activate: true,
    cadenceSeconds: 60
  });
  let polls = 0;
  const supervisor = new WatchSupervisor({
    workspaceRoot: root,
    baseUrl: "fixture",
    apiKey: "k",
    pollerFactory: () => ({
      watcherId: monitor.monitorId,
      poll: async () => {
        polls++;
        throw new Error("source unavailable");
      }
    })
  });
  assert.equal((await supervisor.runCycle()).failures.length, 1);
  assert.equal((await supervisor.runCycle()).polled, 0);
  assert.equal(polls, 1);
  const state = await programs.readVirtualAgentState("task", program.programId, monitor.monitorId);
  assert.equal(state.status, "failed");
  assert.ok(Date.parse(state.retryAt) > Date.now());
});

test("an intentional pause stays quiet instead of waking a Main to undo the user's pause", async (t) => {
  const { root, programs } = await fixture(t);
  const { writeSleep } = await import("../dist/src/runtime/main-sleep.js");
  const program = await programs.createProgram({ taskId: "task", subject: "topic", objective: "x" });
  const monitor = await programs.createVirtualAgent({
    programId: program.programId,
    task: "x",
    activate: true
  });
  await writeSleep(root, "task", {
    runId: "main-task",
    reason: "wait",
    monitorIds: [monitor.monitorId],
    parkedAt: new Date().toISOString()
  });
  await programs.updateVirtualAgent("task", program.programId, monitor.monitorId, { status: "paused" });
  assert.equal(
    (await new WatchSupervisor({ workspaceRoot: root, baseUrl: "fixture", apiKey: "k" }).runCycle())
      .parkWakes,
    0
  );
});

test("restarting the real Dashboard discovers background instances and keeps their baseline", async (t) => {
  const { startDashboard } = await import("./dashboard-fixture.mjs");
  const { root } = await fixture(t);
  const source = join(root, "stable.txt");
  await writeFile(source, "stable");
  const dashboard = await startDashboard({ workspace: root, monitoring: true, defaultProject: false });
  try {
    const created = await (
      await fetch(`${dashboard.base}/api/monitors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task: "restart watcher",
          template: "resource-version",
          source,
          config: { stableChecks: 1 },
          cadenceSeconds: 60
        })
      })
    ).json();
    assert.equal(created.activated, true);
    await dashboard.restart();
    const list = await (await fetch(`${dashboard.base}/api/monitors`)).json();
    assert.equal(list.monitors[0].monitorId, created.monitorId);
    assert.equal(list.monitors[0].scope, "background");
    const programs = new WatchProgramStore(root);
    await programs.updateVirtualAgentState(created.taskId, created.programId, created.monitorId, {
      lastCheckedAt: "1970-01-01T00:00:00Z"
    });
    const deadline = Date.now() + 5000;
    let state;
    do {
      await new Promise((done) => setTimeout(done, 100));
      state = await programs.readVirtualAgentState(created.taskId, created.programId, created.monitorId);
    } while (!(state.checkCount > 0) && Date.now() < deadline);
    assert.equal(state.checkCount, 1);
    assert.equal(state.eventCount, 0, "restart did not replay the baseline as a change");
  } finally {
    await dashboard.stop();
  }
});

test("pausing while an analysis is in flight returns promptly and suppresses its Main wake", async (t) => {
  const { root, programs, management } = await fixture(t);
  const program = await programs.createProgram({ taskId: "task", subject: "topic", objective: "x" });
  const monitor = await programs.createVirtualAgent({
    programId: program.programId,
    task: "x",
    activate: true
  });
  let started, finish;
  const running = new Promise((done) => {
    started = done;
  });
  const held = new Promise((done) => {
    finish = done;
  });
  const supervisor = new WatchSupervisor({
    workspaceRoot: root,
    baseUrl: "fixture",
    apiKey: "k",
    pollerFactory: () => ({
      watcherId: monitor.monitorId,
      poll: async () => [
        {
          watcherId: monitor.monitorId,
          source: "fixture",
          type: "changed",
          dedupeKey: "inflight",
          payload: { value: 1 }
        }
      ]
    }),
    executor: async () => {
      started();
      await held;
      return { status: "succeeded", response: "classification: relevant_change", artifacts: [] };
    }
  });
  const cycle = supervisor.runCycle();
  await running;
  const now = Date.now();
  await management.control("task", monitor.monitorId, "pause");
  assert.ok(Date.now() - now < 1000, "pause did not wait for the model run");
  finish();
  const result = await cycle;
  assert.equal(result.wakeRequests, 0);
  assert.equal((await programs.findVirtualAgent("task", monitor.monitorId)).monitor.status, "paused");
});

test("missing model credentials retain semantic events without spending a model attempt", async (t) => {
  const { root, programs } = await fixture(t);
  const program = await programs.createProgram({ taskId: "task", subject: "topic", objective: "x" });
  const monitor = await programs.createVirtualAgent({
    programId: program.programId,
    task: "x",
    activate: true
  });
  const supervisor = new WatchSupervisor({
    workspaceRoot: root,
    baseUrl: "",
    apiKey: "",
    pollerFactory: () => ({
      watcherId: monitor.monitorId,
      poll: async () => [
        {
          watcherId: monitor.monitorId,
          source: "fixture",
          type: "changed",
          dedupeKey: "no-model",
          payload: { title: "new" }
        }
      ]
    })
  });
  const cycle = await supervisor.runCycle();
  assert.equal(cycle.accepted, 1);
  assert.equal(cycle.processed, 0);
  const state = await programs.readVirtualAgentState("task", program.programId, monitor.monitorId);
  assert.equal(state.modelRunCount ?? 0, 0);
  assert.equal(state.deferredReason, "model_unconfigured");
});

test("persistent probe failures alert Main once instead of silently leaving a parked goal blind", async (t) => {
  const { root, programs } = await fixture(t);
  const program = await programs.createProgram({ taskId: "task", subject: "topic", objective: "x" });
  const monitor = await programs.createVirtualAgent({
    programId: program.programId,
    task: "x",
    activate: true,
    cadenceSeconds: 60
  });
  const supervisor = new WatchSupervisor({
    workspaceRoot: root,
    baseUrl: "fixture",
    apiKey: "k",
    pollerFactory: () => ({
      watcherId: monitor.monitorId,
      poll: async () => {
        throw new Error("source unavailable");
      }
    })
  });
  for (let i = 0; i < 4; i++) {
    await programs.updateVirtualAgentState("task", program.programId, monitor.monitorId, {
      lastCheckedAt: "1970-01-01T00:00:00Z",
      retryAt: undefined,
      pollRetryAt: undefined
    });
    const cycle = await supervisor.runCycle();
    assert.equal(cycle.wakeRequests, i === 2 ? 1 : 0);
  }
  const inbox = new InboxStore(join(root, "task", "runs", "main-task", "agents", "main", "inbox-store.json"));
  assert.equal((await inbox.list("main")).length, 1);
  assert.match((await inbox.list("main"))[0].payload.summary, /source unavailable/);
});

test("a daily source retries at its failure deadline instead of waiting another day", async (t) => {
  const { root, programs } = await fixture(t);
  const program = await programs.createProgram({ taskId: "task", subject: "topic", objective: "x" });
  const monitor = await programs.createVirtualAgent({
    programId: program.programId,
    task: "x",
    activate: true,
    cadenceSeconds: 86400
  });
  let polls = 0;
  const supervisor = new WatchSupervisor({
    workspaceRoot: root,
    baseUrl: "fixture",
    apiKey: "k",
    pollerFactory: () => ({
      watcherId: monitor.monitorId,
      poll: async () => {
        if (++polls === 1) throw new Error("source unavailable");
        return [];
      }
    })
  });
  await supervisor.runCycle();
  await programs.updateVirtualAgentState("task", program.programId, monitor.monitorId, {
    retryAt: "1970-01-01T00:00:00Z",
    pollRetryAt: "1970-01-01T00:00:00Z"
  });
  await supervisor.runCycle();
  assert.equal(polls, 2);
  const state = await programs.readVirtualAgentState("task", program.programId, monitor.monitorId);
  assert.equal(state.status, "active");
  assert.match(state.lastSummary, /已恢复/);
});

test("a monitoring Main failure keeps its goal recoverable with a bounded daily retry budget", async (t) => {
  const { root, programs, store } = await fixture(t);
  const { recoverWatchMain } = await import("../dist/src/runtime/watch-recovery.js");
  const program = await programs.createProgram({ taskId: "task", subject: "topic", objective: "x" });
  await programs.createVirtualAgent({ programId: program.programId, task: "x", activate: true });
  for (let i = 0; i < 8; i++) assert.equal(await recoverWatchMain(root, "task", "main-task", true), true);
  assert.equal((await store.readTask("task")).watchRecovery.retries, 6);
  const inbox = new InboxStore(join(root, "task", "runs", "main-task", "agents", "main", "inbox-store.json"));
  assert.equal((await inbox.list("main")).length, 6);
  await store.transitionTask("task", "cancelled");
  assert.equal(await recoverWatchMain(root, "task", "main-task", true), false);
});

test("a short successful Main clears crash backoff before the next real event", async (t) => {
  const { root } = await fixture(t);
  const { MainSupervisor, resetMainSupervisorBackoff } =
    await import("../dist/src/runtime/main-supervisor.js");
  const inbox = new InboxStore(join(root, "task", "runs", "main-task", "agents", "main", "inbox-store.json"));
  await inbox.enqueue({
    messageId: "work",
    recipientAgentId: "main",
    kind: "external_event",
    eventId: "work",
    priority: 1,
    state: "ready",
    createdAt: new Date().toISOString(),
    payload: { type: "fixture" }
  });
  const supervisor = new MainSupervisor({ workspaceRoot: root, launch: () => {} });
  assert.equal((await supervisor.runCycle()).resumed, 1);
  assert.equal((await supervisor.runCycle()).resumed, 0);
  await resetMainSupervisorBackoff(root, "task");
  assert.equal((await supervisor.runCycle()).resumed, 1);
});

test("paused monitors suppress watch failure retries", async (t) => {
  const { root, programs, store } = await fixture(t);
  const { recoverWatchMain } = await import("../dist/src/runtime/watch-recovery.js");
  const program = await programs.createProgram({ taskId: "task", subject: "paused", objective: "x" });
  const monitor = await programs.createVirtualAgent({
    programId: program.programId,
    task: "x",
    activate: true
  });
  await programs.updateVirtualAgent("task", program.programId, monitor.monitorId, { status: "paused" });
  assert.equal(await recoverWatchMain(root, "task", "main-task", true), true);
  assert.equal((await store.readTask("task")).watchRecovery, undefined);
  const inbox = new InboxStore(join(root, "task", "runs", "main-task", "agents", "main", "inbox-store.json"));
  assert.equal((await inbox.list("main")).length, 0);
});

test("a paused watch program does not suppress an ordinary user message", async (t) => {
  const { root, programs } = await fixture(t);
  const { MainSupervisor } = await import("../dist/src/runtime/main-supervisor.js");
  const program = await programs.createProgram({ taskId: "task", subject: "x", objective: "x" });
  await programs.createVirtualAgent({ programId: program.programId, task: "x", activate: true });
  await programs.updateProgram("task", program.programId, { status: "paused" });
  const inbox = new InboxStore(join(root, "task", "runs", "main-task", "agents", "main", "inbox-store.json"));
  await inbox.enqueue({
    messageId: "user",
    recipientAgentId: "main",
    kind: "human_command",
    eventId: "user",
    priority: 1,
    state: "ready",
    createdAt: new Date().toISOString(),
    payload: { type: "user.request" }
  });
  let launches = 0;
  assert.equal(
    (
      await new MainSupervisor({
        workspaceRoot: root,
        launch: () => {
          launches++;
        }
      }).runCycle()
    ).resumed,
    1
  );
  assert.equal(launches, 1);
});

test("the final event of a retired one-shot monitor can retry a failed Main", async (t) => {
  const { root, programs, store } = await fixture(t);
  const { recoverWatchMain } = await import("../dist/src/runtime/watch-recovery.js");
  const { MainSupervisor } = await import("../dist/src/runtime/main-supervisor.js");
  await store.updateTask("task", { monitoring: { scope: "background" } });
  const program = await programs.createProgram({ taskId: "task", subject: "once", objective: "report once" });
  const monitor = await programs.createVirtualAgent({
    programId: program.programId,
    task: "once",
    activate: true
  });
  await programs.updateVirtualAgent("task", program.programId, monitor.monitorId, { status: "retired" });
  assert.equal(await recoverWatchMain(root, "task", "main-task", true), true);
  assert.equal((await store.readTask("task")).watchRecovery.retries, 1);
  let launches = 0;
  assert.equal(
    (
      await new MainSupervisor({
        workspaceRoot: root,
        launch: () => {
          launches++;
        }
      }).runCycle()
    ).resumed,
    1
  );
  assert.equal(launches, 1);
});

test("analysis backoff keeps collecting evidence and source backoff does not block its later processing", async (t) => {
  const { root, programs } = await fixture(t);
  const program = await programs.createProgram({ taskId: "task", subject: "topic", objective: "x" });
  const monitor = await programs.createVirtualAgent({
    programId: program.programId,
    task: "x",
    activate: true
  });
  let polls = 0,
    modelCalls = 0,
    ready = false;
  const supervisor = new WatchSupervisor({
    workspaceRoot: root,
    baseUrl: "fixture",
    apiKey: "k",
    pollerFactory: () => ({
      watcherId: monitor.monitorId,
      poll: async () => {
        polls++;
        if (polls === 3) throw new Error("source outage");
        return [
          {
            watcherId: monitor.monitorId,
            source: "fixture",
            type: "changed",
            dedupeKey: `change-${polls}`,
            payload: { value: polls }
          }
        ];
      }
    }),
    executor: async () => {
      modelCalls++;
      if (!ready) throw new Error("model outage");
      return {
        status: "succeeded",
        response: "classification: relevant_change\nEvidence verified",
        artifacts: []
      };
    }
  });
  await supervisor.runCycle();
  const forcePoll = () =>
    programs.updateVirtualAgentState("task", program.programId, monitor.monitorId, {
      lastCheckedAt: "1970-01-01T00:00:00Z"
    });
  await forcePoll();
  assert.equal(
    (await supervisor.runCycle()).accepted,
    1,
    "cheap probes continue while the model is backing off"
  );
  assert.equal(modelCalls, 1);
  await forcePoll();
  await supervisor.runCycle();
  const failed = await programs.readVirtualAgentState("task", program.programId, monitor.monitorId);
  assert.ok(failed.pollRetryAt && failed.analysisRetryAt);
  ready = true;
  await programs.updateVirtualAgentState("task", program.programId, monitor.monitorId, {
    analysisRetryAt: undefined,
    retryAt: undefined
  });
  const drained = await supervisor.runCycle();
  assert.equal(drained.processed, 2, "captured evidence can be analyzed while the source is unavailable");
  assert.equal(drained.wakeRequests, 2);
  assert.equal(modelCalls, 3);
  assert.equal(polls, 3);
  const state = await programs.readVirtualAgentState("task", program.programId, monitor.monitorId);
  assert.equal(state.analysisFailures, 0);
  assert.equal(state.pollFailures, 1);
});
