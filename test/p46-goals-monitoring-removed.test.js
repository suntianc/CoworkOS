import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeContext } from "@earendil-works/pi-ai";
import { startDashboard } from "./dashboard-fixture.mjs";
import { RETIRED_GUARDIAN_SWITCH } from "./retired-guardian-switch.mjs";
import { MainRequestStore, mainRequestPath } from "../dist/src/storage/main-request-store.js";
import { MainRequestRetry } from "../dist/src/runtime/main-request-retry.js";
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

test("a failed Main request replays the original context exactly", async (t) => {
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

  const retry = new MainRequestRetry(store, runId, async () => environment, "original-request");
  const prepared = await retry.prepare(model, context);
  assert.equal(prepared.replay?.body, body, "the archived bytes are replayed exactly");
  assert.deepEqual(prepared.replay?.context.messages, context.messages);
  assert.deepEqual(prepared.context.messages, context.messages, "the original session branch is restored");

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
  await retry.settle("retry-request", true);
});

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
