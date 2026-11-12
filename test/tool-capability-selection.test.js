import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = await import(requirePi.resolve("jiti"));
const path = resolve(".pi/runtime/tools/capabilities.ts");
const { registerCapabilityTools, CORE_TOOLS } = await createJiti(pathToFileURL(path).href).import(path);
const optional = [
  "list_applications",
  "list_resources",
  "list_resource_changes",
  "create_resource",
  "export_resource",
  "apply_resource_operation",
  "accept_resource_candidate",
  "read_attachment",
  "publish_artifact",
  "start_job",
  "check_job",
  "kill_job",
  "activate_virtual_agent",
  "sleep_until",
  "browser_open",
  "browser_observe",
  "browser_act",
  "browser_wait",
  "browser_close",
  "cua_script",
  "cua_reset",
  "create_watcher",
  "manage_goal",
  "record_goal_progress",
  "publish_goal_update",
  "computer_status",
  "computer_observe",
  "computer_wait",
  "computer_act"
];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-tool-selection-"));
  const store = new LocalWorkspaceStore(root);
  await store.createTask("task");
  await store.createRun("task", "run");
  const previous = { ...process.env };
  for (const name of ["COWORK_DASHBOARD_URL", "COWORK_API_TOKEN", "COWORK_PROJECT_WRITE"])
    delete process.env[name];
  t.after(async () => {
    for (const name of ["COWORK_DASHBOARD_URL", "COWORK_API_TOKEN", "COWORK_PROJECT_WRITE"]) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(root, { recursive: true, force: true });
  });
  let resources = false;
  const start = () => {
    const tools = new Map();
    let active = ["read", "write", "edit", "bash", ...CORE_TOOLS, ...optional];
    const pi = {
      getActiveTools: () => active,
      setActiveTools: (names) => {
        active = names;
      },
      registerTool: (tool) => tools.set(tool.name, tool)
    };
    const controller = registerCapabilityTools(pi, {
      workspaceRoot: root,
      taskId: "task",
      mainRunId: "run",
      hasResources: async () => {
        if (resources instanceof Error) throw resources;
        return resources;
      },
      supportsImages: true
    });
    return { controller, pi, enable: (groups) => tools.get("enable_tools").execute("load", { groups }) };
  };
  return {
    root,
    store,
    start,
    setResources: (value) => {
      resources = value;
    }
  };
}

test("an unbound ordinary task exposes only core tools in CLI and App without a desktop grant", async (t) => {
  const f = await fixture(t),
    cli = f.start();
  await cli.controller.refresh();
  assert.deepEqual(cli.pi.getActiveTools().sort(), ["read", "write", "edit", "bash", ...CORE_TOOLS].sort());
  process.env.COWORK_DASHBOARD_URL = "http://127.0.0.1:1";
  const app = f.start();
  await app.controller.refresh();
  assert.deepEqual(app.pi.getActiveTools().sort(), cli.pi.getActiveTools().sort());
  assert.ok(cli.pi.getActiveTools().includes("call_subagent"));
});

test("optional groups are discoverable, explicitly loadable, and durable across Main restart", async (t) => {
  const f = await fixture(t),
    main = f.start();
  const discovery = await main.enable();
  assert.equal(discovery.details.groups.applications.enabled, false);
  await main.enable(["applications", "delivery"]);
  assert.ok(main.pi.getActiveTools().includes("create_resource"));
  assert.ok(main.pi.getActiveTools().includes("accept_resource_candidate"));
  assert.ok(main.pi.getActiveTools().includes("publish_artifact"));
  assert.equal(main.pi.getActiveTools().includes("read_attachment"), false);
  const restarted = f.start();
  await restarted.controller.refresh();
  assert.deepEqual(restarted.pi.getActiveTools().sort(), main.pi.getActiveTools().sort());
});

test("goal and watcher tools share the optional monitors group and restore without widening other groups", async (t) => {
  const f = await fixture(t),
    main = f.start();
  const names = [
    "activate_virtual_agent",
    "sleep_until",
    "create_watcher",
    "manage_goal",
    "record_goal_progress",
    "publish_goal_update"
  ];
  const discovery = await main.enable();
  assert.deepEqual(discovery.details.groups.monitors.tools, names);
  for (const name of names) assert.equal(main.pi.getActiveTools().includes(name), false);
  await main.enable(["monitors"]);
  for (const name of names) assert.ok(main.pi.getActiveTools().includes(name));
  for (const name of ["create_resource", "start_job", "computer_observe", "science_run"])
    assert.equal(main.pi.getActiveTools().includes(name), false);
  const restarted = f.start();
  await restarted.controller.refresh();
  assert.deepEqual(restarted.pi.getActiveTools().sort(), main.pi.getActiveTools().sort());
  await restarted.controller.restoreSelection(["manage_goal", "create_watcher"]);
  for (const name of names) assert.ok(restarted.pi.getActiveTools().includes(name));
});

test("context adds resources and uploads without a keyword classifier", async (t) => {
  const f = await fixture(t),
    main = f.start();
  f.setResources(true);
  await mkdir(join(f.root, "task", "inputs", "upload-fixture"), { recursive: true });
  await main.controller.refresh();
  assert.ok(main.pi.getActiveTools().includes("create_resource"));
  assert.ok(main.pi.getActiveTools().includes("read_attachment"));
  f.setResources(false);
  await rm(join(f.root, "task", "inputs"), { recursive: true });
  await main.controller.refresh();
  assert.equal(main.pi.getActiveTools().includes("create_resource"), false);
  assert.equal(main.pi.getActiveTools().includes("read_attachment"), false);
});

test("browser and scripting are separately loadable without enabling desktop control", async (t) => {
  const f = await fixture(t),
    main = f.start();
  await main.controller.refresh();
  assert.equal(main.pi.getActiveTools().includes("browser_open"), false);
  assert.equal(main.pi.getActiveTools().includes("cua_script"), false);
  await main.enable(["cua"]);
  assert.ok(main.pi.getActiveTools().includes("cua_script"));
  assert.ok(main.pi.getActiveTools().includes("cua_reset"));
  assert.equal(main.pi.getActiveTools().includes("browser_open"), false);
  assert.equal(main.pi.getActiveTools().includes("computer_act"), false);
  await main.enable(["browser"]);
  assert.ok(main.pi.getActiveTools().includes("browser_open"));
  assert.ok(main.pi.getActiveTools().includes("browser_wait"));
  assert.equal(main.pi.getActiveTools().includes("computer_act"), false);
  const restarted = f.start();
  await restarted.controller.refresh();
  assert.deepEqual(restarted.pi.getActiveTools().sort(), main.pi.getActiveTools().sort());
});

test("enabling jobs never grants them; the recorded permission activates and revokes their tools", async (t) => {
  const f = await fixture(t),
    main = f.start();
  const requested = await main.enable(["jobs"]);
  assert.equal(requested.details.groups.jobs.enabled, false);
  assert.equal(main.pi.getActiveTools().includes("start_job"), false);
  await f.store.updateTask("task", { capabilities: { longRunning: true } });
  await main.controller.refresh();
  assert.ok(main.pi.getActiveTools().includes("start_job"));
  await f.store.updateTask("task", { capabilities: { longRunning: false } });
  await main.controller.refresh();
  assert.equal(main.pi.getActiveTools().includes("start_job"), false);
});

test("desktop tool schemas follow active human observation/control grants and expiry", async (t) => {
  const f = await fixture(t);
  let session = null;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ session }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  process.env.COWORK_DASHBOARD_URL = `http://127.0.0.1:${server.address().port}`;
  const main = f.start();
  await main.controller.refresh();
  assert.equal(main.pi.getActiveTools().includes("computer_observe"), false);
  await main.enable(["computer"]);
  assert.ok(main.pi.getActiveTools().includes("computer_status"));
  session = { state: "active", mode: "observe", expiresAt: Date.now() + 60000 };
  await main.controller.refresh();
  assert.ok(main.pi.getActiveTools().includes("computer_observe"));
  assert.ok(main.pi.getActiveTools().includes("computer_wait"));
  assert.equal(main.pi.getActiveTools().includes("computer_act"), false);
  session.mode = "control";
  await main.controller.refresh();
  assert.ok(main.pi.getActiveTools().includes("computer_act"));
  session.expiresAt = Date.now() - 1;
  await main.controller.refresh();
  assert.equal(main.pi.getActiveTools().includes("computer_observe"), false);
  assert.equal(main.pi.getActiveTools().includes("computer_wait"), false);
  assert.equal(main.pi.getActiveTools().includes("computer_act"), false);
});

test("damaged optional application references cannot block ordinary Main work", async (t) => {
  const f = await fixture(t),
    main = f.start();
  f.setResources(new Error("damaged application metadata"));
  await main.controller.refresh();
  assert.ok(main.pi.getActiveTools().includes("call_subagent"));
  assert.ok(main.pi.getActiveTools().includes("bash"));
  assert.equal(main.pi.getActiveTools().includes("create_resource"), false);
});
