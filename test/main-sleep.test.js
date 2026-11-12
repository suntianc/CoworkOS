import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { MainSupervisor } from "../dist/src/runtime/main-supervisor.js";
import { MainInboxDelivery } from "../dist/src/runtime/main-inbox-delivery.js";
import { assessTaskCompletion } from "../dist/src/runtime/task-completion.js";
import { readSleep, writeSleep } from "../dist/src/runtime/main-sleep.js";

/**
 * Sleeping and finishing look the same from outside: no work is queued either
 * way. These tests pin what tells them apart — a timed record Main writes on
 * purpose — and that the Main supervisor is what turns it into one wake.
 */

const extensionPath = resolve(".pi/extensions/cowork.ts");
const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const TASK = "sleep-task";
const RUN = `main-${TASK}`;

function fakePi() {
  const tools = new Map();
  const handlers = new Map();
  return {
    tools,
    handlers,
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
    sendMessage: async () => {}
  };
}

async function loadExtension() {
  const { createJiti } = await import(requirePi.resolve("jiti"));
  const jiti = createJiti(pathToFileURL(extensionPath).href, { interopDefault: true });
  const module = await jiti.import(extensionPath, { default: true });
  return module.default ?? module;
}

const ctx = { ui: { notify() {}, setStatus() {} }, sessionManager: { getEntries: () => [] } };

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-sleep-"));
  const previous = { ...process.env };
  // The tool's runtime-state write is fire-and-forget by design; let it land.
  t.after(async () => {
    process.env = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  process.env.COWORK_API_BASE = "https://example.test";
  process.env.COWORK_API_KEY = "test-key";
  process.env.COWORK_CONFIG = join(root, "config.json");
  await writeFile(process.env.COWORK_CONFIG, "{}\n");
  process.env.COWORK_WORKSPACE = root;
  process.env.COWORK_TASK_ID = TASK;
  process.env.COWORK_RUN_ID = RUN;
  const store = new LocalWorkspaceStore(root);
  await store.createTask(TASK, { goal: "keep watch" });
  await store.createRun(TASK, RUN);
  const pi = fakePi();
  (await loadExtension())(pi);
  return { root, store, pi };
}

/** Drive the lifecycle the way Pi does after a final answer. */
async function settle(pi) {
  await pi.handlers.get("agent_end")(
    {
      messages: [
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done for now." }] }
      ]
    },
    ctx
  );
  await pi.handlers.get("agent_settled")({}, ctx);
}

test("the completion gate treats a park as outstanding work, and only a park", () => {
  assert.deepEqual(assessTaskCompletion({ parkedForWake: true, hasFinalAnswer: true }), {
    ready: false,
    reason: "parked_for_wake"
  });
  assert.deepEqual(assessTaskCompletion({ parkedForWake: false, hasFinalAnswer: true }), {
    ready: true,
    reason: "ready"
  });
  // Real outstanding work still comes first: a parked Task with a blocked
  // Subagent is reported as blocked, since that needs a different action.
  assert.equal(
    assessTaskCompletion({ parkedForWake: true, pendingSubagentQuestions: 1 }).reason,
    "pending_subagent_questions"
  );
});

test("sleep_until refuses a park nothing could wake", async (t) => {
  const { root, pi } = await harness(t);
  const result = await pi.tools
    .get("sleep_until")
    .execute("call-1", { reason: "nothing to do" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.reason, "no_wake_condition");
  assert.equal(await readSleep(root, TASK), undefined);
});

test("sleep_until with an interval records a wake time and ends the turn", async (t) => {
  const { root, pi } = await harness(t);
  const before = Date.now();
  const result = await pi.tools
    .get("sleep_until")
    .execute("call-1", { reason: "refresh the report", wakeInSeconds: 10 }, undefined, undefined, ctx);
  assert.equal(result.terminate, true);
  const parked = await readSleep(root, TASK);
  assert.equal(parked.runId, RUN);
  assert.equal(parked.reason, "refresh the report");
  // Below the floor is raised to it: a wake cannot be due before the turn ends.
  assert.ok(Date.parse(parked.wakeAt) >= before + 60_000);
});

test("a parked Main settles to waiting; an unparked Main still completes", async (t) => {
  const { root, store, pi } = await harness(t);
  // The regression guard: ordinary work is unaffected by the sleep machinery.
  await settle(pi);
  assert.equal((await store.readTask(TASK)).status, "completed");

  await store.transitionTask(TASK, "running", { runId: RUN });
  await pi.tools
    .get("sleep_until")
    .execute("call-1", { reason: "come back later", wakeInSeconds: 60 }, undefined, undefined, ctx);
  await settle(pi);
  const task = await store.readTask(TASK);
  assert.equal(task.status, "waiting");
  assert.ok(await readSleep(root, TASK), "the park survives the settle");
});

test("a due park wakes once through the Main supervisor, then delivery clears it", async (t) => {
  const { root, store, pi } = await harness(t);
  await pi.tools
    .get("sleep_until")
    .execute("call-1", { reason: "refresh", wakeInSeconds: 60 }, undefined, undefined, ctx);
  await settle(pi);
  const parked = await readSleep(root, TASK);
  await writeSleep(root, TASK, { ...parked, wakeAt: new Date(Date.now() - 1_000).toISOString() });
  const launches = [];
  const supervisor = new MainSupervisor({
    workspaceRoot: root,
    launch: (input) => {
      launches.push(input);
    }
  });
  const first = await supervisor.runCycle({ taskId: TASK });
  assert.equal(first.parkWakes, 1);
  assert.equal(first.resumed, 1);
  assert.equal(launches[0].runId, RUN);
  const second = await supervisor.runCycle({ taskId: TASK });
  assert.equal(second.parkWakes, 0, "a second cycle does not re-fire");
  const inbox = new InboxStore(join(root, TASK, "runs", RUN, "agents", "main", "inbox-store.json"));
  const messages = await inbox.list("main");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].payload.type, "main.scheduled_wake");

  const delivered = [];
  await new MainInboxDelivery(root, TASK, RUN).deliver(async (message) => {
    delivered.push(message);
    await store.transitionTask(TASK, "running", { runId: RUN, reason: "main_turn_started" });
  });
  assert.equal(delivered.length, 1);
  assert.equal(await readSleep(root, TASK), undefined);
  assert.equal((await store.readTask(TASK)).status, "running");
});

test("a park whose time has not arrived is left alone", async (t) => {
  const { root, store, pi } = await harness(t);
  await pi.tools
    .get("sleep_until")
    .execute("call-1", { reason: "later", wakeInSeconds: 3_600 }, undefined, undefined, ctx);
  await settle(pi);
  const result = await new MainSupervisor({
    workspaceRoot: root,
    launch: () => assert.fail("too early")
  }).runCycle({
    taskId: TASK
  });
  assert.equal(result.parkWakes, 0);
  assert.equal(result.resumed, 0);
  assert.equal(
    (await new InboxStore(join(root, TASK, "runs", RUN, "agents", "main", "inbox-store.json")).list("main"))
      .length,
    0
  );
  assert.ok(await readSleep(root, TASK));
  assert.equal((await store.readTask(TASK)).status, "waiting");
});

test("finish_task supersedes a park and says so", async (t) => {
  const { root, store, pi } = await harness(t);
  await pi.tools
    .get("sleep_until")
    .execute("call-1", { reason: "come back later", wakeInSeconds: 60 }, undefined, undefined, ctx);
  const result = await pi.tools.get("finish_task").execute("call-2", { summary: "objective reached" });
  assert.equal(result.details.completed, true);
  assert.equal(result.details.supersededPark, "come back later");
  assert.equal(await readSleep(root, TASK), undefined);
  assert.equal((await store.readTask(TASK)).status, "completed");
});
