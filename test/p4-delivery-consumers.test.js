import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { startDashboard } from "./dashboard-fixture.mjs";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";
import { createProjectDevelopmentService } from "../dist/src/dashboard/project-development-service.js";
import { createProjectDevelopmentTool } from "../dist/src/runtime/project-development-tool.js";
import { prepareWorkItemSite } from "../dist/src/workspace/work-item-workspace.js";
import { createComposerSession } from "../web/assets/controllers/composer-session.js";

const run = promisify(execFile);
const git = (cwd, args) =>
  run("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((result) => result.stdout.trim());

const waitFor = async (check, message, timeout = 20_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail(message);
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function servingInstance(root) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const instance = await readBackendInstance(backendPaths(join(root, "home")));
    if (instance.value?.token && instance.value.backendId) return instance.value;
    await delay(25);
  }
  assert.fail("the backend did not publish its local credential");
}

const client = (dashboard) => async (path, body, method) => {
  const response = await fetch(`${dashboard.base}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
};

const projectPath = (projectId, suffix) => `/api/projects/${encodeURIComponent(projectId)}${suffix}`;

async function makeRepository(directory) {
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.email", "fixture@example.test"]);
  await git(directory, ["config", "user.name", "Fixture"]);
  await writeFile(join(directory, "baseline.txt"), "baseline\n");
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "baseline"]);
  return directory;
}

async function commitFile(directory, name, content) {
  await writeFile(join(directory, name), content);
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", content]);
  return git(directory, ["rev-parse", "HEAD"]);
}

async function outboxEntries(root) {
  let files;
  try {
    files = await readdir(join(root, "delivery-sync"));
  } catch {
    return [];
  }
  const entries = [];
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const parsed = JSON.parse(await readFile(join(root, "delivery-sync", file), "utf8"));
    entries.push(...(parsed.entries ?? []));
  }
  return entries;
}

test(
  "development consumers read the delivery from project, Task and requirement, and recover a failed sync",
  { timeout: 240_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-p4-delivery-consumers-"));
    const repository = await makeRepository(join(root, "repository"));
    const dashboard = await startDashboard({ defaultProject: false });
    t.after(async () => {
      await dashboard.stop();
      await rm(root, { recursive: true, force: true });
    });
    const request = client(dashboard);
    const project = (
      await request("/api/projects", { projectName: "交付消费项目", projectDirectory: repository })
    ).body.project;
    const otherDirectory = join(root, "other-project");
    await mkdir(otherDirectory, { recursive: true });
    const otherProject = (
      await request("/api/projects", { projectName: "另一个项目", projectDirectory: otherDirectory })
    ).body.project;
    const instance = await servingInstance(dashboard.root);
    const info = (await request("/api/project-data", undefined, "GET")).body;
    const runtime = new ProjectDataRuntime({
      config: { sqlite: { path: info.target } },
      configPath: join(dashboard.root, "config.json"),
      dataRoot: dashboard.root,
      env: {}
    });
    t.after(() => runtime.close());
    const gateway = await runtime.service();
    const calls = {};
    const executionRoot = join(dashboard.root, "development-workspaces");
    // The serving Dashboard and this execution host point at the same data
    // root, so the production controller can show this host's pending fact.
    const deliveryRoot = join(dashboard.root, "delivery-sync");
    let sessionTaskId;
    const service = (target = gateway, backendId = instance.backendId) =>
      createProjectDevelopmentService({
        runtime: { service: async () => target },
        backendId,
        startedAt: "started-consumer",
        developmentRoot: executionRoot,
        deliveryRoot,
        project: async (projectId) =>
          projectId === project.projectId
            ? {
                projectId: project.projectId,
                projectName: project.projectName,
                projectDirectory: repository
              }
            : undefined,
        taskProject: async (taskId) =>
          sessionTaskId && taskId === sessionTaskId
            ? {
                projectId: project.projectId,
                projectName: project.projectName,
                projectDirectory: repository
              }
            : undefined,
        call: async (_taskId, callId) => calls[callId]
      });
    const execution = service();
    const configured = await execution.setMergeConfig(project.projectId, {
      repository,
      targetBranch: "main",
      executionBackendId: instance.backendId
    });
    assert.equal(configured.executionBackendId, instance.backendId);

    // One board demand for the independent path and one internal quick path.
    const published = await request(projectPath(project.projectId, "/board"), {
      action: "publish",
      requestId: "publish-consumer-board",
      title: "独立审查交付",
      content: "需要独立审查并显示发现。",
      source: { kind: "external", reference: "外部渠道" }
    });
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const boardId = published.body.entry.boardId;
    const boardRequirementId = published.body.entry.requirementId;
    const session = await request(projectPath(project.projectId, "/main-sessions"), {
      action: "create",
      title: "交付会话",
      requirementId: boardRequirementId
    });
    assert.equal(session.status, 201, JSON.stringify(session.body));
    const taskId = session.body.session.taskId;
    sessionTaskId = taskId;
    const claimed = await request(projectPath(project.projectId, "/board"), {
      action: "claim",
      boardId,
      expectedRevision: published.body.entry.revision,
      requestId: "claim-consumer-board",
      handler: { backendId: instance.backendId, projectId: project.projectId, taskId }
    });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    const internal = await request(projectPath(project.projectId, "/ledger"), {
      action: "create",
      title: "直接开发交付",
      content: "小改动，Main 直接完成。"
    });
    assert.equal(internal.status, 201, JSON.stringify(internal.body));
    const internalRequirementId = internal.body.requirement.requirementId;

    const develop = (requirementId, title, route) =>
      execution.createForTask(taskId, {
        requirementId,
        goal: title,
        completionCriteria: ["observable result"],
        route
      });
    const reviewed = await develop(boardRequirementId, "独立审查交付", "full");
    const quick = await develop(internalRequirementId, "直接开发交付", "quick");
    assert.equal(reviewed.workspace.state, "ready");
    assert.equal(quick.workspace.state, "ready");

    // --- the independent-review path -----------------------------------------
    const reviewedCandidate = await commitFile(
      reviewed.workspace.directory,
      "report.txt",
      "independent report\n"
    );
    await execution.setReviewPlan(project.projectId, {
      developmentId: reviewed.developmentId,
      channel: "independent",
      basis: "需要独立 Reviewer 核对候选",
      checks: [{ name: "自检", command: "test -f report.txt", exitCode: 0, output: "" }]
    });
    const executorSite = join(executionRoot, "work-items", "call-executor");
    await prepareWorkItemSite({
      developmentDirectory: reviewed.workspace.directory,
      directory: executorSite,
      branch: "coworkos/work/call-executor"
    });
    calls["call-executor"] = {
      callId: "call-executor",
      agentId: "agent-executor",
      role: "executor",
      workspace: executorSite,
      developmentId: reviewed.developmentId,
      status: "completed"
    };
    let review = await execution.startReview(project.projectId, taskId, {
      developmentId: reviewed.developmentId,
      kind: "independent",
      authorCallId: "call-executor"
    });
    const reviewerSite = join(executionRoot, "work-items", "call-reviewer");
    await prepareWorkItemSite({
      developmentDirectory: reviewed.workspace.directory,
      directory: reviewerSite,
      branch: "coworkos/work/call-reviewer"
    });
    calls["call-reviewer"] = {
      callId: "call-reviewer",
      agentId: "agent-reviewer",
      role: "reviewer",
      workspace: reviewerSite,
      developmentId: reviewed.developmentId,
      status: "completed"
    };
    review = await execution.attachReviewer(project.projectId, taskId, {
      reviewId: review.reviewId,
      callId: "call-reviewer"
    });
    review = await execution.recordFinding(project.projectId, {
      reviewId: review.reviewId,
      title: "报告缺少来源",
      detail: "建议补充数据来源。",
      location: "report.txt",
      checks: [{ name: "发现检查", command: "test -f report.txt", exitCode: 0, output: "" }]
    });
    const findingId = review.findings[0].findingId;
    review = await execution.ruleFinding(project.projectId, {
      reviewId: review.reviewId,
      findingId,
      decision: "dismiss",
      category: "out_of_scope",
      basis: "该建议不影响已确认的完成标准"
    });
    review = await execution.completeReview(project.projectId, {
      reviewId: review.reviewId,
      verdict: "passed",
      summary: "候选满足完成标准",
      checks: [{ name: "复审检查", command: "test -f report.txt", exitCode: 0, output: "" }]
    });
    assert.equal(review.state, "passed");
    const reviewedMerge = await execution.requestMerge(project.projectId, {
      developmentId: reviewed.developmentId,
      checks: [{ name: "组合检查", command: "test -f report.txt" }]
    });
    assert.equal(reviewedMerge.state, "merged", JSON.stringify(reviewedMerge));
    // Local work after the merge must not rewrite the delivered diff.
    const unmergedHead = await commitFile(reviewed.workspace.directory, "not-delivered.txt", "local only\n");
    assert.notEqual(unmergedHead, reviewedMerge.mergeCommit);
    await assert.rejects(readFile(join(repository, "not-delivered.txt"), "utf8"));
    assert.equal(await git(repository, ["rev-parse", "main"]), reviewedMerge.mergeCommit);

    // --- the quick direct path -------------------------------------------------
    const quickCandidate = await commitFile(quick.workspace.directory, "quick.txt", "quick\n");
    await execution.setReviewPlan(project.projectId, {
      developmentId: quick.developmentId,
      channel: "self",
      basis: "单文件小改动，Main 自检",
      checks: [{ name: "自检", command: "test -f quick.txt", exitCode: 0, output: "" }]
    });
    const quickMerge = await execution.requestMerge(project.projectId, {
      developmentId: quick.developmentId,
      checks: [{ name: "组合检查", command: "test -f quick.txt" }]
    });
    assert.equal(quickMerge.state, "merged", JSON.stringify(quickMerge));
    const quickUnmergedHead = await commitFile(quick.workspace.directory, "quick-later.txt", "local only\n");
    assert.notEqual(quickUnmergedHead, quickMerge.mergeCommit);

    // --- the project view ------------------------------------------------------
    const viewed = await request(projectPath(project.projectId, "/deliveries"), {
      action: "view",
      developmentId: reviewed.developmentId
    });
    assert.equal(viewed.status, 200, JSON.stringify(viewed.body));
    const view = viewed.body.view;
    assert.equal(view.stage, "delivered");
    assert.equal(view.development.developmentId, reviewed.developmentId);
    assert.equal(view.plan.channel, "independent");
    assert.equal(view.reviews.at(-1).state, "passed");
    assert.equal(view.reviews.at(-1).findings[0].title, "报告缺少来源");
    assert.deepEqual(view.reviews.at(-1).findings[0].ruling.decision, "dismiss");
    assert.equal(view.reviews.at(-1).findings[0].ruling.category, "out_of_scope");
    assert.equal(view.reviews.at(-1).findings[0].ruling.basis, "该建议不影响已确认的完成标准");
    assert.equal(view.reviews.at(-1).verdict.checks[0].exitCode, 0);
    assert.deepEqual(
      view.roles.map((role) => [role.role, role.callId, role.agentId, role.state]),
      [
        ["executor", "call-executor", "agent-executor", "candidate_frozen"],
        ["reviewer", "call-reviewer", "agent-reviewer", "passed"]
      ]
    );
    // The execution host still has both work items in its durable queue, so
    // its own view reports the real role status rather than the fallback.
    const localView = await execution.deliveryView(project.projectId, {
      developmentId: reviewed.developmentId
    });
    assert.deepEqual(
      localView.roles.map((role) => [role.role, role.state]),
      [
        ["executor", "completed"],
        ["reviewer", "completed"]
      ]
    );
    assert.deepEqual(view.diff.files, [{ path: "report.txt", additions: 1, deletions: 0 }]);
    assert.equal(view.diff.base, reviewedMerge.combinedBase);
    assert.equal(view.diff.head, reviewedMerge.mergeCommit);
    assert.equal(view.diff.candidateCommit, reviewedCandidate);
    assert.equal(view.diff.mergedCommit, reviewedMerge.mergeCommit);
    assert.equal(await git(reviewed.workspace.directory, ["rev-parse", "HEAD"]), unmergedHead);
    assert.equal(view.merges.at(-1).mergeCommit, reviewedMerge.mergeCommit);
    assert.equal(view.merges.at(-1).checks[0].exitCode, 0);
    assert.equal(view.delivery.state, "synced");
    assert.equal(view.delivery.mergedCommit, reviewedMerge.mergeCommit);
    assert.ok(view.delivery.syncedAt);
    assert.equal(view.board.state, "pending_release");
    assert.equal(view.board.delivery.mergedCommit, reviewedMerge.mergeCommit);
    assert.equal(view.board.assignment.handler.taskId, taskId);

    // The same view is reachable from the requirement and from the Main Task.
    const byRequirement = await request(projectPath(project.projectId, "/deliveries"), {
      action: "view",
      requirementId: internalRequirementId
    });
    assert.equal(byRequirement.status, 200, JSON.stringify(byRequirement.body));
    const quickView = byRequirement.body.view;
    assert.equal(quickView.stage, "delivered");
    assert.equal(quickView.plan.channel, "self");
    assert.deepEqual(quickView.roles, []);
    assert.equal(quickView.merges.at(-1).mergeCommit, quickMerge.mergeCommit);
    assert.equal(quickView.delivery.mergedCommit, quickMerge.mergeCommit);
    assert.equal(quickView.board, undefined, "an internal need has no board projection");
    assert.deepEqual(quickView.diff.files, [{ path: "quick.txt", additions: 1, deletions: 0 }]);
    assert.equal(quickView.diff.base, quickMerge.combinedBase);
    assert.equal(quickView.diff.head, quickMerge.mergeCommit);
    assert.equal(quickView.diff.candidateCommit, quickCandidate);
    assert.equal(quickView.diff.mergedCommit, quickMerge.mergeCommit);
    assert.equal(await git(quick.workspace.directory, ["rev-parse", "HEAD"]), quickUnmergedHead);

    const tool = createProjectDevelopmentTool({
      dashboardUrl: dashboard.base,
      taskId,
      token: instance.token
    });
    const toolView = await tool.execute({
      action: "delivery_status",
      developmentId: reviewed.developmentId
    });
    assert.equal(toolView.view.delivery.mergedCommit, reviewedMerge.mergeCommit);
    assert.equal(toolView.view.roles[1].callId, "call-reviewer");
    assert.equal(toolView.view.diff.head, reviewedMerge.mergeCommit);
    assert.equal(toolView.view.diff.candidateCommit, reviewedCandidate);
    assert.deepEqual(toolView.view.diff.files, [{ path: "report.txt", additions: 1, deletions: 0 }]);
    const toolByRequirement = await tool.execute({
      action: "delivery_status",
      requirementId: internalRequirementId
    });
    assert.equal(toolByRequirement.view.delivery.mergedCommit, quickMerge.mergeCommit);
  }
);
