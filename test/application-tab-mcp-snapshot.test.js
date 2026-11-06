import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
const { ApplicationService } = await import("../dist/src/applications/application-service.js");
const { McpSupervisor } = await import("../dist/src/applications/mcp-supervisor.js");
const { WorkbenchTabStore } = await import("../dist/src/applications/tab-store.js");
const { handleApplicationRequest } = await import("../dist/src/dashboard/application-routes.js");

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function fixture(t, mcp) {
  const root = await mkdtemp(join(tmpdir(), "atria-tab-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ApplicationService(root);
  const tabStorePath = join(root, "tabs.json");
  const tabs = new WorkbenchTabStore(tabStorePath);
  const instances = [];
  for (const title of ["打开的窗口", "另一个窗口"]) {
    const instance = await service.instances.createInstance({ appType: "text-editor", title });
    instances.push(instance);
    await tabs.open({ kind: "application", appInstanceId: instance.appInstanceId });
  }
  const context = {
    tabStorePath,
    defaultWorkspaceRoot: root,
    locate: async () => {
      throw new Error("no conversations");
    },
    referencingTasks: async () => [],
    workspaceRoots: async () => [root],
    mcp
  };
  async function request(method = "GET", body) {
    let result;
    const input = Readable.from(body ? [JSON.stringify(body)] : []);
    input.method = method;
    input.headers = { "content-type": "application/json" };
    await handleApplicationRequest(
      input,
      {
        setHeader() {},
        getHeader() {},
        writeHead(status) {
          assert.equal(status, 200);
        },
        end(text) {
          result = JSON.parse(text);
        }
      },
      new URL("http://localhost/api/workbench/tabs"),
      context
    );
    return result;
  }
  return { request, instances };
}

test(
  "tab reads return the last MCP status without starting or retrying a server",
  { timeout: 10000 },
  async (t) => {
    const started = deferred();
    const release = deferred();
    let starts = 0;
    let snapshots = 0;
    let failedConsumer;
    const { request, instances } = await fixture(t, {
      async ensure() {
        starts++;
        started.resolve();
        await release.promise;
        return { state: "failed", toolNames: [], error: "unavailable" };
      },
      async statuses() {
        snapshots++;
        return [{ key: failedConsumer, state: "failed", toolNames: [], error: "unavailable" }];
      }
    });
    failedConsumer = `instance:${instances[0].appInstanceId}`;
    const pending = request();
    let outcome;
    try {
      outcome = await Promise.race([
        pending.then(() => "returned"),
        started.promise.then(() => "waited for MCP")
      ]);
    } finally {
      release.resolve();
      await pending;
    }
    assert.equal(outcome, "returned", "opening the loading menu must not start MCP");
    assert.equal((await pending).tabs[0].mcp.state, "failed");
    await request();
    assert.equal(starts, 0, "repeated polling never retries a failed server");
    assert.equal(snapshots, 2, "each list reads one status snapshot, regardless of tab count");
  }
);

test("opening a tab waits for only that window's MCP server", { timeout: 10000 }, async (t) => {
  const started = deferred();
  const release = deferred();
  const consumers = [];
  const { request, instances } = await fixture(t, {
    async ensure({ consumer }) {
      consumers.push(consumer);
      started.resolve();
      await release.promise;
      return { state: "running", toolNames: ["edit"] };
    },
    async statuses() {
      return [];
    }
  });
  let completed = false;
  const pending = request("POST", { kind: "application", appInstanceId: instances[0].appInstanceId }).then(
    (result) => {
      completed = true;
      return result;
    }
  );
  try {
    await started.promise;
    assert.equal(completed, false, "the write keeps its tools-ready response contract");
    assert.deepEqual(consumers, [`instance:${instances[0].appInstanceId}`]);
  } finally {
    release.resolve();
    await pending;
  }
  assert.deepEqual(consumers, [`instance:${instances[0].appInstanceId}`], "other tabs are untouched");
});

test("MCP status snapshots do not wait for a real server still starting", { timeout: 10000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-mcp-starting-"));
  const entered = join(root, "entered");
  const release = join(root, "release");
  const script = join(root, "server.mjs");
  const supervisor = new McpSupervisor(resolve("."), "http://127.0.0.1:1");
  t.after(async () => {
    await writeFile(release, "");
    await supervisor.stopAll();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(
    script,
    `
import { access, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
const [entered, release] = process.argv.slice(2);
await writeFile(entered, "");
while (!(await access(release).then(() => true, () => false))) await delay(10);
const server = new McpServer({ name: "delayed-start", version: "1" });
server.registerTool("ready", { description: "Ready", inputSchema: {} }, async () => ({ content: [] }));
await server.connect(new StdioServerTransport());
`
  );
  const pending = supervisor.ensure({
    consumer: "instance:delayed",
    appType: "delayed-start",
    spec: { command: process.execPath, args: [script, entered, release] }
  });
  for (
    let attempt = 0;
    !(await access(entered).then(
      () => true,
      () => false
    ));
    attempt++
  ) {
    assert.ok(attempt < 200, "the isolated MCP process must reach its startup gate");
    await delay(10);
  }
  let outcome;
  try {
    outcome = await Promise.race([
      supervisor.statuses().then((statuses) => ({ statuses })),
      new Promise((settle) => setImmediate(() => settle({ blocked: true })))
    ]);
  } finally {
    await writeFile(release, "");
    await pending;
  }
  assert.deepEqual(outcome, { statuses: [] }, "starting processes have no settled snapshot yet");
  assert.equal((await pending).state, "running");
  assert.equal((await supervisor.statuses())[0].state, "running");
  assert.deepEqual(
    await supervisor.listTools("instance:delayed").then((tools) => tools.map((tool) => tool.name)),
    ["ready"]
  );
  await supervisor.stop("instance:delayed");
  assert.deepEqual(await supervisor.statuses(), []);
});
