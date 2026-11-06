import "./application-fixture.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const { ApplicationService } = await import("../dist/src/applications/application-service.js");
const { InstanceStore } = await import("../dist/src/applications/instance-store.js");
import { startDashboard } from "./dashboard-fixture.mjs";
const actor = { type: "user", id: "local" };

test("one empty instance is loaded by two conversations and keeps its identity when filled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-independent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ApplicationService(root);
  const instance = await service.openApplication({
    taskId: "workspace",
    appType: "text-editor",
    fresh: true
  });
  assert.equal(instance.taskId, undefined);
  await service.loadInstance("a", instance.appInstanceId);
  await service.loadInstance("b", instance.appInstanceId);
  for (const taskId of ["a", "b"]) {
    const summary = await service.taskSummary(taskId);
    assert.equal(summary.loadedInstanceId, instance.appInstanceId);
    assert.equal(summary.unbound, false);
    assert.match(await service.emptyApplicationContext(taskId), /create_resource/);
  }
  const made = await service.createInApplication({
    taskId: "workspace",
    appInstanceId: instance.appInstanceId,
    kind: "text/markdown",
    title: "共享编辑.md",
    initialContent: "初稿",
    actor
  });
  assert.equal(made.appInstance.appInstanceId, instance.appInstanceId);
  assert.equal((await service.instances.listInstances()).length, 1);
  for (const taskId of ["a", "b"]) {
    const context = await service.activeContext({ taskId, agentId: "main" });
    assert.equal(context.appInstanceId, instance.appInstanceId);
    assert.equal(context.resource.resourceId, made.resource.resourceId);
  }
  await service.loadInstance("a", undefined);
  await service.openResource({ taskId: "a", resourceId: made.resource.resourceId });
  assert.equal((await service.taskSummary("a")).loadedInstanceId, undefined);
  assert.equal((await service.taskSummary("b")).loadedInstanceId, instance.appInstanceId);
  assert.equal((await service.instances.readInstance(instance.appInstanceId)).status, "open");
  const restarted = new ApplicationService(root);
  assert.equal((await restarted.taskSummary("b")).loadedInstanceId, instance.appInstanceId);
  assert.equal((await restarted.taskSummary("a")).loadedInstanceId, undefined);
});

test("legacy per-task duplicates migrate once, preserving aliases, latest UI state, empty apps and original files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-instance-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = [];
  for (const [taskId, id, resourceIds, updatedAt, uiState] of [
    ["a", "app_a", ["res_shared"], "2026-01-01", { zoom: 1 }],
    ["b", "app_b", ["res_shared"], "2026-01-02", { zoom: 2 }],
    ["c", "app_c", [], "2026-01-03", { tab: "notes" }]
  ]) {
    const directory = join(root, taskId, "applications");
    await mkdir(join(directory, "instances"), { recursive: true });
    const raw = JSON.stringify({
      appInstanceId: id,
      taskId,
      appType: "text-editor",
      resourceIds,
      title: "旧文档",
      status: "open",
      createdAt: updatedAt,
      updatedAt,
      uiState
    });
    const path = join(directory, "instances", `${id}.json`);
    await writeFile(path, raw);
    original.push([path, raw]);
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        version: taskId === "c" ? 1 : 2,
        ...(taskId === "c" ? { activeInstanceId: id } : { boundResourceId: "res_shared" }),
        tabOrder: [id]
      })
    );
  }
  const store = new InstanceStore(root);
  const [one, two] = await Promise.all([store.listInstances(), new InstanceStore(root).listInstances()]);
  assert.equal(one.length, 2);
  assert.deepEqual(one, two);
  const canonical = await store.readInstance("app_b");
  assert.equal(canonical.appInstanceId, "app_a");
  assert.equal(canonical.taskId, undefined);
  assert.deepEqual(canonical.uiState, { zoom: 2 });
  assert.equal((await store.readManifest("a")).loadedInstanceId, "app_a");
  assert.equal((await store.readManifest("b")).loadedInstanceId, "app_a");
  assert.equal((await store.readManifest("c")).loadedInstanceId, "app_c");
  await store.setLoadedInstance("a", undefined);
  assert.equal((await new InstanceStore(root).readManifest("a")).loadedInstanceId, undefined);
  assert.equal((await store.readManifest("b")).loadedInstanceId, "app_a");
  for (const [path, raw] of original) assert.equal(await readFile(path, "utf8"), raw);
});

test("HTTP loading never moves or copies an instance; tabs keep their identity and closing a view does not unload it", async (t) => {
  const dashboard = await startDashboard();
  t.after(() => dashboard.stop());
  const request = async (path, body, method = "POST") => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  for (const taskId of ["a", "b"]) await request("/api/tasks", { taskId, goal: taskId });
  const opened = await request("/api/workbench/open-application", { appType: "text-editor" });
  const id = opened.appInstance.appInstanceId;
  const tabId = opened.tabs.find((tab) => tab.appInstanceId === id).tabId;
  for (const taskId of ["a", "b"]) {
    const loaded = await request("/api/workbench/load-instance", { taskId, appInstanceId: id });
    assert.equal(loaded.appInstance.appInstanceId, id);
    assert.equal(loaded.appInstance.taskId, undefined);
  }
  let tabs = await request("/api/workbench/tabs", undefined, "GET");
  assert.equal(tabs.tabs.filter((tab) => tab.kind === "application").length, 1);
  assert.deepEqual(tabs.tabs[0].loadedConversations.map((entry) => entry.taskId).sort(), ["a", "b"]);
  const made = await request(`/api/workbench/instances/${id}/resources`, {
    kind: "text/markdown",
    title: "HTTP.md",
    initialContent: "正文"
  });
  tabs = await request("/api/workbench/tabs", undefined, "GET");
  assert.equal(tabs.tabs[0].tabId, tabId);
  assert.equal(tabs.tabs[0].appInstanceId, id);
  assert.equal(tabs.tabs[0].resourceId, made.resource.resourceId);
  await request("/api/workbench/load-instance", { taskId: "a" });
  await request("/api/workbench/tabs", { tabId }, "PATCH");
  assert.equal((await request("/api/tasks/a", undefined, "GET")).applications.loadedInstanceId, undefined);
  await request("/api/workbench/tabs", { tabId }, "DELETE");
  assert.equal((await request("/api/tasks/b", undefined, "GET")).applications.loadedInstanceId, id);
  await request("/api/workbench/tabs", { kind: "application", appInstanceId: id });
  tabs = await request("/api/workbench/tabs", undefined, "GET");
  assert.equal(tabs.tabs[0].tabId, tabId);
  assert.deepEqual(
    tabs.tabs[0].loadedConversations.map((entry) => entry.taskId),
    ["b"]
  );
});

test("concurrent creation cannot replace a shared instance's first document", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-instance-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ApplicationService(root);
  const otherProcess = new ApplicationService(root);
  const instance = await service.openApplication({ taskId: "workspace", appType: "text-editor" });
  await service.loadInstance("a", instance.appInstanceId);
  const input = {
    taskId: "workspace",
    appInstanceId: instance.appInstanceId,
    kind: "text/markdown",
    title: "one.md",
    actor
  };
  const results = await Promise.allSettled([
    service.createInApplication(input),
    otherProcess.createInApplication({ ...input, title: "two.md" }),
    otherProcess.loadInstance("b", instance.appInstanceId)
  ]);
  assert.equal(results.slice(0, 2).filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(results[2].status, "fulfilled");
  const held = (await service.instances.readInstance(instance.appInstanceId)).resourceIds;
  assert.equal(held.length, 1);
  for (const task of ["a", "b"])
    assert.equal(
      (await service.activeContext({ taskId: task, agentId: "main" })).resource.resourceId,
      held[0]
    );
  await service.loadInstance("a", undefined);
  assert.deepEqual((await new InstanceStore(root).readManifest("a")).instanceHistory, [
    instance.appInstanceId
  ]);
});

test("independent editor access resolves the resource workspace instead of another workspace's hidden task", async (t) => {
  const dashboard = await startDashboard();
  t.after(() => dashboard.stop());
  const other = await mkdtemp(join(tmpdir(), "atria-other-workspace-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  const post = async (path, data) => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data)
    });
    assert.ok(response.ok, `${path}: ${await response.clone().text()}`);
    return response.json();
  };
  await post("/api/workbench/open-application", { appType: "text-editor" });
  await post("/api/tasks", { taskId: "other", goal: "另一工作区", workspaceRoot: other });
  const made = await post("/api/tasks/other/resources", {
    kind: "text/markdown",
    title: "other.md",
    initialContent: "在另一工作区"
  });
  const holdingPath = join(other, "workspace/applications/mapping.json");
  const holdingBefore = await readFile(holdingPath, "utf8");
  const response = await fetch(`${dashboard.base}/api/tasks/workspace/resources/${made.resource.resourceId}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).snapshot.content, "在另一工作区");
  assert.equal(await readFile(holdingPath, "utf8"), holdingBefore);
  await post(`/api/tasks/workspace/resources/${made.resource.resourceId}/operations`, {
    operationId: "independent-edit",
    appType: "text-editor",
    operationType: "text.insert",
    baseRevision: 0,
    payload: { at: 0, text: "编辑：" }
  });
  const read = await fetch(`${dashboard.base}/api/tasks/other/resources/${made.resource.resourceId}`).then(
    (r) => r.json()
  );
  assert.equal(read.snapshot.content, "编辑：在另一工作区");
  // Editor access does not grant an unrelated conversation a resource reference.
  await post("/api/tasks", { taskId: "unrelated", goal: "没有文档引用的会话" });
  assert.equal(
    (await fetch(`${dashboard.base}/api/tasks/unrelated/resources/${made.resource.resourceId}`)).status,
    404
  );
  const legacyMapping = JSON.parse(
    await readFile(join(other, "workspace/applications/mapping.json"), "utf8")
  );
  assert.equal(
    legacyMapping.resources.find((entry) => entry.resourceId === made.resource.resourceId).workspaceRoot,
    undefined
  );
  await dashboard.restart();
  const restored = await fetch(`${dashboard.base}/api/tasks/workspace/resources/${made.resource.resourceId}`);
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).snapshot.content, "编辑：在另一工作区");
});

test("standalone instances and editor collection access honor a workspace with no conversations", async (t) => {
  const dashboard = await startDashboard();
  t.after(() => dashboard.stop());
  const other = await mkdtemp(join(tmpdir(), "atria-empty-workspace-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  const post = async (path, data) => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data)
    });
    assert.ok(response.ok, `${path}: ${await response.clone().text()}`);
    return response.json();
  };
  const get = async (path) => fetch(`${dashboard.base}${path}`).then((r) => r.json());
  await post("/api/workbench/open-application", { appType: "text-editor" });
  const opened = await post("/api/workbench/open-application", {
    appType: "text-editor",
    workspaceRoot: other
  });
  const id = opened.appInstance.appInstanceId;
  const resolved = opened.tabs.find((tab) => tab.appInstanceId === id);
  assert.equal(resolved.workspaceRoot, other);
  assert.deepEqual((await get("/api/tasks")).tasks, []);
  const resource = await post(`/api/tasks/workspace/resources?workspaceRoot=${encodeURIComponent(other)}`, {
    kind: "text/markdown",
    title: "other.md",
    initialContent: "other workspace"
  });
  const list = await get(`/api/tasks/workspace/resources?workspaceRoot=${encodeURIComponent(other)}`);
  assert.deepEqual(
    list.resources.map((r) => r.resourceId),
    [resource.resource.resourceId]
  );
  const main = await get(
    `/api/tasks/workspace/resources?workspaceRoot=${encodeURIComponent(dashboard.workspaceRoot)}`
  );
  assert.equal(main.resources.length, 0);
  // New holding metadata belongs to Task storage, rather than inventing a Task
  // directory in an otherwise empty application resource workspace.
  await assert.rejects(access(join(other, "workspace/task.json")), { code: "ENOENT" });
  const mainResource = await post("/api/tasks/workspace/resources", {
    kind: "text/markdown",
    title: "main.md",
    initialContent: "main workspace"
  });
  // Represent an existing root-local holding Task without moving its document.
  const legacy = await new ApplicationService(other).createResource({
    taskId: "workspace",
    kind: "text/markdown",
    title: "legacy.md",
    initialContent: "legacy workspace",
    actor
  });
  const legacyMappingPath = join(other, "workspace/applications/mapping.json");
  const legacyMappingBefore = await readFile(legacyMappingPath, "utf8");
  // Opening this existing document adds central editor access as well. The
  // collection still shows it once and leaves its old holding reference intact.
  await post("/api/workbench/tabs", {
    kind: "application",
    appInstanceId: legacy.appInstance.appInstanceId
  });
  const inOther = await get(`/api/tasks/workspace/resources?workspaceRoot=${encodeURIComponent(other)}`);
  assert.deepEqual(
    inOther.resources.map((entry) => entry.resourceId).sort(),
    [resource.resource.resourceId, legacy.resource.resourceId].sort()
  );
  assert.deepEqual(
    (
      await get(`/api/tasks/workspace/resources?workspaceRoot=${encodeURIComponent(dashboard.workspaceRoot)}`)
    ).resources.map((entry) => entry.resourceId),
    [mainResource.resource.resourceId]
  );
  assert.equal(
    (await get(`/api/tasks/workspace/resources/${legacy.resource.resourceId}`)).snapshot.content,
    "legacy workspace"
  );
  assert.equal(await readFile(legacyMappingPath, "utf8"), legacyMappingBefore);
  await dashboard.restart();
  assert.deepEqual(
    (await get(`/api/tasks/workspace/resources?workspaceRoot=${encodeURIComponent(other)}`)).resources
      .map((entry) => entry.resourceId)
      .sort(),
    [resource.resource.resourceId, legacy.resource.resourceId].sort()
  );
  assert.deepEqual(
    (
      await get(`/api/tasks/workspace/resources?workspaceRoot=${encodeURIComponent(dashboard.workspaceRoot)}`)
    ).resources.map((entry) => entry.resourceId),
    [mainResource.resource.resourceId]
  );
  await post(`/api/workbench/instances/${id}/resources`, { kind: "text/markdown", title: "instance.md" });
  assert.ok(
    (await get("/api/workbench/tabs")).tabs.some(
      (tab) => tab.appInstanceId === id && tab.workspaceRoot === other
    )
  );
});

test("independent resource access rejects absent and wrong-root holding references without creating metadata", async (t) => {
  const dashboard = await startDashboard();
  t.after(() => dashboard.stop());
  const other = await mkdtemp(join(tmpdir(), "atria-unreferenced-editor-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  const registered = await fetch(`${dashboard.base}/api/workbench/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceRoot: other })
  });
  assert.equal(registered.status, 200);
  const created = await new ApplicationService(other).resources.createResource({
    appType: "text-editor",
    kind: "text/plain",
    title: "unreferenced.txt",
    initialContent: "No holding Task has access.\n",
    actor
  });
  const resourceId = created.resource.resourceId;
  const read = () => fetch(`${dashboard.base}/api/tasks/workspace/resources/${resourceId}`);
  const missing = await read();
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "resource_not_found");
  await assert.rejects(access(join(other, "workspace")), { code: "ENOENT" });
  await assert.rejects(access(join(dashboard.workspaceRoot, "workspace")), { code: "ENOENT" });

  const mappingPath = join(dashboard.workspaceRoot, "workspace/applications/mapping.json");
  const mapping = JSON.stringify({
    version: 1,
    resources: [
      { resourceId, appType: "text-editor", addedAt: "2026-01-01", workspaceRoot: dashboard.workspaceRoot }
    ]
  });
  await mkdir(join(dashboard.workspaceRoot, "workspace/applications"), { recursive: true });
  await writeFile(mappingPath, mapping);
  const wrongRoot = await read();
  assert.equal(wrongRoot.status, 404);
  assert.equal((await wrongRoot.json()).error.code, "resource_not_found");
  assert.equal(await readFile(mappingPath, "utf8"), mapping);
  await assert.rejects(access(join(other, "workspace")), { code: "ENOENT" });
});
