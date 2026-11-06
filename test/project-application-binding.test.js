import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startDashboard } from "./dashboard-fixture.mjs";
const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");
const { ApplicationService } = await import("../dist/src/applications/application-service.js");
const { applicationServiceForTask } = await import("../dist/src/applications/task-service.js");

async function fixture(t) {
  const dashboard = await startDashboard({ defaultProject: false });
  t.after(() => dashboard.stop());
  const directories = ["project-a", "project-b", "imported-storage"].map((name) =>
    join(dashboard.root, name)
  );
  await Promise.all(directories.map((directory) => mkdir(directory)));
  const api = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000)
    });
    return { status: response.status, body: await response.json() };
  };
  const projects = [];
  for (const [index, projectDirectory] of directories.slice(0, 2).entries()) {
    const created = await api("/api/projects", { projectName: `Project ${index}`, projectDirectory });
    assert.equal(created.status, 201);
    projects.push(created.body.project);
  }
  for (const [index, taskId] of ["first", "other"].entries()) {
    const created = await api("/api/tasks", { taskId, goal: taskId, projectId: projects[index].projectId });
    assert.equal(created.status, 201);
    assert.equal(created.body.storageRoot, dashboard.workspaceRoot);
    assert.equal(created.body.projectDirectory, directories[index]);
  }
  const document = async (workspaceRoot, title = "项目文档.txt") => {
    const opened = await api("/api/workbench/open-application", { appType: "text-editor", workspaceRoot });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const appInstanceId = opened.body.appInstance.appInstanceId;
    const created = await api(`/api/workbench/instances/${appInstanceId}/resources`, {
      kind: "text/plain",
      title,
      initialContent: `原稿：${title}\n`
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return { appInstanceId, resourceId: created.body.resource.resourceId };
  };
  const load = (taskId, value) => api("/api/workbench/load-instance", { taskId, ...value });
  const context = async (taskId) => {
    const result = await api(`/api/tasks/${taskId}/active-app-context`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.context;
  };
  return { ...dashboard, api, projects, directories, document, load, context };
}

test("project documents load without moving Task storage and reject an unrelated project without mutation", async (t) => {
  const f = await fixture(t);
  const document = await f.document(f.directories[0]);
  const loaded = await f.load("first", { appInstanceId: document.appInstanceId });
  assert.equal(loaded.status, 200, JSON.stringify(loaded.body));
  assert.equal((await f.context("first")).resource.resourceId, document.resourceId);
  const detail = (await f.api("/api/tasks/first")).body;
  assert.equal(detail.storageRoot, f.workspaceRoot);
  assert.equal(detail.projectDirectory, f.directories[0]);
  assert.equal(detail.applications.workspaceRoot, f.directories[0]);
  const manifestPath = join(f.workspaceRoot, "first/applications/manifest.json");
  const mappingPath = join(f.workspaceRoot, "first/applications/mapping.json");
  assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).workspaceRoot, f.directories[0]);
  assert.equal(JSON.parse(await readFile(mappingPath, "utf8")).resources[0].workspaceRoot, f.directories[0]);
  for (const id of ["first", "other", "workspace"])
    await assert.rejects(access(join(f.directories[0], id)), { code: "ENOENT" });
  assert.equal((await new LocalWorkspaceStore(f.workspaceRoot).readTask("workspace")).kind, "workspace");
  const before = await readFile(join(f.workspaceRoot, "other/task.json"), "utf8");
  const denied = await f.load("other", { appInstanceId: document.appInstanceId });
  assert.equal(denied.status, 422);
  assert.equal(denied.body.error.code, "invalid_operation");
  assert.equal(await f.context("other"), null);
  assert.equal(await readFile(join(f.workspaceRoot, "other/task.json"), "utf8"), before);
  await assert.rejects(access(join(f.workspaceRoot, "other/applications/mapping.json")), { code: "ENOENT" });
  const deniedResource = await f.load("other", { resourceId: document.resourceId });
  assert.equal(deniedResource.status, 422);
  const deniedTab = await f.api("/api/workbench/tabs", {
    kind: "application",
    resourceId: document.resourceId,
    bindTo: "other"
  });
  assert.equal(deniedTab.status, 422);
  await f.restart();
  assert.equal((await f.context("first")).resource.resourceId, document.resourceId);
  assert.equal((await f.api(`/api/tasks/first/resources/${document.resourceId}`)).status, 200);
});

test("legacy and project resource references survive root switching, folder changes and restart", async (t) => {
  const f = await fixture(t);
  const legacyService = new ApplicationService(f.workspaceRoot);
  const old = await legacyService.resources.createResource({
    appType: "text-editor",
    kind: "text/plain",
    title: "旧工作区.txt",
    initialContent: "旧资源保留\n",
    actor: { type: "user", id: "fixture" }
  });
  await legacyService.referenceResource({
    taskId: "first",
    resourceId: old.resource.resourceId,
    appType: "text-editor"
  });
  const legacy = {
    body: {
      resource: old.resource,
      appInstance: await legacyService.openResource({ taskId: "first", resourceId: old.resource.resourceId })
    }
  };
  const legacyId = legacy.body.resource.resourceId;
  const legacyInstance = legacy.body.appInstance.appInstanceId;
  assert.equal((await f.load("first", { appInstanceId: legacyInstance })).status, 200);
  assert.equal((await f.context("first")).resource.resourceId, legacyId);
  const project = await f.document(f.directories[0]);
  assert.equal((await f.load("first", { appInstanceId: project.appInstanceId })).status, 200);
  const mixed = await applicationServiceForTask(f.workspaceRoot, "first");
  assert.equal(
    (await mixed.openResource({ taskId: "first", resourceId: legacyId })).appInstanceId,
    legacyInstance
  );
  assert.equal((await mixed.readResource("first", legacyId)).snapshot.content, "旧资源保留\n");
  assert.equal(
    (await mixed.renderForDownload({ taskId: "first", resourceId: legacyId, format: "text" })).body,
    "旧资源保留\n"
  );
  await mixed.renameResource({ taskId: "first", resourceId: legacyId, title: "旧文件新名.txt" });
  assert.equal(
    await readFile(join(f.workspaceRoot, "applications/text-editor/files/旧文件新名.txt"), "utf8"),
    "旧资源保留\n"
  );
  await assert.rejects(access(join(f.directories[0], "applications/text-editor/files/旧文件新名.txt")), {
    code: "ENOENT"
  });
  const ids = async () => {
    const listed = await f.api("/api/tasks/first/resources");
    assert.equal(listed.status, 200);
    return listed.body.resources.map((entry) => entry.resourceId).sort();
  };
  assert.deepEqual(await ids(), [legacyId, project.resourceId].sort());
  assert.equal((await f.api(`/api/tasks/first/resources/${legacyId}`)).status, 200);
  assert.equal((await f.load("first", { resourceId: legacyId })).status, 200);
  assert.equal((await f.context("first")).resource.resourceId, legacyId);
  const legacyTab = (await f.api("/api/workbench/tabs")).body.tabs.find(
    (tab) => tab.appInstanceId === legacyInstance
  );
  assert.equal(legacyTab.workspaceRoot, f.workspaceRoot);
  assert.ok(legacyTab.loadedConversations.some((entry) => entry.taskId === "first"));
  assert.ok(legacyTab.conversations.some((entry) => entry.taskId === "first"));
  assert.deepEqual(await ids(), [legacyId, project.resourceId].sort());
  assert.equal((await f.load("first", { resourceId: project.resourceId })).status, 200);
  const third = join(f.root, "changed-project");
  await mkdir(third);
  assert.equal(
    (await f.api(`/api/projects/${f.projects[0].projectId}`, { projectDirectory: third }, "PATCH")).status,
    200
  );
  assert.equal((await f.context("first")).resource.resourceId, project.resourceId);
  await f.restart({ newPort: true });
  assert.equal((await f.context("first")).resource.resourceId, project.resourceId);
  assert.deepEqual(await ids(), [legacyId, project.resourceId].sort());
  assert.equal((await f.load("first", { resourceId: legacyId })).status, 200);
  assert.equal((await f.api("/api/tasks/first/app-instances/unbind", {})).status, 200);
  assert.equal(await f.context("first"), null);
  assert.deepEqual(await ids(), [legacyId, project.resourceId].sort());
  assert.equal((await f.load("first", { resourceId: project.resourceId })).status, 200);
  for (const directory of [f.directories[0], third])
    await assert.rejects(access(join(directory, "first")), { code: "ENOENT" });
});

test("project-bound MCP calls survive restart and retain reference checks and resource revision CAS", async (t) => {
  const f = await fixture(t);
  const opened = await f.api("/api/workbench/open-application", {
    appType: "text-editor",
    workspaceRoot: f.directories[0]
  });
  assert.equal(opened.status, 201);
  const appInstanceId = opened.body.appInstance.appInstanceId;
  const created = await f.api(`/api/workbench/instances/${appInstanceId}/resources`, {
    kind: "text/markdown",
    title: "项目章节.md",
    initialContent: "# 文档\n\n## 背景\n旧背景。\n"
  });
  assert.equal(created.status, 201);
  const resourceId = created.body.resource.resourceId;
  assert.equal((await f.load("first", { appInstanceId })).status, 200);
  await f.restart({ newPort: true });
  const tools = await f.api(`/api/workbench/mcp/tools?taskId=first&appInstanceId=${appInstanceId}`);
  assert.equal(tools.status, 200);
  assert.ok(tools.body.tools.some((tool) => tool.name === "replace_section"));
  const params = {
    resourceId,
    appInstanceId,
    name: "replace_section",
    params: { heading: "背景", body: "MCP 修改后的背景。" }
  };
  const denied = await f.api("/api/workbench/mcp/call", { taskId: "other", ...params });
  assert.equal(denied.status, 404);
  assert.equal(denied.body.error.code, "resource_not_found");
  const called = await f.api("/api/workbench/mcp/call", { taskId: "first", ...params });
  assert.equal(called.status, 200, JSON.stringify(called.body));
  assert.equal(called.body.baseRevision, 0);
  const operation = called.body.operations[0];
  const applied = await f.api(`/api/tasks/first/resources/${resourceId}/operations`, {
    operationId: "project-mcp-operation",
    appType: "text-editor",
    ...operation,
    baseRevision: called.body.baseRevision
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.resource.revision, 1);
  assert.match(
    (await f.api(`/api/tasks/first/resources/${resourceId}`)).body.snapshot.content,
    /MCP 修改后的背景/
  );
  assert.match(
    await readFile(join(f.directories[0], "applications/text-editor/files/项目章节.md"), "utf8"),
    /MCP 修改后的背景/
  );
  await assert.rejects(access(join(f.directories[0], "first")), { code: "ENOENT" });
});

test("one project window can be loaded by Tasks in two storage roots without sharing manifests or cursors", async (t) => {
  const f = await fixture(t);
  const storage = f.directories[2];
  assert.equal((await f.api("/api/workbench/workspaces", { workspaceRoot: storage })).status, 200);
  await new LocalWorkspaceStore(storage).createTask("imported", {
    goal: "Imported conversation",
    projectDirectory: f.directories[0]
  });
  const document = await f.document(f.directories[0]);
  for (const taskId of ["first", "imported"])
    assert.equal((await f.load(taskId, { appInstanceId: document.appInstanceId })).status, 200);
  const edit = await f.api(`/api/tasks/first/resources/${document.resourceId}/operations`, {
    operationId: "shared-project-edit",
    appType: "text-editor",
    operationType: "text.replace",
    baseRevision: 0,
    payload: { from: 0, to: 0, text: "共享更新\n" }
  });
  assert.equal(edit.status, 200);
  const firstService = await applicationServiceForTask(f.workspaceRoot, "first");
  const importedService = await applicationServiceForTask(storage, "imported");
  await firstService.context.recordAcknowledged("first", "main", document.resourceId, 1);
  await importedService.context.recordInjected("imported", "main", document.resourceId, 1);
  assert.equal(
    (await firstService.context.readCursor("first", "main", document.resourceId)).lastAcknowledgedRevision,
    1
  );
  assert.equal(
    (await importedService.context.readCursor("imported", "main", document.resourceId))
      .lastAcknowledgedRevision,
    0
  );
  assert.ok(
    (
      await readFile(join(f.workspaceRoot, "first/agents/main/context/application-cursors.json"), "utf8")
    ).includes(document.resourceId)
  );
  assert.ok(
    (await readFile(join(storage, "imported/agents/main/context/application-cursors.json"), "utf8")).includes(
      document.resourceId
    )
  );
  for (const [root, taskId] of [
    [f.workspaceRoot, "first"],
    [storage, "imported"]
  ]) {
    assert.equal((await f.context(taskId)).resource.resourceId, document.resourceId);
    assert.equal(
      JSON.parse(await readFile(join(root, taskId, "applications/manifest.json"), "utf8")).loadedInstanceId,
      document.appInstanceId
    );
    await assert.rejects(access(join(f.directories[0], taskId)), { code: "ENOENT" });
  }
  let tabs = (await f.api("/api/workbench/tabs")).body.tabs;
  let window = tabs.find((tab) => tab.appInstanceId === document.appInstanceId);
  assert.deepEqual(window.loadedConversations.map((entry) => entry.taskId).sort(), ["first", "imported"]);
  assert.equal((await f.api("/api/tasks/first/app-instances/unbind", {})).status, 200);
  assert.equal(await f.context("first"), null);
  assert.equal((await f.context("imported")).resource.resourceId, document.resourceId);
  await f.restart();
  assert.equal((await f.context("imported")).resource.resourceId, document.resourceId);
  tabs = (await f.api("/api/workbench/tabs")).body.tabs;
  window = tabs.find((tab) => tab.appInstanceId === document.appInstanceId);
  assert.deepEqual(
    window.loadedConversations.map((entry) => entry.taskId),
    ["imported"]
  );
  assert.equal(
    (await f.api(`/api/workbench/instances/${document.appInstanceId}`, { status: "closed" }, "PATCH")).status,
    200
  );
  assert.equal(await f.context("imported"), null);
  assert.equal((await f.api(`/api/tasks/imported/resources/${document.resourceId}`)).status, 200);
  await f.restart();
  assert.equal(await f.context("imported"), null);
});
