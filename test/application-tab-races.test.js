import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { ApplicationService } = await import("../dist/src/applications/application-service.js");
const { WorkbenchTabStore } = await import("../dist/src/applications/tab-store.js");
const { handleApplicationRequest } = await import("../dist/src/dashboard/application-routes.js");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-tab-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ApplicationService(root);
  const taskId = await service.ensureStandaloneWorkspace();
  const tabStorePath = join(root, "tabs.json");
  const tabs = new WorkbenchTabStore(tabStorePath);
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let first = true;
  const context = {
    tabStorePath,
    defaultWorkspaceRoot: root,
    locate: async (id) => {
      if (id !== taskId) throw new Error("missing task");
      return { workspaceRoot: root };
    },
    locateResource: async () => ({ workspaceRoot: root }),
    referencingTasks: async () => {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return [taskId];
    },
    mcp: {
      statuses: async () => [],
      ensure: async () => ({ state: "running", toolNames: [] })
    }
  };
  let result;
  const headers = new Map();
  const response = {
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    writeHead(status) {
      assert.equal(status, 200);
    },
    end(body) {
      result = JSON.parse(body);
    }
  };
  return {
    service,
    taskId,
    tabs,
    started,
    release,
    poll: () =>
      handleApplicationRequest(
        { method: "GET" },
        response,
        new URL("http://localhost/api/workbench/tabs"),
        context
      ),
    result: () => result
  };
}

for (const [appType, kind, title] of [["text-editor", "text/plain", "notes.txt"]]) {
  for (const legacyTab of [false, true]) {
    test(`${appType}: a concurrent poll preserves the created document (legacy tab: ${legacyTab})`, async (t) => {
      const f = await fixture(t);
      const instance = await f.service.openApplication({ taskId: f.taskId, appType });
      const windowId = `window:${instance.appInstanceId}`;
      await f.tabs.open({
        kind: "application",
        ...(legacyTab ? { taskId: f.taskId } : {}),
        appInstanceId: instance.appInstanceId
      });
      const polling = f.poll();
      await f.started; // The route has taken its empty-window snapshot.
      const created = await f.service.createInApplication({
        taskId: f.taskId,
        appInstanceId: instance.appInstanceId,
        kind,
        title,
        actor: { type: "user", id: "local" }
      });
      f.release();
      await polling;
      const resourceTabId = windowId;
      assert.equal(f.result().tabs.length, 1);
      assert.equal(f.result().tabs[0].hasResource, true);
      assert.equal(f.result().activeTabId, resourceTabId);
      const persisted = await f.tabs.read();
      assert.deepEqual(
        persisted.tabs.map((tab) => tab.tabId),
        [resourceTabId]
      );
      assert.equal(persisted.activeTabId, resourceTabId);
    });
  }
}

test("pruning a missing conversation never removes a tab opened after the poll snapshot", async (t) => {
  const f = await fixture(t);
  await f.tabs.open({ kind: "conversation", taskId: "deleted" });
  const polling = f.poll();
  await f.started;
  const instance = await f.service.openApplication({ taskId: f.taskId, appType: "text-editor" });
  await f.tabs.open({ kind: "application", taskId: f.taskId, appInstanceId: instance.appInstanceId });
  f.release();
  await polling;
  const windowId = `window:${instance.appInstanceId}`;
  assert.deepEqual(f.result().tabs, [], "this response describes its original snapshot");
  assert.equal(f.result().activeTabId, windowId);
  assert.deepEqual(
    (await f.tabs.read()).tabs.map((tab) => tab.tabId),
    [windowId]
  );
});
