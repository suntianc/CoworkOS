import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createDashboardRunService } from "../dist/src/dashboard/run-service.js";
import { readJsonFile } from "../dist/src/dashboard/event-stream.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { HumanRequestStore } from "../dist/src/runtime/human.js";
import { writeHeartbeat } from "../dist/src/runtime/main-heartbeat.js";
import { SUPERVISOR_WAKE_TURN } from "../dist/src/runtime/main-supervisor.js";
import { now } from "../dist/src/domain/types.js";
import { singleConnectionMainModel } from "./role-model-fixture.mjs";

/**
 * The Run service owns Main recovery.
 *
 * A Task with an unconsumed callback, no live Main and no pending human
 * question is started again by the service's own guardian cycle. These tests
 * build no monitoring service, so a pass means recovery no longer depends on
 * watch scheduling, monitor programs or long-term-goal routing.
 */

const WORKSPACE = "workspace";
const RUN = (taskId) => `main-${taskId}`;

const setEnv = (t, values) => {
  const previous = {};
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  for (const [name, value] of Object.entries(values)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

/** The guardian must decide from a clean switch state unless a test sets one. */
const enabledGuardian = (t) => setEnv(t, { COWORK_DISABLE_MAIN_GUARDIAN: undefined });

async function fixture(
  t,
  { tasks = [], capacity, mainSessions, projectId, modelConfigured = () => true } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "atria-main-guardian-"));
  const workspaceRoot = join(root, WORKSPACE);
  // The fake Main stays alive until shutdown, which is what an owned Run looks
  // like from the host; the guardian's decision is the only thing under test.
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "scripts", "start-pi.mjs"), "setInterval(() => {}, 1000);\n");
  const store = new LocalWorkspaceStore(workspaceRoot);
  for (const task of tasks) {
    const runId = RUN(task.taskId);
    await store.createTask(task.taskId, { goal: `fixture ${task.taskId}` });
    await store.createRun(task.taskId, runId);
    await store.transitionTask(task.taskId, "waiting", { runId });
    if (task.callback !== false) await queueCallback(workspaceRoot, task.taskId, runId);
    if (task.human)
      await new HumanRequestStore(workspaceRoot).create({
        taskId: task.taskId,
        runId,
        question: "Which paths are the scorer?"
      });
    if (task.alive) await writeHeartbeat(workspaceRoot, task.taskId, runId);
  }
  const records = [];
  const service = createDashboardRunService({
    projectRoot: root,
    tabStorePath: join(root, "tabs.json"),
    dashboardUrl: "http://127.0.0.1:1",
    runCredential: "unit-test",
    coordinator: { waitForSubagents: async () => ({ pending: [], callbackPending: [] }) },
    locateTask: async (taskId) => ({
      workspaceRoot,
      store,
      task: await store.readTask(taskId),
      projectId: projectId ?? "project-a",
      projectName: "Fixture",
      projectDirectory: workspaceRoot
    }),
    resolveMainModel: singleConnectionMainModel(),
    normalizeModel: (value) => (typeof value === "string" ? value : undefined),
    appendRunEvent: async (workspace, taskId, runId, type, payload) => {
      records.push({ workspace, taskId, runId, type, payload });
    },
    readJsonFile,
    mainGuardian: { workspaceRoots: async () => [workspaceRoot], modelConfigured },
    ...(capacity ? { mainCapacity: capacity.port } : {}),
    ...(mainSessions ? { mainSessions } : {})
  });
  t.after(async () => {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  });
  const spawned = (taskId) =>
    records.filter((record) => record.type === "main.run_spawned" && (!taskId || record.taskId === taskId));
  const waitForSpawn = async (taskId) => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (spawned(taskId).length) return;
      await delay(10);
    }
    assert.fail(`the guardian did not start ${taskId}`);
  };
  return { root, workspaceRoot, store, service, records, spawned, waitForSpawn };
}

async function queueCallback(workspaceRoot, taskId, runId) {
  await new InboxStore(
    join(workspaceRoot, taskId, "runs", runId, "agents", "main", "inbox-store.json")
  ).enqueue({
    messageId: `callback-${taskId}`,
    recipientAgentId: "main",
    kind: "callback",
    callId: "call-1",
    eventId: `event-${taskId}`,
    priority: 1,
    state: "ready",
    createdAt: now(),
    payload: { status: "succeeded", response: "round finished" }
  });
}

const decisionFor = (cycle, taskId) => cycle.decisions.find((decision) => decision.taskId === taskId);

test("the Run service resumes a parked Task while leaving answered and live Tasks alone", async (t) => {
  enabledGuardian(t);
  const f = await fixture(t, {
    tasks: [
      { taskId: "resume-me" },
      { taskId: "needs-answer", human: true },
      { taskId: "already-live", alive: true }
    ]
  });

  const [cycle] = await f.service.runMainGuardianCycle();
  assert.equal(cycle.resumed, 1);
  assert.equal(decisionFor(cycle, "resume-me").action, "resumed");
  assert.equal(decisionFor(cycle, "needs-answer").reason, "awaiting_human");
  assert.equal(decisionFor(cycle, "already-live").reason, "main_alive");
  assert.deepEqual(
    f.spawned().map((record) => record.taskId),
    ["resume-me"],
    "a question keeps its Task parked and a live Main is never duplicated"
  );
  assert.deepEqual(
    f.spawned()[0].payload.prompt,
    SUPERVISOR_WAKE_TURN,
    "the wake uses the same turn the supervisored Main always received"
  );

  // A second cycle while that process is owned by the service must not start
  // another Main for the same Task.
  await f.service.runMainGuardianCycle();
  assert.equal(f.spawned("resume-me").length, 1);
});

test("a host without a Main connection takes no recovery decision until one is configured", async (t) => {
  enabledGuardian(t);
  let configured = false;
  const taskId = "waiting-for-model";
  const f = await fixture(t, { tasks: [{ taskId }], modelConfigured: () => configured });
  const runEvents = join(f.workspaceRoot, taskId, "runs", RUN(taskId), "run_events.jsonl");

  assert.deepEqual(await f.service.runMainGuardianCycle(), [], "no connection means no launch decision");
  assert.equal(f.spawned(taskId).length, 0);
  assert.equal(await readFile(runEvents, "utf8"), "", "an unconfigured host records no resume attempt");

  configured = true;
  const [cycle] = await f.service.runMainGuardianCycle();
  assert.equal(decisionFor(cycle, taskId).action, "resumed");
  assert.equal(f.spawned(taskId).length, 1, "the next cycle sees the connection and starts Main");
  assert.match(await readFile(runEvents, "utf8"), /main\.supervisor_resume/);
});

test("a full budget queues the wake and starts it when a slot frees", async (t) => {
  enabledGuardian(t);
  const capacity = capacityFixture(1);
  capacity.occupy("an-external-holder");
  const f = await fixture(t, {
    tasks: [{ taskId: "queued" }],
    capacity,
    mainSessions: {
      resolve: async () => ({ sessionId: "session-a", entryKind: "external", kind: "regular" })
    }
  });
  capacity.starter = async (entry) => {
    await f.service.startMainRun(entry.taskId, entry.prompt, entry.runId, true, undefined, undefined, {
      admittedRequestId: entry.requestId,
      origin: "internal",
      queueWhenFull: false
    });
  };

  const [cycle] = await f.service.runMainGuardianCycle();
  assert.equal(decisionFor(cycle, "queued").action, "resumed");
  assert.equal(f.spawned("queued").length, 0, "no process runs before a slot exists");
  assert.deepEqual(
    capacity.queued().map((entry) => [entry.taskId, entry.prompt]),
    [["queued", SUPERVISOR_WAKE_TURN]],
    "the wake waits in the same durable queue as any other demand"
  );

  await capacity.release("an-external-holder");
  await f.waitForSpawn("queued");
  assert.equal(f.spawned("queued").length, 1, "releasing a slot starts exactly that waiting demand");
});

for (const name of ["COWORK_DISABLE_MAIN_GUARDIAN"])
  test(`${name}=1 keeps the guardian idle`, async (t) => {
    setEnv(t, { COWORK_DISABLE_MAIN_GUARDIAN: undefined });
    setEnv(t, { [name]: "1" });
    const f = await fixture(t, { tasks: [{ taskId: "would-resume" }] });
    f.service.startMainGuardian();
    assert.deepEqual(await f.service.runMainGuardianCycle(), []);
    await delay(50);
    assert.equal(f.spawned().length, 0);
  });

test("shutdown stops the guardian and leaves no launch in progress", async (t) => {
  enabledGuardian(t);
  const f = await fixture(t, { tasks: [{ taskId: "guarded" }] });
  f.service.startMainGuardian();
  await f.waitForSpawn("guarded");
  assert.equal(f.service.activeRuns.size, 1);

  await f.service.stop();
  assert.equal(f.service.activeRuns.size, 0, "shutdown reaps the Main it started");
  assert.deepEqual(await f.service.runMainGuardianCycle(), [], "a stopped backend takes no new decisions");
  await delay(50);
  assert.equal(f.spawned("guarded").length, 1, "no cycle runs after shutdown");
});

test("the guardian implementation imports no retired monitoring modules", async () => {
  const forbidden = [
    "watch-service.js",
    "watch-program-store.js",
    "watch-supervisor.js",
    "watch-management.js",
    "monitoring-control.js",
    "goal-routing.js"
  ];
  const source = await readFile(resolve("src/runtime/main-supervisor.ts"), "utf8");
  const imports = [...source.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/g)].map(
    (match) => match[1]
  );
  for (const name of forbidden)
    assert.equal(
      imports.some((specifier) => specifier.endsWith(name)),
      false,
      `the guardian must not import ${name}`
    );

  const runService = await readFile(resolve("src/dashboard/run-service.ts"), "utf8");
  assert.match(runService, /new MainSupervisor\(/, "the Run service is where the guardian runs");
  assert.match(runService, /queueWhenFull: true/, "a full budget queues the wake");
  assert.match(runService, /modelConfigured\(\)/, "each cycle checks the host's model connection");

  const application = await readFile(resolve("src/dashboard/application.ts"), "utf8");
  assert.match(application, /modelConfigured: \(\) =>/, "the host supplies the model gate");
  assert.match(application, /runtimeValue\("COWORK_API_BASE"\)/);
  assert.match(application, /runtimeValue\("COWORK_API_KEY"\)/);
});

/**
 * The external-capacity queue the Run service talks to, with the production
 * dispatch contract: releasing a slot starts the first waiting demand.
 */
function capacityFixture(limit) {
  const slots = new Map();
  const queue = [];
  let sequence = 0;
  const service = {
    starter: undefined,
    occupy(requestId) {
      slots.set(requestId, { requestId, taskId: "holder" });
    },
    queued: () => queue.map((entry) => ({ ...entry })),
    release: (requestId) => service.port.release(requestId),
    port: {
      enabled: () => true,
      admit: async (request) => {
        const requestId = `request-${(sequence += 1)}`;
        if (slots.size < limit) {
          slots.set(requestId, { requestId, taskId: request.taskId });
          return { state: "running", requestId };
        }
        queue.push({
          requestId,
          taskId: request.taskId,
          runId: request.runId,
          prompt: request.prompt
        });
        return { state: "queued", requestId, position: queue.length };
      },
      bindProcess: async () => true,
      markStarted: async () => {},
      cancelTask: async () => {},
      release: async (requestId) => {
        slots.delete(requestId);
        if (slots.size >= limit || !queue.length) return;
        const next = queue.shift();
        slots.set(next.requestId, { requestId: next.requestId, taskId: next.taskId });
        await service.starter?.(next);
      }
    }
  };
  return service;
}
