import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  PROJECT_DATA_ENGINES,
  startPostgresProjectDatabase,
  startProjectDataDashboard
} from "./p3-storage-fixture.mjs";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";
import { RemoteProjectDataService } from "../dist/src/workspace/project-data-remote.js";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";
import { createProjectDevelopmentService } from "../dist/src/dashboard/project-development-service.js";
import { createProjectDevelopmentTool } from "../dist/src/runtime/project-development-tool.js";
import { prepareWorkItemSite } from "../dist/src/workspace/work-item-workspace.js";

const run = promisify(execFile);
const git = (cwd, args) =>
  run("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((result) => result.stdout.trim());

let postgres;

before(
  async () => {
    postgres = await startPostgresProjectDatabase();
  },
  { timeout: 180_000 }
);

after(async () => {
  await postgres?.stop();
});

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

/** The authority's own gateway, opened beside the serving Dashboard. */
async function openAuthority(engine, dashboard) {
  const info = await fetch(`${dashboard.base}/api/project-data`).then((response) => response.json());
  const config =
    engine === "sqlite"
      ? { sqlite: { path: info.target } }
      : { engine, postgres: { connectionString: postgres.connectionString } };
  const authority = new ProjectDataRuntime({
    config,
    configPath: join(dashboard.root, "config.json"),
    dataRoot: dashboard.root,
    env: {}
  });
  return { gateway: await authority.service(), close: () => authority.close() };
}

/** One real backend service over the shared gateway, with its own checkout root. */
function serviceFor({ gateway, backendId, startedAt, root, project, calls = {} }) {
  return createProjectDevelopmentService({
    runtime: { service: async () => gateway },
    backendId,
    startedAt,
    developmentRoot: join(root, "development-workspaces"),
    project: async (projectId) =>
      projectId === project.projectId
        ? {
            projectId: project.projectId,
            projectName: project.projectName,
            projectDirectory: project.projectDirectory
          }
        : undefined,
    taskProject: async () => undefined,
    call: async (_taskId, callId) => calls[callId]
  });
}

async function commitFile(directory, name, content) {
  await writeFile(join(directory, name), content);
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", content]);
  return git(directory, ["rev-parse", "HEAD"]);
}

/**
 * Two Main requirements, two backends, one project target.
 *
 * Both developments are independent real Git checkouts. The second backend
 * applies for a merge first; while it waits, the first backend does too. The
 * configured execution location updates the target one operation at a time, so
 * the second merge runs its checks on the combined version and the target keeps
 * both results. A candidate whose acceptance no longer matches, or whose
 * combined checks fail, is never marked merged.
 */
for (const engine of PROJECT_DATA_ENGINES) {
  test(
    `${engine}: two Main requirements merge through the project entry in order`,
    { timeout: 240_000 },
    async (t) => {
      const dashboard = await startProjectDataDashboard(t, engine, { postgres });
      const repository = await makeRepository(join(dashboard.root, "repository"));
      const baseline = await git(repository, ["rev-parse", "HEAD"]);
      const createdProject = await dashboard.request("/api/projects", {
        projectName: "共同合入项目",
        projectDirectory: repository
      });
      assert.equal(createdProject.status, 201, JSON.stringify(createdProject.body));
      const project = createdProject.body.project;
      const instance = await readBackendInstance(backendPaths(join(dashboard.root, "home")));
      assert.ok(instance.value?.token && instance.value.backendId);
      const authority = await openAuthority(engine, dashboard);
      t.after(() => authority.close());
      const secondRemote = await RemoteProjectDataService.open({
        url: dashboard.base,
        token: instance.value.token,
        backendId: "backend_second",
        source: "p4-project-integration-test"
      });
      t.after(() => secondRemote.close());
      const main = serviceFor({
        gateway: authority.gateway,
        backendId: instance.value.backendId,
        startedAt: "started-main",
        root: dashboard.root,
        project
      });
      const secondRoot = join(dashboard.root, "backend-second");
      const calls = {};
      const second = serviceFor({
        gateway: secondRemote,
        backendId: "backend_second",
        startedAt: "started-second",
        root: secondRoot,
        project,
        calls
      });
      const configured = await main.setMergeConfig(project.projectId, {
        repository,
        targetBranch: "main"
      });
      assert.equal(configured.executionBackendId, instance.value.backendId);
      assert.equal(configured.targetBranch, "main");

      const requirement = async (title) => {
        const response = await dashboard.request(
          `/api/projects/${encodeURIComponent(project.projectId)}/ledger`,
          { action: "create", title, content: `${title}的内容` }
        );
        assert.equal(response.status, 201, JSON.stringify(response.body));
        return response.body.requirement;
      };
      const develop = async (service, title, route = "direct") => {
        const item = await requirement(title);
        const development = await service.create(project.projectId, {
          requirementId: item.requirementId,
          goal: title,
          completionCriteria: ["observable result"],
          route
        });
        assert.equal(development.workspace.state, "ready", JSON.stringify(development.workspace));
        return development;
      };

      // The second backend develops an independent file and gets it through an
      // independent review, not a Main self-check.
      const remoteDevelopment = await develop(second, "远端后端的报表", "full");
      const remoteCandidate = await commitFile(
        remoteDevelopment.workspace.directory,
        "report.txt",
        "remote report\n"
      );
      await second.setReviewPlan(project.projectId, {
        developmentId: remoteDevelopment.developmentId,
        channel: "independent",
        basis: "独立审查远端候选",
        checks: [{ name: "远端自检", command: "test -f report.txt", exitCode: 0, output: "" }]
      });
      const executorSite = join(secondRoot, "development-workspaces", "work-items", "call-executor");
      await prepareWorkItemSite({
        developmentDirectory: remoteDevelopment.workspace.directory,
        directory: executorSite,
        branch: "coworkos/work/call-executor"
      });
      calls["call-executor"] = {
        callId: "call-executor",
        agentId: "agent-executor",
        role: "executor",
        workspace: executorSite,
        developmentId: remoteDevelopment.developmentId,
        status: "completed"
      };
      let review = await second.startReview(project.projectId, "task-second", {
        developmentId: remoteDevelopment.developmentId,
        kind: "independent",
        authorCallId: "call-executor"
      });
      const reviewerSite = join(secondRoot, "development-workspaces", "work-items", "call-reviewer");
      await prepareWorkItemSite({
        developmentDirectory: remoteDevelopment.workspace.directory,
        directory: reviewerSite,
        branch: "coworkos/work/call-reviewer"
      });
      calls["call-reviewer"] = {
        callId: "call-reviewer",
        agentId: "agent-reviewer",
        role: "reviewer",
        workspace: reviewerSite,
        developmentId: remoteDevelopment.developmentId,
        status: "completed"
      };
      review = await second.attachReviewer(project.projectId, "task-second", {
        reviewId: review.reviewId,
        callId: "call-reviewer"
      });
      review = await second.completeReview(project.projectId, {
        reviewId: review.reviewId,
        verdict: "passed",
        summary: "远端候选通过独立审查",
        checks: [{ name: "审查检查", command: "test -f report.txt", exitCode: 0, output: "" }]
      });
      assert.equal(review.state, "passed");
      assert.equal(review.candidate.commit, remoteCandidate);
      const remoteDelivery = await second.delivery(project.projectId, remoteDevelopment.developmentId);
      assert.equal(remoteDelivery.eligible, true, JSON.stringify(remoteDelivery));

      // The second backend applies first. It is not the execution location, so
      // the operation waits instead of running Git there.
      const remoteRequest = await second.requestMerge(project.projectId, {
        developmentId: remoteDevelopment.developmentId,
        checks: [{ name: "远端内容", command: "test -f report.txt" }]
      });
      assert.equal(remoteRequest.state, "waiting", JSON.stringify(remoteRequest));
      assert.equal(remoteRequest.requestedBy, "backend_second");
      assert.equal(remoteRequest.executionBackendId, instance.value.backendId);
      assert.equal(
        await git(repository, ["rev-parse", "main"]),
        baseline,
        "a waiting request does not move the target"
      );

      // Two more requests on the same backend exercise the refusal paths; they
      // stay queued until the execution location applies the project queue.
      const staleDevelopment = await develop(second, "远端候选前移", "quick");
      await commitFile(staleDevelopment.workspace.directory, "stale.txt", "first\n");
      await second.setReviewPlan(project.projectId, {
        developmentId: staleDevelopment.developmentId,
        channel: "self",
        basis: "远端自检",
        checks: [{ name: "自检", command: "test -f stale.txt", exitCode: 0, output: "" }]
      });
      const staleRequest = await second.requestMerge(project.projectId, {
        developmentId: staleDevelopment.developmentId,
        checks: [{ name: "组合检查", command: "test -f stale.txt" }]
      });
      assert.equal(staleRequest.state, "waiting");
      // The accepted version changes before the execution location runs it.
      await commitFile(staleDevelopment.workspace.directory, "stale.txt", "first\nsecond\n");
      await second.setReviewPlan(project.projectId, {
        developmentId: staleDevelopment.developmentId,
        channel: "self",
        basis: "在新版本重新自检",
        checks: [{ name: "自检", command: "test -f stale.txt", exitCode: 0, output: "" }]
      });

      const failingDevelopment = await develop(second, "组合检查失败", "quick");
      await commitFile(failingDevelopment.workspace.directory, "broken.txt", "broken\n");
      await second.setReviewPlan(project.projectId, {
        developmentId: failingDevelopment.developmentId,
        channel: "self",
        basis: "组合检查会失败",
        checks: [{ name: "自检", command: "test -f broken.txt", exitCode: 0, output: "" }]
      });
      const failingRequest = await second.requestMerge(project.projectId, {
        developmentId: failingDevelopment.developmentId,
        checks: [{ name: "组合检查", command: "printf 'combined check failed\\n' >&2; exit 3" }]
      });
      assert.equal(failingRequest.state, "waiting");

      // The first backend's request runs the project queue on the execution
      // location: first the waiting remote candidate, then its own combined
      // version. Its check needs both files, so it only passes on the updated
      // target.
      const mainDevelopment = await develop(main, "主后端的登录页", "quick");
      const mainCandidate = await commitFile(
        mainDevelopment.workspace.directory,
        "login.txt",
        "main login\n"
      );
      await main.setReviewPlan(project.projectId, {
        developmentId: mainDevelopment.developmentId,
        channel: "self",
        basis: "单文件改动，Main 自查",
        checks: [{ name: "自检", command: "test -f login.txt", exitCode: 0, output: "" }]
      });
      const mainRequest = await main.requestMerge(project.projectId, {
        developmentId: mainDevelopment.developmentId,
        checks: [
          {
            name: "组合检查",
            command: "test -f report.txt && test -f login.txt && printf 'both files\\n'"
          }
        ]
      });
      assert.equal(mainRequest.state, "merged", JSON.stringify(mainRequest));

      // The queue also ran the earlier waiting operations.
      const all = await main.queryMerges(project.projectId);
      const byDevelopment = (developmentId) => {
        const found = all.find((entry) => entry.developmentId === developmentId);
        assert.ok(found, `no merge operation for ${developmentId}`);
        return found;
      };
      const remoteMerged = byDevelopment(remoteDevelopment.developmentId);
      const staleResult = byDevelopment(staleDevelopment.developmentId);
      const failingResult = byDevelopment(failingDevelopment.developmentId);
      const mainMerged = byDevelopment(mainDevelopment.developmentId);

      assert.equal(remoteMerged.state, "merged", JSON.stringify(remoteMerged));
      assert.equal(remoteMerged.candidate.commit, remoteCandidate);
      assert.notEqual(remoteMerged.mergeCommit, remoteCandidate, "the target keeps a real merge commit");
      assert.equal(remoteMerged.combinedBase, baseline);
      assert.ok(remoteMerged.receipt, "a merged operation carries an idempotent receipt");
      assert.equal(remoteMerged.receipt.requirementId, remoteDevelopment.requirementId);

      assert.equal(staleResult.state, "check_failed", JSON.stringify(staleResult));
      assert.ok(staleResult.reasons.includes("candidate_changed"), JSON.stringify(staleResult.reasons));
      assert.equal(staleResult.mergeCommit, undefined);

      assert.equal(failingResult.state, "check_failed", JSON.stringify(failingResult));
      assert.match(failingResult.detail, /组合检查/);
      assert.equal(failingResult.checks[0].exitCode, 3);
      assert.match(failingResult.checks[0].output, /combined check failed/);

      assert.equal(mainMerged.state, "merged", JSON.stringify(mainMerged));
      assert.equal(mainMerged.combinedBase, remoteMerged.mergeCommit, "merged on the moved target");
      assert.equal(mainMerged.checks[0].exitCode, 0);
      assert.match(mainMerged.checks[0].output, /both files/);

      // Git facts: the target contains both independent results, the second
      // merge is based on the first, and the recorded SHA is the actual tip.
      assert.equal(await git(repository, ["rev-parse", "main"]), mainMerged.mergeCommit);
      assert.equal(await readFile(join(repository, "report.txt"), "utf8"), "remote report\n");
      assert.equal(await readFile(join(repository, "login.txt"), "utf8"), "main login\n");
      await assert.rejects(readFile(join(repository, "stale.txt"), "utf8"));
      await assert.rejects(readFile(join(repository, "broken.txt"), "utf8"));
      await git(repository, [
        "merge-base",
        "--is-ancestor",
        remoteMerged.mergeCommit,
        mainMerged.mergeCommit
      ]);
      const parents = (await git(repository, ["rev-list", "--parents", "-n", "1", mainMerged.mergeCommit]))
        .split(" ")
        .slice(1);
      assert.deepEqual(parents, [remoteMerged.mergeCommit, mainCandidate]);

      // The refusals only touched the operations' own sites; both development
      // branches still carry their own commits.
      assert.equal(
        await git(staleDevelopment.workspace.directory, ["rev-parse", "--abbrev-ref", "HEAD"]),
        staleDevelopment.workspace.branch
      );
      assert.equal(
        await readFile(join(staleDevelopment.workspace.directory, "stale.txt"), "utf8"),
        "first\nsecond\n"
      );
      assert.equal(
        await readFile(join(failingDevelopment.workspace.directory, "broken.txt"), "utf8"),
        "broken\n"
      );

      // A retry of the same merged candidate returns the same receipt and does
      // not create another target commit.
      const beforeRetry = await git(repository, ["rev-list", "--count", `main`]);
      const retried = await main.requestMerge(project.projectId, {
        developmentId: mainDevelopment.developmentId
      });
      assert.equal(retried.mergeId, mainMerged.mergeId);
      assert.equal(retried.mergeCommit, mainMerged.mergeCommit);
      assert.equal(await git(repository, ["rev-list", "--count", "main"]), beforeRetry);

      // The Main tool reaches the same shared entry through its Task-scoped
      // route: status reads the receipt and a repeat request is idempotent.
      const session = await dashboard.request(
        `/api/projects/${encodeURIComponent(project.projectId)}/main-sessions`,
        { action: "create", title: "合入会话", requirementId: mainDevelopment.requirementId }
      );
      assert.equal(session.status, 201, JSON.stringify(session.body));
      const tool = createProjectDevelopmentTool({
        dashboardUrl: dashboard.base,
        taskId: session.body.session.taskId,
        token: instance.value.token
      });
      const status = await tool.execute({
        action: "merge_status",
        developmentId: mainDevelopment.developmentId
      });
      assert.equal(status.merges[0].mergeId, mainMerged.mergeId);
      assert.equal(status.merges[0].receipt.mergedCommit, mainMerged.mergeCommit);
      const toolRetry = await tool.execute({
        action: "request_merge",
        developmentId: mainDevelopment.developmentId,
        mergeChecks: [{ name: "组合检查", command: "test -f login.txt" }]
      });
      assert.equal(toolRetry.merge.mergeId, mainMerged.mergeId);
      assert.equal(toolRetry.merge.mergeCommit, mainMerged.mergeCommit);
      assert.equal(await git(repository, ["rev-list", "--count", "main"]), beforeRetry);

      // Even a direct shared-store create for the same candidate returns the
      // existing operation: a retrying backend cannot enqueue a second merge of
      // the same version.
      const duplicate = await authority.gateway.createMerge(
        project.projectId,
        mainDevelopment.developmentId,
        {
          candidate: mainMerged.candidate,
          acceptance: mainMerged.acceptance,
          checks: [{ name: "组合检查", command: "test -f login.txt" }],
          requestedBy: "backend_second",
          executionBackendId: mainMerged.executionBackendId,
          targetBranch: mainMerged.targetBranch
        }
      );
      assert.equal(duplicate.mergeId, mainMerged.mergeId);
      assert.equal(await git(repository, ["rev-list", "--count", "main"]), beforeRetry);

      // The shared rows survive a restart and are part of the backup contract.
      await dashboard.restart();
      const afterRestart = await dashboard.request(
        `/api/projects/${encodeURIComponent(project.projectId)}/merges`,
        { action: "query" },
        "POST"
      );
      assert.equal(afterRestart.status, 200, JSON.stringify(afterRestart.body));
      assert.equal(afterRestart.body.merges.length, all.length);
      const backupPath = join(dashboard.root, "merges-backup.json");
      const backup = await authority.gateway.backupTo(backupPath);
      assert.equal(backup.counts.project_data_development_merges, all.length);
      assert.equal(backup.counts.project_data_merge_configs, 1);
      const restored = await authority.gateway.restoreFrom(backupPath);
      assert.equal(restored.counts.project_data_development_merges, all.length);
      assert.equal((await authority.gateway.queryMerges(project.projectId)).length, all.length);
    }
  );
}
