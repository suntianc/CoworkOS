import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { startDashboard } from "./dashboard-fixture.mjs";
const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");

test("opening a shared instance loads it into another conversation without unloading its first conversation", async (t) => {
  const dashboard = await startDashboard();
  t.after(() => dashboard.stop());
  const store = new LocalWorkspaceStore(dashboard.workspaceRoot);
  await store.createTask("a", { goal: "第一份文档" });
  await store.createTask("b", { goal: "第二份文档" });
  const post = async (path, body) => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const documents = {};
  for (const taskId of ["a", "b"]) {
    const created = await post(`/api/tasks/${taskId}/resources`, {
      kind: "text/plain",
      title: `${taskId}.txt`,
      initialContent: taskId
    });
    assert.equal(created.status, 201);
    documents[taskId] = created.body.resource.resourceId;
    assert.equal(
      (
        await post("/api/workbench/tabs", {
          kind: "application",
          resourceId: documents[taskId],
          bindTo: taskId,
          activate: false
        })
      ).status,
      200
    );
  }
  const shared = await post("/api/workbench/tabs", {
    kind: "application",
    resourceId: documents.b,
    bindTo: "a",
    activate: false
  });
  assert.equal(shared.status, 200);
  const sharedTab = shared.body.tabs.find((tab) => tab.resourceId === documents.b);
  assert.deepEqual(sharedTab.loadedConversations.map((chat) => chat.taskId).sort(), ["a", "b"]);
  for (const taskId of ["a", "b"]) {
    const summary = await (await fetch(`${dashboard.base}/api/tasks/${taskId}/app-instances`)).json();
    assert.equal(summary.boundResourceId, documents.b);
    const context = await (await fetch(`${dashboard.base}/api/tasks/${taskId}/active-app-context`)).json();
    assert.equal(context.context.resource.resourceId, documents.b);
  }
  assert.equal((await post("/api/tasks/a/app-instances/unbind", {})).status, 200);
  assert.equal(
    (await (await fetch(`${dashboard.base}/api/tasks/a/active-app-context`)).json()).context,
    null
  );
  assert.equal(
    (await (await fetch(`${dashboard.base}/api/tasks/b/active-app-context`)).json()).context.resource
      .resourceId,
    documents.b
  );
});
