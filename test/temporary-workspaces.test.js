import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startDashboard } from "./dashboard-fixture.mjs";
const { ResourceFiles } = await import("../dist/src/applications/resource-files.js");

async function fixture(t) {
  const dashboard = await startDashboard({ defaultProject: false });
  t.after(() => dashboard.stop());
  const api = async (path, body, status = body === undefined ? 200 : 201) => {
    const response = await fetch(dashboard.base + path, {
      ...(body === undefined
        ? {}
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(8_000)
    });
    const payload = await response.json();
    assert.equal(response.status, status, `${path}: ${JSON.stringify(payload)}`);
    return payload;
  };
  return {
    ...dashboard,
    get base() {
      return dashboard.base;
    },
    api
  };
}

test("independent editors and projectless chats use isolated durable roots, stay out of projects, and recover after restart", async (t) => {
  const f = await fixture(t);
  const first = await f.api("/api/workbench/open-application", { appType: "text-editor" });
  const other = await f.api("/api/workbench/open-application", { appType: "text-editor" });
  assert.notEqual(first.taskId, other.taskId);
  const firstTab = first.tabs.find((tab) => tab.appInstanceId === first.appInstance.appInstanceId);
  const otherTab = other.tabs.find((tab) => tab.appInstanceId === other.appInstance.appInstanceId);
  assert.notEqual(firstTab.workspaceRoot, otherTab.workspaceRoot);
  assert.equal(firstTab.accessTaskId, first.taskId);
  assert.equal(firstTab.project, null);
  assert.equal(firstTab.standalone, true);
  assert.ok(firstTab.workspaceRoot.startsWith(join(await realpath(f.root), "temporary-workspaces")));
  assert.notEqual(firstTab.workspaceRoot, f.workspaceRoot);
  const created = await f.api(`/api/workbench/instances/${first.appInstance.appInstanceId}/resources`, {
    kind: "text/plain",
    title: "copy.txt",
    initialContent: "first\n"
  });
  const resourceId = created.resource.resourceId;
  assert.equal(created.resource.project, null);
  const task = await f.api("/api/tasks", { taskId: "temporary-chat", goal: "处理文件", projectId: null });
  const otherTask = await f.api("/api/tasks", { taskId: "other-chat", goal: "隔离测试", temporary: true });
  assert.equal(task.projectId, null);
  assert.notEqual(task.temporaryWorkspaceRoot, otherTask.temporaryWorkspaceRoot);
  assert.equal(task.storageRoot, f.workspaceRoot);
  assert.equal(task.projectDirectory, task.temporaryWorkspaceRoot);
  const collaboration = await f.api("/api/tasks", {
    taskId: "editor-chat",
    goal: "编辑同一文档",
    projectId: null,
    temporaryWorkspaceRoot: firstTab.workspaceRoot
  });
  await f.api(
    "/api/workbench/load-instance",
    { taskId: collaboration.taskId, appInstanceId: first.appInstance.appInstanceId },
    200
  );
  const context = (await f.api(`/api/tasks/${collaboration.taskId}/active-app-context`)).context;
  assert.equal(context.resource.resourceId, resourceId);
  assert.equal(context.resource.project, null);
  const catalog = await f.api("/api/tasks");
  assert.deepEqual(catalog.projects, []);
  assert.equal(catalog.tasks.length, 3);
  assert.ok(catalog.tasks.every((entry) => entry.kind !== "workspace" && entry.projectId === null));
  assert.equal((await f.api(`/api/tasks/${other.taskId}/resources`)).resources.length, 0);
  const documentPath = new ResourceFiles(firstTab.workspaceRoot).absolutePath(created.resource);
  assert.equal(await readFile(documentPath, "utf8"), "first\n");
  await f.restart({ newPort: true });
  const tabs = (await f.api("/api/workbench/tabs")).tabs;
  const restored = tabs.find((tab) => tab.resourceId === resourceId);
  assert.equal(restored.workspaceRoot, firstTab.workspaceRoot);
  assert.equal(restored.accessTaskId, first.taskId);
  assert.equal(
    (await f.api(`/api/tasks/${collaboration.taskId}/active-app-context`)).context.resource.resourceId,
    resourceId
  );
  assert.deepEqual((await f.api("/api/tasks")).projects, []);
  const switchedRoot = join(f.root, "later-storage");
  await mkdir(switchedRoot);
  await f.api("/api/workspace/choose", { workspaceRoot: switchedRoot }, 200);
  assert.equal(
    (await f.api("/api/workbench/temporary-resources")).resources.find(
      (entry) => entry.resourceId === resourceId
    ).accessTaskId,
    first.taskId
  );
  assert.equal(
    (await f.api("/api/workbench/tabs")).tabs.find((entry) => entry.resourceId === resourceId).accessTaskId,
    first.taskId
  );
  await assert.rejects(access(join(switchedRoot, first.taskId, "task.json")), { code: "ENOENT" });
  const response = await fetch(f.base + "/api/workbench/tabs", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tabId: restored.tabId })
  });
  assert.ok(response.ok);
  assert.equal(await readFile(documentPath, "utf8"), "first\n");
  assert.equal(
    (await f.api(`/api/tasks/${collaboration.taskId}/resources/${resourceId}`)).snapshot.content,
    "first\n"
  );
  const retained = (await f.api("/api/workbench/temporary-resources")).resources.find(
    (entry) => entry.resourceId === resourceId
  );
  assert.equal(retained.accessTaskId, first.taskId);
  await f.api(`/api/tasks/${retained.accessTaskId}/resources/${resourceId}/open`, {}, 200);
  await f.api("/api/workbench/tabs", { kind: "application", resourceId }, 200);
  assert.ok((await f.api("/api/workbench/tabs")).tabs.some((entry) => entry.resourceId === resourceId));
  await access(join(f.workspaceRoot, first.taskId, "task.json"));
  await assert.rejects(access(join(firstTab.workspaceRoot, first.taskId, "task.json")), { code: "ENOENT" });
});

test("first exports never adopt identical existing files, including unrecorded saves after restart", async (t) => {
  const f = await fixture(t);
  const opened = await f.api("/api/workbench/open-application", { appType: "text-editor" });
  const created = await f.api(`/api/workbench/instances/${opened.appInstance.appInstanceId}/resources`, {
    kind: "text/plain",
    title: "original.txt",
    initialContent: "original\n"
  });
  const directory = join(f.root, "originals");
  await mkdir(directory);
  const original = join(directory, "original.txt");
  await writeFile(original, "original\n");
  const endpoint = `/api/tasks/${opened.taskId}/resources/${created.resource.resourceId}/save-copy`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const rejected = await f.api(endpoint, { directory, format: "text", revision: 0 }, 422);
    assert.equal(rejected.error.code, "invalid_operation");
  }
  // Exercise the actual exclusive file commit without ResourceStore's receipt,
  // as if the process stopped after linking but before metadata persistence.
  const interrupted = join(f.root, "interrupted-save");
  await mkdir(interrupted);
  await new ResourceFiles(f.root).saveCopy(interrupted, "original.txt", "original\n");
  await f.restart();
  await f.api(endpoint, { directory, format: "text", revision: 0 }, 422);
  await f.api(endpoint, { directory: interrupted, format: "text", revision: 0 }, 422);
  assert.equal(await readFile(join(interrupted, "original.txt"), "utf8"), "original\n");
  const edited = await f.api(
    `/api/tasks/${opened.taskId}/resources/${created.resource.resourceId}/operations`,
    {
      operationId: "edit-after-rejected-adoption",
      appType: "text-editor",
      operationType: "text.replace",
      baseRevision: 0,
      payload: { from: 0, to: 9, text: "changed\n" }
    },
    200
  );
  await f.api(endpoint, { directory, format: "text", revision: edited.resource.revision }, 422);
  const read = await f.api(`/api/tasks/${opened.taskId}/resources/${created.resource.resourceId}`);
  assert.equal(read.resource.savedCopies, undefined);
  assert.equal(await readFile(original, "utf8"), "original\n");
  assert.deepEqual(await readdir(directory), ["original.txt"]);
});

test("explicit exports retain managed history and references, repeat the same destination, and refuse external conflicts and symlinks", async (t) => {
  const f = await fixture(t);
  const opened = await f.api("/api/workbench/open-application", { appType: "text-editor" });
  const created = await f.api(`/api/workbench/instances/${opened.appInstance.appInstanceId}/resources`, {
    kind: "text/plain",
    title: "copy.txt",
    initialContent: "original\n"
  });
  const resourceId = created.resource.resourceId;
  const root = opened.tabs.find(
    (tab) => tab.appInstanceId === opened.appInstance.appInstanceId
  ).workspaceRoot;
  const originalPath = new ResourceFiles(root).absolutePath(created.resource);
  const directory = join(f.root, "export");
  await mkdir(directory);
  const endpoint = `/api/tasks/${opened.taskId}/resources/${resourceId}/save-copy`;
  const first = await f.api(endpoint, { directory, format: "text", revision: 0 }, 200);
  assert.equal(await readFile(first.path, "utf8"), "original\n");
  const second = await f.api(endpoint, { directory, format: "text", revision: 0 }, 200);
  assert.equal(second.path, first.path);
  assert.equal(second.resource.savedCopies.length, 1);
  const operation = await f.api(
    `/api/tasks/${opened.taskId}/resources/${resourceId}/operations`,
    {
      operationId: "edit-copy",
      appType: "text-editor",
      operationType: "text.replace",
      baseRevision: 0,
      payload: { from: 0, to: 9, text: "edited\n" }
    },
    200
  );
  const next = await f.api(
    endpoint,
    { directory, format: "text", revision: operation.resource.revision },
    200
  );
  assert.equal(next.path, first.path);
  assert.equal(await readFile(next.path, "utf8"), "edited\n");
  assert.equal((await readdir(directory)).length, 1);
  await writeFile(next.path, "external change");
  const conflict = await f.api(
    endpoint,
    { directory, format: "text", revision: operation.resource.revision },
    409
  );
  assert.equal(conflict.error.code, "source_file_conflict");
  assert.equal(await readFile(next.path, "utf8"), "external change");
  assert.equal(await readFile(originalPath, "utf8"), "edited\n");
  const target = join(f.root, "project");
  await mkdir(target);
  const { project } = await f.api("/api/projects", { projectName: "结果项目", projectDirectory: target });
  const saved = await f.api(
    endpoint,
    { projectId: project.projectId, format: "text", revision: operation.resource.revision },
    200
  );
  assert.equal(saved.resource.project.projectId, project.projectId);
  assert.equal(saved.resource.revision, operation.resource.revision);
  assert.equal(saved.resource.savedCopies.length, 2);
  assert.equal(await readFile(saved.path, "utf8"), "edited\n");
  const conversation = await f.api("/api/tasks", {
    taskId: "saved-project-collaboration",
    goal: "Collaborate on the saved temporary document",
    projectId: project.projectId
  });
  await f.api(
    "/api/workbench/load-instance",
    {
      taskId: conversation.taskId,
      appInstanceId: opened.appInstance.appInstanceId
    },
    200
  );
  assert.equal(conversation.projectId, project.projectId);
  const context = (await f.api(`/api/tasks/${conversation.taskId}/active-app-context`)).context;
  assert.equal(context.resource.resourceId, resourceId);
  assert.equal(context.resource.project.projectId, project.projectId);
  assert.equal((await f.api("/api/tasks")).projects.length, 1);
  assert.equal(await readFile(originalPath, "utf8"), "edited\n");
  assert.equal(
    (await f.api(`/api/tasks/${opened.taskId}/resources/${resourceId}/operations`)).operations.length,
    1
  );
  const unrelated = join(f.root, "unrelated");
  await mkdir(unrelated);
  await symlink(originalPath, join(unrelated, "copy.txt"));
  const rejected = await f.api(
    endpoint,
    { directory: unrelated, format: "text", revision: operation.resource.revision },
    400
  );
  assert.equal(rejected.error.code, "unsafe_path");
  await f.restart();
  const restored = await f.api(`/api/tasks/${opened.taskId}/resources/${resourceId}`);
  assert.equal(restored.resource.project.projectId, project.projectId);
  assert.equal(restored.snapshot.content, "edited\n");
  assert.equal(restored.resource.savedCopies.length, 2);
  assert.equal((await f.api("/api/tasks")).projects.length, 1);
  await f.api(
    "/api/tasks",
    { taskId: "bad", goal: "拒绝错误目录", projectId: null, temporaryWorkspaceRoot: target },
    400
  );
  await f.api("/api/tasks", { taskId: "bad-type", goal: "拒绝错误字段", temporary: "true" }, 400);
});
