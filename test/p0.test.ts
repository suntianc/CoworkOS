import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEvent } from "../src/testing/fakes.js";
import { JsonlEventStore } from "../src/storage/event-store.js";
import { resolveCallMode, transitionCall, type Call } from "../src/domain/types.js";
import { LocalWorkspaceStore } from "../src/workspace/workspace-store.js";
import { listTaskArtifacts } from "../src/workspace/artifact-store.js";
import {
  configuredMainTimeout,
  configuredSubagentTimeout,
  configuredWorkspaceRoot,
  runtimeSettingsEnv
} from "../src/runtime/runtime-settings.js";
import { assessTaskCompletion } from "../src/runtime/task-completion.js";

async function main(): Promise<void> {
  assert.equal(
    resolveCallMode({ requestedMode: "auto", importance: "normal", dependency: "required" }),
    "sync"
  );
  assert.equal(
    resolveCallMode({ requestedMode: "auto", importance: "normal", dependency: "independent" }),
    "async"
  );
  assert.equal(configuredMainTimeout({ COWORK_MAIN_TIMEOUT_MS: "180000" }), 180000);
  assert.equal(configuredSubagentTimeout({ COWORK_TIMEOUT_MS: "900000" }), 900000);
  assert.equal(
    configuredSubagentTimeout({ COWORK_TIMEOUT_MS: "900000", COWORK_SUBAGENT_TIMEOUT_MS: "0" }),
    0
  );
  assert.equal(configuredMainTimeout(runtimeSettingsEnv({ mainTimeoutMs: 0 })), 0);
  assert.equal(
    configuredWorkspaceRoot({ workspaceRoot: ".tmp-from-config" }, {}, "/repo"),
    "/repo/.tmp-from-config"
  );
  assert.equal(
    configuredWorkspaceRoot(
      { workspaceRoot: ".tmp-from-config" },
      { COWORK_WORKSPACE: "/tmp/from-env" },
      "/repo"
    ),
    "/tmp/from-env"
  );
  assert.equal(
    configuredWorkspaceRoot({}, { ATRIA_HOME: "/fixture/atria" }, "/repo"),
    "/fixture/atria/workspace"
  );
  assert.deepEqual(assessTaskCompletion({ hasFinalAnswer: true }), { ready: true, reason: "ready" });
  assert.deepEqual(assessTaskCompletion({ hasFinalAnswer: false }), {
    ready: false,
    reason: "incomplete_response"
  });
  assert.deepEqual(assessTaskCompletion({ pendingCallbacks: 1 }), {
    ready: false,
    reason: "pending_callbacks"
  });
  assert.deepEqual(assessTaskCompletion({ pendingCalls: 1 }), { ready: false, reason: "pending_subagents" });
  assert.deepEqual(assessTaskCompletion({ pendingHumanRequests: 1 }), {
    ready: false,
    reason: "pending_human"
  });
  assert.deepEqual(assessTaskCompletion({ pendingSubagentQuestions: 1 }), {
    ready: false,
    reason: "pending_subagent_questions"
  });
  // A blocked Subagent is usually also a pending call; the older reasons keep priority.
  assert.deepEqual(assessTaskCompletion({ pendingCalls: 1, pendingSubagentQuestions: 1 }), {
    ready: false,
    reason: "pending_subagents"
  });
  assert.deepEqual(assessTaskCompletion({ pendingSubagentQuestions: 1, hasFinalAnswer: true }), {
    ready: false,
    reason: "pending_subagent_questions"
  });
  assert.deepEqual(assessTaskCompletion(), { ready: true, reason: "ready" });

  const call: Call = {
    callId: "call_1",
    callerAgentId: "main",
    calleeAgentId: "coordinator",
    mode: "sync",
    importance: "normal",
    dependency: "required",
    callbackPolicy: "on_complete",
    interruptOnCallback: false,
    state: "created",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  assert.equal(transitionCall(call, "accepted").state, "accepted");
  assert.throws(() => transitionCall(call, "succeeded"), /invalid call transition/);

  const dir = await mkdtemp(join(tmpdir(), "cowork-p0-"));
  try {
    const store = new JsonlEventStore(join(dir, "events.jsonl"));
    await store.append(fakeEvent("run_a"));
    await store.append(fakeEvent("run_b"));
    assert.equal((await store.list("run_a")).length, 1);
    assert.equal((await store.list("run_b")).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "cowork-workspace-"));
  try {
    const workspace = new LocalWorkspaceStore(workspaceRoot);
    await workspace.createRun("task_1", "run_1");
    await workspace.createTask("task_1");
    const initialTaskEvents = (await readFile(join(workspaceRoot, "task_1", "task_events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    assert.equal(initialTaskEvents.filter((event) => event.type === "task.created").length, 1);
    const createdTask = await workspace.readTask("task_1");
    assert.deepEqual(createdTask.completion, { policy: "natural", signal: "none" });
    await workspace.updateTask("task_1", { completion: { policy: "explicit" } });
    assert.equal((await workspace.readTask("task_1")).completion?.policy, "explicit");
    await workspace.transitionTask("task_1", "waiting", {
      runId: "run_1",
      reason: "natural stop",
      completion: { signal: "natural_stop" }
    });
    assert.equal((await workspace.readTask("task_1")).completion?.signal, "natural_stop");
    await workspace.transitionTask("task_1", "completed", {
      runId: "run_1",
      reason: "verified",
      completion: { signal: "finish_task", summary: "verified", verifiedAt: new Date().toISOString() }
    });
    const completedTask = await workspace.readTask("task_1");
    assert.equal(completedTask.completion?.signal, "finish_task");
    assert.equal(completedTask.completion?.summary, "verified");
    const taskEvents = (await readFile(join(workspaceRoot, "task_1", "task_events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; completion?: { signal?: string } });
    assert.equal(
      taskEvents.some(
        (event) => event.type === "task.status_changed" && event.completion?.signal === "finish_task"
      ),
      true
    );
    await workspace.transitionTask("task_1", "running", {
      runId: "run_2",
      reason: "new execution generation"
    });
    assert.equal((await workspace.readTask("task_1")).completion?.signal, "none");
    assert.equal(workspace.agentWorkDir("task_1", "run_1", "sub_1").endsWith("agents/subagents/sub_1"), true);
    assert.equal(
      workspace.sessionPath("task_1", "run_1", "main").endsWith("task_1/sessions/main/run_1.jsonl"),
      true
    );
    const preparedWorkDir = await workspace.prepareAgentWorkDir("task_1", "run_1", "sub_1");
    assert.equal(preparedWorkDir.endsWith("task_1/agents/subagents/sub_1"), true);
    const artifact = await workspace.publishArtifact({
      taskId: "task_1",
      runId: "run_1",
      producerAgentId: "sub_1",
      relativePath: "answer.txt",
      content: "ok"
    });
    assert.equal(artifact.size, 2);
    assert.equal(artifact.sha256.length, 64);
    const manifest = await listTaskArtifacts({ workspaceRoot, taskId: "task_1" });
    assert.equal(manifest.length, 1);
    assert.equal("content" in manifest[0], false);
    assert.equal(manifest[0].relativePath, "answer.txt");
    const nestedArtifact = await workspace.publishArtifact({
      taskId: "task_1",
      runId: "run_1",
      producerAgentId: "sub_1",
      relativePath: "deliverables/report.md",
      content: "# report"
    });
    assert.equal(nestedArtifact.relativePath, "deliverables/report.md");
    await workspace.publishArtifact({
      taskId: "task_1",
      runId: "run_1",
      producerAgentId: "sub_1",
      relativePath: "answer.txt",
      content: "updated"
    });
    const replacedManifest = await listTaskArtifacts({ workspaceRoot, taskId: "task_1" });
    assert.equal(replacedManifest.filter((entry) => entry.relativePath === "answer.txt").length, 1);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }

  console.log("P0 tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
