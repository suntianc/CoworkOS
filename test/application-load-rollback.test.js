import "./application-fixture.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const { ApplicationService } = await import("../dist/src/applications/application-service.js");
const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");

for (const separateRoots of [false, true])
  test(`rollback reads fixed-load data and restores independent switching/unloading (${separateRoots ? "separate" : "shared"} storage roots)`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-load-rollback-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const tasks = join(root, "tasks");
    const resources = separateRoots ? join(root, "resources") : tasks;
    await mkdir(tasks);
    if (separateRoots) await mkdir(resources);
    const workspace = new LocalWorkspaceStore(tasks);
    for (const taskId of ["a", "b"]) await workspace.createTask(taskId, { goal: taskId });
    let service = new ApplicationService(resources, undefined, tasks);
    const actor = { type: "user", id: "local" };
    const first = await service.createResource({
      taskId: "a",
      kind: "text/plain",
      title: "saved.txt",
      initialContent: "Document after update",
      actor
    });
    await service.bindResource("a", first.resource.resourceId);
    await service.applyOperation({
      taskId: "a",
      resourceId: first.resource.resourceId,
      appType: "text-editor",
      operationId: "human-edit",
      operationType: "text.insert",
      baseRevision: 0,
      payload: { at: 0, text: "Human edit\n" },
      actor
    });
    const second = await service.createResource({
      taskId: "a",
      kind: "text/plain",
      title: "second.txt",
      initialContent: "Second document",
      actor
    });

    // Actual persisted shapes produced by PR14, including data written after migration.
    const indexPath = join(resources, "applications", "instances", "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    index.version = 3;
    for (const instance of index.instances) {
      instance.projectId = "project";
      if (instance.appInstanceId === first.appInstance.appInstanceId) instance.loadedByTaskId = "a";
    }
    await writeFile(indexPath, JSON.stringify(index));
    const manifestPath = join(tasks, "a", "applications", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = 4;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const file = join(resources, "applications", "text-editor", "files", "saved.txt");
    const bytes = await readFile(file);

    service = new ApplicationService(resources, undefined, tasks);
    assert.equal((await service.activeContext({ taskId: "a", agentId: "main" })).resource.revision, 1);
    assert.equal((await service.taskSummary("a")).loadedInstanceId, first.appInstance.appInstanceId);
    await service.loadInstance("b", first.appInstance.appInstanceId);
    assert.equal((await service.taskSummary("a")).loadedInstanceId, first.appInstance.appInstanceId);
    await service.loadInstance("a", second.appInstance.appInstanceId);
    assert.equal(
      (await service.activeContext({ taskId: "a", agentId: "main" })).resource.resourceId,
      second.resource.resourceId
    );
    assert.equal(
      (await service.activeContext({ taskId: "b", agentId: "main" })).resource.resourceId,
      first.resource.resourceId
    );
    await service.loadInstance("a", undefined);
    service = new ApplicationService(resources, undefined, tasks);
    assert.equal(await service.activeContext({ taskId: "a", agentId: "main" }), undefined);
    assert.equal((await service.taskSummary("b")).loadedInstanceId, first.appInstance.appInstanceId);
    const retained = await service.readResource("b", first.resource.resourceId);
    assert.equal(retained.resource.revision, 1);
    assert.equal(retained.snapshot.content, "Human edit\nDocument after update");
    assert.deepEqual(await readFile(file), bytes);
    assert.equal((await service.instances.listInstances()).length, 2);
  });
