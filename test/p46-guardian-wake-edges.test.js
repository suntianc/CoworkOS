import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDashboardRunService } from "../dist/src/dashboard/run-service.js";
import { readJsonFile } from "../dist/src/dashboard/event-stream.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { HumanRequestStore } from "../dist/src/runtime/human.js";
import { MainInboxDelivery } from "../dist/src/runtime/main-inbox-delivery.js";
import { MainSupervisor } from "../dist/src/runtime/main-supervisor.js";
import { readSleep, writeSleep } from "../dist/src/runtime/main-sleep.js";
import { now } from "../dist/src/domain/types.js";
import { singleConnectionMainModel } from "./role-model-fixture.mjs";

/**
 * Two boundaries around Main recovery, each with a queue the guardian decides
 * from and a consumer that drains it.
 *
 * A park belongs to the Run that recorded it, but the Task may have moved on:
 * only the Task's current Run has a Main to read anything. And a pending
 * decision from a feature this product no longer ships is not a person
 * deciding — it cannot be answered, so it must not stop the Task either.
 */

const inboxPath = (root, taskId, runId) =>
  join(root, taskId, "runs", runId, "agents", "main", "inbox-store.json");

async function queuedWakes(root, taskId, runId) {
  return (await new InboxStore(inboxPath(root, taskId, runId)).list("main")).filter(
    (message) => message.payload.type === "main.scheduled_wake"
  );
}

/** A Task parked earlier, a Task that has since moved on, and one Inbox each. */
async function parkedFixture(t, { parkedRun, activeRun }) {
  const root = await mkdtemp(join(tmpdir(), "atria-wake-edges-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const store = new LocalWorkspaceStore(root);
  await store.createTask("task", { goal: "watch the queue" });
  await store.createRun("task", parkedRun);
  if (activeRun !== parkedRun) await store.createRun("task", activeRun);
  await store.transitionTask("task", "waiting", { runId: activeRun });
  const parkedAt = now();
  await writeSleep(root, "task", {
    runId: parkedRun,
    reason: "refresh the report",
    wakeAt: new Date(Date.now() - 1_000).toISOString(),
    parkedAt
  });
  return { root, store };
}

test("a due park left on a replaced Run wakes the Run Main reads, and delivery consumes it", async (t) => {
  const parkedRun = "main-earlier";
  const activeRun = "main-current";
  const { root, store } = await parkedFixture(t, { parkedRun, activeRun });

  const launches = [];
  const cycle = await new MainSupervisor({
    workspaceRoot: root,
    launch: (input) => {
      launches.push(input);
    }
  }).runCycle({ taskId: "task" });

  assert.equal(cycle.parkWakes, 1);
  assert.equal(cycle.resumed, 1);
  assert.equal(launches[0].runId, activeRun, "the wake starts the Run that is active now");
  assert.deepEqual(await queuedWakes(root, "task", parkedRun), [], "the replaced Run is never read again");
  const queued = await queuedWakes(root, "task", activeRun);
  assert.equal(queued.length, 1, "the wake waits where the guardian and Main both look");
  assert.equal(await readSleep(root, "task"), undefined, "queueing the wake retires the park");

  const delivered = [];
  const delivery = new MainInboxDelivery(root, "task", activeRun);
  await delivery.deliver(async (message) => {
    delivered.push(message);
    await store.transitionTask("task", "running", { runId: activeRun, reason: "main_turn_started" });
  });
  assert.equal(delivered.length, 1, "Main reads the wake on its next turn");
  assert.equal(delivered[0].details.type, "main.scheduled_wake");
  await delivery.acknowledge([{ role: "custom", ...delivered[0] }]);
  assert.equal((await new InboxStore(inboxPath(root, "task", activeRun)).list("main"))[0].state, "consumed");
  assert.equal((await store.readTask("task")).status, "running");
});

test("a due park on the active Run still wakes once and leaves no duplicate", async (t) => {
  const runId = "main-current";
  const { root } = await parkedFixture(t, { parkedRun: runId, activeRun: runId });

  const launches = [];
  const supervisor = new MainSupervisor({
    workspaceRoot: root,
    launch: (input) => {
      launches.push(input);
    }
  });
  const first = await supervisor.runCycle({ taskId: "task" });
  assert.equal(first.parkWakes, 1);
  assert.equal(first.resumed, 1);
  assert.equal(launches[0].runId, runId);
  assert.equal((await queuedWakes(root, "task", runId)).length, 1);
  assert.equal(await readSleep(root, "task"), undefined);

  const second = await supervisor.runCycle({ taskId: "task" });
  assert.equal(second.parkWakes, 0, "a woken park is not queued again");
  assert.equal((await queuedWakes(root, "task", runId)).length, 1);
});

/** A decision id shaped exactly like the ones the retired goal tool recorded. */
const RETIRED_DECISION = "human-goal_5f1d4c3b2a1908070605040302010f0e";

async function serviceFixture(t, { tasks = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atria-wake-service-"));
  const workspaceRoot = join(root, "workspace");
  // The fake Main stays alive until shutdown; only the guardian's decision and
  // the launch gate are under test here.
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "scripts", "start-pi.mjs"), "setInterval(() => {}, 1000);\n");
  const store = new LocalWorkspaceStore(workspaceRoot);
  const human = new HumanRequestStore(workspaceRoot);
  const previous = process.env.COWORK_DISABLE_MAIN_GUARDIAN;
  delete process.env.COWORK_DISABLE_MAIN_GUARDIAN;
  t.after(() => {
    if (previous === undefined) delete process.env.COWORK_DISABLE_MAIN_GUARDIAN;
    else process.env.COWORK_DISABLE_MAIN_GUARDIAN = previous;
  });

  for (const task of tasks) {
    const runId = `main-${task.taskId}`;
    await store.createTask(task.taskId, { goal: `fixture ${task.taskId}` });
    await store.createRun(task.taskId, runId);
    await store.transitionTask(task.taskId, "waiting", { runId });
    await new InboxStore(inboxPath(workspaceRoot, task.taskId, runId)).enqueue({
      messageId: `callback-${task.taskId}`,
      recipientAgentId: "main",
      kind: "callback",
      callId: "call-1",
      eventId: `event-${task.taskId}`,
      priority: 1,
      state: "ready",
      createdAt: now(),
      payload: { status: "succeeded", response: "round finished" }
    });
    if (task.decision)
      await human.create(
        {
          taskId: task.taskId,
          runId,
          question: "Which release should this goal target?"
        },
        task.decision
      );
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
      projectName: "Fixture",
      projectDirectory: workspaceRoot
    }),
    resolveMainModel: singleConnectionMainModel(),
    normalizeModel: (value) => (typeof value === "string" ? value : undefined),
    appendRunEvent: async (_workspace, taskId, runId, type, payload) => {
      records.push({ taskId, runId, type, payload });
    },
    readJsonFile,
    mainGuardian: { workspaceRoots: async () => [workspaceRoot], modelConfigured: () => true }
  });
  t.after(async () => {
    await service.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const spawned = (taskId) =>
    records.filter((record) => record.type === "main.run_spawned" && (!taskId || record.taskId === taskId));
  return { root, workspaceRoot, store, human, service, records, spawned };
}

test("a leftover decision from the retired goal tool does not block a Main launch", async (t) => {
  const f = await serviceFixture(t, { tasks: [{ taskId: "legacy", decision: RETIRED_DECISION }] });

  const started = await f.service.startMainRun("legacy", "继续这个会话。", "main-legacy");
  assert.equal(started.status, "running");
  assert.equal(f.spawned("legacy").length, 1, "the Task's Main starts despite the leftover decision");
  assert.equal(
    (await f.human.list("legacy", "pending")).length,
    1,
    "the leftover stays on disk; it is ignored, not rewritten"
  );
});

test("an ordinary pending question still blocks a Main launch", async (t) => {
  const f = await serviceFixture(t, { tasks: [{ taskId: "asked" }] });
  await f.human.create({ taskId: "asked", runId: "main-asked", question: "Which paths are the scorer?" });

  await assert.rejects(
    f.service.startMainRun("asked", "继续这个会话。", "main-asked"),
    /请先回答任务中待确认的问题/
  );
  assert.equal(f.spawned("asked").length, 0);
});

test("the guardian resumes past a leftover decision but still waits on an ordinary question", async (t) => {
  const f = await serviceFixture(t, {
    tasks: [{ taskId: "legacy", decision: RETIRED_DECISION }, { taskId: "asked" }]
  });
  await f.human.create({ taskId: "asked", runId: "main-asked", question: "Which paths are the scorer?" });

  const [cycle] = await f.service.runMainGuardianCycle();
  const decisionFor = (taskId) => cycle.decisions.find((decision) => decision.taskId === taskId);
  assert.equal(decisionFor("legacy").action, "resumed");
  assert.equal(decisionFor("asked").reason, "awaiting_human");
  assert.deepEqual(
    f.spawned().map((record) => record.taskId),
    ["legacy"]
  );
});
