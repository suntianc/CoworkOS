import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { WatchManagement } from "../dist/src/runtime/watch-management.js";
import { MainInboxDelivery } from "../dist/src/runtime/main-inbox-delivery.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { monitoringPrograms } from "../dist/src/runtime/monitoring-control.js";
import { GoalManagement } from "../dist/src/runtime/goal-management.js";
import { HumanRequestStore } from "../dist/src/runtime/human.js";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

async function fixture(t, scope = "background") {
  const root = await mkdtemp(join(tmpdir(), "atria-pause-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new LocalWorkspaceStore(root);
  await workspace.createTask("task", { goal: "watch" });
  await workspace.createRun("task", "main-task");
  await workspace.updateTask("task", { monitoring: { scope }, activeRunId: "main-task" });
  await workspace.transitionTask("task", "waiting", { runId: "main-task" });
  const management = new WatchManagement(root, resolve("."));
  const input = {
    template: "timer",
    task: "wait",
    cadenceSeconds: 60,
    config: { startAt: new Date(Date.now() + 3600000).toISOString(), intervalMs: 60000 }
  };
  const created = await management.create("task", "main-task", input);
  assert.equal(created.activated, true, JSON.stringify(created));
  const inbox = new InboxStore(join(root, "task/runs/main-task/agents/main/inbox-store.json"));
  const queue = (id, payload, kind = "external_event") =>
    inbox.enqueue({
      messageId: id,
      recipientAgentId: "main",
      kind,
      eventId: id,
      priority: 1,
      state: "ready",
      createdAt: new Date().toISOString(),
      payload
    });
  return { root, workspace, management, created, input, inbox, queue };
}

test("pause is enforced by registration, including changed configs and attempts to escape into another task", async (t) => {
  const f = await fixture(t);
  await f.management.control("task", f.created.monitorId, "pause");
  assert.equal((await f.management.store.readProgram("task", f.created.programId)).status, "paused");
  const tasks = (await f.workspace.listTasks()).length;
  for (const input of [
    f.input,
    { ...f.input, programId: f.created.programId },
    { ...f.input, scope: "background", task: "rebuild paused observer", config: { intervalMs: 120000 } }
  ])
    await assert.rejects(
      new WatchManagement(f.root, resolve(".")).create("task", "main-task", input),
      /暂停/
    );
  await assert.rejects(
    f.management.activate("task", "main-task", { path: "new-package", task: "rebuild", cadenceSeconds: 60 }),
    /暂停/
  );
  assert.equal((await f.workspace.listTasks()).length, tasks);
  assert.equal((await f.management.store.listVirtualAgents("task", f.created.programId)).length, 1);
  await f.management.control("task", f.created.monitorId, "resume");
  assert.equal((await f.management.store.readProgram("task", f.created.programId)).status, "monitoring");
  const repeated = await f.management.create("task", "main-task", f.input);
  assert.equal(repeated.monitorId, f.created.monitorId);
  assert.equal(repeated.alreadyActive, true);
});

test("session source pause holds its timer but permits ordinary callbacks and user messages", async (t) => {
  const f = await fixture(t, "session");
  await f.management.control("task", f.created.monitorId, "pause");
  await f.queue("monitor-clock", { type: "main.scheduled_wake", monitorIds: [f.created.monitorId] });
  await f.queue("unrelated-clock", { type: "main.scheduled_wake", monitorIds: [] });
  await f.queue("work", { response: "training finished" }, "callback");
  await f.queue("user", { type: "user.request" }, "human_command");
  let delivered = 0;
  await new MainInboxDelivery(f.root, "task", "main-task").deliver(() => {
    delivered++;
  });
  assert.equal(delivered, 3);
  assert.equal(
    (await f.inbox.list("main")).find((entry) => entry.messageId === "monitor-clock").state,
    "ready"
  );
  assert.equal((await monitoringPrograms(f.root, "task"))[0].status, "paused");
});

test("pausing one source cannot be bypassed by repeating its creation while another source remains active", async (t) => {
  const f = await fixture(t);
  const other = await f.management.create("task", "main-task", {
    ...f.input,
    programId: f.created.programId,
    task: "other source",
    config: { ...f.input.config, intervalMs: 120000 }
  });
  assert.equal(other.activated, true, JSON.stringify(other));
  await f.management.control("task", f.created.monitorId, "pause");
  assert.equal((await f.management.store.readProgram("task", f.created.programId)).status, "monitoring");
  await assert.rejects(f.management.create("task", "main-task", f.input), /暂停/);
  const original = (await f.management.store.findVirtualAgent("task", f.created.monitorId)).monitor;
  await assert.rejects(
    f.management.activate("task", "main-task", {
      path: original.config.packagePath,
      cadenceSeconds: 60,
      task: "re-activate paused package"
    }),
    /暂停/
  );
  assert.equal((await f.management.store.findVirtualAgent("task", other.monitorId)).monitor.status, "active");
});

test("model guidance and question timeouts cannot resume a paused monitor or create another goal", async (t) => {
  const f = await fixture(t);
  const tools = new Map();
  const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = await import(requirePi.resolve("jiti"));
  const context = {
    taskId: "task",
    mainRunId: "main-task",
    workspaceRoot: f.root,
    harnessRoot: resolve("."),
    watchStore: f.management.store,
    humanStore: new HumanRequestStore(f.root),
    inboxDelivery: new MainInboxDelivery(f.root, "task", "main-task"),
    runtimeEnv: { COWORK_HUMAN_ANSWER_TIMEOUT_MS: "0" },
    updateRuntime() {}
  };
  for (const [file, register] of [
    ["coordination", "registerCoordinationTools"],
    ["goals", "registerGoalTools"]
  ]) {
    const path = resolve(`.pi/runtime/tools/${file}.ts`);
    const module = await createJiti(pathToFileURL(path).href, { interopDefault: true }).import(path);
    module[register](
      {
        registerTool(tool) {
          tools.set(tool.name, tool);
        }
      },
      context
    );
  }
  const cancelled = await tools.get("cancel_subagent").execute("cancel", { callId: f.created.monitorId });
  assert.equal(cancelled.details.status, "paused");
  const unanswered = await tools.get("askhuman").execute(
    "ask",
    {
      question: "恢复已暂停的监控？",
      options: ["恢复", "保持暂停"],
      recommended: 0
    },
    undefined,
    undefined,
    { ui: { notify() {} } }
  );
  assert.equal(unanswered.details.status, "timeout");
  assert.equal(unanswered.details.recommendedOption, "恢复");
  await assert.rejects(
    f.management.create("task", "main-task", {
      ...f.input,
      programId: f.created.programId,
      task: "rebuild after timeout"
    }),
    /暂停/
  );
  const guided = await tools.get("send_subagent_message").execute("guide", {
    callId: f.created.monitorId,
    message: "Try rebuilding after the old question timed out"
  });
  assert.equal(guided.details.status, "paused");
  assert.equal(
    (await f.management.store.listControls("task", f.created.programId, f.created.monitorId)).length,
    1
  );
  const brief = { title: "replacement", objective: "try moving the paused work" };
  for (const action of ["create", "resume", "edit", "steer"])
    await assert.rejects(
      tools.get("manage_goal").execute("goal", {
        action,
        programId: f.created.programId,
        revision: 1,
        brief
      }),
      /暂停/
    );
  await assert.rejects(
    new GoalManagement(f.root).create("task", {
      brief,
      requestId: "escape",
      scope: "background"
    }),
    /暂停/
  );
  assert.equal((await f.workspace.listTasks()).length, 1);
});

test("pause during a custom activation probe wins final acceptance for legacy programs too", async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, "task/artifacts/slow-package");
  await mkdir(join(directory, "watcher"), { recursive: true });
  await mkdir(join(directory, "tests"));
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      name: "slow",
      version: "1.0.0",
      entrypoint: "watcher/rule.mjs",
      handler: "AGENT.md",
      state: "watcher/state.json",
      sources: ["clock"],
      events: { dedupeKey: "fixture", wake: "important" }
    })
  );
  await writeFile(join(directory, "AGENT.md"), "Fixture observer.");
  await writeFile(
    join(directory, "watcher/rule.mjs"),
    "export default async () => {await new Promise(r=>setTimeout(r,500));return {events:[],state:{ok:true}}};"
  );
  const activating = f.management.activate("task", "main-task", {
    path: "artifacts/slow-package",
    task: "new source",
    cadenceSeconds: 60,
    programId: f.created.programId
  });
  let draft;
  for (let n = 0; n < 200; n++) {
    draft = (await f.management.store.listVirtualAgents("task", f.created.programId)).find(
      (m) => m.config?.packagePath === "artifacts/slow-package"
    );
    if (draft) break;
    await delay(10);
  }
  assert.ok(draft);
  await f.management.control("task", f.created.monitorId, "pause");
  const result = await activating;
  assert.equal(result.activated, false);
  assert.match(result.error, /暂停/);
  assert.ok(
    (await f.management.store.listVirtualAgents("task", f.created.programId)).every(
      (m) => m.status !== "active"
    )
  );
  assert.equal((await f.management.store.readProgram("task", f.created.programId)).status, "paused");
});
