import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { GoalManagement } from "../dist/src/runtime/goal-management.js";
import { GoalSupervisor } from "../dist/src/runtime/goal-supervisor.js";
import { goalContext } from "../dist/src/runtime/goal-context.js";
import { routeGoalMessage } from "../dist/src/runtime/goal-routing.js";
import { nextWeeklyDigest } from "../dist/src/domain/goal.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { WatchManagement } from "../dist/src/runtime/watch-management.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { MainSupervisor } from "../dist/src/runtime/main-supervisor.js";
import { MainInboxDelivery } from "../dist/src/runtime/main-inbox-delivery.js";
import { WatchSupervisor } from "../dist/src/runtime/watch-supervisor.js";
import { writeSleep } from "../dist/src/runtime/main-sleep.js";

const brief = {
  title: "Claude Code 动态",
  objective: "只关注对项目有影响的变化",
  preferences: ["避免重复提醒"]
};
async function fixture(t, scope = "background", overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "atria-goal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new LocalWorkspaceStore(root);
  await workspace.createTask("source", { goal: "user conversation" });
  await workspace.createRun("source", "main-source");
  const manager = new GoalManagement(root);
  const input = { brief: { ...brief, ...overrides }, scope, requestId: "fixture-goal" };
  const program = await manager.create("source", input);
  const inbox = new InboxStore(
    join(root, program.taskId, "runs", program.watchRunId, "agents", "main", "inbox-store.json")
  );
  return { root, workspace, manager, input, program, inbox };
}

for (const scope of ["session", "background"]) {
  test(`${scope}: one goal owns multiple watchers and creation retries preserve identity`, async (t) => {
    const f = await fixture(t, scope);
    assert.equal(f.program.taskId === "source", scope === "session");
    assert.equal((await f.manager.create("source", f.input)).programId, f.program.programId);
    await assert.rejects(
      f.manager.create("source", { ...f.input, brief: { ...brief, objective: "different request" } }),
      /目标已更新/
    );
    const source = join(f.root, "metric.json");
    await writeFile(
      source,
      JSON.stringify({ metric: "loss", unit: "ratio", value: 0, observedAt: new Date().toISOString() })
    );
    const input = {
      template: "metric-threshold",
      task: "observe loss",
      source,
      cadenceSeconds: 60,
      programId: f.program.programId,
      config: { metric: "loss", unit: "ratio", threshold: 2, consecutiveSamples: 1 }
    };
    const watches = new WatchManagement(f.root, resolve("."));
    const first = await watches.create(f.program.taskId, f.program.watchRunId, input);
    const second = await watches.create(f.program.taskId, f.program.watchRunId, {
      ...input,
      task: "observe a different threshold",
      config: { ...input.config, threshold: 4 }
    });
    assert.equal(first.activated, true);
    assert.equal(second.activated, true);
    assert.equal(first.taskId, f.program.taskId);
    assert.equal(second.programId, first.programId);
    assert.equal(
      (await f.manager.store.programs.listVirtualAgents(f.program.taskId, first.programId)).length,
      2
    );
    assert.equal(
      (await watches.create(f.program.taskId, f.program.watchRunId, input)).monitorId,
      first.monitorId
    );
    assert.equal((await f.workspace.listTasks()).length, scope === "session" ? 1 : 2);
    assert.equal(
      (await f.manager.store.read(f.program.taskId, f.program.programId)).goal.revision,
      1,
      "monitor membership does not invalidate goal edits"
    );
  });
}

test("a stale model cannot overwrite or notify after the user changes the goal", async (t) => {
  const f = await fixture(t);
  const updated = await f.manager.edit(f.program.taskId, f.program.programId, 1, {
    ...brief,
    objective: "只关注权限变化"
  });
  assert.equal(updated.goal.revision, 2);
  await assert.rejects(
    f.manager.progress(f.program.taskId, f.program.programId, 1, {
      summary: "stale plan",
      disposition: "complete"
    }),
    /目标已更新/
  );
  await assert.rejects(
    f.manager.publish(f.program.taskId, f.program.programId, 1, {
      topicKey: "old",
      kind: "important",
      title: "old",
      summary: "obsolete"
    }),
    /目标已更新/
  );
  assert.equal((await f.manager.activity(f.program.taskId, f.program.programId).view()).unreadCount, 0);
});

test("review clocks are explicit, idempotent, retained while paused, and quiet between deadlines", async (t) => {
  const f = await fixture(t);
  const supervisor = new GoalSupervisor(f.root);
  await supervisor.runTask(f.program.taskId, f.program.watchRunId);
  await supervisor.runTask(f.program.taskId, f.program.watchRunId);
  assert.equal((await f.inbox.list("main")).length, 1);
  await assert.rejects(
    f.manager.progress(f.program.taskId, f.program.programId, 1, {
      summary: "nothing to wait for",
      disposition: "wait"
    }),
    /活动监控或明确/
  );
  const progressed = await f.manager.progress(f.program.taskId, f.program.programId, 1, {
    summary: "plan ready",
    disposition: "continue",
    nextAction: "review new evidence",
    nextReviewAt: new Date(Date.now() + 120000).toISOString(),
    steps: [
      { id: "sources", description: "validate sources", status: "completed", evidence: "baseline accepted" }
    ]
  });
  await supervisor.runTask(f.program.taskId, f.program.watchRunId);
  assert.equal((await f.inbox.list("main")).length, 1);
  await f.manager.store.withGoal(f.program.taskId, f.program.programId, (p) =>
    f.manager.store.save(p, { ...p.goal, nextReviewAt: "2000-01-01T00:00:00Z" })
  );
  const paused = await f.manager.control(
    f.program.taskId,
    f.program.programId,
    "pause",
    progressed.goal.revision
  );
  await supervisor.runTask(f.program.taskId, f.program.watchRunId);
  assert.equal((await f.inbox.list("main")).length, 1);
  await f.manager.control(f.program.taskId, f.program.programId, "resume", paused.goal.revision);
  await supervisor.runTask(f.program.taskId, f.program.watchRunId);
  const messages = await f.inbox.list("main");
  assert.equal(messages.filter((m) => m.payload.type === "watch.goal_review").length, 1);
  await supervisor.runTask(f.program.taskId, f.program.watchRunId);
  assert.equal((await f.inbox.list("main")).length, messages.length);
});

test("cross-source topics merge, important updates surface once, and routine items wait for a digest", async (t) => {
  const f = await fixture(t, "background", {
    notificationPolicy: "digest",
    digest: { dayOfWeek: 0, hour: 18, minute: 0, timeZone: "Asia/Shanghai" }
  });
  const publish = (entry) => f.manager.publish(f.program.taskId, f.program.programId, 1, entry);
  const update = {
    topicKey: "claude-code/version-x",
    kind: "routine",
    title: "Version X",
    summary: "Changes to tools",
    sources: [{ title: "official", url: "https://example.com/release" }]
  };
  assert.equal((await publish(update)).notified, false);
  const duplicate = await publish({
    ...update,
    sources: [{ title: "community", url: "https://example.com/discussion" }]
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.update.sources.length, 2);
  assert.equal(
    (await f.manager.activity(f.program.taskId, f.program.programId).view()).pendingDigestCount,
    1
  );
  assert.equal((await publish({ ...update, kind: "important" })).notified, true);
  assert.equal((await publish({ ...update, kind: "important" })).notified, false);
  await publish({ ...update, topicKey: "claude-code/another-release", title: "Another release" });
  const activity = f.manager.activity(f.program.taskId, f.program.programId);
  assert.equal(await activity.digest("2026-10-18T10:00:00Z", f.program.goal), true);
  assert.equal(await activity.digest("2026-10-18T10:00:00Z", f.program.goal), false);
  let view = await activity.view();
  assert.equal(view.notifications.length, 2);
  assert.equal(view.unreadCount, 2);
  assert.equal(view.pendingDigestCount, 0);
  await activity.readNotification(view.notifications[0].notificationId);
  await activity.readNotification(view.notifications[0].notificationId);
  view = await activity.view();
  assert.equal(view.unreadCount, 1);
  await assert.rejects(
    publish({ ...update, sources: [{ title: "unsafe", url: "javascript:alert(1)" }] }),
    /HTTP/
  );
});

test("decision requests persist, block premature progress and resume through the ordinary Inbox", async (t) => {
  const f = await fixture(t);
  const p = await f.manager.progress(f.program.taskId, f.program.programId, 1, {
    summary: "Need a source choice",
    disposition: "needs_input",
    waitingFor: "Should we include community sources?"
  });
  assert.equal(p.status, "review_required");
  assert.ok(p.goal.decisionRequestId);
  await assert.rejects(
    f.manager.progress(p.taskId, p.programId, p.goal.revision, {
      summary: "assuming yes",
      disposition: "complete"
    }),
    /用户尚未回答/
  );
  await f.manager.respond(p.taskId, p.programId, "Include official sources only");
  assert.ok((await f.inbox.list("main")).some((entry) => entry.payload.type === "human.answer"));
  const completed = await f.manager.progress(p.taskId, p.programId, p.goal.revision, {
    summary: "Answer accepted, responsibility complete",
    disposition: "complete"
  });
  assert.equal(completed.status, "completed");
  await assert.rejects(f.manager.edit(p.taskId, p.programId, completed.goal.revision, brief), /目标已结束/);
});

test("weekly digests honor local time, DST gaps and duplicate local dates", () => {
  const schedule = { dayOfWeek: 0, hour: 18, minute: 0, timeZone: "Asia/Shanghai" };
  assert.equal(nextWeeklyDigest(schedule, Date.parse("2026-10-15T10:00:00Z")), "2026-10-18T10:00:00.000Z");
  const gap = { dayOfWeek: 0, hour: 2, minute: 30, timeZone: "America/New_York" };
  assert.equal(nextWeeklyDigest(gap, Date.parse("2026-03-08T06:59:00Z")), "2026-03-15T06:30:00.000Z");
  assert.equal(
    nextWeeklyDigest({ ...gap, hour: 1 }, Date.parse("2026-11-01T05:30:00Z"), "2026-11-01"),
    "2026-11-08T06:30:00.000Z"
  );
});

test("goal context remains bounded and never includes notification history", async (t) => {
  const f = await fixture(t);
  await f.manager.store.withGoal(f.program.taskId, f.program.programId, (p) =>
    f.manager.store.save(p, {
      ...p.goal,
      facts: Array.from({ length: 50 }, (_, i) => `fact ${i} ${"x".repeat(900)}`)
    })
  );
  await f.manager.publish(f.program.taskId, f.program.programId, 1, {
    topicKey: "report",
    kind: "internal",
    title: "internal",
    summary: "PRIVATE_HISTORY_ONLY"
  });
  const context = await goalContext(f.root, f.program.taskId, 1200);
  assert.ok(context.length <= 1200);
  assert.ok(context.includes(f.program.programId));
  assert.equal(context.includes("PRIVATE_HISTORY_ONLY"), false);
});

test("a paused background goal holds callbacks while a paused session goal permits unrelated work", async (t) => {
  const f = await fixture(t);
  const p = { ...f.program, status: "paused" };
  const message = { kind: "external_event", payload: { type: "job.finished" } };
  assert.equal(routeGoalMessage([p], true, message), "hold");
  assert.equal(routeGoalMessage([p], false, message), "deliver");
  assert.equal(
    routeGoalMessage([p], true, { kind: "human_command", payload: { type: "human.message" } }),
    "deliver"
  );
  assert.equal(routeGoalMessage([{ ...p, status: "completed" }], true, message), "discard");
});

test("old Main polling clocks are routed without hiding goal reviews or unrelated session clocks", async (t) => {
  const f = await fixture(t);
  const clock = {
    messageId: "old-model-poll",
    recipientAgentId: "main",
    kind: "external_event",
    priority: 1,
    state: "ready",
    createdAt: new Date().toISOString(),
    payload: { type: "main.scheduled_wake", monitorIds: ["managed-source"] }
  };
  const program = { ...f.program, monitorIds: ["managed-source"] };
  assert.equal(routeGoalMessage([program], true, clock), "discard");
  assert.equal(routeGoalMessage([program], false, clock), "deliver");
  assert.equal(routeGoalMessage([{ ...program, status: "paused" }], false, clock), "deliver");
  assert.equal(routeGoalMessage([{ ...program, status: "paused", goal: undefined }], false, clock), "hold");
  assert.equal(
    routeGoalMessage(
      [
        program,
        { ...program, programId: "legacy", status: "paused", goal: undefined, monitorIds: ["legacy-source"] }
      ],
      false,
      { ...clock, payload: { ...clock.payload, monitorIds: ["managed-source", "legacy-source"] } }
    ),
    "hold"
  );
  assert.equal(
    routeGoalMessage([program], false, {
      ...clock,
      payload: { ...clock.payload, programId: program.programId }
    }),
    "discard"
  );
  assert.equal(
    routeGoalMessage([program], false, {
      ...clock,
      payload: { ...clock.payload, monitorIds: ["legacy-source"] }
    }),
    "deliver"
  );
  assert.equal(
    routeGoalMessage([program], true, {
      ...clock,
      payload: { type: "watch.goal_command", programId: program.programId }
    }),
    "deliver"
  );
  assert.equal(routeGoalMessage([{ ...program, goal: undefined }], true, clock), "deliver");
});

for (const state of ["parked", "queued"])
  test(`a ${state} legacy session clock reaches Main despite an unrelated goal pause`, async (t) => {
    const f = await fixture(t, "session");
    const monitor = await f.manager.store.programs.createVirtualAgent({
      programId: f.program.programId,
      task: "watch unrelated source changes",
      cadenceSeconds: 60,
      wake: "important",
      activate: true
    });
    await f.manager.control(f.program.taskId, f.program.programId, "pause", f.program.goal.revision);
    const clock = {
      messageId: "legacy-unrelated-reminder",
      recipientAgentId: "main",
      kind: "external_event",
      priority: 1,
      state: "ready",
      createdAt: new Date().toISOString(),
      payload: {
        type: "main.scheduled_wake",
        reason: "Remind the user about a meeting; unrelated to the goal",
        monitorIds: [monitor.monitorId]
      }
    };
    if (state === "queued") await f.inbox.enqueue(clock);
    else {
      await writeSleep(f.root, f.program.taskId, {
        runId: f.program.watchRunId,
        reason: clock.payload.reason,
        monitorIds: clock.payload.monitorIds,
        parkedAt: new Date(Date.now() - 120_000).toISOString(),
        wakeAt: new Date(Date.now() - 1_000).toISOString()
      });
      const cycle = await new WatchSupervisor({
        workspaceRoot: f.root,
        baseUrl: "http://model.test",
        apiKey: "k"
      }).runCycle({ taskId: f.program.taskId });
      assert.equal(cycle.parkWakes, 1);
    }
    let launches = 0;
    const cycle = await new MainSupervisor({
      workspaceRoot: f.root,
      launch: () => {
        launches++;
      }
    }).runCycle({ taskId: f.program.taskId });
    assert.equal(cycle.resumed, 1);
    assert.equal(launches, 1);
    const delivered = [];
    await new MainInboxDelivery(f.root, f.program.taskId, f.program.watchRunId).deliver((message) =>
      delivered.push(message)
    );
    assert.equal(delivered.length, 1);
  });

test("an unsettled plan is visible once without an automatic model retry loop", async (t) => {
  const f = await fixture(t);
  const { parkBackgroundWatchGoal } = await import("../dist/src/runtime/watch-main-lifecycle.js");
  await new GoalSupervisor(f.root).runTask(f.program.taskId, f.program.watchRunId);
  await parkBackgroundWatchGoal(f.root, f.program.taskId, f.program.watchRunId);
  await parkBackgroundWatchGoal(f.root, f.program.taskId, f.program.watchRunId);
  const current = await f.manager.get(f.program.taskId, f.program.programId);
  assert.equal(current.status, "review_required");
  assert.equal(current.activity.unreadCount, 1);
  assert.equal(current.activity.notifications.length, 1);
});

test("an expired last source raises an actionable durable notice without invoking Main", async (t) => {
  const f = await fixture(t);
  await new GoalSupervisor(f.root).runTask(f.program.taskId, f.program.watchRunId);
  const created = await new WatchManagement(f.root, resolve(".")).create(
    f.program.taskId,
    f.program.watchRunId,
    {
      programId: f.program.programId,
      template: "timer",
      task: "explicit future follow-up",
      cadenceSeconds: 60,
      expiresAt: new Date(Date.now() + 120000).toISOString(),
      config: { startAt: new Date(Date.now() + 3600000).toISOString(), intervalMs: null }
    }
  );
  assert.equal(created.activated, true);
  await f.manager.progress(f.program.taskId, f.program.programId, 1, {
    summary: "Waiting on registered source",
    disposition: "wait"
  });
  await f.manager.store.programs.updateVirtualAgent(
    f.program.taskId,
    f.program.programId,
    created.monitorId,
    { expiresAt: "2026-01-01T00:00:00Z" }
  );
  const count = (await f.inbox.list("main")).length;
  await new GoalSupervisor(f.root).runTask(f.program.taskId, f.program.watchRunId);
  await new GoalSupervisor(f.root).runTask(f.program.taskId, f.program.watchRunId);
  const current = await f.manager.get(f.program.taskId, f.program.programId);
  assert.equal(current.status, "review_required");
  assert.equal(current.activity.unreadCount, 1);
  assert.equal((await f.inbox.list("main")).length, count);
});

test("a decision interrupted between saving intent and writing effects repairs without duplicate questions", async (t) => {
  const f = await fixture(t);
  const { HumanRequestStore } = await import("../dist/src/runtime/human.js");
  const original = HumanRequestStore.prototype.create;
  HumanRequestStore.prototype.create = async () => {
    throw new Error("synthetic decision write interruption");
  };
  try {
    await assert.rejects(
      f.manager.progress(f.program.taskId, f.program.programId, 1, {
        summary: "Need scope",
        waitingFor: "Include previews?",
        disposition: "needs_input"
      }),
      /synthetic decision/
    );
  } finally {
    HumanRequestStore.prototype.create = original;
  }
  assert.equal((await f.manager.store.read(f.program.taskId, f.program.programId)).goal.revision, 2);
  await new GoalSupervisor(f.root).runTask(f.program.taskId, f.program.watchRunId);
  await new GoalSupervisor(f.root).runTask(f.program.taskId, f.program.watchRunId);
  const current = await f.manager.get(f.program.taskId, f.program.programId);
  assert.equal(current.decision.status, "pending");
  assert.equal((await new HumanRequestStore(f.root).list(f.program.taskId)).length, 1);
  assert.equal(current.activity.unreadCount, 1);
});

test("the goal list separates paused legacy monitors from ended history", async (t) => {
  const f = await fixture(t);
  const watches = new WatchManagement(f.root, resolve("."));
  const created = await watches.create("source", "main-source", {
    template: "timer",
    task: "legacy timer",
    cadenceSeconds: 60,
    config: { startAt: new Date(Date.now() + 3600000).toISOString(), intervalMs: null }
  });
  assert.equal(created.activated, true);
  const { createGoalService } = await import("../dist/src/dashboard/goal-service.js");
  const service = createGoalService({
    harnessRoot: resolve("."),
    workspaceRoot: () => f.root,
    knownWorkspaceRoots: async () => [f.root],
    locateTask: async () => ({ workspaceRoot: f.root }),
    resumeHumanAnswers: async () => {},
    cancelTask: async () => {}
  });
  await watches.control("source", created.monitorId, "pause");
  assert.equal((await service.all()).find((goal) => goal.programId === created.programId).status, "paused");
  assert.equal((await service.get("source", created.programId)).status, "paused");
  await watches.control("source", created.monitorId, "retire");
  assert.equal(
    (await service.all()).find((goal) => goal.programId === created.programId).status,
    "completed"
  );
});

test("a source registration racing goal completion cannot reactivate the goal or source", async (t) => {
  const f = await fixture(t);
  const { WatchProgramStore } = await import("../dist/src/runtime/watch-program-store.js");
  const original = WatchProgramStore.prototype.createVirtualAgent;
  WatchProgramStore.prototype.createVirtualAgent = async function (input) {
    await f.manager.control(f.program.taskId, f.program.programId, "complete", 1);
    return original.call(this, input);
  };
  let result;
  try {
    result = await new WatchManagement(f.root, resolve(".")).create(f.program.taskId, f.program.watchRunId, {
      programId: f.program.programId,
      template: "timer",
      task: "racing source",
      cadenceSeconds: 60,
      config: { startAt: new Date(Date.now() + 3600000).toISOString(), intervalMs: null }
    });
  } finally {
    WatchProgramStore.prototype.createVirtualAgent = original;
  }
  assert.equal(result.activated, false);
  const current = await f.manager.get(f.program.taskId, f.program.programId);
  assert.equal(current.status, "completed");
  assert.equal(
    current.monitors.some((monitor) => monitor.status === "active"),
    false
  );
});
