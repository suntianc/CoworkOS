import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore, DurableScheduler, InboxStore } from "../src/runtime/scheduler.js";
import { emptyCompaction, readAgentCheckpoint } from "../src/runtime/agent-checkpoint.js";
import {
  ensureMainContext,
  mainContextPaths,
  persistMainContext,
  readMainContextState,
  updateMainContextRuntime
} from "../src/runtime/main-context.js";
import { CoordinatorRuntime } from "../src/runtime/coordinator-runtime.js";
import { WatcherRuntime } from "../src/runtime/watcher.js";
import { LocalWorkspaceStore } from "../src/workspace/workspace-store.js";
import { HumanRequestStore } from "../src/runtime/human.js";
import { SubagentQuestionStore } from "../src/runtime/subagent-questions.js";
import { ExperimentProgramStore } from "../src/runtime/experiment-program-store.js";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cowork-p2-"));
  try {
    const scheduler = new DurableScheduler(join(root, "queue.json"));
    await scheduler.enqueue({
      stepId: "normal",
      taskId: "t",
      runId: "r",
      agentId: "a",
      importance: "normal",
      payload: {}
    });
    await scheduler.enqueue({
      stepId: "critical",
      taskId: "t",
      runId: "r",
      agentId: "a",
      importance: "critical",
      payload: {}
    });
    const first = await scheduler.claim("worker", 10_000);
    assert.equal(first?.stepId, "critical");
    await assert.rejects(() => scheduler.complete(first!.stepId, "wrong-token"), /lease mismatch/);
    await scheduler.complete(first!.stepId, first!.lease!.token);
    await scheduler.complete(first!.stepId, first!.lease!.token); // idempotent retry
    const second = await scheduler.claim("worker", 1);
    assert.equal(second?.stepId, "normal");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reclaimed = await scheduler.claim("worker-2", 10_000);
    assert.equal(reclaimed?.stepId, "normal");
    await scheduler.fail(reclaimed!.stepId, reclaimed!.lease!.token, "test failure");
    const retry = await scheduler.enqueue({
      stepId: "retry",
      taskId: "t",
      runId: "r",
      agentId: "a",
      importance: "normal",
      payload: {},
      maxAttempts: 2
    });
    const retryLease1 = await scheduler.claim("worker");
    assert.equal(retryLease1?.stepId, "retry");
    const retryAfterFailure = await scheduler.fail(retry.stepId, retryLease1!.lease!.token, "transient");
    assert.equal(retryAfterFailure.status, "queued");
    const retryLease2 = await scheduler.claim("worker");
    assert.equal(retryLease2?.stepId, "retry");
    const deadLetter = await scheduler.fail(retry.stepId, retryLease2!.lease!.token, "permanent");
    assert.equal(deadLetter.status, "failed");

    // Separate scheduler instances use the same on-disk lock, so concurrent
    // writers must not lose queue entries.
    const schedulerA = new DurableScheduler(join(root, "concurrent-queue.json"));
    const schedulerB = new DurableScheduler(join(root, "concurrent-queue.json"));
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 === 0 ? schedulerA : schedulerB).enqueue({
          stepId: `concurrent-${index}`,
          taskId: "t",
          runId: "r",
          agentId: "a",
          importance: "normal",
          payload: {}
        })
      )
    );
    assert.equal((await schedulerA.list()).length, 12);
    const heartbeat = new DurableScheduler(join(root, "heartbeat.json"));
    const heartbeatItem = await heartbeat.enqueue({
      stepId: "heartbeat",
      taskId: "t",
      runId: "r",
      agentId: "a",
      importance: "normal",
      payload: {},
      maxAttempts: 2
    });
    const heartbeatLease = await heartbeat.claim("worker-a", 1_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await heartbeat.renew(heartbeatItem.stepId, heartbeatLease!.lease!.token, 1_000);
    assert.equal(
      (await new DurableScheduler(join(root, "heartbeat.json")).claim("worker-b", 1_000))?.stepId,
      undefined
    );

    const checkpoints = new CheckpointStore(join(root, "checkpoints.json"));
    await checkpoints.save({
      runId: "r",
      sequence: 2,
      state: { value: 2 },
      savedAt: new Date().toISOString()
    });
    await checkpoints.save({
      runId: "r",
      sequence: 1,
      state: { value: 1 },
      savedAt: new Date().toISOString()
    });
    assert.equal((await checkpoints.load("r"))?.sequence, 2);
    const checkpoint = readAgentCheckpoint({
      version: 1,
      status: "running",
      prompt: "continue",
      messages: [],
      compaction: emptyCompaction()
    });
    assert.equal(checkpoint?.status, "running");
    assert.equal(readAgentCheckpoint({ version: 2 }), undefined);

    const mainContext = mainContextPaths(root, "task");
    await ensureMainContext(mainContext);
    assert.match(await readFile(mainContext.memory, "utf8"), /## Goal/);
    await writeFile(mainContext.memory, "## Goal\nKeep going\n", "utf8");
    const state = await persistMainContext(mainContext, [{ type: "user", content: "hello" }]);
    assert.equal(state.memoryVersion, 1);
    assert.equal(JSON.parse(await readFile(mainContext.messages, "utf8"))[0].content, "hello");
    assert.equal((await readMainContextState(mainContext)).memoryVersion, 1);
    await updateMainContextRuntime(mainContext, {
      runtimeGoal: "Keep going",
      runtimePhase: "waiting",
      runtimePendingDelegations: 2,
      runtimeRouting: { strategy: "parallel_research", reason: "independent sources" }
    });
    const runtimeState = await readMainContextState(mainContext);
    assert.equal(runtimeState.runtimePhase, "waiting");
    assert.equal(runtimeState.runtimePendingDelegations, 2);
    assert.equal(runtimeState.runtimeRouting?.strategy, "parallel_research");

    const experimentRoot = join(root, "experiment");
    const experimentWorkspace = new LocalWorkspaceStore(experimentRoot);
    await experimentWorkspace.createTask("train-task", { goal: "迭代训练模型并提升验证集指标" });
    const experiments = new ExperimentProgramStore(experimentRoot);
    const experiment = await experiments.createProgram({
      taskId: "train-task",
      objective: "分析数据配比并运行下一轮训练",
      successCriteria: "验证集分数提升",
      budget: { maxRuns: 3 }
    });
    const experimentRun = await experiments.startRun({
      taskId: "train-task",
      experimentId: experiment.experimentId,
      callId: "call-train-1",
      agentId: "subagent_1",
      objective: "运行第一轮训练"
    });
    assert.equal(experimentRun.status, "running");
    const finishedExperimentRun = await experiments.completeRun({
      taskId: "train-task",
      experimentId: experiment.experimentId,
      runId: experimentRun.runId,
      status: "partial",
      summary: "训练已启动，等待评测",
      artifacts: ["runs/train-1.log"]
    });
    assert.equal(finishedExperimentRun.status, "partial");
    assert.equal((await experiments.readProgram("train-task", experiment.experimentId)).status, "waiting");
    assert.equal((await experiments.listPrograms("train-task")).length, 1);

    const coordinatorRoot = join(root, "coordinator");
    const coordinator = new CoordinatorRuntime();
    const coordinatorWorkspace = new LocalWorkspaceStore(coordinatorRoot);
    await coordinatorWorkspace.createRun("task", "run");
    const coordinatorQueue = new DurableScheduler(join(coordinatorRoot, "task", "runs", "run", "queue.json"));
    await coordinatorQueue.enqueue({
      stepId: "call-1",
      taskId: "task",
      runId: "run",
      agentId: "subagent-1",
      importance: "normal",
      payload: { task: "inspect" }
    });
    const queuedMessage = await coordinator.sendMessage({
      taskId: "task",
      runId: "run",
      workspaceRoot: coordinatorRoot,
      callId: "call-1",
      message: "Prioritize the error path."
    });
    assert.equal(queuedMessage.status, "queued");
    const subagentInbox = new InboxStore(
      join(coordinatorRoot, "task", "runs", "run", "agents", "subagents", "subagent-1", "inbox-store.json")
    );
    const queuedMessages = await subagentInbox.list("subagent-1");
    assert.equal(
      (queuedMessages[0]?.payload as { message?: string } | undefined)?.message,
      "Prioritize the error path."
    );
    const cancelled = await coordinator.cancelSubagent({
      taskId: "task",
      runId: "run",
      workspaceRoot: coordinatorRoot,
      callId: "call-1",
      reason: "no longer needed"
    });
    assert.equal(cancelled.status, "cancelled");
    assert.equal((await coordinatorQueue.list())[0]?.status, "cancelled");
    await coordinatorQueue.enqueue({
      stepId: "call-pending",
      taskId: "task",
      runId: "run",
      agentId: "subagent-2",
      importance: "normal",
      payload: { task: "wait" }
    });
    const pendingSnapshot = await coordinator.waitForSubagents({
      taskId: "task",
      runId: "run",
      workspaceRoot: coordinatorRoot,
      timeoutMs: 0
    });
    assert.deepEqual(pendingSnapshot.pending, ["call-pending"]);
    await coordinatorQueue.cancel("call-pending");

    const lifecycleRoot = join(root, "lifecycle");
    const lifecycleWorkspace = new LocalWorkspaceStore(lifecycleRoot);
    await lifecycleWorkspace.createTask("lifecycle-task", { goal: "ship the feature" });
    assert.equal((await lifecycleWorkspace.readTask("lifecycle-task")).status, "created");
    await lifecycleWorkspace.transitionTask("lifecycle-task", "running", {
      runId: "run-1",
      reason: "started"
    });
    await lifecycleWorkspace.updateTask("lifecycle-task", { successCriteria: ["tests pass"] });
    await lifecycleWorkspace.transitionTask("lifecycle-task", "waiting", {
      runId: "run-1",
      reason: "awaiting callback"
    });
    assert.equal((await lifecycleWorkspace.readTask("lifecycle-task")).status, "waiting");
    await lifecycleWorkspace.transitionTask("lifecycle-task", "completed", {
      runId: "run-1",
      reason: "verified"
    });
    const completedTask = await lifecycleWorkspace.readTask("lifecycle-task");
    assert.equal(completedTask.status, "completed");
    assert.deepEqual(completedTask.successCriteria, ["tests pass"]);

    const pending = await coordinator.waitForSubagents({
      taskId: "task",
      runId: "run",
      workspaceRoot: coordinatorRoot,
      timeoutMs: 0
    });
    assert.deepEqual(pending.pending, []);

    const inbox = new InboxStore(join(root, "inbox.json"));
    const message = {
      messageId: "m1",
      recipientAgentId: "a",
      kind: "callback" as const,
      eventId: "e1",
      priority: 1,
      state: "ready" as const,
      payload: { ok: true },
      createdAt: new Date().toISOString()
    };
    await inbox.enqueue(message);
    await inbox.enqueue(message);
    const leased = await inbox.lease("a");
    assert.equal(leased?.messageId, "m1");
    await inbox.consume("m1");
    await inbox.consume("m1");
    assert.equal((await inbox.list("a"))[0].state, "consumed");
    const direct = { ...message, messageId: "m2", eventId: "e2" };
    await inbox.enqueue(direct);
    const directLease = await inbox.leaseMessage("a", "m2");
    assert.equal(directLease?.state, "leased");
    await inbox.release("m2");
    assert.equal((await inbox.list("a")).find((item) => item.messageId === "m2")?.state, "ready");
    const directRetry = await inbox.leaseMessage("a", "m2");
    assert.equal(directRetry?.state, "leased");
    await inbox.consume("m2");
    // A crashed consumer leaves a leased message; the next consumer can
    // reclaim it once the lease is expired.
    const expiredPath = join(root, "expired-inbox.json");
    const expiredInbox = new InboxStore(expiredPath);
    await expiredInbox.enqueue({ ...message, messageId: "m3", eventId: "e3" });
    await expiredInbox.lease("a");
    const expiredMessages = JSON.parse(await readFile(expiredPath, "utf8")) as Array<{
      lease?: { expiresAt: string };
    }>;
    expiredMessages[0].lease = { expiresAt: new Date(Date.now() - 1).toISOString() } as never;
    await writeFile(expiredPath, JSON.stringify(expiredMessages), "utf8");
    assert.equal((await expiredInbox.lease("a"))?.messageId, "m3");

    const watcherRoot = join(root, "watcher");
    const watcherWorkspace = new LocalWorkspaceStore(watcherRoot);
    await watcherWorkspace.createRun("watch-task", "watch-run");
    const watcher = new WatcherRuntime({
      workspaceRoot: watcherRoot,
      taskId: "watch-task",
      runId: "watch-run"
    });
    const observation = {
      watcherId: "file-watcher",
      source: "repo",
      type: "file.changed",
      dedupeKey: "src/app.ts:42",
      payload: { path: "src/app.ts" }
    };
    const accepted = await watcher.ingest(observation);
    assert.equal(accepted.accepted, true);
    const duplicate = await watcher.ingest(observation);
    assert.equal(duplicate.duplicate, true);
    const externalInbox = new InboxStore(
      join(watcherRoot, "watch-task", "runs", "watch-run", "agents", "main", "inbox-store.json")
    );
    assert.equal(
      (await externalInbox.list("main")).filter((message) => message.kind === "external_event").length,
      1
    );
    const polled = await watcher.poll({
      watcherId: "manual",
      poll: async () => [{ ...observation, watcherId: "timer", dedupeKey: "tick-1", type: "timer.tick" }]
    });
    assert.equal(polled.accepted, 1);
    const failedPoll = await watcher.poll({
      watcherId: "broken",
      poll: async () => {
        throw new Error("source unavailable");
      }
    });
    assert.equal(failedPoll.failed, "source unavailable");

    const human = new HumanRequestStore(join(root, "human"));
    const request = await human.create({
      taskId: "company-task",
      runId: "watch-run",
      question: "是否扩大监控范围？",
      options: ["是", "否"]
    });
    assert.equal((await human.list("company-task", "pending"))[0]?.requestId, request.requestId);
    const answered = await human.answer("company-task", request.requestId, "是");
    assert.equal(answered.status, "answered");

    // Subagent -> Main questions: the upward counterpart to askhuman.
    const questions = new SubagentQuestionStore(join(root, "questions"));
    const questionInput = {
      taskId: "question-task",
      runId: "question-run",
      callId: "call-1",
      agentId: "subagent-1",
      agentName: "Ada",
      question: "哪个评测脚本是权威的？",
      assumption: "用 scripts/eval.py"
    };
    const raised = await questions.create({ questionId: "question-1", ...questionInput });
    assert.equal(raised.status, "pending");
    assert.equal((await questions.list("question-task", "pending")).length, 1);
    // A replayed tool call must not open a second question for the same id.
    assert.equal(
      (await questions.create({ questionId: "question-1", ...questionInput })).createdAt,
      raised.createdAt
    );
    assert.equal((await questions.list("question-task", "pending")).length, 1);

    // waitForAnswer returns as soon as Main answers.
    const waiting = questions.waitForAnswer("question-task", "question-1", { timeoutMs: 5_000, pollMs: 100 });
    await questions.answer("question-task", "question-1", "configs/eval.py");
    const settled = await waiting;
    assert.equal(settled.status, "answered");
    assert.equal(settled.question.answer, "configs/eval.py");
    // A repeated answer keeps the first one.
    assert.equal((await questions.answer("question-task", "question-1", "别的")).answer, "configs/eval.py");
    assert.equal((await questions.list("question-task", "pending")).length, 0);

    // A timeout expires the question so it stops counting as outstanding work.
    await questions.create({ questionId: "question-2", ...questionInput });
    const expired = await questions.waitForAnswer("question-task", "question-2", {
      timeoutMs: 0,
      pollMs: 50
    });
    assert.equal(expired.status, "expired");
    assert.equal((await questions.list("question-task", "pending")).length, 0);
    // An answer arriving after the Subagent gave up leaves the record expired.
    assert.equal((await questions.answer("question-task", "question-2", "太晚了")).status, "expired");

    // Cancellation is polled, because a blocking tool never receives the signal.
    await questions.create({ questionId: "question-3", ...questionInput });
    const cancelledWait = await questions.waitForAnswer("question-task", "question-3", {
      timeoutMs: 60_000,
      pollMs: 50,
      isCancelled: () => true
    });
    assert.equal(cancelledWait.status, "cancelled");
    assert.equal((await questions.read("question-task", "question-3")).status, "expired");

    // A terminal call closes what it left open, scoped to its own callId.
    await questions.create({ questionId: "question-4", ...questionInput });
    await questions.create({ questionId: "question-5", ...questionInput, callId: "call-2" });
    const reclaimedQuestions = await questions.expireForCall("question-task", "call-1");
    assert.deepEqual(
      reclaimedQuestions.map((entry) => entry.questionId),
      ["question-4"]
    );
    assert.deepEqual(
      (await questions.list("question-task", "pending")).map((entry) => entry.questionId),
      ["question-5"]
    );

    await assert.rejects(
      questions.create({ questionId: "question-6", ...questionInput, assumption: "  " }),
      /assumption/
    );
    console.log("P2 scheduler/checkpoint/inbox tests passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
