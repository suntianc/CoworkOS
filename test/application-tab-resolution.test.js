import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { ApplicationService } = await import("../dist/src/applications/application-service.js");
const { WorkbenchTabStore } = await import("../dist/src/applications/tab-store.js");
const { handleApplicationRequest } = await import("../dist/src/dashboard/application-routes.js");
const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");

test("a full tab strip discovers workspace and project catalogs once per request and refreshes on the next", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-tab-resolution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const defaultWorkspaceRoot = join(root, "storage");
  const workspaceRoot = join(root, "documents");
  await Promise.all([mkdir(defaultWorkspaceRoot), mkdir(workspaceRoot)]);
  const service = new ApplicationService(workspaceRoot, undefined, defaultWorkspaceRoot);
  const tabStorePath = join(root, "tabs.json");
  const tabs = new WorkbenchTabStore(tabStorePath);
  const instances = [];
  for (let index = 0; index < 40; index++) {
    const instance = await service.instances.createInstance({
      appType: "text-editor",
      title: `历史文档 ${index}`
    });
    instances.push(instance);
    await tabs.open({ kind: "application", appInstanceId: instance.appInstanceId });
  }
  let discoveries = 0;
  let projectDiscoveries = 0;
  const context = {
    tabStorePath,
    defaultWorkspaceRoot,
    locate: async () => {
      throw new Error("no conversations");
    },
    referencingTasks: async () => [],
    workspaceRoots: async () => {
      discoveries++;
      return [defaultWorkspaceRoot, workspaceRoot];
    },
    projectForWorkspace: async () => {
      projectDiscoveries++;
      return null;
    },
    mcp: {
      statuses: async () => [],
      ensure: async () => ({ state: "running", toolNames: [] })
    }
  };
  async function poll() {
    let result;
    await handleApplicationRequest(
      { method: "GET" },
      {
        setHeader() {},
        getHeader() {},
        writeHead(status) {
          assert.equal(status, 200);
        },
        end(body) {
          result = JSON.parse(body);
        }
      },
      new URL("http://localhost/api/workbench/tabs"),
      context
    );
    return result;
  }

  const first = await poll();
  assert.equal(first.tabs.length, 40);
  assert.equal(discoveries, 1, "40 windows share one global workspace discovery");
  assert.equal(projectDiscoveries, 1, "windows in the same root share one project discovery");

  await service.instances.updateInstance(instances[0].appInstanceId, { title: "最新标题" });
  await service.instances.updateInstance(instances.at(-1).appInstanceId, { status: "closed" });
  const next = await poll();
  assert.equal(next.tabs.length, 39);
  assert.equal(next.tabs[0].title, "最新标题");
  assert.equal(discoveries, 2, "the next request discovers current workspaces");
  assert.equal(projectDiscoveries, 2, "project assignments are not cached across requests");
});

for (const [name, manifest, expectedStatus] of [
  ["missing", undefined, 200],
  ["empty", {}, 200],
  ["loaded window", { version: 3, loadedInstanceId: "old-window" }, 200],
  ["active window", { version: 1, activeInstanceId: "old-window" }, 200],
  ["window history", { version: 3, instanceHistory: ["", "../invalid", "old-window"] }, 200],
  ["bound resource", { version: 1, boundResourceId: "old-resource" }, 400]
]) {
  test(`conversation tabs retain ${name} manifest behavior with an invalid legacy window file`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-tab-legacy-discovery-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const storage = join(root, "storage");
    await new LocalWorkspaceStore(storage).createTask("task", { goal: "Conversation" });
    const legacyDirectory = join(storage, "task", "applications", "instances");
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(join(legacyDirectory, "empty-window.json"), JSON.stringify({ appInstanceId: "" }));
    if (manifest)
      await writeFile(join(storage, "task", "applications", "manifest.json"), JSON.stringify(manifest));
    const tabStorePath = join(root, "tabs.json");
    await new WorkbenchTabStore(tabStorePath).open({ kind: "conversation", taskId: "task" });
    let status;
    let result;
    await handleApplicationRequest(
      { method: "GET" },
      {
        setHeader() {},
        getHeader() {},
        writeHead(value) {
          status = value;
        },
        end(body) {
          result = JSON.parse(body);
        }
      },
      new URL("http://localhost/api/workbench/tabs"),
      {
        tabStorePath,
        defaultWorkspaceRoot: storage,
        locate: async () => ({ workspaceRoot: storage }),
        referencingTasks: async () => ["task"],
        workspaceRoots: async () => [storage],
        mcp: {
          statuses: async () => [],
          ensure: async () => {
            throw new Error("a read must not start MCP");
          }
        }
      }
    );
    assert.equal(status, expectedStatus, JSON.stringify(result));
    if (expectedStatus === 200) {
      assert.equal(result.tabs.length, 1);
      assert.equal(result.tabs[0].title, "Conversation");
    } else assert.equal(result.error.code, "unsafe_path");
  });
}
