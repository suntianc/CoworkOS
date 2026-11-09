import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { startDashboard } from "./dashboard-fixture.mjs";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";
import { createProjectDevelopmentService } from "../dist/src/dashboard/project-development-service.js";

const run = promisify(execFile);
const git = (cwd, args) =>
  run("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((result) => result.stdout.trim());

const client = (dashboard) => async (path, body) => {
  const response = await fetch(`${dashboard.base}${path}`, {
    method: body === undefined ? "GET" : "POST",
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
  await git(directory, ["commit", "-m", `add ${name}`]);
  return git(directory, ["rev-parse", "HEAD"]);
}

async function servingInstance(root) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const instance = await readBackendInstance(backendPaths(join(root, "home")));
    if (instance.value?.token && instance.value.backendId) return instance.value;
    await delay(25);
  }
  assert.fail("the backend did not publish its local credential");
}

test(
  "the delivery preview returns the committed patch of the accepted change",
  { timeout: 180_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-p45-delivery-diff-"));
    const repository = await makeRepository(join(root, "repository"));
    const dashboard = await startDashboard({ defaultProject: false });
    t.after(async () => {
      await dashboard.stop();
      await rm(root, { recursive: true, force: true });
    });
    const request = client(dashboard);
    const project = (
      await request("/api/projects", { projectName: "diff 项目", projectDirectory: repository })
    ).body.project;
    const instance = await servingInstance(dashboard.root);
    const info = (await request("/api/project-data")).body;
    const runtime = new ProjectDataRuntime({
      config: { sqlite: { path: info.target } },
      configPath: join(dashboard.root, "config.json"),
      dataRoot: dashboard.root,
      env: {}
    });
    t.after(() => runtime.close());
    const gateway = await runtime.service();
    const execution = createProjectDevelopmentService({
      runtime: { service: async () => gateway },
      backendId: instance.backendId,
      startedAt: "started-diff",
      developmentRoot: join(dashboard.root, "development-workspaces"),
      deliveryRoot: join(dashboard.root, "delivery-sync"),
      project: async (projectId) =>
        projectId === project.projectId
          ? {
              projectId: project.projectId,
              projectName: project.projectName,
              projectDirectory: repository
            }
          : undefined,
      taskProject: async () => undefined
    });
    await execution.setMergeConfig(project.projectId, {
      repository,
      targetBranch: "main",
      executionBackendId: instance.backendId
    });
    const requirement = (
      await request(projectPath(project.projectId, "/ledger"), {
        action: "create",
        title: "按分数文件汇总总分",
        content: "新增 summarize.sh。"
      })
    ).body.requirement;
    const development = await execution.create(project.projectId, {
      requirementId: requirement.requirementId,
      goal: "新增 summarize.sh",
      completionCriteria: ["bash summarize.sh 输出 30", "文件不存在时退出码 1"],
      route: "quick"
    });
    await commitFile(
      development.workspace.directory,
      "summarize.sh",
      "#!/usr/bin/env bash\nset -euo pipefail\n"
    );
    await commitFile(development.workspace.directory, "notes.md", "# 验收记录\n");
    await execution.setReviewPlan(project.projectId, {
      developmentId: development.developmentId,
      channel: "self",
      basis: "两个小文件，Main 自检",
      checks: [
        { name: "脚本可执行", command: "test -x summarize.sh", exitCode: 0, output: "" },
        { name: "记录存在", command: "test -f notes.md", exitCode: 0, output: "" }
      ]
    });
    const merge = await execution.requestMerge(project.projectId, {
      developmentId: development.developmentId,
      checks: [
        { name: "组合检查 1", command: "test -f summarize.sh" },
        { name: "组合检查 2", command: "test -f notes.md" }
      ]
    });
    assert.equal(merge.state, "merged", JSON.stringify(merge));

    const whole = await request(projectPath(project.projectId, "/deliveries"), {
      action: "diff",
      developmentId: development.developmentId
    });
    assert.equal(whole.status, 200, JSON.stringify(whole.body));
    const patch = whole.body.diff;
    assert.match(patch.patch, /diff --git a\/summarize\.sh b\/summarize\.sh/);
    assert.match(patch.patch, /\+#!\/usr\/bin\/env bash/);
    assert.match(patch.patch, /diff --git a\/notes\.md b\/notes\.md/);
    assert.equal(patch.truncated, false);
    assert.equal(patch.base, merge.combinedBase);
    assert.equal(patch.head, merge.mergeCommit);
    assert.equal(patch.candidateCommit, merge.candidate.commit);
    assert.deepEqual(
      patch.files.map((file) => file.path),
      ["notes.md", "summarize.sh"]
    );

    const one = await request(projectPath(project.projectId, "/deliveries"), {
      action: "diff",
      requirementId: requirement.requirementId,
      path: "summarize.sh"
    });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.diff.path, "summarize.sh");
    assert.match(one.body.diff.patch, /summarize\.sh/);
    assert.doesNotMatch(one.body.diff.patch, /notes\.md/);

    const unknown = await request(projectPath(project.projectId, "/deliveries"), {
      action: "diff",
      developmentId: development.developmentId,
      path: "baseline.txt"
    });
    assert.equal(unknown.status, 409, JSON.stringify(unknown.body));
    assert.equal(unknown.body.code, "delivery_patch_path_unknown");

    // A requirement that never had a development has no patch to read.
    const other = (
      await request(projectPath(project.projectId, "/ledger"), {
        action: "create",
        title: "只有台账的需求",
        content: "还没有开发记录。"
      })
    ).body.requirement;
    const missing = await request(projectPath(project.projectId, "/deliveries"), {
      action: "diff",
      requirementId: other.requirementId
    });
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
  }
);
