import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startDashboard } from "./dashboard-fixture.mjs";
const { ApplicationService } = await import("../dist/src/applications/application-service.js");
const { ResourceFiles } = await import("../dist/src/applications/resource-files.js");

async function fixture(t) {
  const dashboard = await startDashboard({ defaultProject: false });
  t.after(() => dashboard.stop());
  const api = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000)
    });
    const result = await response.json();
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  };
  const projects = [];
  for (const name of ["用户项目", "另一个项目", "合法空项目"]) {
    const projectDirectory = join(dashboard.root, name);
    await mkdir(projectDirectory);
    projects.push((await api("/api/projects", { projectName: name, projectDirectory })).project);
  }
  for (const [index, taskId] of ["first", "other"].entries())
    await api("/api/tasks", { taskId, goal: taskId, projectId: projects[index].projectId });
  return { ...dashboard, api, projects };
}

const metadataPath = (root, resource) =>
  join(root, "applications", resource.appType, "resources", resource.resourceId, "metadata.json");

test("a first text document inherits its conversation project in metadata and actual files, independent of Task storage", async (t) => {
  const f = await fixture(t);
  const project = f.projects[0];
  const { applications } = await f.api("/api/applications");
  const kind = applications.find((entry) => entry.appType === "text-editor").resourceKinds[0];
  const created = await f.api("/api/tasks/first/resources", { kind, title: "自我介绍" });
  assert.equal(created.resource.project?.projectId, project.projectId);
  assert.equal(created.resource.project.projectName, project.projectName);
  assert.equal(created.appInstance.project?.projectId, project.projectId);
  const resourceRoot = project.projectDirectory;
  const metadata = JSON.parse(await readFile(metadataPath(resourceRoot, created.resource), "utf8"));
  assert.deepEqual(metadata.project, created.resource.project);
  await access(new ResourceFiles(resourceRoot).absolutePath(metadata));
  await assert.rejects(access(new ResourceFiles(f.workspaceRoot).absolutePath(metadata)), { code: "ENOENT" });
  await access(join(f.workspaceRoot, "first", "task.json"));
  await assert.rejects(access(join(resourceRoot, "first", "task.json")), { code: "ENOENT" });
  await f.api("/api/workbench/load-instance", {
    taskId: "first",
    appInstanceId: created.appInstance.appInstanceId
  });
  const window = (await f.api("/api/workbench/tabs")).tabs.find(
    (tab) => tab.resourceId === metadata.resourceId
  );
  assert.equal(window.workspaceRoot, resourceRoot);
  assert.equal(window.project.projectName, project.projectName);
  for (const references of [window.conversations, window.loadedConversations, window.relatedConversations]) {
    assert.equal(references.find((entry) => entry.taskId === "first").storageRoot, f.workspaceRoot);
  }
  const conversationTabs = await f.api("/api/workbench/tabs", {
    kind: "conversation",
    taskId: "first"
  });
  assert.equal(
    conversationTabs.tabs.find((tab) => tab.kind === "conversation" && tab.taskId === "first").storageRoot,
    f.workspaceRoot
  );
  const missingInstance = await fetch(`${f.base}/api/workbench/instances/missing-instance`);
  assert.equal(missingInstance.status, 404);
  await assert.rejects(access(join(f.projects[2].projectDirectory, "applications")), { code: "ENOENT" });
  await f.restart({ newPort: true });
  const restored = (await f.api("/api/tasks/first/active-app-context")).context;
  assert.equal(restored.resource.resourceId, metadata.resourceId);
  assert.equal(restored.resource.project.projectId, project.projectId);
  const restoredTab = (await f.api("/api/workbench/tabs")).tabs.find(
    (tab) => tab.resourceId === metadata.resourceId
  );
  assert.equal(restoredTab.workspaceRoot, resourceRoot);
  assert.equal(
    restoredTab.conversations.find((entry) => entry.taskId === "first").storageRoot,
    f.workspaceRoot
  );
});

test("standalone windows keep their project and file root across loading, explicit sharing, rename and restart", async (t) => {
  const f = await fixture(t);
  const project = f.projects[0];
  const opened = await f.api("/api/workbench/open-application", {
    appType: "text-editor",
    workspaceRoot: project.projectDirectory
  });
  assert.equal(opened.appInstance.project?.projectId, project.projectId);
  const created = await f.api(`/api/workbench/instances/${opened.appInstance.appInstanceId}/resources`, {
    kind: "text/plain",
    title: "原归属.txt",
    initialContent: "保留内容\n"
  });
  const resource = created.resource;
  assert.equal(resource.project?.projectId, project.projectId);
  const file = new ResourceFiles(project.projectDirectory).absolutePath(resource);
  const before = await readFile(metadataPath(project.projectDirectory, resource), "utf8");
  await f.api("/api/workbench/load-instance", {
    taskId: "first",
    appInstanceId: opened.appInstance.appInstanceId
  });
  // Explicit access permits cross-project sharing; loading alone cannot grant it.
  await new ApplicationService(project.projectDirectory, undefined, f.workspaceRoot).referenceResource({
    taskId: "other",
    resourceId: resource.resourceId,
    appType: resource.appType
  });
  await f.api("/api/workbench/load-instance", {
    taskId: "other",
    appInstanceId: opened.appInstance.appInstanceId
  });
  await f.api(`/api/projects/${project.projectId}`, { projectName: "项目新名称" }, "PATCH");
  let tab = (await f.api("/api/workbench/tabs")).tabs.find(
    (entry) => entry.resourceId === resource.resourceId
  );
  assert.equal(tab.project.projectId, project.projectId);
  assert.equal(tab.project.projectName, "项目新名称");
  assert.deepEqual(tab.loadedConversations.map((entry) => entry.taskId).sort(), ["first", "other"]);
  assert.ok(tab.loadedConversations.every((entry) => entry.storageRoot === f.workspaceRoot));
  assert.equal(await readFile(metadataPath(project.projectDirectory, resource), "utf8"), before);
  assert.equal(await readFile(file, "utf8"), "保留内容\n");
  await f.restart({ newPort: true });
  tab = (await f.api("/api/workbench/tabs")).tabs.find((entry) => entry.resourceId === resource.resourceId);
  assert.equal(tab.project.projectId, project.projectId);
  assert.equal(tab.workspaceRoot, project.projectDirectory);
  assert.equal((await f.api("/api/tasks/other")).projectId, f.projects[1].projectId);
  assert.equal(
    (await f.api(`/api/tasks/other/resources/${resource.resourceId}`)).snapshot.content,
    "保留内容\n"
  );
});

test("an unassigned standalone document and legacy migrated indexes never borrow the selected chat project", async (t) => {
  const f = await fixture(t);
  const opened = await f.api("/api/workbench/open-application", {
    appType: "text-editor",
    workspaceRoot: f.workspaceRoot
  });
  assert.equal(opened.appInstance.project, null);
  const created = await f.api(`/api/workbench/instances/${opened.appInstance.appInstanceId}/resources`, {
    kind: "text/plain",
    title: "未归属.txt",
    initialContent: "独立内容\n"
  });
  assert.equal(created.resource.project, null);
  await f.api("/api/workbench/load-instance", {
    taskId: "first",
    appInstanceId: opened.appInstance.appInstanceId
  });
  const tab = (await f.api("/api/workbench/tabs")).tabs.find(
    (entry) => entry.resourceId === created.resource.resourceId
  );
  assert.equal(tab.project, null);
  assert.equal(tab.workspaceRoot, f.workspaceRoot);
  const indexPath = join(f.root, "projects.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  const stale = [f.workspaceRoot, join(f.root, "test"), join(f.root, "atria-reasoning-launcher-old")].map(
    (directory) => ({
      projectId: directory,
      projectName: directory.split("/").at(-1),
      projectDirectory: directory,
      legacy: true,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z"
    })
  );
  index.projects.push(...stale);
  await writeFile(indexPath, JSON.stringify(index));
  const listed = await f.api("/api/tasks");
  // The internal storage root does contain an unassigned document, but no project-owned content.
  assert.deepEqual(
    listed.projects.map((entry) => entry.projectId).sort(),
    f.projects.map((entry) => entry.projectId).sort()
  );
  const nextEditor = await f.api("/api/workbench/open-application", {
    appType: "text-editor",
    workspaceRoot: f.workspaceRoot
  });
  assert.equal(
    nextEditor.appInstance.project,
    null,
    "opening another editor cannot revive a hidden internal project"
  );
  const next = await f.api(`/api/workbench/instances/${nextEditor.appInstance.appInstanceId}/resources`, {
    kind: "text/plain",
    title: "仍然未归属.txt"
  });
  assert.equal(next.resource.project, null);
  await assert.rejects(access(stale[2].projectDirectory), { code: "ENOENT" });
  assert.deepEqual(
    (await f.api("/api/tasks")).projects.map((entry) => entry.projectId).sort(),
    f.projects.map((entry) => entry.projectId).sort()
  );
  assert.equal(JSON.parse(await readFile(indexPath, "utf8")).projects.length, index.projects.length);
  assert.equal(
    await readFile(new ResourceFiles(f.workspaceRoot).absolutePath(created.resource), "utf8"),
    "独立内容\n"
  );
});

test("new-file defaults follow the current project while existing loaded and shared files retain their original roots", async (t) => {
  const f = await fixture(t);
  const original = new ApplicationService(f.workspaceRoot);
  const saved = await original.resources.createResource({
    appType: "text-editor",
    kind: "text/plain",
    title: "老布局.txt",
    initialContent: "历史内容\n",
    actor: { type: "user", id: "fixture" }
  });
  const old = saved.resource;
  await original.referenceResource({ taskId: "first", resourceId: old.resourceId, appType: old.appType });
  const oldWindow = await original.openResource({ taskId: "first", resourceId: old.resourceId });
  await f.api("/api/workbench/load-instance", { taskId: "first", appInstanceId: oldWindow.appInstanceId });
  const oldMetadata = await readFile(metadataPath(f.workspaceRoot, old), "utf8");
  const created = await f.api("/api/tasks/first/resources", {
    kind: "text/plain",
    title: "本次新文件.txt",
    initialContent: "本次内容\n"
  });
  assert.equal(created.resource.project.projectId, f.projects[0].projectId);
  await access(new ResourceFiles(f.projects[0].projectDirectory).absolutePath(created.resource));
  assert.equal(
    (await f.api("/api/tasks/first/active-app-context")).context.resource.resourceId,
    old.resourceId
  );
  assert.equal(await readFile(metadataPath(f.workspaceRoot, old), "utf8"), oldMetadata);
  const nextDirectory = join(f.root, "changed-project");
  await mkdir(nextDirectory);
  await f.api(`/api/projects/${f.projects[0].projectId}`, { projectDirectory: nextDirectory }, "PATCH");
  const afterChange = await f.api("/api/tasks/first/resources", {
    kind: "text/plain",
    title: "新目录文件.txt"
  });
  assert.equal(afterChange.resource.project.projectDirectory, nextDirectory);
  await access(new ResourceFiles(nextDirectory).absolutePath(afterChange.resource));
  await f.api("/api/workbench/load-instance", {
    taskId: "first",
    appInstanceId: created.appInstance.appInstanceId
  });
  const tab = (await f.api("/api/workbench/tabs")).tabs.find(
    (entry) => entry.resourceId === created.resource.resourceId
  );
  assert.equal(tab.workspaceRoot, f.projects[0].projectDirectory);
  assert.equal(
    tab.project.projectDirectory,
    f.projects[0].projectDirectory,
    "affiliation snapshot never moves with project folder settings"
  );
  await f.restart();
  assert.equal(
    (await f.api("/api/tasks/first/active-app-context")).context.resource.resourceId,
    created.resource.resourceId
  );
  assert.equal(await readFile(metadataPath(f.workspaceRoot, old), "utf8"), oldMetadata);
  assert.equal(await readFile(new ResourceFiles(f.workspaceRoot).absolutePath(old), "utf8"), "历史内容\n");
});

test("opening a new empty window after loading a legacy file creates its document in the conversation project", async (t) => {
  const f = await fixture(t);
  const project = f.projects[0];
  const original = new ApplicationService(f.workspaceRoot);
  const old = (
    await original.resources.createResource({
      appType: "text-editor",
      kind: "text/plain",
      title: "old.txt",
      initialContent: "original\n",
      actor: { type: "user", id: "fixture" }
    })
  ).resource;
  await original.referenceResource({ taskId: "first", resourceId: old.resourceId, appType: old.appType });
  const oldWindow = await original.openResource({ taskId: "first", resourceId: old.resourceId });
  await f.api("/api/workbench/load-instance", { taskId: "first", appInstanceId: oldWindow.appInstanceId });
  const before = await readFile(metadataPath(f.workspaceRoot, old), "utf8");
  const { appInstance } = await f.api("/api/tasks/first/app-instances/open", {
    appType: "text-editor",
    workspaceRoot: f.workspaceRoot
  });
  assert.equal(appInstance.project.projectId, project.projectId);
  const created = await f.api(`/api/tasks/first/app-instances/${appInstance.appInstanceId}/resources`, {
    kind: "text/plain",
    title: "new.txt",
    initialContent: "new\n"
  });
  assert.equal(created.appInstance.appInstanceId, appInstance.appInstanceId);
  assert.equal(created.resource.project.projectId, project.projectId);
  const file = new ResourceFiles(project.projectDirectory).absolutePath(created.resource);
  assert.equal(await readFile(file, "utf8"), "new\n");
  await assert.rejects(access(new ResourceFiles(f.workspaceRoot).absolutePath(created.resource)), {
    code: "ENOENT"
  });
  assert.equal(await readFile(metadataPath(f.workspaceRoot, old), "utf8"), before);
  assert.equal(await readFile(new ResourceFiles(f.workspaceRoot).absolutePath(old), "utf8"), "original\n");
  await f.api("/api/workbench/load-instance", { taskId: "first", appInstanceId: appInstance.appInstanceId });
  await f.restart();
  const tab = (await f.api("/api/workbench/tabs")).tabs.find(
    (entry) => entry.appInstanceId === appInstance.appInstanceId
  );
  assert.equal(tab.workspaceRoot, project.projectDirectory);
  assert.equal(tab.project.projectId, project.projectId);
  assert.equal(
    (await f.api("/api/tasks/first/active-app-context")).context.resource.resourceId,
    created.resource.resourceId
  );
});

test("legacy empty windows recover their original-root project while explicit unassigned windows retain null", async (t) => {
  const f = await fixture(t);
  const project = f.projects[0];
  for (const { legacy, taskId } of [
    { legacy: true, taskId: "first" },
    { legacy: true, taskId: "other" },
    { legacy: false, taskId: "other" }
  ]) {
    const { appInstance } = await f.api("/api/workbench/open-application", {
      appType: "text-editor",
      workspaceRoot: project.projectDirectory
    });
    const indexPath = join(project.projectDirectory, "applications", "instances", "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    const record = index.instances.find((entry) => entry.appInstanceId === appInstance.appInstanceId);
    if (legacy) delete record.project;
    else record.project = null;
    await writeFile(indexPath, JSON.stringify(index));
    await f.api("/api/workbench/load-instance", {
      taskId,
      appInstanceId: appInstance.appInstanceId
    });
    const before = (await f.api("/api/workbench/tabs")).tabs.find(
      (entry) => entry.appInstanceId === appInstance.appInstanceId
    );
    assert.equal(before.project?.projectId ?? null, legacy ? project.projectId : null);
    const endpoint =
      taskId === "first"
        ? `/api/workbench/instances/${appInstance.appInstanceId}/resources`
        : `/api/tasks/${taskId}/app-instances/${appInstance.appInstanceId}/resources`;
    const { resource } = await f.api(endpoint, {
      kind: "text/plain",
      title: legacy ? "legacy.txt" : "unassigned.txt"
    });
    assert.equal(resource.project?.projectId ?? null, legacy ? project.projectId : null);
    const persisted = JSON.parse(await readFile(metadataPath(project.projectDirectory, resource), "utf8"));
    assert.deepEqual(persisted.project, resource.project);
    await access(new ResourceFiles(project.projectDirectory).absolutePath(resource));
    if (taskId === "first")
      await new ApplicationService(project.projectDirectory, undefined, f.workspaceRoot).referenceResource({
        taskId: "other",
        resourceId: resource.resourceId,
        appType: resource.appType
      });
    await f.restart();
    const after = (await f.api("/api/workbench/tabs")).tabs.find(
      (entry) => entry.appInstanceId === appInstance.appInstanceId
    );
    assert.equal(after.project?.projectId ?? null, legacy ? project.projectId : null);
    assert.equal(after.workspaceRoot, project.projectDirectory);
    assert.equal(
      (await f.api(`/api/tasks/${taskId}`)).projectId,
      taskId === "first" ? project.projectId : f.projects[1].projectId
    );
  }
});

test("a damaged discovery manifest cannot hide real conversations or other valid application roots", async (t) => {
  const f = await fixture(t);
  const sourceRoot = join(f.root, "retained-source-root");
  await mkdir(sourceRoot);
  const source = new ApplicationService(sourceRoot, undefined, f.workspaceRoot);
  const created = await source.createResource({
    taskId: "first",
    kind: "text/plain",
    title: "retained.txt",
    initialContent: "retained document\n",
    actor: { type: "user", id: "fixture" }
  });
  await f.api("/api/workbench/load-instance", {
    taskId: "first",
    appInstanceId: created.appInstance.appInstanceId
  });
  const damagedPath = join(f.workspaceRoot, "other", "applications", "manifest.json");
  await mkdir(join(f.workspaceRoot, "other", "applications"), { recursive: true });
  await writeFile(damagedPath, "{bad json");
  const taskPath = join(f.workspaceRoot, "other", "task.json");
  const taskBefore = await readFile(taskPath, "utf8");
  const listed = await f.api("/api/tasks");
  assert.deepEqual(listed.tasks.map((entry) => entry.taskId).sort(), ["first", "other"]);
  assert.equal(listed.tasks.find((entry) => entry.taskId === "other").goal, "other");
  assert.equal((await f.api("/api/tasks/first")).task.goal, "first");
  assert.equal(
    (await f.api(`/api/tasks/first/resources/${created.resource.resourceId}`)).snapshot.content,
    "retained document\n"
  );
  const tab = (await f.api("/api/workbench/tabs")).tabs.find(
    (entry) => entry.resourceId === created.resource.resourceId
  );
  assert.equal(tab.workspaceRoot, sourceRoot);
  assert.equal(await readFile(damagedPath, "utf8"), "{bad json");
  assert.equal(await readFile(taskPath, "utf8"), taskBefore);
  await f.restart();
  assert.deepEqual((await f.api("/api/tasks")).tasks.map((entry) => entry.taskId).sort(), ["first", "other"]);
  assert.equal(await readFile(damagedPath, "utf8"), "{bad json");
});

test("legacy scalar project IDs survive folder reuse and an explicit null overrides that compatibility field", async (t) => {
  const f = await fixture(t);
  const owner = f.projects[0];
  const created = await f.api("/api/tasks/first/resources", {
    kind: "text/plain",
    title: "legacy-id.txt",
    initialContent: "retained\n"
  });
  const metadataFile = metadataPath(owner.projectDirectory, created.resource);
  const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
  assert.equal(metadata.projectId, owner.projectId);
  delete metadata.project;
  await writeFile(metadataFile, JSON.stringify(metadata));
  const instancesFile = join(owner.projectDirectory, "applications", "instances", "index.json");
  const index = JSON.parse(await readFile(instancesFile, "utf8"));
  delete index.instances.find((entry) => entry.appInstanceId === created.appInstance.appInstanceId).project;
  await writeFile(instancesFile, JSON.stringify(index));
  const newHome = join(f.root, "owner-moved");
  await mkdir(newHome);
  await f.api(
    `/api/projects/${owner.projectId}`,
    { projectName: "原归属改名", projectDirectory: newHome },
    "PATCH"
  );
  await f.api("/api/projects", {
    projectName: "后来复用目录的项目",
    projectDirectory: owner.projectDirectory
  });
  await f.api("/api/workbench/tabs", {
    kind: "application",
    appInstanceId: created.appInstance.appInstanceId
  });
  await f.restart();
  let tab = (await f.api("/api/workbench/tabs")).tabs.find(
    (entry) => entry.resourceId === created.resource.resourceId
  );
  assert.equal(tab.project.projectId, owner.projectId);
  assert.equal(tab.project.projectName, "原归属改名");
  assert.equal(tab.project.projectDirectory, owner.projectDirectory);
  assert.equal(tab.workspaceRoot, owner.projectDirectory);
  assert.equal(await readFile(metadataFile, "utf8"), JSON.stringify(metadata));
  metadata.project = null;
  await writeFile(metadataFile, JSON.stringify(metadata));
  tab = (await f.api("/api/workbench/tabs")).tabs.find(
    (entry) => entry.resourceId === created.resource.resourceId
  );
  assert.equal(tab.project, null);
  assert.equal(tab.projectId, undefined);
  assert.equal(
    await readFile(new ResourceFiles(owner.projectDirectory).absolutePath(metadata), "utf8"),
    "retained\n"
  );
});
