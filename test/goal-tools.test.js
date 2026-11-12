import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { GoalManagement } from "../dist/src/runtime/goal-management.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { MainSupervisor } from "../dist/src/runtime/main-supervisor.js";
import { MainInboxDelivery } from "../dist/src/runtime/main-inbox-delivery.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-goal-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new LocalWorkspaceStore(root);
  await workspace.createTask("conversation", { goal: "ordinary conversation" });
  await workspace.createRun("conversation", "main-conversation");
  const manager = new GoalManagement(root);
  const goal = await manager.create("conversation", {
    brief: { title: "Tibo", objective: "Only report verified new resets" },
    scope: "background",
    requestId: "existing"
  });
  // Finish initial planning, leaving the follow-up handoff as the only wake.
  const current = await manager.progress(goal.taskId, goal.programId, 1, {
    summary: "Waiting for new information",
    disposition: "wait",
    nextReviewAt: new Date(Date.now() + 3600000).toISOString()
  });
  const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = await import(requirePi.resolve("jiti"));
  const path = resolve(".pi/runtime/tools/goals.ts");
  const module = await createJiti(pathToFileURL(path).href, { interopDefault: true }).import(path);
  const tools = new Map();
  module.registerGoalTools(
    { registerTool: (tool) => tools.set(tool.name, tool) },
    {
      taskId: "conversation",
      workspaceRoot: root
    }
  );
  return {
    root,
    workspace,
    manager,
    goal: current,
    tool: tools.get("manage_goal"),
    inbox: new InboxStore(join(root, goal.taskId, "runs", goal.watchRunId, "agents/main/inbox-store.json"))
  };
}

test("a normal conversation resolves the existing background goal without an owner Task ID", async (t) => {
  const f = await fixture(t);
  const result = await f.tool.execute("read", { action: "get", programId: f.goal.programId });
  assert.equal(result.details.taskId, f.goal.taskId);
  assert.equal(result.details.goal.brief.title, "Tibo");
  await assert.rejects(
    f.tool.execute("wrong-owner", {
      action: "get",
      programId: f.goal.programId,
      taskId: "conversation"
    }),
    /ENOENT/
  );
  await assert.rejects(f.manager.resolveTaskId("missing"), /manage_goal list/);
  await f.manager.store.programs.createProgram({
    taskId: "conversation",
    programId: f.goal.programId,
    subject: "duplicate reference",
    objective: "ambiguous reference",
    scope: "session",
    watchRunId: "main-conversation"
  });
  await assert.rejects(f.manager.resolveTaskId(f.goal.programId), /不唯一/);
});

test("steering reuses the goal and its Main Inbox, deduplicates retries and survives a restart", async (t) => {
  const f = await fixture(t);
  const params = {
    action: "steer",
    programId: f.goal.programId,
    revision: f.goal.goal.revision,
    message: "Check current monitoring health and continue; do not create another collector."
  };
  const first = await f.tool.execute("handoff", params);
  const repeated = await f.tool.execute("handoff", params);
  assert.equal(first.details.messageId, repeated.details.messageId);
  assert.equal(first.details.status, "ready");
  assert.equal((await f.inbox.list("main")).length, 1);
  assert.equal((await f.workspace.listTasks()).length, 2);
  assert.deepEqual(
    (await f.manager.get(f.goal.taskId, f.goal.programId)).goal,
    JSON.parse(JSON.stringify(f.goal.goal))
  );
  let launches = 0;
  await new MainSupervisor({
    workspaceRoot: f.root,
    launch: ({ taskId, runId }) => {
      assert.equal(taskId, f.goal.taskId);
      assert.equal(runId, f.goal.watchRunId);
      launches++;
    }
  }).runCycle({ taskId: f.goal.taskId });
  assert.equal(launches, 1);
  const delivered = [];
  await new MainInboxDelivery(f.root, f.goal.taskId, f.goal.watchRunId).deliver((message) =>
    delivered.push(message)
  );
  assert.equal(delivered.length, 1);
  assert.ok(JSON.stringify(delivered).includes(params.message));
});

test("handoffs cannot bypass pause, stale revisions, decisions or completed goals", async (t) => {
  const f = await fixture(t);
  const params = {
    action: "steer",
    programId: f.goal.programId,
    revision: f.goal.goal.revision,
    message: "Continue"
  };
  await assert.rejects(f.tool.execute("stale", { ...params, revision: 1 }), /目标已更新/);
  const paused = await f.manager.control(f.goal.taskId, f.goal.programId, "pause", params.revision);
  await assert.rejects(f.tool.execute("paused", { ...params, revision: paused.goal.revision }), /暂停/);
  const resumed = await f.manager.control(f.goal.taskId, f.goal.programId, "resume", paused.goal.revision);
  const waiting = await f.manager.progress(f.goal.taskId, f.goal.programId, resumed.goal.revision, {
    summary: "Need scope",
    disposition: "needs_input",
    waitingFor: "Include unverified sources?"
  });
  await assert.rejects(f.tool.execute("blocked", { ...params, revision: waiting.goal.revision }), /用户决定/);
  const completed = await f.manager.control(
    f.goal.taskId,
    f.goal.programId,
    "complete",
    waiting.goal.revision
  );
  await assert.rejects(f.tool.execute("closed", { ...params, revision: completed.goal.revision }), /已结束/);
  assert.equal((await f.inbox.list("main")).filter((m) => m.payload.type === "watch.goal_steer").length, 0);
});
