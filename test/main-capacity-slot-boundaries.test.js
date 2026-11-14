import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createDashboardRunService } from "../dist/src/dashboard/run-service.js";
import { createMainCapacityService } from "../dist/src/dashboard/main-capacity-service.js";
import { readJsonFile } from "../dist/src/dashboard/event-stream.js";
import { MainCapacityStore } from "../dist/src/storage/main-capacity-store.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { singleConnectionMainModel } from "./role-model-fixture.mjs";

const TASK_ID = "task";
const RUN_ID = "run-1";
const SLOT_SETTINGS = { resident: 1, continuation: 0 };

/** Wait for an observable condition instead of guessing a fixed delay. */
async function waitFor(check, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(20);
  }
}

/**
 * The capacity sweeper's `slotIdle`: a paused Run with delegated work keeps its
 * place; one with nothing left releases it.
 */
async function capacityFixture(t, { unfinished }) {
  const root = await mkdtemp(join(tmpdir(), "p46-slot-idle-"));
  const store = new MainCapacityStore(join(root, "main-capacity", "state.json"));
  await store.update((state) => {
    state.slots = [
      {
        requestId: "request-paused",
        projectId: "project-1",
        sessionId: "session-1",
        taskId: TASK_ID,
        runId: RUN_ID,
        kind: "regular",
        host: hostname(),
        startedAt: new Date().toISOString()
      }
    ];
  });
  const service = createMainCapacityService({
    store,
    backendId: "backend-slot-test",
    settings: () => SLOT_SETTINGS,
    persistSettings: async () => {},
    projects: async () => [],
    sessions: async () => [],
    taskState: async () => ({ status: "paused", activeRunId: RUN_ID }),
    heartbeat: async () => ({
      pid: process.pid,
      host: hostname(),
      runId: RUN_ID,
      turnActive: false,
      updatedAt: new Date().toISOString()
    }),
    unfinishedWork: async () => unfinished
  });
  t.after(async () => {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { service, store };
}

test("a paused slot with unfinished delegated work is kept", async (t) => {
  const f = await capacityFixture(t, { unfinished: true });
  await f.service.recover();
  assert.equal(
    (await f.store.read()).slots.length,
    1,
    "a paused Main waiting on a Subagent still owns its place"
  );
});

test("a paused slot with no delegated work left is released", async (t) => {
  const f = await capacityFixture(t, { unfinished: false });
  await f.service.recover();
  assert.equal((await f.store.read()).slots.length, 0, "the turn ended and nothing is left to run");
});

/**
 * A dashboard run service over a fake resident Main whose settled event is
 * released by a signal file, a real capacity ledger, and a fake subagent port
 * so "unfinished work" is an input the test can set.
 */
async function runFixture(t, { unfinished, holdUnfinished = false }) {
  const root = await mkdtemp(join(tmpdir(), "p46-slot-boundary-"));
  const workspaceRoot = join(root, "workspace");
  const store = new LocalWorkspaceStore(workspaceRoot);
  await store.createTask(TASK_ID, { goal: "回合边界与名额。" });
  await mkdir(join(root, "scripts"), { recursive: true });
  const signalPath = join(root, "settle-signal");
  await writeFile(
    join(root, "scripts", "start-pi.mjs"),
    `import { access } from "node:fs/promises";
     await new Promise((done) =>
       process.stdout.write(${JSON.stringify(`${JSON.stringify({ type: "agent_start" })}\n`)}, done)
     );
     for (;;) {
       try { await access(${JSON.stringify(signalPath)}); break; }
       catch { await new Promise((done) => setTimeout(done, 10)); }
     }
     await new Promise((done) =>
       process.stdout.write(${JSON.stringify(`${JSON.stringify({ type: "agent_settled", aborted: false })}\n`)}, done)
     );
     setInterval(() => {}, 1000);`
  );
  const capacityStore = new MainCapacityStore(join(root, "capacity", "state.json"));
  const capacity = createMainCapacityService({
    store: capacityStore,
    backendId: "backend-boundary-test",
    settings: () => SLOT_SETTINGS,
    persistSettings: async () => {},
    projects: async () => [],
    sessions: async () => [],
    taskState: async () => ({ status: (await store.readTask(TASK_ID)).status, activeRunId: RUN_ID }),
    heartbeat: async () => undefined,
    unfinishedWork: async () => unfinished
  });
  const unfinishedCalls = [];
  const releases = [];
  let releaseUnfinished;
  const unfinishedGate = new Promise((done) => {
    releaseUnfinished = done;
  });
  const port = {
    ...capacity,
    releaseIfCurrent: async (taskId, runId, requestId) => {
      releases.push(requestId);
      return capacity.releaseIfCurrent(taskId, runId, requestId);
    }
  };
  const service = createDashboardRunService({
    projectRoot: root,
    dashboardUrl: "http://127.0.0.1:1",
    coordinator: { waitForSubagents: async () => ({ pending: [], callbackPending: [] }) },
    subagents: {
      cancel: async () => {},
      unfinishedWork: async () => {
        unfinishedCalls.push(Date.now());
        if (holdUnfinished) await unfinishedGate;
        return unfinished;
      }
    },
    locateTask: async () => ({
      workspaceRoot,
      store,
      task: await store.readTask(TASK_ID),
      projectId: "project-1",
      projectName: "P",
      projectDirectory: workspaceRoot
    }),
    mainSessions: {
      resolve: async () => ({ sessionId: "session-1", entryKind: "external", kind: "regular" })
    },
    mainCapacity: port,
    resolveMainModel: singleConnectionMainModel(),
    normalizeModel: (value) => (typeof value === "string" ? value : undefined),
    appendRunEvent: async () => {},
    readJsonFile
  });
  t.after(async () => {
    await service.stop();
    await endResidentMains(workspaceRoot);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const settle = async () => {
    await writeFile(signalPath, "settled\n");
  };
  const slots = async () => (await capacityStore.read()).slots;
  const pause = async () => {
    await store.transitionTask(TASK_ID, "running", { runId: RUN_ID });
    await store.transitionTask(TASK_ID, "paused", { runId: RUN_ID });
  };
  return {
    service,
    store,
    capacityStore,
    unfinishedCalls,
    releases,
    settle,
    slots,
    pause,
    releaseUnfinished
  };
}

/** End every fake resident Main this test left behind, by its recorded group. */
async function endResidentMains(workspaceRoot) {
  const runs = await readdir(join(workspaceRoot, TASK_ID, "runs")).catch(() => []);
  for (const runId of runs) {
    const record = await readFile(
      join(workspaceRoot, TASK_ID, "runs", runId, "agents", "main", "process.json"),
      "utf8"
    )
      .then((value) => JSON.parse(value))
      .catch(() => undefined);
    if (!record?.pid) continue;
    try {
      process.kill(-record.pid, "SIGKILL");
    } catch {
      /* the fake process already exited */
    }
  }
}

test("a paused turn with unfinished delegated work releases no slot", async (t) => {
  const f = await runFixture(t, { unfinished: true });
  const started = f.service.startMainRun(TASK_ID, "first turn", RUN_ID);
  await started;
  await waitFor(async () => (await f.slots()).length === 1, "the admitted slot");
  await f.pause();
  await f.settle();
  await waitFor(() => f.unfinishedCalls.length > 0, "the boundary to consult delegated work");
  assert.equal((await f.slots()).length, 1, "the paused Main still owns its place");
  assert.deepEqual(f.releases, [], "nothing released the place its Subagent still uses");
});

test("a paused turn with no delegated work left releases its slot", async (t) => {
  const f = await runFixture(t, { unfinished: false });
  await f.service.startMainRun(TASK_ID, "first turn", RUN_ID);
  await waitFor(async () => (await f.slots()).length === 1, "the admitted slot");
  await f.pause();
  await f.settle();
  await waitFor(async () => (await f.slots()).length === 0, "the boundary to release the place");
  assert.equal(f.releases.length, 1, "the release names the claim of that boundary");
});

test("an admission between the boundary and its release keeps the newer claim", async (t) => {
  const f = await runFixture(t, { unfinished: false, holdUnfinished: true });
  await f.service.startMainRun(TASK_ID, "first turn", RUN_ID);
  await waitFor(async () => (await f.slots()).length === 1, "the admitted slot");
  await f.pause();
  const boundaryClaim = (await f.slots())[0].requestId;
  await f.settle();
  await waitFor(() => f.unfinishedCalls.length > 0, "the boundary to reach its release decision");
  // An admission for the same Run lands between the boundary and its release:
  // the ledger now holds a newer claim.
  await f.capacityStore.update((state) => {
    state.slots = state.slots.map((slot) => ({ ...slot, requestId: "request-newer" }));
  });
  f.releaseUnfinished();
  await waitFor(() => f.releases.length > 0, "the boundary to attempt its release");
  assert.deepEqual(f.releases, [boundaryClaim], "the boundary names the claim it ran under");
  assert.deepEqual(
    (await f.slots()).map((slot) => slot.requestId),
    ["request-newer"],
    "the admission made after the boundary keeps its place"
  );
});

test("a release names the claim it is for and keeps a newer one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p46-slot-claim-"));
  const store = new MainCapacityStore(join(root, "state.json"));
  const startedAt = new Date().toISOString();
  const slot = (requestId) => ({
    requestId,
    projectId: "project-1",
    sessionId: "session-1",
    taskId: TASK_ID,
    runId: RUN_ID,
    kind: "regular",
    host: hostname(),
    startedAt
  });
  await store.update((state) => {
    state.slots = [slot("request-old")];
  });
  const service = createMainCapacityService({
    store,
    backendId: "backend-claim-test",
    settings: () => SLOT_SETTINGS,
    persistSettings: async () => {},
    projects: async () => [],
    sessions: async () => [],
    taskState: async () => undefined,
    heartbeat: async () => undefined,
    unfinishedWork: async () => false
  });
  t.after(async () => {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  });
  // A later admission replaces the claim before the late boundary arrives.
  await store.update((state) => {
    state.slots = [slot("request-new")];
  });
  assert.equal(await service.releaseIfCurrent(TASK_ID, RUN_ID, "request-old"), false);
  assert.deepEqual(
    (await store.read()).slots.map((entry) => entry.requestId),
    ["request-new"],
    "the newer claim is kept"
  );
  assert.equal(await service.releaseIfCurrent(TASK_ID, RUN_ID, "request-new"), true);
  assert.deepEqual((await store.read()).slots, [], "the current claim is released");
});
