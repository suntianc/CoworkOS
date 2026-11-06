import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
const { ApplicationService } = await import("../dist/src/applications/application-service.js");
const { McpSupervisor, MCP_TOOL_TIMEOUT_MS, resourceConsumer } =
  await import("../dist/src/applications/mcp-supervisor.js");
const { postLocalApiJson } = await import("../dist/src/applications/mcp/local-api-client.js");
const { handleApplicationRequest } = await import("../dist/src/dashboard/application-routes.js");

async function fixture(t, deadline) {
  const root = await mkdtemp(join(tmpdir(), "atria-mcp-deadline-"));
  const log = join(root, "calls.jsonl");
  const supervisor = new McpSupervisor(resolve("."), "http://127.0.0.1:1", 3000, deadline);
  const spec = { command: process.execPath, args: [resolve("test/fixtures/mcp-delayed-server.mjs"), log] };
  const consumer = resourceConsumer("res_delay");
  const started = await supervisor.ensure({ consumer, appType: "delayed", spec });
  assert.equal(started.state, "running", started.error);
  t.after(async () => {
    await supervisor.stopAll();
    await rm(root, { recursive: true, force: true });
  });
  const events = () =>
    readFile(log, "utf8")
      .then((text) => text.trim().split("\n").filter(Boolean).map(JSON.parse))
      .catch(() => []);
  const waitFor = async (type) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await events()).some((event) => event.type === type)) return;
      await delay(20);
    }
    assert.fail(`server did not observe ${type}`);
  };
  const call = (delayMs, signal) =>
    supervisor.callTool({
      consumer,
      taskId: "task",
      name: "delayed_replace",
      params: { delayMs },
      resource: { resourceId: "res_delay", revision: 0 },
      signal
    });
  return { root, supervisor, spec, events, waitFor, call };
}

test(
  "MCP computation can finish after the SDK's former one-minute tool deadline",
  { timeout: 80000 },
  async (t) => {
    const { call } = await fixture(t);
    assert.equal(MCP_TOOL_TIMEOUT_MS, 600000);
    const started = Date.now();
    const result = await call(61000);
    assert.ok(Date.now() - started >= 60000);
    assert.equal(result.operations[0].payload.text, "candidate\n");
  }
);

test(
  "MCP cancellation and hard deadlines stop the request while preserving the shared server",
  { timeout: 15000 },
  async (t) => {
    const { call, events, waitFor } = await fixture(t, 500);
    const controller = new AbortController();
    const pending = call(10000, controller.signal);
    await waitFor("started");
    controller.abort(new Error("user cancelled"));
    await assert.rejects(pending, /user cancelled/);
    await waitFor("cancelled");
    assert.equal((await call(0)).operations.length, 1);
    const before = await events();
    await assert.rejects(call(10000), /Request timed out/);
    await delay(100);
    assert.equal((await events()).filter((event) => event.type === "cancelled").length, 2);
    assert.equal((await call(0)).operations.length, 1);
    const cancelled = new AbortController();
    cancelled.abort(new Error("already cancelled"));
    const count = (await events()).length;
    await assert.rejects(call(0, cancelled.signal), /already cancelled/);
    assert.equal((await events()).length, count);
    assert.equal(before.filter((event) => event.type === "finished").length, 1);
  }
);

test(
  "Pi MCP cancellation crosses real HTTP and the server without committing late candidate operations",
  { timeout: 20000 },
  async (t) => {
    const { root, supervisor, spec, waitFor, events } = await fixture(t);
    const service = new ApplicationService(root);
    const created = await service.createResource({
      taskId: "task",
      kind: "text/markdown",
      title: "bound.md",
      initialContent: "original\n",
      actor: { type: "user", id: "local" }
    });
    const resourceId = created.resource.resourceId;
    await service.bindResource("task", resourceId);
    const mcp = {
      statuses: () => supervisor.statuses(),
      stop: (consumer) => supervisor.stop(consumer),
      ensure: (input) => supervisor.ensure({ ...input, spec }),
      listTools: (consumer) => supervisor.listTools(consumer),
      callTool: (input) => supervisor.callTool(input)
    };
    const server = createServer((request, response) => {
      void handleApplicationRequest(request, response, new URL(request.url, "http://127.0.0.1"), {
        locate: async () => ({ workspaceRoot: root }),
        locateResource: async () => ({ workspaceRoot: root }),
        referencingTasks: async () => ["task"],
        publish: async () => {},
        publishToReferencers: async () => {},
        tabStorePath: join(root, "tabs.json"),
        defaultWorkspaceRoot: root,
        mcp
      }).catch((error) => response.destroy(error));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const { createJiti } = await import(requirePi.resolve("jiti"));
    const jiti = createJiti(pathToFileURL(resolve(".pi/runtime/application-bridge.ts")).href, {
      interopDefault: true
    });
    const { createApplicationBridge } = await jiti.import(resolve(".pi/runtime/application-bridge.ts"));
    const previousBase = process.env.COWORK_DASHBOARD_URL;
    process.env.COWORK_DASHBOARD_URL = base;
    t.after(() => {
      if (previousBase === undefined) delete process.env.COWORK_DASHBOARD_URL;
      else process.env.COWORK_DASHBOARD_URL = previousBase;
    });
    const tools = new Map(),
      handlers = new Map(),
      active = new Set();
    const bridge = createApplicationBridge({
      pi: {
        on(name, handler) {
          handlers.set(name, handler);
        },
        registerTool(tool) {
          tools.set(tool.name, tool);
          active.add(tool.name);
        },
        getActiveTools: () => [...active],
        setActiveTools: (names) => {
          active.clear();
          for (const name of names) active.add(name);
        }
      },
      workspaceRoot: root,
      taskId: "task",
      mainRunId: "main",
      harnessRoot: resolve(".")
    });
    await bridge.prepareApplicationContext();
    const tool = tools.get("delayed_replace");
    assert.ok(tool, "actual MCP tool must be discovered through HTTP");
    const controller = new AbortController();
    const pending = tool.execute("cancelled-call", { delayMs: 10000 }, controller.signal);
    await waitFor("started");
    controller.abort();
    const cancelledResult = await pending;
    assert.equal(cancelledResult.isError, true);
    assert.deepEqual(
      await handlers.get("tool_result")({ toolName: "delayed_replace", details: cancelledResult.details }),
      { isError: true }
    );
    await waitFor("cancelled");
    assert.equal((await service.readResource("task", resourceId)).resource.revision, 0);
    assert.equal((await service.readResource("task", resourceId)).snapshot.content, "original\n");
    const recovery = await tool.execute("next-call", { delayMs: 0 });
    assert.equal(recovery.isError, undefined);
    assert.equal((await service.readResource("task", resourceId)).resource.revision, 1);
    assert.match((await service.readResource("task", resourceId)).snapshot.content, /^candidate\noriginal/);
    assert.equal((await events()).filter((event) => event.type === "finished").length, 1);
    assert.throws(() => postLocalApiJson("https://example.test/api", "{}", 1000), /本机/);
  }
);
