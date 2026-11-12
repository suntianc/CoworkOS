import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeContext } from "@earendil-works/pi-ai";
import { startDashboard } from "./dashboard-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";
import { RETIRED_GUARDIAN_SWITCH } from "./retired-guardian-switch.mjs";
import { MainRequestStore, mainRequestPath } from "../dist/src/storage/main-request-store.js";
import { MainRequestRetry } from "../dist/src/runtime/main-request-retry.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { cliHelp, parseCliCommand } from "../dist/src/cli/commands.js";
import { installedPiVersion } from "./pi-version-fixture.mjs";

const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

// The removed interfaces and tools must be unreachable over HTTP.
test("goal and monitoring HTTP endpoints are gone", async (t) => {
  const dashboard = await startDashboard();
  t.after(() => dashboard.stop());
  const requests = [
    ["GET", "/api/goals"],
    ["POST", "/api/goals"],
    ["GET", "/api/goals/activity?offset=0"],
    ["GET", "/api/monitors"],
    ["POST", "/api/monitors"],
    ["GET", "/api/tasks/task/goals"],
    ["POST", "/api/tasks/task/goals"],
    ["GET", "/api/tasks/task/monitors"],
    ["POST", "/api/tasks/task/monitors"]
  ];
  for (const [method, path] of requests) {
    const response = await fetch(`${dashboard.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(method === "POST" ? { body: "{}" } : {})
    });
    assert.equal(response.status, 404, `${method} ${path} must be gone`);
  }
  // A fresh conversation no longer receives the removed feature's directories.
  const created = await fetch(`${dashboard.base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "fresh", goal: "新会话" })
  });
  assert.equal(created.status, 201);
  for (const directory of ["watch", "virtual-agents"])
    await assert.rejects(
      access(join(dashboard.workspaceRoot, "fresh", directory)),
      undefined,
      `${directory} is not part of a Task layout`
    );
});

test("the Pi tool table and CLI no longer offer goal or monitoring operations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-p46-tools-"));
  const previous = { ...process.env };
  t.after(async () => {
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "config.json"), "{}");
  Object.assign(process.env, {
    COWORK_CONFIG: join(root, "config.json"),
    COWORK_WORKSPACE: join(root, "workspace"),
    COWORK_TASK_ID: "tool-task",
    COWORK_RUN_ID: "main-tool-task",
    COWORK_DASHBOARD_URL: "http://127.0.0.1:1"
  });
  delete process.env.COWORK_API_BASE;
  delete process.env.COWORK_API_KEY;
  const tools = new Map();
  const pi = {
    on() {},
    registerTool: (tool) => tools.set(tool.name, tool),
    registerProvider() {},
    registerCommand() {},
    getActiveTools: () => [...tools.keys()],
    setActiveTools() {},
    sendMessage: async () => {}
  };
  const extensionPath = resolve(".pi/extensions/cowork.ts");
  const { createJiti } = await import(requirePi.resolve("jiti"));
  const extension = await createJiti(pathToFileURL(extensionPath).href, {
    interopDefault: true
  }).import(extensionPath, { default: true });
  await (extension.default ?? extension)(pi);
  for (const name of [
    "manage_goal",
    "record_goal_progress",
    "publish_goal_update",
    "activate_virtual_agent",
    "create_watcher"
  ])
    assert.equal(tools.has(name), false, `${name} must not be registered`);
  // Retained capabilities remain available.
  for (const name of ["sleep_until", "call_subagent", "get_subagent_status"]) assert.ok(tools.has(name));

  assert.doesNotMatch(cliHelp(), /coworkos watch/);
  for (const command of ["watch", "watch-file", "watch-research", "watch-run", "watch-supervisor"])
    assert.throws(() => parseCliCommand(command, []), /Unknown command/);
});

test("a failed Main request replays the original context exactly without reading or writing the removed delegation record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-p46-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectDirectory = join(root, "project");
  await mkdir(projectDirectory);
  const taskId = "retry-task";
  const runId = "original-run";
  const store = new MainRequestStore(mainRequestPath(join(root, "workspace"), taskId), taskId);
  const model = {
    id: "fixture",
    provider: "fixture",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 10000,
    maxTokens: 64
  };
  const context = normalizeContext({
    systemPrompt: "Original system",
    tools: [{ name: "fixture_tool", description: "Fixture tool", parameters: { type: "object" } }],
    messages: [{ role: "user", content: "Original input", timestamp: 1 }]
  });
  const environment = {
    projectDirectory,
    binding: JSON.stringify({
      workspaceRoot: projectDirectory,
      loadedInstanceId: null,
      boundResourceId: null
    }),
    executionScope: {
      version: 1,
      taskStorageRoot: join(root, "workspace", taskId),
      projectDirectory,
      application: null
    }
  };
  const body = '{ "model": "fixture", "messages": [] }';
  await store.begin({
    runId,
    requestId: "original-request",
    model,
    context,
    environment: { projectDirectory, binding: environment.binding },
    executionScope: environment.executionScope,
    endpoint: "http://127.0.0.1:1/v1/chat/completions",
    piVersion: installedPiVersion,
    body
  });
  await store.settle("original-request", "failed");
  // An old goal-delegation boundary is ordinary disk state now. Retrying must
  // neither consult it nor rewrite it.
  const delegationPath = join(root, "workspace", taskId, "runs", runId, "goal-delegation-request.json");
  await mkdir(join(root, "workspace", taskId, "runs", runId), { recursive: true });
  const delegationBytes = '{"version":1,"requestId":"user:old","legacyRequestId":"user:old"}\n';
  await writeFile(delegationPath, delegationBytes);

  const retry = new MainRequestRetry(store, runId, async () => environment, "original-request");
  const prepared = await retry.prepare(model, context);
  assert.equal(prepared.replay?.body, body, "the archived bytes are replayed exactly");
  assert.deepEqual(prepared.replay?.context.messages, context.messages);
  assert.deepEqual(prepared.context.messages, context.messages, "the original session branch is restored");
  assert.equal(await readFile(delegationPath, "utf8"), delegationBytes);

  await retry.capture({
    requestId: "retry-request",
    retryOf: "original-request",
    model,
    context,
    endpoint: "http://127.0.0.1:1/v1/chat/completions",
    body
  });
  const snapshot = await store.read();
  assert.equal(snapshot.requestId, "retry-request");
  assert.equal(Object.hasOwn(snapshot, "goalDelegationRequestId"), false);
  assert.equal(await readFile(delegationPath, "utf8"), delegationBytes);
  await retry.settle("retry-request", true);
});

test(
  "old goal, monitor and pause files do not stop startup, task listing, opening a conversation or running Main",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-p46-legacy-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    const taskId = "legacy-task";
    const taskRoot = join(workspace, taskId);
    await new LocalWorkspaceStore(workspace).createTask(taskId, { goal: "旧的后台监控会话" });
    const savedTask = JSON.parse(await readFile(join(taskRoot, "task.json"), "utf8"));
    await writeFile(
      join(taskRoot, "task.json"),
      JSON.stringify({
        ...savedTask,
        status: "waiting",
        monitoring: { scope: "background", sourceTaskId: "source" },
        watchRecovery: { day: "2026-11-01", retries: 2 }
      })
    );
    await mkdir(join(taskRoot, "watch", "programs", "goal_1", "events"), { recursive: true });
    await mkdir(join(taskRoot, "goal", "programs", "goal_1"), { recursive: true });
    await writeFile(
      join(taskRoot, "watch", "programs", "goal_1", "program.json"),
      JSON.stringify({ programId: "goal_1", taskId, status: "paused", goal: { version: 1 } })
    );
    await writeFile(
      join(taskRoot, "goal", "programs", "goal_1", "notifications.json"),
      JSON.stringify({ items: [] })
    );
    await writeFile(
      join(taskRoot, "agents", "main", "sleep.json"),
      JSON.stringify({
        runId: "main-legacy-task",
        reason: "old monitor",
        monitorIds: ["monitor_1"],
        parkedAt: new Date().toISOString()
      })
    );
    const requests = [];
    const provider = createServer(async (request, response) => {
      if (request.method !== "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(JSON.stringify({ data: [{ id: "legacy-fixture" }] }));
      }
      let raw = "";
      for await (const chunk of request.setEncoding("utf8")) raw += chunk;
      requests.push(JSON.parse(raw));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(protocolStream("openai-completions", { text: "旧数据会话已读取。" }));
    });
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    t.after(async () => {
      provider.closeAllConnections();
      await new Promise((done) => provider.close(done));
    });
    const dashboard = await startDashboard({
      workspace,
      defaultProject: false,
      modelEndpoint: `http://127.0.0.1:${provider.address().port}`,
      model: "legacy-fixture"
    });
    t.after(() => dashboard.stop());
    const list = await fetch(`${dashboard.base}/api/tasks`);
    assert.equal(list.status, 200);
    assert.ok((await list.json()).tasks.some((task) => task.taskId === taskId));
    const opened = await fetch(`${dashboard.base}/api/tasks/${taskId}`);
    assert.equal(opened.status, 200);
    const detail = await opened.json();
    assert.equal(Object.hasOwn(detail, "monitoring"), false);
    const run = await fetch(`${dashboard.base}/api/tasks/${taskId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "继续这个旧会话。" })
    });
    assert.equal(run.status, 202);
    for (let attempt = 0; attempt < 600; attempt++) {
      const current = await (await fetch(`${dashboard.base}/api/tasks/${taskId}`)).json();
      if (!current.runtime.active) {
        assert.equal(current.task.status, "completed", JSON.stringify(current.task));
        assert.equal(current.task.lastError, undefined);
        assert.ok(requests.length > 0, "Main actually ran");
        return;
      }
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.fail("the legacy-data conversation did not settle");
  }
);

test("no goal or monitoring module or identifier remains in product sources", async () => {
  const files = (await Promise.all(["src", ".pi", "web", "scripts", "desktop"].map(walk))).flat();
  const removedModules = [
    "src/domain/goal.ts",
    "src/domain/watch.ts",
    "src/domain/virtual-agent.ts",
    "src/dashboard/goal-routes.ts",
    "src/dashboard/goal-service.ts",
    "src/dashboard/watch-service.ts",
    "src/cli/watch-run.ts",
    ".pi/runtime/tools/goals.ts",
    ".pi/runtime/tools/monitors.ts",
    "scripts/monitor-service.mjs"
  ];
  for (const path of removedModules) assert.equal(files.includes(path), false, `${path} is removed`);
  assert.equal(
    files.some((path) => path.startsWith(".pi/skills/virtual-agent-authoring/")),
    false,
    "the monitoring authoring skill and its templates are removed"
  );
  const removedIdentifiers = [
    "manage_goal",
    "record_goal_progress",
    "publish_goal_update",
    "activate_virtual_agent",
    "create_watcher",
    "GoalManagement",
    "GoalActivityStore",
    "GoalSupervisor",
    "WatchProgramStore",
    "WatchManagement",
    "WatchSupervisor",
    "ScriptWatcher",
    "ResearchPollingWatcher",
    "FilePollingWatcher",
    "WatcherLoop",
    "VirtualAgentStore",
    "monitoringPrograms",
    "backgroundMonitoringPaused",
    RETIRED_GUARDIAN_SWITCH,
    "COWORK_SUPERVISOR_AUTOSTART",
    "COWORK_SUPERVISOR_INTERVAL_MS",
    "goalDelegation",
    "goal-delegation-request",
    "watch-supervisor",
    "virtual-agent-authoring",
    "长期目标",
    "长期任务",
    "后台监控会话"
  ];
  const sourceFiles = files.filter((path) => /\.(?:ts|tsx|js|mjs|cjs|json|css|html|md)$/.test(path));
  const offenders = [];
  for (const path of sourceFiles) {
    const text = await readFile(path, "utf8");
    for (const identifier of removedIdentifiers)
      if (text.includes(identifier)) offenders.push(`${path}: ${identifier}`);
  }
  assert.deepEqual(offenders, []);
});

test("maintained docs no longer describe the removed retry ownership field or Watch domain", async () => {
  const layout = await readFile("docs/task-workspace-layout.md", "utf8");
  assert.equal(layout.includes("goalDelegationRequestId"), false);
  const runtimeGuide = await readFile("src/runtime/AGENTS.md", "utf8");
  assert.equal(/Task、Run、Agent、Watch、Job/.test(runtimeGuide), false);
  for (const path of [
    "docs/long-term-goals-architecture.md",
    "docs/long-term-goals-ux.md",
    "docs/monitoring-pause-contract.md",
    "docs/watch-program-design.md"
  ])
    await assert.rejects(access(path), undefined, `${path} is removed`);
});
