import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDashboard } from "./dashboard-fixture.mjs";
const { ApplicationService } = await import("../dist/src/applications/application-service.js");

const actor = { type: "agent", id: "live-fixture" };

test("revision feed exposes committed standalone operations from another process without a run or snapshot", async (t) => {
  const dashboard = await startDashboard();
  t.after(() => dashboard.stop());
  const request = async (path, body) => {
    const response = await fetch(
      `${dashboard.base}${path}`,
      body && {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }
    );
    assert.ok(response.ok, `${path}: ${response.status}`);
    return response.json();
  };
  const service = new ApplicationService(dashboard.workspaceRoot);
  const opened = await request("/api/workbench/open-application", {
    appType: "text-editor",
    workspaceRoot: dashboard.workspaceRoot
  });
  const appInstanceId = opened.appInstance.appInstanceId;
  assert.deepEqual((await request("/api/workbench/revisions")).instances, [
    {
      appInstanceId,
      appType: "text-editor",
      title: opened.appInstance.title
    }
  ]);
  // The direct service uses the same files as Pi/MCP but has no Dashboard event sink.
  const { resource } = await service.createInApplication({
    taskId: opened.taskId,
    appInstanceId,
    kind: "text/plain",
    title: "实时.txt",
    actor
  });
  const before = (await request("/api/workbench/revisions")).instances[0];
  assert.equal(before.resourceId, resource.resourceId);
  assert.equal(before.revision, 0);
  assert.equal(before.snapshot, undefined);
  const committed = await service.applyOperation({
    taskId: opened.taskId,
    appInstanceId,
    resourceId: resource.resourceId,
    appType: "text-editor",
    operationId: "stage-one",
    operationType: "text.insert",
    baseRevision: 0,
    payload: { at: 0, text: "第一阶段" },
    actor
  });
  const after = (await request("/api/workbench/revisions")).instances[0];
  assert.equal(after.revision, 1);
  assert.equal(after.contentVersion, committed.resource.contentVersion);
  assert.equal((await request("/api/tasks")).tasks.length, 0);

  // Do not announce a metadata revision while its durable transaction is unfinished.
  const transactionDir = join(dashboard.workspaceRoot, ".runtime", "applications", "transactions");
  await mkdir(transactionDir, { recursive: true });
  const marker = join(transactionDir, `${resource.resourceId}.json`);
  await writeFile(marker, JSON.stringify({ fixture: "write in progress" }));
  assert.deepEqual((await request("/api/workbench/revisions")).instances, []);
  await unlink(marker);
  assert.equal((await request("/api/workbench/revisions")).instances[0].revision, 1);
});

test("revision feed includes plain text and Markdown resources without loading document bodies", async (t) => {
  const dashboard = await startDashboard();
  t.after(() => dashboard.stop());
  const service = new ApplicationService(dashboard.workspaceRoot);
  const expected = [];
  for (const [appType, kind] of [
    ["text-editor", "text/plain"],
    ["text-editor", "text/markdown"]
  ]) {
    const response = await fetch(`${dashboard.base}/api/workbench/open-application`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appType, workspaceRoot: dashboard.workspaceRoot })
    });
    assert.equal(response.status, 201);
    const opened = await response.json();
    const created = await service.createInApplication({
      taskId: opened.taskId,
      appInstanceId: opened.appInstance.appInstanceId,
      kind,
      title: `实时-${kind}`,
      actor
    });
    expected.push(created.resource.resourceId);
  }
  const feed = await (await fetch(`${dashboard.base}/api/workbench/revisions`)).json();
  assert.deepEqual(
    feed.instances.map((instance) => instance.resourceId),
    expected
  );
  assert.ok(feed.instances.every((instance) => instance.revision === 0 && !instance.snapshot));
});
