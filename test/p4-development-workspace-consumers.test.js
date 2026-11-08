import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { parseHTML } from "linkedom";
import { startDashboard } from "./dashboard-fixture.mjs";
import { projectDataConfig } from "./p3-storage-fixture.mjs";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";
import { createProjectDevelopmentTool } from "../dist/src/runtime/project-development-tool.js";
import { createProjectDevelopmentController } from "../web/assets/controllers/project-development.js";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";
import { createProjectDevelopmentService } from "../dist/src/dashboard/project-development-service.js";
import { createComposerSession } from "../web/assets/controllers/composer-session.js";

const run = promisify(execFile);
const git = (cwd, args) =>
  run("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((result) => result.stdout.trim());

/**
 * Development-record consumers: the production Main tool over real HTTP, the
 * production controller, and the composer's draft/attachments.
 *
 * The tool is the same executor the extension registers, and it addresses one
 * Task through the Dashboard. A record that crossed a project, a session or a
 * late response would show up here as a wrong project id, a wrong draft or a
 * stale detail.
 */
async function makeRepository(directory) {
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.email", "fixture@example.test"]);
  await git(directory, ["config", "user.name", "Fixture"]);
  await writeFile(join(directory, "tracked.txt"), "committed\n");
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "baseline"]);
  return directory;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const waitFor = async (check, message, timeout = 15_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await tick();
  }
  assert.fail(message);
};

async function toolFixture(t) {
  const dashboard = await startDashboard({
    defaultProject: false,
    config: { projectData: projectDataConfig("sqlite") }
  });
  t.after(() => dashboard.stop());
  const request = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };
  const repository = await makeRepository(join(dashboard.root, "repository"));
  await mkdir(join(dashboard.root, "project-b"), { recursive: true });
  const projectA = await request("/api/projects", {
    projectName: "项目 A",
    projectDirectory: repository
  });
  const projectB = await request("/api/projects", {
    projectName: "项目 B",
    projectDirectory: join(dashboard.root, "project-b")
  });
  assert.equal(projectA.status, 201, JSON.stringify(projectA.body));
  assert.equal(projectB.status, 201, JSON.stringify(projectB.body));
  const a = projectA.body.project;
  const b = projectB.body.project;
  const requirementA = await request(`/api/projects/${encodeURIComponent(a.projectId)}/ledger`, {
    action: "create",
    title: "登录记住设备",
    content: "同一台设备 30 天内不再验证。"
  });
  const requirementB = await request(`/api/projects/${encodeURIComponent(b.projectId)}/ledger`, {
    action: "create",
    title: "报表导出",
    content: "管理员按月导出。"
  });
  assert.equal(requirementA.status, 201, JSON.stringify(requirementA.body));
  assert.equal(requirementB.status, 201, JSON.stringify(requirementB.body));
  const sessionA = await request(`/api/projects/${encodeURIComponent(a.projectId)}/main-sessions`, {
    action: "create",
    title: "A 的开发会话",
    requirementId: requirementA.body.requirement.requirementId
  });
  assert.equal(sessionA.status, 201, JSON.stringify(sessionA.body));
  const taskA = sessionA.body.session.taskId;
  const taskB = "task-b";
  const createdTaskB = await request("/api/tasks", {
    taskId: taskB,
    goal: "B 的会话",
    projectId: b.projectId
  });
  assert.equal(createdTaskB.status, 201, JSON.stringify(createdTaskB.body));
  const configured = await request(`/api/projects/${encodeURIComponent(a.projectId)}/merge-config`, {
    repository,
    targetBranch: "main"
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  const instance = await readBackendInstance(backendPaths(join(dashboard.root, "home")));
  assert.ok(instance.value?.token, "the serving backend published its local credential");
  return {
    ...dashboard,
    request,
    repository,
    a,
    b,
    taskA,
    taskB,
    requirementA: requirementA.body.requirement,
    requirementB: requirementB.body.requirement,
    sessionA: sessionA.body.session,
    token: instance.value.token
  };
}

test("the Main tool records and reads developments only for its own project", async (t) => {
  const f = await toolFixture(t);
  const seen = [];
  const remember = (value) => {
    seen.push(JSON.stringify(value));
    return value;
  };
  const tool = createProjectDevelopmentTool({
    dashboardUrl: f.base,
    taskId: f.taskA,
    token: f.token
  });
  const other = createProjectDevelopmentTool({
    dashboardUrl: f.base,
    taskId: f.taskB,
    token: f.token
  });

  const created = remember(
    await tool.execute({
      action: "create",
      requirementId: f.requirementA.requirementId,
      goal: "同一设备 30 天内免验证",
      completionCriteria: ["同一设备第二次登录不再要求验证码", "敏感操作仍需验证"],
      route: "direct"
    })
  );
  const development = created.development;
  assert.equal(development.projectId, f.a.projectId);
  assert.equal(development.requirementId, f.requirementA.requirementId);
  assert.equal(development.requirementTitle, "登录记住设备");
  assert.equal(development.taskId, f.taskA);
  assert.equal(development.sessionId, f.sessionA.sessionId);
  assert.equal(development.workspace.state, "ready");
  assert.equal(development.workspace.directory.startsWith(f.root), true);
  assert.equal(development.baseline.branch, "main");
  assert.equal(development.baseline.commit, await git(f.repository, ["rev-parse", "refs/heads/main"]));

  const read = remember(await tool.execute({ action: "get", developmentId: development.developmentId }));
  assert.equal(read.development.developmentId, development.developmentId);
  const listed = remember(await tool.execute({ action: "query" }));
  assert.equal(listed.projectId, f.a.projectId);
  assert.deepEqual(
    listed.developments.map((entry) => entry.developmentId),
    [development.developmentId]
  );
  const found = remember(
    await tool.execute({
      action: "find_by_requirement",
      requirementId: f.requirementA.requirementId
    })
  );
  assert.equal(found.development.developmentId, development.developmentId);

  // A second Main session on the same project keeps its own record ownership.
  const secondRequirement = await f.request(`/api/projects/${encodeURIComponent(f.a.projectId)}/ledger`, {
    action: "create",
    title: "第二个需求",
    content: "同一项目的另一个会话。"
  });
  assert.equal(secondRequirement.status, 201, JSON.stringify(secondRequirement.body));
  const secondSession = await f.request(`/api/projects/${encodeURIComponent(f.a.projectId)}/main-sessions`, {
    action: "create",
    title: "A 的第二个会话",
    requirementId: secondRequirement.body.requirement.requirementId
  });
  assert.equal(secondSession.status, 201, JSON.stringify(secondSession.body));
  const secondTool = createProjectDevelopmentTool({
    dashboardUrl: f.base,
    taskId: secondSession.body.session.taskId,
    token: f.token
  });
  const secondCreated = await secondTool.execute({
    action: "create",
    requirementId: secondRequirement.body.requirement.requirementId,
    goal: "第二个需求的目标",
    completionCriteria: ["第二个需求完成"],
    route: "quick"
  });
  assert.notEqual(secondCreated.development.developmentId, development.developmentId);
  assert.equal(secondCreated.development.sessionId, secondSession.body.session.sessionId);
  assert.equal(secondCreated.development.taskId, secondSession.body.session.taskId);
  const firstAgain = await tool.execute({
    action: "get",
    developmentId: development.developmentId
  });
  assert.equal(firstAgain.development.sessionId, f.sessionA.sessionId);
  assert.equal(firstAgain.development.taskId, f.taskA);
  // The record is shared project data, but reading it from another session
  // never re-attributes it to that session.
  const sharedRead = await secondTool.execute({
    action: "find_by_requirement",
    requirementId: f.requirementA.requirementId
  });
  assert.equal(sharedRead.development.developmentId, development.developmentId);
  assert.equal(sharedRead.development.sessionId, f.sessionA.sessionId);
  assert.equal(sharedRead.development.taskId, f.taskA);

  // An update carries the revision it read; a stale one is refused.
  const updated = remember(
    await tool.execute({
      action: "update",
      developmentId: development.developmentId,
      expectedRevision: 1,
      goal: "同一设备 30 天内免验证，公共设备除外"
    })
  );
  assert.equal(updated.development.revision, 2);
  await assert.rejects(
    tool.execute({
      action: "update",
      developmentId: development.developmentId,
      expectedRevision: 1,
      goal: "过期写入"
    }),
    (error) => error.status === 409 && error.code === "revision_conflict"
  );

  // The other conversation's project never sees or changes this record.
  await assert.rejects(
    other.execute({ action: "get", developmentId: development.developmentId }),
    (error) => {
      assert.equal(error.status, 404);
      return true;
    }
  );
  const denied = await fetch(`${f.base}/api/projects/${encodeURIComponent(f.b.projectId)}/developments`, {
    headers: { "x-atria-token": f.token, "x-cowork-task-id": f.taskA }
  });
  const deniedBody = await denied.json();
  assert.equal(denied.status, 403, JSON.stringify(deniedBody));
  assert.equal(deniedBody.code, "project_scope_denied");
  const crossProject = await f.request(
    `/api/projects/${encodeURIComponent(f.b.projectId)}/developments/${encodeURIComponent(
      development.developmentId
    )}`
  );
  assert.equal(crossProject.status, 404, JSON.stringify(crossProject.body));
  const otherRequirements = await f.request(`/api/projects/${encodeURIComponent(f.b.projectId)}/ledger`);
  assert.doesNotMatch(JSON.stringify(otherRequirements.body), /登录记住设备/);

  // Everything the Agent saw, and the tool's own description, stay credential-free.
  seen.push(other.description);
  for (const value of seen) {
    assert.ok(!value.includes(f.token), "no response leaks the local credential");
    assert.doesNotMatch(value, /"delivery"|已交付/, "this ticket never claims delivery");
  }
});

test("the development view continues its workspace and keeps drafts and late responses in place", async (t) => {
  const f = await toolFixture(t);
  const tool = createProjectDevelopmentTool({
    dashboardUrl: f.base,
    taskId: f.taskA,
    token: f.token
  });
  const created = await tool.execute({
    action: "create",
    requirementId: f.requirementA.requirementId,
    goal: "同一设备 30 天内免验证",
    completionCriteria: ["同一设备第二次登录不再要求验证码"],
    route: "full"
  });
  const development = created.development;

  const previous = { window: globalThis.window, document: globalThis.document, CSS: globalThis.CSS };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  const { window, document } = parseHTML(readFileSync("web/index.html", "utf8"));
  globalThis.window = window;
  globalThis.document = document;
  globalThis.CSS = { escape: (value) => value };
  window.HTMLElement.prototype.getClientRects ??= () => [];

  const records = new Map();
  const storage = {
    get length() {
      return records.size;
    },
    key: (index) => [...records.keys()][index] ?? null,
    getItem: (key) => records.get(key),
    setItem: (key, value) => records.set(key, value),
    removeItem: (key) => records.delete(key)
  };
  let attachments = [];
  const input = { value: "", addEventListener() {} };
  const composer = createComposerSession({
    input,
    storage,
    getAttachments: () => attachments,
    setAttachments: (files) => {
      attachments = files;
    }
  });
  composer.activate(null);
  composer.setBackend("test-backend");
  composer.activate(null, { projectId: f.a.projectId });
  const api = (path, options) =>
    fetch(`${f.base}${path}`, {
      method: options?.method ?? (options?.body === undefined ? "GET" : "POST"),
      headers: options?.headers ?? { "content-type": "application/json" },
      ...(options?.body === undefined ? {} : { body: options.body })
    }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error(body.error ?? "请求失败"), { status: response.status });
      return body;
    });
  const state = {
    projects: [
      { ...f.a, tasks: [] },
      { ...f.b, tasks: [] }
    ],
    selectedProjectId: f.a.projectId,
    selected: f.taskA
  };
  const toasts = [];
  const controller = createProjectDevelopmentController({
    api,
    state,
    showToast: (message) => toasts.push(message)
  });
  const $ = (selector) => document.querySelector(selector);

  // The draft and its attachment belong to the selected session.
  input.value = "A 的草稿";
  attachments = [{ name: "a.txt", text: "A 附件" }];
  composer.save();

  controller.open(f.a.projectId);
  await waitFor(
    () => /登录记住设备/.test($("[data-list]").textContent),
    "project A developments did not load"
  );
  $("[data-list] button").click();
  await waitFor(() => /完成标准/.test($("[data-detail]").textContent), "the record detail did not load");
  assert.match($("[data-detail]").textContent, /同一设备 30 天内免验证/);
  assert.match($("[data-detail]").textContent, /同一设备第二次登录不再要求验证码/);
  assert.match($("[data-detail]").textContent, /coworkos\/development\//);
  assert.match($("[data-detail]").textContent, /进行中/);
  assert.doesNotMatch($("[data-detail]").textContent, /已交付/);
  assert.equal(input.value, "A 的草稿", "opening the view does not move the draft");
  assert.equal(attachments[0].name, "a.txt");

  // Continue re-reads the same checkout instead of preparing a second one.
  $("[data-continue]").click();
  await waitFor(() => toasts.at(-1) === "现场已就绪", "continue did not confirm the workspace");
  assert.equal(toasts.at(-1), "现场已就绪");
  const afterContinue = await f.request(
    `/api/projects/${encodeURIComponent(f.a.projectId)}/developments/${encodeURIComponent(
      development.developmentId
    )}`
  );
  assert.equal(afterContinue.body.development.workspace.directory, development.workspace.directory);
  assert.equal(afterContinue.body.development.workspace.state, "ready");
  assert.equal(afterContinue.body.development.workspace.branch, development.workspace.branch);
  assert.equal(input.value, "A 的草稿");
  assert.equal(attachments[0].name, "a.txt");

  // Switching projects reads that project only and leaves the draft alone.
  const select = $("[data-project]");
  select.children[0].removeAttribute("selected");
  select.children[1].setAttribute("selected", "");
  select.dispatchEvent(new window.Event("change"));
  await waitFor(
    () => /还没有开发记录/.test($("[data-list]").textContent),
    "project B developments did not load"
  );
  assert.doesNotMatch($("[data-list]").textContent, /登录记住设备/);
  assert.equal(input.value, "A 的草稿", "switching the list does not move the draft");
  assert.equal(attachments[0].name, "a.txt");
  controller.close();
  document.querySelector(".development-backdrop")?.remove();

  // A late project-A response must not take the page back after the switch.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let delayed = true;
  const lateApi = async (path, options) => {
    if (delayed && path === `/api/projects/${encodeURIComponent(f.a.projectId)}/developments`) {
      await gate;
      delayed = false;
    }
    return api(path, options);
  };
  const late = createProjectDevelopmentController({
    api: lateApi,
    state,
    showToast: () => {}
  });
  late.open(f.a.projectId);
  const lateSelect = $("[data-project]");
  lateSelect.children[0].removeAttribute("selected");
  lateSelect.children[1].setAttribute("selected", "");
  lateSelect.dispatchEvent(new window.Event("change"));
  await waitFor(
    () => /还没有开发记录/.test($("[data-list]").textContent),
    "project B did not replace the pending project A load"
  );
  release();
  await waitFor(() => delayed === false, "the late project A request did not resume");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.doesNotMatch($("[data-list]").textContent, /登录记住设备/);
  assert.equal($("[data-detail]").hidden, true, "a late project A detail stayed hidden");
  assert.equal(input.value, "A 的草稿");
  assert.equal(attachments[0].name, "a.txt");
  late.close();

  // A checkout that can no longer be verified is reported, not hidden: the
  // record keeps its requirement, directory and baseline and is never delivered.
  await rm(f.repository, { recursive: true, force: true });
  const failed = await tool.execute({
    action: "ensure_workspace",
    developmentId: development.developmentId
  });
  assert.equal(failed.development.workspace.state, "failed");
  assert.ok(failed.development.workspace.error, "the failure is locatable");
  assert.match(failed.development.workspace.error, /repository/);
  assert.equal(failed.development.workspace.directory, development.workspace.directory);
  assert.equal(failed.development.workspace.branch, development.workspace.branch);
  assert.equal(failed.development.workspace.baseCommit, development.baseline.commit);
  assert.equal(failed.development.requirementId, f.requirementA.requirementId);
  assert.equal(failed.development.status, "active");
  assert.doesNotMatch(JSON.stringify(failed.development), /已交付|delivered/);
  const stillFound = await f.request(
    `/api/projects/${encodeURIComponent(f.a.projectId)}/developments/${encodeURIComponent(
      development.developmentId
    )}`
  );
  assert.equal(stillFound.status, 200, JSON.stringify(stillFound.body));
  assert.equal(stillFound.body.development.workspace.state, "failed");
  const requirement = await f.request(
    `/api/projects/${encodeURIComponent(f.a.projectId)}/ledger/${encodeURIComponent(
      f.requirementA.requirementId
    )}`
  );
  assert.equal(requirement.status, 200);
  assert.equal(requirement.body.requirement.requirementId, f.requirementA.requirementId);
});

test("a failed record with an intact checkout returns to ready without a second checkout", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coworkos-p4-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = await makeRepository(join(directory, "repository"));
  const runtime = new ProjectDataRuntime({
    config: { sqlite: { path: join(directory, "project-data.sqlite") } },
    configPath: join(directory, "config.json"),
    dataRoot: directory,
    backendId: "backend_recovery"
  });
  t.after(() => runtime.close());
  const gateway = await runtime.service();
  const projectId = "project_recovery";
  await gateway.ensureProject({
    projectId,
    projectName: "恢复项目",
    projectDirectory: repository,
    backendId: "backend_recovery"
  });
  await gateway.setMergeConfig(projectId, { repository, targetBranch: "main" }, "backend_recovery");
  const requirement = await gateway.createRequirement(projectId, {
    title: "恢复现场",
    content: "一次就绪写入失败后，同一现场仍可恢复。"
  });

  // Controlled single failure: the checkout is created, then the ready write
  // fails once, so the record is persisted as failed while the worktree exists.
  let failReady = true;
  const wrapped = {
    service: async () =>
      new Proxy(gateway, {
        get(target, property, receiver) {
          if (property === "recordDevelopmentWorkspace" && failReady) {
            return async () => {
              failReady = false;
              throw new Error("fixture: ready write failed");
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      })
  };
  const service = createProjectDevelopmentService({
    runtime: wrapped,
    backendId: "backend_recovery",
    developmentRoot: join(directory, "workspaces"),
    project: async () => ({ projectId, projectName: "恢复项目", projectDirectory: repository }),
    taskProject: async () => undefined
  });

  const created = await service.create(projectId, {
    requirementId: requirement.requirementId,
    goal: "恢复同一现场",
    completionCriteria: ["恢复后不创建第二个 checkout"],
    route: "direct"
  });
  assert.equal(created.workspace.state, "failed", JSON.stringify(created.workspace));
  assert.match(created.workspace.error, /ready write failed/, "the first failure receipt is kept");
  const original = created.workspace;

  // Work the user already did in the checkout must survive the recovery.
  await git(original.directory, ["config", "user.email", "fixture@example.test"]);
  await git(original.directory, ["config", "user.name", "Fixture"]);
  await writeFile(join(original.directory, "user-change.txt"), "keep me\n");
  await git(original.directory, ["add", "."]);
  await git(original.directory, ["commit", "-m", "user change"]);
  const userHead = await git(original.directory, ["rev-parse", "HEAD"]);
  const checkoutsBefore = (await git(repository, ["worktree", "list", "--porcelain"]))
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;

  const recovered = await service.ensureWorkspace(projectId, created.developmentId);
  assert.equal(recovered.workspace.state, "ready", JSON.stringify(recovered.workspace));
  assert.equal(recovered.workspace.workspaceId, original.workspaceId);
  assert.equal(recovered.workspace.directory, original.directory);
  assert.equal(recovered.workspace.branch, original.branch);
  assert.equal(recovered.workspace.baseCommit, original.baseCommit);
  assert.equal(recovered.workspace.error, undefined);
  assert.equal(await git(original.directory, ["rev-parse", "HEAD"]), userHead, "HEAD was not reset");
  assert.equal(await readFile(join(original.directory, "user-change.txt"), "utf8"), "keep me\n");
  const checkoutsAfter = (await git(repository, ["worktree", "list", "--porcelain"]))
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;
  assert.equal(checkoutsAfter, checkoutsBefore, "no second checkout was created");

  // A mismatched identity or a genuinely unrelated non-empty directory is still
  // refused, and its files are preserved.
  const unrelated = join(directory, "unrelated");
  await mkdir(unrelated, { recursive: true });
  await writeFile(join(unrelated, "keep.txt"), "do not delete\n");
  await gateway.recordDevelopmentWorkspace(projectId, created.developmentId, {
    workspaceId: original.workspaceId,
    backendId: "backend_recovery",
    directory: unrelated,
    branch: "coworkos/development/wrong-branch",
    baseCommit: userHead,
    state: "failed",
    error: "fixture: identity mismatch"
  });
  const refused = await service.ensureWorkspace(projectId, created.developmentId);
  assert.equal(refused.workspace.state, "failed");
  assert.match(refused.workspace.error, /已有内容/);
  assert.equal(await readFile(join(unrelated, "keep.txt"), "utf8"), "do not delete\n");
  assert.equal((await stat(unrelated)).isDirectory(), true);
});
