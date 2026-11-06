import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");
const { McpSupervisor, resourceConsumer } = await import("../dist/src/applications/mcp-supervisor.js");

/**
 * Application MCP servers.
 *
 * The point of the protocol is that an application can contribute tools from
 * its own process, in any language, without being compiled into the harness —
 * so these tests drive real child processes rather than a double. What they
 * guard is the part a stub would hide: that the process starts and dies with
 * the window, that a failure to start is survivable, and that a tool's writes
 * still go through revision CAS.
 */

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

async function dashboard(t, { root: existingRoot } = {}) {
  // An existing root is how a restart is expressed: the same workspace and the
  // same tab strip, a different process.
  const root = existingRoot ?? (await mkdtemp(join(tmpdir(), "atria-mcp-")));
  const workspaceRoot = join(root, "workspace");
  if (!existingRoot)
    await new LocalWorkspaceStore(workspaceRoot).createTask("task", { goal: "MCP regression" });
  const config = join(root, "config.json");
  await writeFile(config, "{}");
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/src/cli/dashboard.js"], {
    cwd: resolve("."),
    stdio: "ignore",
    env: {
      ...process.env,
      COWORK_WORKSPACE: workspaceRoot,
      COWORK_GLOBAL_INDEX: join(root, "global.json"),
      COWORK_TABS_INDEX: join(root, "tabs.json"),
      COWORK_CONFIG: config,
      COWORK_UI_PORT: String(port)
    }
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/tasks`)).ok) break;
    } catch {
      /* still starting */
    }
    await new Promise((settle) => setTimeout(settle, 100));
  }
  t.after(async () => {
    child.kill("SIGKILL");
  });
  return { base, workspaceRoot, child, root };
}

async function api(base, path, body, method) {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

test("the reference server starts with its window and offers domain tools", { timeout: 40000 }, async (t) => {
  const { base } = await dashboard(t);

  const opened = await api(base, "/api/tasks/task/app-instances/open", { appType: "text-editor" });
  assert.equal(opened.status, 201);
  // The window reports its server, so a failure is visible rather than silent.
  assert.equal(opened.body.mcp?.state, "running", `server should start: ${opened.body.mcp?.error}`);
  assert.deepEqual(opened.body.mcp.toolNames.sort(), ["replace_section"]);

  const appInstanceId = opened.body.appInstance.appInstanceId;
  const status = await api(base, "/api/workbench/mcp/status");
  const entry = status.body.servers.find((server) => server.key.endsWith(appInstanceId));
  assert.ok(entry, "the running server is listed");
  assert.ok(entry.pid && alive(entry.pid), "and its process is really running");

  const tools = await api(base, `/api/workbench/mcp/tools?taskId=task&appInstanceId=${appInstanceId}`);
  assert.deepEqual(tools.body.tools.map((tool) => tool.name).sort(), ["replace_section"]);
  // A tool with no schema would be rejected by the provider, so every tool
  // must carry a usable one.
  for (const tool of tools.body.tools) {
    assert.equal(tool.parameters.type, "object", `${tool.name} needs an object schema`);
    assert.ok(tool.description.length > 0);
  }
});

test("a tool's write goes through revision CAS, not a direct file write", { timeout: 40000 }, async (t) => {
  const { base, workspaceRoot } = await dashboard(t);
  const opened = await api(base, "/api/tasks/task/app-instances/open", { appType: "text-editor" });
  const appInstanceId = opened.body.appInstance.appInstanceId;
  const created = await api(base, `/api/tasks/task/app-instances/${appInstanceId}/resources`, {
    kind: "text/markdown",
    title: "方案.md",
    initialContent: "# 产品方案\n\n## 背景\n旧的背景。\n\n### 细分\n子小节。\n\n## 目标\n待定。\n"
  });
  const resourceId = created.body.resource.resourceId;

  // The domain tool: a heading is something the platform deliberately does not
  // understand, which is why this cannot be done with offsets alone.
  const call = await api(base, "/api/workbench/mcp/call", {
    taskId: "task",
    appInstanceId,
    resourceId,
    name: "replace_section",
    params: { heading: "背景", body: "重写过的背景。" }
  });
  assert.equal(call.status, 200);
  assert.equal(call.body.operations.length, 1);
  assert.equal(call.body.operations[0].operationType, "text.replace");
  // The server returns an operation; it must not have written anything itself.
  const onDisk = await readFile(
    join(workspaceRoot, "applications", "text-editor", "files", "方案.md"),
    "utf8"
  );
  assert.match(onDisk, /旧的背景/, "the server must not write the file itself");

  const applied = await api(base, `/api/tasks/task/resources/${resourceId}/operations`, {
    operationId: "op-1",
    appType: "text-editor",
    operationType: call.body.operations[0].operationType,
    baseRevision: call.body.baseRevision,
    payload: call.body.operations[0].payload,
    actor: { type: "agent", id: "main" }
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.resource.revision, 1);

  const after = await readFile(
    join(workspaceRoot, "applications", "text-editor", "files", "方案.md"),
    "utf8"
  );
  assert.match(after, /重写过的背景/);
  // A section owns its subheadings, so the subsection went with it — and the
  // next sibling section did not.
  assert.equal(after.includes("### 细分"), false, "the subsection belongs to the section replaced");
  assert.match(after, /## 目标\n待定。/, "the next section is untouched");
});

test(
  "a stale baseRevision is refused, so an open editor is not overwritten",
  { timeout: 40000 },
  async (t) => {
    const { base } = await dashboard(t);
    const opened = await api(base, "/api/tasks/task/app-instances/open", { appType: "text-editor" });
    const appInstanceId = opened.body.appInstance.appInstanceId;
    const created = await api(base, `/api/tasks/task/app-instances/${appInstanceId}/resources`, {
      kind: "text/markdown",
      title: "冲突.md",
      initialContent: "# 标题\n\n## 甲\n原文。\n"
    });
    const resourceId = created.body.resource.resourceId;

    const call = await api(base, "/api/workbench/mcp/call", {
      taskId: "task",
      appInstanceId,
      resourceId,
      name: "replace_section",
      params: { heading: "甲", body: "Agent 写的。" }
    });
    assert.equal(call.body.baseRevision, 0);

    // Meanwhile the person types in the editor.
    const human = await api(base, `/api/tasks/task/resources/${resourceId}/operations`, {
      operationId: "op-human",
      appType: "text-editor",
      operationType: "text.insert",
      baseRevision: 0,
      payload: { at: 0, text: "用户先写的一行\n" },
      actor: { type: "user", id: "ui" }
    });
    assert.equal(human.body.resource.revision, 1);

    // The agent's operation was computed against revision 0 and must now lose.
    const conflicted = await api(base, `/api/tasks/task/resources/${resourceId}/operations`, {
      operationId: "op-agent",
      appType: "text-editor",
      operationType: call.body.operations[0].operationType,
      baseRevision: call.body.baseRevision,
      payload: call.body.operations[0].payload,
      actor: { type: "agent", id: "main" }
    });
    assert.equal(conflicted.status, 409);
    assert.equal(conflicted.body.error.code, "revision_conflict");

    const read = await api(base, `/api/tasks/task/resources/${resourceId}`);
    assert.match(read.body.snapshot.content, /用户先写的一行/, "the person's text must survive");
    assert.equal(read.body.resource.revision, 1, "and the agent's write must not have landed");
  }
);

test("a server that will not start leaves the window usable", { timeout: 40000 }, async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "atria-mcp-fail-"));
  const supervisor = new McpSupervisor(resolve("."));
  t.after(() => supervisor.stopAll());

  const status = await supervisor.ensure({
    consumer: resourceConsumer("res_1"),
    appType: "broken",
    spec: { command: process.execPath, args: ["-e", "process.exit(3)"] }
  });
  // Reported, not thrown: no tools is a lesser state, not a broken window.
  assert.equal(status.state, "failed");
  assert.ok(status.error, "the reason must be available to show the user");
  assert.deepEqual(await supervisor.listTools(resourceConsumer("res_1")), []);
  await assert.rejects(() =>
    supervisor.callTool({
      consumer: resourceConsumer("res_1"),
      taskId: "task",
      name: "anything",
      params: {},
      resource: { resourceId: "res_1", revision: 0 }
    })
  );
  assert.ok(workspaceRoot);
});

test(
  "concurrent starts produce one process, and closing the window ends it",
  { timeout: 40000 },
  async (t) => {
    const supervisor = new McpSupervisor(resolve("."));
    t.after(() => supervisor.stopAll());
    const spec = {
      command: process.execPath,
      args: ["dist/test/fixtures/application-contract/text-editor-server.js"]
    };

    // Starting a process is slow; two callers arriving in that window must not
    // each spawn one, or the second would be unstoppable.
    const [first, second] = await Promise.all([
      supervisor.ensure({ consumer: resourceConsumer("res_1"), appType: "text-editor", spec }),
      supervisor.ensure({ consumer: resourceConsumer("res_1"), appType: "text-editor", spec })
    ]);
    assert.equal(first.state, "running", first.error);
    assert.equal(first.pid, second.pid, "both callers share one process");
    const pid = first.pid;
    assert.ok(alive(pid));

    await supervisor.stop(resourceConsumer("res_1"));
    assert.equal(alive(pid), false, "closing the window must end the process");
    assert.deepEqual(await supervisor.statuses(), []);
  }
);

test("killing the dashboard takes its servers with it", { timeout: 40000 }, async (t) => {
  const { base, child } = await dashboard(t);
  const opened = await api(base, "/api/tasks/task/app-instances/open", { appType: "text-editor" });
  const status = await api(base, "/api/workbench/mcp/status");
  const pid = status.body.servers[0]?.pid;
  assert.ok(pid && alive(pid), "the server is running");
  assert.ok(opened.body.appInstance.appInstanceId);

  // Nothing cleaned up on exit before this, so every restart left children
  // behind; with a server per window that would accumulate an editor process
  // each time.
  child.kill("SIGTERM");
  for (let attempt = 0; attempt < 60 && alive(pid); attempt += 1) {
    await new Promise((settle) => setTimeout(settle, 100));
  }
  assert.equal(alive(pid), false, "no orphaned server after the dashboard exits");
});

test(
  "windows of one application share a process, and it lives until the last closes",
  { timeout: 40000 },
  async (t) => {
    const { base } = await dashboard(t);
    // Opening the same application twice reuses the empty window rather than
    // stacking another beside it.
    const first = await api(base, "/api/tasks/task/app-instances/open", { appType: "text-editor" });
    await api(base, "/api/workbench/load-instance", {
      taskId: "task",
      appInstanceId: first.body.appInstance.appInstanceId
    });
    const again = await api(base, "/api/tasks/task/app-instances/open", { appType: "text-editor" });
    assert.equal(again.body.appInstance.appInstanceId, first.body.appInstance.appInstanceId);

    // A window holding a document is a separate window — but not a separate
    // process. These servers are stateless: every call carries its document in
    // `atria/resource` metadata, so a second process computes the same answers
    // from the same inputs. Measured before this changed: each window cost its
    // own Node process and ~72 MB, so six open documents held ~490 MB of
    // identical servers.
    await api(base, `/api/tasks/task/app-instances/${first.body.appInstance.appInstanceId}/resources`, {
      kind: "text/markdown",
      title: "一.md",
      initialContent: "# 一\n"
    });
    const second = await api(base, "/api/tasks/task/app-instances/open", { appType: "text-editor" });
    const survivor = second.body.appInstance.appInstanceId;
    assert.notEqual(survivor, first.body.appInstance.appInstanceId);

    const both = (await api(base, "/api/workbench/mcp/status")).body.servers;
    // One consumer per document plus one for the still-empty window, and a single
    // process behind both. A document's consumer is the document, so two
    // conversations sharing it would still be one entry here.
    assert.equal(both.length, 2, "each consumer still reports its own tools");
    assert.equal(new Set(both.map((server) => server.pid)).size, 1, "but they share one process");
    const shared = both[0].pid;

    // Closing one window must not take the tools away from the other. Stopping
    // the process on the first close is the bug this guards.
    const closing = first.body.appInstance.appInstanceId;
    assert.equal(
      await api(base, `/api/tasks/task/app-instances/${closing}`, { status: "closed" }, "PATCH").then(
        (r) => r.status
      ),
      200
    );
    const remaining = (await api(base, "/api/workbench/mcp/status")).body.servers;
    assert.deepEqual(
      remaining.map((server) => server.key),
      [`instance:${survivor}`],
      "only the still-open window's consumer remains"
    );
    assert.ok(alive(shared), "the shared process keeps running for the window still open");
    const tools = await api(base, `/api/workbench/mcp/tools?taskId=task&appInstanceId=${survivor}`);
    assert.deepEqual(
      tools.body.tools.map((tool) => tool.name).sort(),
      ["replace_section"],
      "and that window's tools still work"
    );

    // The last window closing is what ends it.
    assert.equal(
      await api(base, `/api/tasks/task/app-instances/${survivor}`, { status: "closed" }, "PATCH").then(
        (r) => r.status
      ),
      200
    );
    for (let attempt = 0; attempt < 60 && alive(shared); attempt += 1) {
      await new Promise((settle) => setTimeout(settle, 100));
    }
    assert.equal(alive(shared), false, "no process is left behind once nothing is open");
    assert.deepEqual((await api(base, "/api/workbench/mcp/status")).body.servers, []);
  }
);

test("a window open across a Dashboard restart gets its server back", { timeout: 60000 }, async (t) => {
  // A window lives in the durable strip; a server is a process. Restarting the
  // Dashboard used to leave every open window permanently toolless, because
  // `ensure` was only ever reached by opening or binding a window — a window
  // already in the strip had no path back to one.
  const first = await dashboard(t);
  const opened = await api(first.base, "/api/tasks/task/app-instances/open", { appType: "text-editor" });
  const appInstanceId = opened.body.appInstance.appInstanceId;
  await api(first.base, `/api/tasks/task/app-instances/${appInstanceId}/resources`, {
    kind: "text/markdown",
    title: "doc.md",
    initialContent: "# 标题\n正文\n"
  });
  await api(first.base, "/api/workbench/tabs", { kind: "application", taskId: "task", appInstanceId });
  const before = await api(first.base, `/api/workbench/mcp/tools?taskId=task&appInstanceId=${appInstanceId}`);
  assert.deepEqual(before.body.tools.map((tool) => tool.name).sort(), ["replace_section"]);

  const pid = (await api(first.base, "/api/workbench/mcp/status")).body.servers[0]?.pid;
  first.child.kill("SIGTERM");
  for (let attempt = 0; attempt < 100 && alive(pid); attempt += 1) {
    await new Promise((settle) => setTimeout(settle, 100));
  }

  // Same workspace and same strip, a new process: exactly a restart.
  const second = await dashboard(t, { root: first.root });
  const tools = await api(second.base, `/api/workbench/mcp/tools?taskId=task&appInstanceId=${appInstanceId}`);
  assert.deepEqual(
    tools.body.tools.map((tool) => tool.name).sort(),
    ["replace_section"],
    "a window that survived the restart must get its tools back"
  );

  // And the revived server actually works, rather than merely being listed.
  const resources = await api(second.base, "/api/tasks/task/resources");
  const called = await api(second.base, "/api/workbench/mcp/call", {
    taskId: "task",
    appInstanceId,
    resourceId: resources.body.resources[0].resourceId,
    name: "replace_section",
    params: { heading: "标题", body: "复活之后写的\n" }
  });
  assert.equal(called.status, 200);
  assert.equal(called.body.result.section, "标题");
});

test("an unrelated data model travels the same MCP path", { timeout: 40000 }, async (t) => {
  // The architectural acceptance condition, extended to MCP: a resource of
  // keyed counters — no text, no offsets, no lines — must reach the Agent
  // through exactly the same supervisor and routes. If this needs a special
  // case anywhere, a real CAD server would hit the same wall.
  const supervisor = new McpSupervisor(resolve("."), "http://127.0.0.1:1");
  t.after(() => supervisor.stopAll());
  const status = await supervisor.ensure({
    consumer: resourceConsumer("res_counter"),
    appType: "dummy-counter",
    spec: { command: process.execPath, args: ["dist/src/applications/mcp/dummy-counter-server.js"] }
  });
  assert.equal(status.state, "running", status.error);
  assert.deepEqual(status.toolNames.sort(), ["bump_largest", "largest_counter"]);

  const tools = await supervisor.listTools(resourceConsumer("res_counter"));
  // Same shape the editor's tools arrive in — nothing about this is text.
  for (const tool of tools) {
    assert.equal(tool.parameters.type, "object");
    assert.ok(tool.description.length > 0);
  }
  await supervisor.stop(resourceConsumer("res_counter"));
});

test("a shared process still serves each document from its own metadata", { timeout: 40000 }, async (t) => {
  // The isolation question a shared process raises: if one server now answers
  // for several documents, can a call reach the wrong one? It cannot, and this
  // is why sharing is safe — the document is request metadata the platform
  // sets, never a parameter the model chooses, and the server reads the content
  // back over HTTP per call rather than holding any of its own.
  const { base } = await dashboard(t);
  const windows = [];
  for (const [title, body] of [
    ["甲.md", "# 甲\n甲的正文\n"],
    ["乙.md", "# 乙\n乙的正文\n"]
  ]) {
    const opened = await api(base, "/api/tasks/task/app-instances/open", { appType: "text-editor" });
    const appInstanceId = opened.body.appInstance.appInstanceId;
    const created = await api(base, `/api/tasks/task/app-instances/${appInstanceId}/resources`, {
      kind: "text/markdown",
      title,
      initialContent: body
    });
    windows.push({ appInstanceId, resourceId: created.body.resource.resourceId, title });
  }

  const servers = (await api(base, "/api/workbench/mcp/status")).body.servers;
  assert.equal(new Set(servers.map((server) => server.pid)).size, 1, "one process serves both");

  // Each window's call sees its own document, not the other's. The server
  // resolves that from request metadata, so a tool naming a heading only one
  // of the two documents has must succeed for that window alone.
  for (const window of windows) {
    const outlined = await api(base, "/api/workbench/mcp/call", {
      taskId: "task",
      appInstanceId: window.appInstanceId,
      resourceId: window.resourceId,
      name: "replace_section",
      params: { heading: window.title.replace(".md", ""), body: "各自的正文\n" }
    });
    assert.equal(outlined.status, 200);
    assert.equal(
      outlined.body.result.section,
      window.title.replace(".md", ""),
      `${window.title} must be resolved from its own content`
    );
  }

  // And a write lands in the document it was aimed at, leaving the other alone.
  const target = windows[0];
  const written = await api(base, "/api/workbench/mcp/call", {
    taskId: "task",
    appInstanceId: target.appInstanceId,
    resourceId: target.resourceId,
    name: "replace_section",
    params: { heading: "甲", body: "改写后的甲\n" }
  });
  assert.equal(written.status, 200);
  for (const operation of written.body.operations) {
    await api(base, `/api/tasks/task/resources/${target.resourceId}/operations`, {
      operationId: `op_${Math.random().toString(36).slice(2, 10)}`,
      appType: "text-editor",
      operationType: operation.operationType,
      baseRevision: written.body.baseRevision,
      payload: operation.payload
    });
  }
  const other = await api(base, `/api/tasks/task/resources/${windows[1].resourceId}`);
  assert.match(other.body.snapshot.content, /乙的正文/, "the other document is untouched");
});

test(
  "a bound window's server tools reach the model, not just the HTTP route",
  { timeout: 60000 },
  async (t) => {
    // Defect C. The Agent finds the Dashboard through COWORK_DASHBOARD_URL, and
    // nothing in the repo ever set it: the Dashboard spawned the Agent with
    // COWORK_TABS_INDEX but not its own address. So `discoverMcpTools` returned
    // early on every turn and `replace_section` was never once visible to a
    // model in production — silently, because an unreachable server is the
    // ordinary case there and not an error worth failing a turn over.
    //
    // Every other test in this file drives the HTTP routes directly, which is
    // exactly why none of them caught it. This one goes through the extension.
    const { base, workspaceRoot } = await dashboard(t);

    const created = await api(base, "/api/tasks/task/resources", {
      kind: "text/markdown",
      title: "方案.md",
      initialContent: "# 方案\n\n## 背景\n旧的背景。\n"
    });
    assert.equal(created.status, 201);
    const resourceId = created.body.resource.resourceId;
    const opened = await api(base, "/api/workbench/tabs", {
      kind: "application",
      taskId: "task",
      bindTo: "task",
      appInstanceId: created.body.appInstance.appInstanceId
    });
    assert.equal(opened.status, 200, "putting the window in front is what binds the conversation");

    const previous = { ...process.env };
    await writeFile(join(workspaceRoot, "extension-config.json"), "{}\n");
    Object.assign(process.env, {
      COWORK_API_BASE: "https://example.test",
      COWORK_API_KEY: "test-key",
      COWORK_CONFIG: join(workspaceRoot, "extension-config.json"),
      COWORK_WORKSPACE: workspaceRoot,
      COWORK_TASK_ID: "task",
      COWORK_RUN_ID: "main-mcp",
      COWORK_DASHBOARD_URL: base
    });
    t.after(() => {
      for (const key of [
        "COWORK_API_BASE",
        "COWORK_API_KEY",
        "COWORK_CONFIG",
        "COWORK_WORKSPACE",
        "COWORK_TASK_ID",
        "COWORK_RUN_ID",
        "COWORK_DASHBOARD_URL"
      ]) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });

    await new LocalWorkspaceStore(workspaceRoot).createRun("task", "main-mcp").catch(() => {});

    const { createRequire } = await import("node:module");
    const { pathToFileURL } = await import("node:url");
    const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const { createJiti } = await import(requirePi.resolve("jiti"));
    const jiti = createJiti(pathToFileURL(resolve(".pi/extensions/cowork.ts")).href, {
      interopDefault: true
    });
    const extension = await jiti.import(resolve(".pi/extensions/cowork.ts"), { default: true });

    const tools = new Map();
    const handlers = new Map();
    const active = new Set();
    const pi = {
      on(name, handler) {
        handlers.set(name, handler);
      },
      registerTool(tool) {
        tools.set(tool.name, tool);
        active.add(tool.name);
      },
      registerProvider() {},
      registerCommand() {},
      getActiveTools() {
        return [...active];
      },
      setActiveTools(names) {
        active.clear();
        for (const name of names) active.add(name);
      },
      sendMessage: async () => {}
    };
    (extension.default ?? extension)(pi);

    // One turn, which is when a bound application's tools are discovered.
    await handlers.get("context")(
      { messages: [] },
      {
        ui: { notify() {}, setStatus() {} },
        sessionManager: SessionManager.inMemory()
      }
    );

    assert.ok(tools.has("replace_section"), "the window's own server tool must reach the model");
    assert.ok(pi.getActiveTools().includes("replace_section"), "and be visible on this turn");

    // And it really writes, through the same revision CAS as everything else.
    const result = await tools
      .get("replace_section")
      .execute("call-1", { heading: "背景", body: "重写过的背景。\n" }, undefined, undefined, {
        ui: { notify() {}, setStatus() {} }
      });
    assert.equal(result.isError, undefined, `the call should succeed: ${JSON.stringify(result.details)}`);
    const after = await api(base, `/api/tasks/task/resources/${resourceId}`);
    assert.match(
      after.body.snapshot.content,
      /重写过的背景。/,
      "the MCP tool's write must land in the document"
    );
    assert.equal(
      after.body.resource.revision,
      1,
      "and go through the version protocol, not a direct file write"
    );
  }
);
