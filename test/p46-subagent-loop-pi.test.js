import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { DurableScheduler } from "../dist/src/runtime/scheduler.js";

/**
 * Delegation through the backend: execute, review, rework, re-review.
 *
 * Main asks the serving backend for a work item; the backend registers it in
 * the Run's durable queue, launches a real delegated Pi process, and settles it
 * back into the queue, the Run events and Main's Inbox. Every case here runs the
 * real Dashboard, the real launcher and real Pi processes against a scripted
 * local provider; no part of the loop is an in-process stand-in.
 */

const harness = resolve(".");
const git = promisify(execFile);
const runGit = (cwd, args) =>
  git("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((result) => result.stdout.trim());

async function waitFor(check, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(25);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const messageText = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("");

const userText = (body) =>
  body.messages
    .filter((message) => message.role === "user")
    .map(messageText)
    .join("\n");
const assistantText = (body) =>
  body.messages
    .filter((message) => message.role === "assistant")
    .map(messageText)
    .join("\n");
const lastToolText = (body) => {
  const last = body.messages.findLast((message) => message.role === "tool");
  return last ? messageText(last) : "";
};
const toolJson = (body) => JSON.parse(lastToolText(body));

/**
 * Which work item this request is for, read from the role and the brief.
 *
 * A continuation carries every earlier turn, so the label comes from the
 * latest user brief rather than from the first one in the transcript.
 */
function identityOf(body) {
  const system = body.messages
    .filter((message) => ["system", "developer"].includes(message.role))
    .map(messageText)
    .join("\n");
  if (!system.includes("You are a CoworkOS Subagent")) return "main";
  const brief = body.messages.filter((message) => message.role === "user").at(-1);
  const match = (brief ? messageText(brief) : "").match(/工作项 ([A-Z])/);
  return match ? match[1] : "unknown";
}

const client = (dashboard) => async (path, body, method) => {
  const response = await fetch(`${dashboard.base}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
};

const settle = async (request, taskId, timeout = 180_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const detail = await request(`/api/tasks/${encodeURIComponent(taskId)}`);
    if (detail.status === 200 && !detail.body.runtime.active && detail.body.task.status === "completed")
      return detail.body;
    await delay(50);
  }
  assert.fail(`Main ${taskId} did not settle`);
};

async function makeRepository(directory) {
  await mkdir(directory, { recursive: true });
  await runGit(directory, ["init", "-b", "main"]);
  await runGit(directory, ["config", "user.email", "fixture@example.test"]);
  await runGit(directory, ["config", "user.name", "Fixture"]);
  await writeFile(join(directory, "tracked.txt"), "committed\n");
  await runGit(directory, ["add", "."]);
  await runGit(directory, ["commit", "-m", "baseline"]);
  return directory;
}

/** A real Dashboard, a scripted local provider, a project and one requirement. */
async function fixture(t, { handle, taskId = "loop-task", goal = "完成需求并独立审查" }) {
  const root = await mkdtemp(join(tmpdir(), "p46-loop-"));
  const repository = await makeRepository(join(root, "repository"));
  const provider = await modelProtocolFixture("openai-completions", handle);
  const dashboard = await startDashboard({
    defaultProject: false,
    env: { COWORK_PROJECT_WRITE: "1", COWORK_DISABLE_MAIN_GUARDIAN: "1" }
  });
  t.after(async () => {
    await dashboard.stop();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  });
  const request = client(dashboard);
  const saved = await request("/api/model-settings", {
    profileName: "本地夹具",
    baseUrl: provider.baseUrl,
    model: "protocol-fixture",
    api: "openai-completions",
    supportsReasoningEffort: false,
    supportsImages: false,
    apiKey: "local-fixture-key"
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const created = await request("/api/projects", {
    projectName: "派单闭环项目",
    projectDirectory: repository
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const project = created.body.project;
  const requirement = await request(`/api/projects/${encodeURIComponent(project.projectId)}/ledger`, {
    action: "create",
    title: "导出入口",
    content: "报表页提供导出入口。"
  });
  assert.equal(requirement.status, 201, JSON.stringify(requirement.body));
  const merge = await request(`/api/projects/${encodeURIComponent(project.projectId)}/merge-config`, {
    repository,
    targetBranch: "main"
  });
  assert.equal(merge.status, 200, JSON.stringify(merge.body));
  const task = await request("/api/tasks", {
    taskId,
    goal,
    projectId: project.projectId
  });
  assert.equal(task.status, 201, JSON.stringify(task.body));
  return {
    root,
    repository,
    provider,
    dashboard,
    request,
    project,
    requirementId: requirement.body.requirement.requirementId,
    taskId
  };
}

/** Queue, process records and Main's Inbox of one Run. */
function runPaths(dashboard, taskId, runId) {
  const runRoot = join(dashboard.workspaceRoot, taskId, "runs", runId);
  return {
    runRoot,
    queue: join(runRoot, "queue.json"),
    subagents: join(runRoot, "agents", "subagents")
  };
}

async function queueItems(f, runId) {
  return await new DurableScheduler(runPaths(f.dashboard, f.taskId, runId).queue).list();
}

async function processRecords(f, runId) {
  const run = runPaths(f.dashboard, f.taskId, runId);
  const directories = [join(run.runRoot, "agents", "main")];
  for (const entry of await readdir(run.subagents, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) directories.push(join(run.subagents, entry.name));
  }
  const records = [];
  for (const directory of directories) {
    const value = await readFile(join(directory, "process.json"), "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => undefined);
    if (value) records.push(value);
  }
  return records;
}

/** No work item is left for a backend nobody runs any more. */
async function assertEverythingSettled(f, runId) {
  const items = await queueItems(f, runId);
  assert.deepEqual(
    items
      .filter((item) => !["completed", "failed", "cancelled"].includes(item.status))
      .map((item) => item.stepId),
    [],
    "every dispatched work item reached a terminal state"
  );
  const records = await processRecords(f, runId);
  assert.deepEqual(
    records.filter((record) => record.role !== "main" && !record.settledAt).map((record) => record.callId),
    [],
    "every delegated process was settled by an owner"
  );
}

test(
  "AC1/AC4: executors and reviewers close the loop through the backend, including after a backend restart",
  { timeout: 300_000 },
  async (t) => {
    const mainSteps = [];
    const subagentSteps = new Map();
    const failures = [];
    let developmentId = "";
    let integration = "";
    let calls = {};
    let reviewIds = {};
    let candidate1 = "";
    let reworkSawOriginalSession = false;
    let reviewerPin = {};
    let restartRequested;
    const beforeRestart = new Promise((done) => {
      restartRequested = done;
    });
    let releaseAfterRestart;
    const afterRestart = new Promise((done) => {
      releaseAfterRestart = done;
    });
    let failTest;
    const scriptFailure = new Promise((_, reject) => {
      failTest = reject;
    });
    const f = await fixture(t, {
      handle: async (body) => {
        try {
          const role = identityOf(body);
          const step = role === "main" ? mainSteps.length : (subagentSteps.get(role) ?? 0);
          if (role === "main") mainSteps.push(lastToolText(body));
          else subagentSteps.set(role, step + 1);
          if (role === "main") {
            if (step === 0)
              return {
                name: "project_development",
                arguments: {
                  action: "create",
                  requirementId: f.requirementId,
                  goal: "报表页提供导出入口",
                  completionCriteria: ["导出文件包含实现结果"],
                  route: "direct"
                }
              };
            if (step === 1) {
              const development = toolJson(body).development;
              integration = development.workspace.directory;
              developmentId = development.developmentId;
              return {
                name: "call_subagent",
                arguments: {
                  task: "执行者工作项 A：在需求现场写入 impl.txt 并提交。",
                  mode: "sync",
                  role: "executor",
                  developmentId
                }
              };
            }
            if (step === 2) {
              calls.a = toolJson(body);
              assert.equal(calls.a.status, "succeeded", JSON.stringify(calls.a));
              assert.equal(calls.a.role, "executor");
              assert.notEqual(calls.a.workspace, integration);
              // Mid-loop, while Main is between two steps and no work item is
              // running: the backend restarts and the loop must still finish.
              restartRequested();
              await afterRestart;
              return {
                name: "bash",
                arguments: {
                  command: [
                    "set -e",
                    `cd "${integration}"`,
                    `cp "${calls.a.workspace}/impl.txt" .`,
                    "git add -A",
                    'git commit -m "collect A" >/dev/null',
                    "echo COLLECTED_A"
                  ].join(" && ")
                }
              };
            }
            if (step === 3) {
              assert.match(lastToolText(body), /COLLECTED_A/);
              return {
                name: "project_development",
                arguments: {
                  action: "review_plan",
                  developmentId,
                  channel: "independent",
                  basis: "实现结果需要独立核验",
                  checks: [
                    { name: "自检：文件存在", command: "cat impl.txt", exitCode: 0, output: "impl v1" }
                  ]
                }
              };
            }
            if (step === 4)
              return {
                name: "project_development",
                arguments: {
                  action: "freeze_candidate",
                  developmentId,
                  kind: "independent",
                  authorCallId: calls.a.callId
                }
              };
            if (step === 5) {
              const review = toolJson(body).review;
              reviewIds.first = review.reviewId;
              candidate1 = review.candidate.commit;
              // The Executor checkout advances after the freeze. The Reviewer
              // must still examine the frozen candidate, not this newer commit.
              return {
                name: "bash",
                arguments: {
                  command: `cd "${integration}" && printf "later\\n" > later.txt && git add -A && git commit -m "later change" >/dev/null && git rev-parse HEAD`
                }
              };
            }
            if (step === 6) {
              const advanced = lastToolText(body).trim().split("\n").at(-1);
              assert.notEqual(
                advanced,
                candidate1,
                "the integration checkout moved past the frozen candidate"
              );
              return {
                name: "call_subagent",
                arguments: {
                  task: "审查者工作项 B：独立核验冻结候选的导出实现。",
                  mode: "sync",
                  role: "reviewer",
                  developmentId
                }
              };
            }
            if (step === 7) {
              calls.b = toolJson(body);
              assert.equal(calls.b.status, "succeeded", JSON.stringify(calls.b));
              assert.equal(calls.b.role, "reviewer");
              assert.notEqual(calls.b.workspace, calls.a.workspace);
              reviewerPin = { head: await runGit(calls.b.workspace, ["rev-parse", "HEAD"]) };
              return {
                name: "call_subagent",
                arguments: {
                  task: "执行者工作项 D：修复审查发现，写入 impl.txt 的第二版并提交。",
                  mode: "sync",
                  role: "executor",
                  developmentId,
                  continueCallId: calls.a.callId,
                  reviewId: reviewIds.first
                }
              };
            }
            if (step === 8) {
              calls.a2 = toolJson(body);
              assert.equal(calls.a2.status, "succeeded", JSON.stringify(calls.a2));
              assert.equal(calls.a2.agentId, calls.a.agentId, "the rework keeps the original identity");
              assert.equal(calls.a2.workspace, calls.a.workspace, "the rework keeps the original checkout");
              assert.equal(calls.a2.continuedFrom, calls.a.callId);
              return {
                name: "bash",
                arguments: {
                  command: [
                    "set -e",
                    `cd "${integration}"`,
                    `cp "${calls.a2.workspace}/impl.txt" .`,
                    "git add -A",
                    'git commit -m "collect rework" >/dev/null',
                    "echo COLLECTED_A2"
                  ].join(" && ")
                }
              };
            }
            if (step === 9) {
              assert.match(lastToolText(body), /COLLECTED_A2/);
              return {
                name: "project_development",
                arguments: {
                  action: "freeze_candidate",
                  developmentId,
                  kind: "independent",
                  previousReviewId: reviewIds.first
                }
              };
            }
            if (step === 10) {
              return {
                name: "call_subagent",
                arguments: {
                  task: "审查者工作项 C：复审返修后的候选。",
                  mode: "sync",
                  role: "reviewer",
                  developmentId
                }
              };
            }
            if (step === 11) {
              calls.c = toolJson(body);
              assert.equal(calls.c.status, "succeeded", JSON.stringify(calls.c));
              return { text: "实现、审查与返修已完成。" };
            }
            return { text: "实现、审查与返修已完成。" };
          }
          if (role === "A") {
            if (step === 0) return { name: "write", arguments: { path: "impl.txt", content: "impl v1\n" } };
            if (step === 1)
              return {
                name: "bash",
                arguments: { command: 'git add -A && git commit -m "impl v1" >/dev/null && echo COMMITTED_A' }
              };
            return { text: "A 完成：impl.txt 第一版已提交。" };
          }
          if (role === "B") {
            if (step === 0)
              return {
                name: "submit_review",
                arguments: {
                  verdict: "changes_requested",
                  findings: [
                    {
                      location: "impl.txt",
                      evidence: "impl.txt 只有第一版实现，需要返修后复审。",
                      blocking: true
                    }
                  ]
                }
              };
            return { text: "B 完成：候选需要返修。" };
          }
          if (role === "D") {
            // The rework appends one turn to A's own session: the first
            // attempt's prompts and answer are the transcript it continues.
            assert.match(userText(body), /修复审查发现/);
            assert.match(assistantText(body), /impl\.txt 第一版已提交/);
            assert.equal(
              body.messages.filter((message) => message.role === "user").length,
              2,
              "the rework turn is appended to the original transcript"
            );
            reworkSawOriginalSession = true;
            if (step === 0) return { name: "write", arguments: { path: "impl.txt", content: "impl v2\n" } };
            if (step === 1)
              return {
                name: "bash",
                arguments: {
                  command: 'git add -A && git commit -m "impl v2" >/dev/null && echo COMMITTED_A2'
                }
              };
            return { text: "D 完成：impl.txt 第二版已提交。" };
          }
          // Reviewer C is the one whose settlement happens after the backend
          // was restarted underneath it.
          if (step === 0) return { name: "submit_review", arguments: { verdict: "pass", findings: [] } };
          return { text: "C 完成：返修后的候选通过审查。" };
        } catch (error) {
          failures.push(error.stack ?? error.message);
          failTest(error);
          return { text: "派单闭环夹具失败。" };
        }
      }
    });
    const started = await f.request(`/api/tasks/${encodeURIComponent(f.taskId)}/run`, {
      prompt: "实现导出需求，冻结候选做独立审查，按审查发现返修并复审。"
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    // AC4: the backend serving the loop restarts in the middle of it.
    await Promise.race([beforeRestart, scriptFailure]);
    await f.dashboard.restart();
    releaseAfterRestart();
    await Promise.race([settle(f.request, f.taskId), scriptFailure]);
    assert.equal(reworkSawOriginalSession, true, "the rework request carried the original session history");
    assert.deepEqual(failures, [], failures.join("\n"));

    // The Reviewer examined the frozen candidate even though the Executor
    // checkout had already moved past it.
    assert.equal(reviewerPin.head, candidate1, "the Reviewer's site is the frozen candidate");
    assert.notEqual(reviewerPin.head, await runGit(integration, ["rev-parse", "HEAD"]));
    assert.equal(await readFile(join(integration, "impl.txt"), "utf8"), "impl v2\n");
    // The rework reused the original branch rather than a fresh checkout.
    assert.equal(
      await runGit(calls.a2.workspace, ["rev-parse", "--abbrev-ref", "HEAD"]),
      `coworkos/work/${calls.a.callId}`
    );
    await assertEverythingSettled(f, started.body.runId);
  }
);

test(
  "AC2: a dependent item starts only after its prerequisite, and two parallel items never share a checkout",
  { timeout: 300_000 },
  async (t) => {
    const mainSteps = [];
    const subagentSteps = new Map();
    const failures = [];
    let developmentId = "";
    let calls = {};
    let gateStarted;
    const started = new Promise((done) => {
      gateStarted = done;
    });
    let release;
    const held = new Promise((done) => {
      release = done;
    });
    let failTest;
    const scriptFailure = new Promise((_, reject) => {
      failTest = reject;
    });
    const f = await fixture(t, {
      handle: async (body) => {
        try {
          const role = identityOf(body);
          const step = role === "main" ? mainSteps.length : (subagentSteps.get(role) ?? 0);
          if (role === "main") mainSteps.push(lastToolText(body));
          else subagentSteps.set(role, step + 1);
          if (role === "main") {
            if (step === 0)
              return {
                name: "project_development",
                arguments: {
                  action: "create",
                  requirementId: f.requirementId,
                  goal: "报表页提供导出入口",
                  completionCriteria: ["导出文件包含实现结果"],
                  route: "direct"
                }
              };
            if (step === 1) {
              developmentId = toolJson(body).development.developmentId;
              return {
                name: "call_subagent",
                arguments: {
                  task: "执行者工作项 A：先写 impl-a.txt，等待被取消。",
                  mode: "async",
                  role: "executor",
                  developmentId
                }
              };
            }
            if (step === 2) {
              calls.a = toolJson(body);
              return {
                name: "call_subagent",
                arguments: {
                  task: "执行者工作项 B：写 impl-b.txt 并返回。",
                  mode: "async",
                  role: "executor",
                  developmentId
                }
              };
            }
            if (step === 3) {
              calls.b = toolJson(body);
              return {
                name: "call_subagent",
                arguments: {
                  task: "执行者工作项 C：只在 A 完成后写 impl-c.txt。",
                  mode: "async",
                  role: "executor",
                  developmentId,
                  dependsOn: [calls.a.callId]
                }
              };
            }
            if (step === 4) {
              calls.c = toolJson(body);
              assert.deepEqual(calls.c.dependsOn, [calls.a.callId]);
              assert.notEqual(calls.a.workspace, calls.b.workspace, "parallel items get their own checkouts");
              return {
                name: "cancel_subagent",
                arguments: { callId: calls.a.callId, reason: "改由其它工作项覆盖" }
              };
            }
            if (step === 5) {
              const cancelled = toolJson(body);
              assert.equal(cancelled.callId, calls.a.callId);
              assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
              return {
                name: "wait_for_subagents",
                arguments: { callIds: [calls.a.callId, calls.b.callId, calls.c.callId], timeoutMs: 120_000 }
              };
            }
            if (step === 6) {
              const waited = toolJson(body);
              const statuses = new Map(waited.calls.map((call) => [call.callId, call.status]));
              assert.equal(statuses.get(calls.a.callId), "cancelled");
              assert.equal(statuses.get(calls.b.callId), "completed");
              assert.equal(statuses.get(calls.c.callId), "failed", JSON.stringify(waited.calls));
              return { text: "依赖顺序与隔离现场已核对。" };
            }
            return { text: "依赖顺序与隔离现场已核对。" };
          }
          if (role === "A") {
            if (step === 0) {
              gateStarted();
              await held;
              return { name: "write", arguments: { path: "impl-a.txt", content: "a\n" } };
            }
            return { text: "A 完成。" };
          }
          if (role === "B") {
            if (step === 0) return { name: "write", arguments: { path: "impl-b.txt", content: "b\n" } };
            return { text: "B 完成：impl-b.txt 已写入。" };
          }
          // C must never reach the model: its prerequisite was cancelled.
          if (step === 0) return { name: "write", arguments: { path: "impl-c.txt", content: "c\n" } };
          return { text: "C 完成：impl-c.txt 已写入。" };
        } catch (error) {
          failures.push(error.stack ?? error.message);
          failTest(error);
          return { text: "依赖夹具失败。" };
        }
      }
    });
    const run = await f.request(`/api/tasks/${encodeURIComponent(f.taskId)}/run`, {
      prompt: "按依赖组织实现工作项。"
    });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    await Promise.race([settle(f.request, f.taskId), scriptFailure]);
    release();
    assert.deepEqual(failures, [], failures.join("\n"));
    assert.equal(
      f.provider.requests.filter((entry) => userText(entry.body).includes("工作项 C")).length,
      0,
      "the dependent item never ran after its prerequisite was cancelled"
    );
    assert.equal(await readFile(join(calls.b.workspace, "impl-b.txt"), "utf8"), "b\n");
    const dependentItem = (await queueItems(f, run.body.runId)).find(
      (item) => item.stepId === calls.c.callId
    );
    assert.equal(dependentItem.status, "failed", JSON.stringify(dependentItem));
    assert.match(String(dependentItem.error), /前置工作 .* 未成功完成，本工作项未执行/);
    await assertEverythingSettled(f, run.body.runId);
  }
);

test(
  "AC3: a waiting Main stays alive in one process, and that process takes no new demand",
  { timeout: 300_000 },
  async (t) => {
    const mainSteps = new Map();
    const subagentSteps = new Map();
    const failures = [];
    let developmentId = "";
    let delegateGate;
    const delegated = new Promise((done) => {
      delegateGate = done;
    });
    let release;
    const held = new Promise((done) => {
      release = done;
    });
    let failTest;
    const scriptFailure = new Promise((_, reject) => {
      failTest = reject;
    });
    const f = await fixture(t, {
      handle: async (body) => {
        try {
          const role = identityOf(body);
          const promptKey = userText(body).includes("OTHER_DEMAND") ? "other" : "loop";
          if (role === "main" && promptKey === "other") return { text: "另一个需求已完成。" };
          const step = role === "main" ? (mainSteps.get("loop") ?? 0) : (subagentSteps.get(role) ?? 0);
          if (role === "main") mainSteps.set("loop", step + 1);
          else subagentSteps.set(role, step + 1);
          if (role === "main") {
            if (step === 0)
              return {
                name: "project_development",
                arguments: {
                  action: "create",
                  requirementId: f.requirementId,
                  goal: "报表页提供导出入口",
                  completionCriteria: ["导出文件包含实现结果"],
                  route: "direct"
                }
              };
            if (step === 1) {
              developmentId = toolJson(body).development.developmentId;
              return {
                name: "call_subagent",
                arguments: {
                  task: "执行者工作项 A：等待放行后写入 impl.txt。",
                  mode: "async",
                  role: "executor",
                  developmentId
                }
              };
            }
            if (step === 2) {
              const accepted = toolJson(body);
              assert.equal(accepted.accepted, true);
              delegateGate();
              return { name: "wait_for_subagents", arguments: { timeoutMs: 120_000 } };
            }
            if (step === 3) return { text: "子任务完成。" };
            return { text: "子代理闭环已完成。" };
          }
          if (step === 0) {
            release();
            return { name: "write", arguments: { path: "impl.txt", content: "impl v1\n" } };
          }
          return { text: "A 完成：impl.txt 已写入。" };
        } catch (error) {
          failures.push(error.stack ?? error.message);
          failTest(error);
          return { text: "等待中插入夹具失败。" };
        }
      }
    });
    const run = await f.request(`/api/tasks/${encodeURIComponent(f.taskId)}/run`, {
      prompt: "委派一个工作项，等待它完成。"
    });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    await Promise.race([delegated, scriptFailure]);
    // The Main process is in its waiting turn: the backend reports it running,
    // and the Run it owns is unchanged.
    const waiting = await waitFor(async () => {
      const detail = await f.request(`/api/tasks/${encodeURIComponent(f.taskId)}`);
      return detail.body.runtime.mainRunning && detail.body.runtime.active ? detail.body : undefined;
    }, "the backend to report the waiting Main");
    const mainPid = await waitFor(async () => {
      const records = await processRecords(f, run.body.runId);
      return records.find((record) => record.role === "main")?.pid;
    }, "the Main process record");
    assert.equal(waiting.task.activeRunId, run.body.runId);

    // A change inserted while the work item runs is queued for this same
    // process; a demand for another Task gets its own Main instead.
    const inserted = await f.request(`/api/tasks/${encodeURIComponent(f.taskId)}/run`, {
      prompt: "插入的变更：请在当前工作项完成后说明进度。"
    });
    assert.equal(inserted.status, 202, JSON.stringify(inserted.body));
    assert.equal(inserted.body.runId, run.body.runId, "the insertion joins the Run this Main owns");
    const other = await f.request("/api/tasks", {
      taskId: "loop-other",
      goal: "另一个需求",
      projectId: f.project.projectId
    });
    assert.equal(other.status, 201, JSON.stringify(other.body));
    const otherRun = await f.request("/api/tasks/loop-other/run", { prompt: "OTHER_DEMAND" });
    assert.equal(otherRun.status, 202, JSON.stringify(otherRun.body));
    await waitFor(async () => {
      const detail = await f.request("/api/tasks/loop-other");
      return !detail.body.runtime.active;
    }, "the other demand's own Main");
    const after = await processRecords(f, run.body.runId);
    assert.equal(
      after.find((record) => record.role === "main").pid,
      mainPid,
      "the waiting Main kept its process and did not take the other demand"
    );
    release();
    await Promise.race([settle(f.request, f.taskId), scriptFailure]);
    assert.deepEqual(failures, [], failures.join("\n"));
    assert.ok(
      f.provider.requests.some((entry) => userText(entry.body).includes("插入的变更")),
      "the inserted change was read by a Main turn"
    );
    const mainRecords = (await processRecords(f, run.body.runId)).filter((record) => record.role === "main");
    assert.equal(mainRecords.length, 1, "one Main process served the whole wait");
    assert.equal(
      mainRecords[0].settledAt,
      undefined,
      "a Subagent settling never settles Main's own process record"
    );
    assert.equal(alive(mainRecords[0].pid), true, "the waiting Main is still the same live process");
    await assertEverythingSettled(f, run.body.runId);
  }
);

test("closing the session stops the delegated process it started", { timeout: 180_000 }, async (t) => {
  let releaseGate;
  const gate = new Promise((done) => {
    releaseGate = done;
  });
  let gateStarted;
  const started = new Promise((done) => {
    gateStarted = done;
  });
  const mainSteps = [];
  let delegate = {};
  let developmentId = "";
  let failTest;
  const scriptFailure = new Promise((_, reject) => {
    failTest = reject;
  });
  const f = await fixture(t, {
    taskId: "cancel-task",
    handle: async (body) => {
      try {
        const role = identityOf(body);
        if (role === "main") {
          const step = mainSteps.length;
          mainSteps.push(lastToolText(body));
          if (step === 0)
            return {
              name: "project_development",
              arguments: {
                action: "create",
                requirementId: f.requirementId,
                goal: "报表页提供导出入口",
                completionCriteria: ["导出文件包含实现结果"],
                route: "direct"
              }
            };
          if (step === 1) {
            developmentId = toolJson(body).development.developmentId;
            return {
              name: "call_subagent",
              arguments: {
                task: "执行者工作项 A：等待放行后写入 impl.txt。",
                mode: "async",
                role: "executor",
                developmentId
              }
            };
          }
          if (step === 2) {
            delegate = toolJson(body);
            return { text: "已委派，等待结果。" };
          }
          return { text: "已委派，等待结果。" };
        }
        gateStarted();
        await gate;
        return { name: "write", arguments: { path: "impl.txt", content: "never\n" } };
      } catch (error) {
        failTest(error);
        return { text: "取消夹具失败。" };
      }
    }
  });
  const run = await f.request(`/api/tasks/${encodeURIComponent(f.taskId)}/run`, {
    prompt: "委派一个长任务。"
  });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await Promise.race([started, scriptFailure]);
  // The delegated process is alive and its record names it, so the close has
  // a real process group to end.
  const record = await waitFor(async () => {
    const records = await processRecords(f, run.body.runId);
    return records.find((entry) => entry.callId === delegate.callId && entry.pid && !entry.settledAt);
  }, "the delegated process record");
  assert.equal(alive(record.pid), true);

  const seen = [];
  let watching = true;
  void (async () => {
    while (watching) {
      const view = await f.request(`/api/tasks/${encodeURIComponent(f.taskId)}`).catch(() => undefined);
      // This loop observes the close; a read the backend cannot answer is a
      // sample of its own, not a reason to crash the test with a rejection.
      const body = view?.body?.task ? view.body : undefined;
      const state = body
        ? `${body.task.status}/${body.runtime.active}/${body.runtime.mainRunning}`
        : "unreadable";
      if (seen.at(-1) !== state) seen.push(state);
      await delay(20);
    }
  })();
  const closed = await f.request(`/api/tasks/${encodeURIComponent(f.taskId)}/action`, {
    action: "cancel"
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  const item = await waitFor(async () => {
    const found = (await queueItems(f, run.body.runId)).find((entry) => entry.stepId === delegate.callId);
    return found?.status === "cancelled" ? found : undefined;
  }, "the delegated item to be cancelled");
  assert.equal(item.status, "cancelled");
  await waitFor(() => !alive(record.pid), "the delegated process group to end", 30_000);
  await waitFor(
    async () => {
      const detail = await f.request(`/api/tasks/${encodeURIComponent(f.taskId)}`);
      return !detail.body.runtime.mainRunning;
    },
    "the Main process to end with the session",
    30_000
  );
  watching = false;
  await delay(100);
  const detail = await f.request(`/api/tasks/${encodeURIComponent(f.taskId)}`);
  // A late settlement callback must not reopen the session that was closed.
  assert.equal(detail.body.task.status, "cancelled", JSON.stringify(seen));
  assert.equal(detail.body.runtime.mainRunning, false);
  releaseGate();
});

test("a dependent item the backend owns is never recovered in-process", { timeout: 180_000 }, async (t) => {
  let releaseFirst;
  const firstGate = new Promise((done) => {
    releaseFirst = done;
  });
  let firstStarted;
  const firstReached = new Promise((done) => {
    firstStarted = done;
  });
  const mainSteps = [];
  const subagentSteps = new Map();
  let calls = {};
  let developmentId = "";
  let failTest;
  const scriptFailure = new Promise((_, reject) => {
    failTest = reject;
  });
  const f = await fixture(t, {
    taskId: "owned-dependency",
    handle: async (body) => {
      try {
        const role = identityOf(body);
        const step = role === "main" ? mainSteps.length : (subagentSteps.get(role) ?? 0);
        if (role === "main") mainSteps.push(lastToolText(body));
        else subagentSteps.set(role, step + 1);
        if (role === "main") {
          if (step === 0)
            return {
              name: "project_development",
              arguments: {
                action: "create",
                requirementId: f.requirementId,
                goal: "报表页提供导出入口",
                completionCriteria: ["导出文件包含实现结果"],
                route: "direct"
              }
            };
          if (step === 1) {
            developmentId = toolJson(body).development.developmentId;
            return {
              name: "call_subagent",
              arguments: {
                task: "执行者工作项 A：等待放行后写入 impl-a.txt。",
                mode: "async",
                role: "executor",
                developmentId
              }
            };
          }
          if (step === 2) {
            calls.a = toolJson(body);
            return {
              name: "call_subagent",
              arguments: {
                task: "执行者工作项 B：只在 A 完成后写入 impl-b.txt。",
                mode: "async",
                role: "executor",
                developmentId,
                dependsOn: [calls.a.callId]
              }
            };
          }
          if (step === 3) {
            calls.b = toolJson(body);
            // End the turn: from here Main's own settle loop keeps the turn
            // open while it waits, and that loop is where an in-process
            // recovery would claim the queued dependent item.
            return { text: "已委派两个工作项，等待结果。" };
          }
          return { text: "已委派两个工作项，等待结果。" };
        }
        if (role === "A") {
          if (step === 0) {
            firstStarted();
            await firstGate;
            return { name: "write", arguments: { path: "impl-a.txt", content: "a\n" } };
          }
          return { text: "A 完成：impl-a.txt 已写入。" };
        }
        if (step === 0) return { name: "write", arguments: { path: "impl-b.txt", content: "b\n" } };
        return { text: "B 完成：impl-b.txt 已写入。" };
      } catch (error) {
        failTest(error);
        return { text: "依赖夹具失败。" };
      }
    }
  });
  const run = await f.request(`/api/tasks/${encodeURIComponent(f.taskId)}/run`, {
    prompt: "按依赖组织两个实现工作项。"
  });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await Promise.race([firstReached, scriptFailure]);
  // B waits on A. Main's own turn is open and its recovery loop runs while
  // it waits, so an in-process recovery would claim B here.
  await delay(1_500);
  const waiting = (await queueItems(f, run.body.runId)).find((item) => item.stepId === calls.b.callId);
  assert.equal(waiting.status, "queued", "the backend's dependent item stays queued, not leased");
  assert.equal(
    (await processRecords(f, run.body.runId)).filter((entry) => entry.callId === calls.b.callId).length,
    0,
    "no process exists for B before its prerequisite finishes"
  );
  assert.equal(
    f.provider.requests.filter((entry) => userText(entry.body).includes("工作项 B")).length,
    0,
    "B is not started before its prerequisite"
  );

  releaseFirst();
  await Promise.race([settle(f.request, f.taskId), scriptFailure]);
  assert.equal(await readFile(join(calls.b.workspace, "impl-b.txt"), "utf8"), "b\n");
  // B ran as a real delegated process once A settled: the backend owns it.
  const record = await waitFor(async () => {
    const records = await processRecords(f, run.body.runId);
    return records.find((entry) => entry.callId === calls.b.callId && entry.pid);
  }, "a delegated process record for B");
  assert.equal(alive(record.pid), false, "the delegated process ended after its work");
  const finished = (await queueItems(f, run.body.runId)).find((item) => item.stepId === calls.b.callId);
  assert.equal(finished.status, "completed");
  await assertEverythingSettled(f, run.body.runId);
});

test(
  "a delegation under an open experiment program records and settles its ledger row",
  { timeout: 180_000 },
  async (t) => {
    const mainSteps = [];
    const subagentSteps = new Map();
    let calls = {};
    let failTest;
    const scriptFailure = new Promise((_, reject) => {
      failTest = reject;
    });
    const f = await fixture(t, {
      taskId: "experiment-task",
      handle: async (body) => {
        try {
          const role = identityOf(body);
          const step = role === "main" ? mainSteps.length : (subagentSteps.get(role) ?? 0);
          if (role === "main") mainSteps.push(lastToolText(body));
          else subagentSteps.set(role, step + 1);
          if (role === "main") {
            if (step === 0)
              return {
                name: "call_subagent",
                arguments: {
                  task: "执行者工作项 A：写入 metrics.json 并返回结论。",
                  mode: "sync",
                  role: "executor"
                }
              };
            if (step === 1) {
              calls.a = toolJson(body);
              assert.equal(calls.a.status, "succeeded", JSON.stringify(calls.a));
              return { text: "实验轮次已完成。" };
            }
            return { text: "实验轮次已完成。" };
          }
          if (step === 0)
            return {
              name: "write",
              arguments: { path: "metrics.json", content: JSON.stringify({ eval_score: 58.1 }) + "\n" }
            };
          return { text: "A 完成：本轮评测评分为 58.1。" };
        } catch (error) {
          failTest(error);
          return { text: "实验夹具失败。" };
        }
      }
    });
    const run = await f.request(`/api/tasks/${encodeURIComponent(f.taskId)}/run`, {
      prompt: "执行一轮可计量的实验委派。"
    });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    await Promise.race([settle(f.request, f.taskId), scriptFailure]);

    const { ExperimentProgramStore } = await import("../dist/src/runtime/experiment-program-store.js");
    const store = new ExperimentProgramStore(f.dashboard.workspaceRoot);
    const programs = await store.listPrograms(f.taskId);
    assert.equal(programs.length, 1, "the delegation opened one ledger program");
    const runs = await store.listRuns(f.taskId, programs[0].experimentId);
    const row = runs.find((entry) => entry.callId === calls.a.callId);
    assert.ok(row, `the ledger row names the delegated call: ${JSON.stringify(runs)}`);
    assert.equal(row.objective, "执行者工作项 A：写入 metrics.json 并返回结论。");
    assert.equal(row.status, "succeeded");
    assert.ok(row.finishedAt, "the row is settled");
    assert.deepEqual(row.metrics, { eval_score: 58.1 }, JSON.stringify(row.metrics));
    assert.match(String(row.metricsSource), /metrics\.json/);

    // The reference reaches Main with the result, as the in-process path sent it.
    const inbox = await readFile(
      join(f.dashboard.workspaceRoot, f.taskId, "runs", run.body.runId, "agents", "main", "inbox-store.json"),
      "utf8"
    ).then((text) => JSON.parse(text));
    const callback = inbox.find(
      (message) => message.callId === calls.a.callId && message.kind === "callback"
    );
    assert.ok(callback, "the delegated result reached Main's Inbox");
    assert.equal(callback.payload.experimentId, programs[0].experimentId);
    assert.equal(callback.payload.experimentRunId, row.runId);
  }
);

test(
  "the CLI worker takes no work while the serving backend owns the workspace",
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t, { handle: async () => ({ text: "unused" }), taskId: "owner-task" });
    const ownerPath = join(f.dashboard.workspaceRoot, ".runtime", "subagent-owner.json");
    await waitFor(
      async () => (await readJson(ownerPath, undefined))?.kind === "dashboard",
      "the backend to claim the workspace"
    );
    const env = Object.fromEntries(
      Object.entries(f.dashboard.env).filter(([name]) => !/^(?:COWORK_DISABLE_MAIN_GUARDIAN)$/.test(name))
    );
    const child = spawn(
      process.execPath,
      [
        join(harness, "dist", "src", "cli", "cowork.js"),
        "worker",
        "--task",
        "owner-task",
        "--run",
        "owner-run"
      ],
      {
        cwd: f.root,
        env: {
          ...env,
          COWORK_DISABLE_MAIN_GUARDIAN: "1",
          COWORK_API_BASE: f.provider.baseUrl,
          COWORK_API_KEY: "owner-test-key",
          COWORK_MODEL: "protocol-fixture",
          COWORK_MODEL_API: "openai-completions"
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const exited = once(child, "exit");
    const code = await Promise.race([
      exited.then(([value]) => value),
      delay(30_000).then(() => assert.fail(`the worker did not yield: ${output}`))
    ]);
    assert.equal(code, 0, output);
    assert.match(output, /owned by the running backend/);
    assert.deepEqual(await processRecords(f, "owner-run"), [], "the worker started nothing");
  }
);

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
