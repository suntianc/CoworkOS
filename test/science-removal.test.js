import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { startDashboard } from "./dashboard-fixture.mjs";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { GlobalWorkspaceCatalog } from "../dist/src/workspace/global-catalog.js";
import { WorkbenchTabStore } from "../dist/src/applications/tab-store.js";
import { TemporaryWorkspaceStore } from "../dist/src/workspace/temporary-workspaces.js";
import { McpSupervisor, resourceConsumer } from "../dist/src/applications/mcp-supervisor.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import "./automation-pi.test.js";
import "./input-files.test.js";
import "./input-files-pi.test.js";
import "./main-restart-recovery.test.js";

test("CLI help keeps general commands and omits the retired science commands", () => {
  const help = execFileSync(process.execPath, [resolve("scripts/atria.mjs"), "--help"], {
    encoding: "utf8"
  });
  assert.match(help, /coworkos\s+doctor/);
  assert.doesNotMatch(help, /coworkos\s+science\b/);
});

test("retired CLI science commands cannot start an interpreter from old settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cowork-prune-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config.json");
  const marker = join(root, "started");
  const python = join(root, "python");
  await writeFile(config, JSON.stringify({ science: { enabled: true, pythonExecutable: python } }));
  await writeFile(python, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o700 });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(COWORK_|ATRIA_|PI_)/.test(name))
  );
  Object.assign(env, { ATRIA_HOME: root, COWORK_CONFIG: config, COWORK_SCIENCE_TOOLS: "1" });
  const result = spawnSync(process.execPath, [resolve("scripts/atria.mjs"), "science", "status"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10000
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /unknown|未知|不支持/i);
  await assert.rejects(access(marker));
});

test("legacy science configuration cannot restore the settings and installation endpoints", async (t) => {
  const dashboard = await startDashboard({
    config: { science: { enabled: true, pythonExecutable: "/nonexistent/python" } },
    env: { COWORK_SCIENCE_TOOLS: "1" }
  });
  t.after(() => dashboard.stop());
  for (const [method, path] of [
    ["GET", "/api/science-settings"],
    ["GET", "/api/science-settings/environments"],
    ["POST", "/api/science-settings/check"],
    ["POST", "/api/science-settings/install"],
    ["POST", "/api/science-settings/cancel"]
  ]) {
    const response = await fetch(dashboard.base + path, { method });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  assert.equal((await fetch(dashboard.base + "/api/tasks")).status, 200);
});

test(
  "real Main and Subagent ignore old science settings and run project Python",
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cowork-science-removal-"));
    const project = join(root, "project");
    const workspace = join(root, "workspace");
    await mkdir(project, { recursive: true });
    const pythonEnvironment = join(project, ".venv");
    execFileSync("python3", ["-m", "venv", pythonEnvironment], { stdio: "pipe" });
    await writeFile(join(root, "config.json"), JSON.stringify({ science: { enabled: true } }));
    const store = new LocalWorkspaceStore(workspace);
    await store.createTask("task");
    await store.createRun("task", "run");
    const steps = { main: 0, delegate: 0 };
    const failures = [];
    const provider = await modelProtocolFixture("openai-completions", (body) => {
      try {
        const system = body.messages
          .filter((message) => message.role === "system")
          .map((message) => message.content)
          .join("\n");
        const role = system.includes("You are a CoworkOS Subagent") ? "delegate" : "main";
        const step = ++steps[role];
        const last = JSON.stringify(body.messages.findLast((message) => message.role === "tool"));
        if (role === "delegate") {
          assert.ok(body.tools.some((tool) => tool.function.name === "run_command"));
          if (step === 1)
            return {
              name: "run_command",
              arguments: {
                command: join(pythonEnvironment, "bin", "python"),
                args: ["-c", "print(6 * 7)"]
              }
            };
          assert.match(last, /42/);
          return { text: "Project Python produced 42." };
        }
        if (step === 1) return { name: "enable_tools", arguments: {} };
        if (step === 2)
          return {
            name: "call_subagent",
            arguments: { mode: "sync", task: "Run project Python and report the calculation." }
          };
        assert.match(last, /Project Python produced 42/);
        return { text: "fixture complete" };
      } catch (error) {
        failures.push(error.stack ?? error.message);
        return { text: "fixture failed" };
      }
    });
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^(COWORK_|ATRIA_|PI_|SERPER_|OPENAI_|ANTHROPIC_)/.test(name) && name !== "NODE_OPTIONS"
      )
    );
    const child = spawn(
      process.execPath,
      [
        "scripts/start-pi.mjs",
        "--print",
        "--mode",
        "json",
        "--session-id",
        "run",
        "--session-dir",
        join(root, "sessions"),
        "Inspect available tools."
      ],
      {
        cwd: resolve("."),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...inherited,
          ATRIA_HOME: join(root, "home"),
          COWORK_CONFIG: join(root, "config.json"),
          COWORK_WORKSPACE: workspace,
          COWORK_PROJECT_DIR: project,
          COWORK_TASK_ID: "task",
          COWORK_RUN_ID: "run",
          COWORK_API_BASE: provider.baseUrl,
          COWORK_API_KEY: "local-fixture",
          COWORK_MODEL: "protocol-fixture",
          COWORK_MODEL_API: "openai-completions",
          COWORK_SCIENCE_TOOLS: "1",
          COWORK_DISABLE_WATCH_SUPERVISOR: "1",
          COWORK_REASONING_EFFORT: "off",
          COWORK_SUPPORTS_REASONING_EFFORT: "0",
          PI_CODING_AGENT_DIR: join(root, "pi"),
          PI_OFFLINE: "1"
        }
      }
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const exited = once(child, "exit");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
      await provider.close();
      await rm(root, { recursive: true, force: true });
    });
    const [code] = await exited;
    assert.equal(code, 0, output);
    assert.deepEqual(failures, []);
    assert.ok(steps.main >= 3 && steps.delegate >= 2, "Main and Subagent must finish the tool lifecycle");
    const observed = JSON.stringify(provider.requests);
    assert.doesNotMatch(
      observed,
      /science_search|science_describe|science_run|scientific_environment|scientific-analysis|molecular-analysis/
    );
    assert.match(observed, /call_subagent/);
  }
);

test("generic MCP starts, executes, and works again after its supervisor restarts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cowork-prune-mcp-"));
  const log = join(root, "calls.jsonl");
  let supervisor = new McpSupervisor(resolve("."), "http://127.0.0.1:1");
  t.after(async () => {
    await supervisor.stopAll();
    await rm(root, { recursive: true, force: true });
  });
  const consumer = resourceConsumer("res_fixture");
  const spec = { command: process.execPath, args: [resolve("test/fixtures/mcp-delayed-server.mjs"), log] };
  const exercise = async () => {
    const started = await supervisor.ensure({ consumer, appType: "fixture", spec });
    assert.equal(started.state, "running", started.error);
    assert.ok((await supervisor.listTools(consumer)).some((tool) => tool.name === "delayed_replace"));
    const result = await supervisor.callTool({
      consumer,
      taskId: "task",
      name: "delayed_replace",
      params: { delayMs: 0 },
      resource: { resourceId: "res_fixture", revision: 0 }
    });
    assert.equal(result.operations[0].payload.text, "candidate\n");
  };
  await exercise();
  await supervisor.stopAll();
  supervisor = new McpSupervisor(resolve("."), "http://127.0.0.1:1");
  await exercise();
});

test("one-time cleanup previews owned assets, protects active and external data, and removes orphan tabs", async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "cowork-prune-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "home");
  const workspace = join(data, "workspace");
  const runtime = join(data, "runtime");
  const external = join(root, "external");
  await mkdir(runtime, { recursive: true });
  await mkdir(external);
  await writeFile(join(external, "keep.txt"), "external project");
  await writeFile(join(data, "config.json"), "fixture configuration");
  await writeFile(join(data, "credentials.json"), "fixture credentials");
  const store = new LocalWorkspaceStore(workspace);
  await store.createTask("old-task");
  await store.createTask("active-task");
  await store.transitionTask("active-task", "running", { runId: "active-run" });
  await store.createTask("job-task");
  const jobs = join(workspace, "job-task", "runs", "run", "agents", "main", "jobs");
  await mkdir(jobs, { recursive: true });
  await writeFile(join(jobs, "job-1.json"), JSON.stringify({ pid: process.pid, jobId: "job-1" }));
  const temporary = await new TemporaryWorkspaceStore(runtime).create(workspace);
  await store.createTask(temporary.record.holdingTaskId, {
    kind: "workspace",
    temporaryWorkspaceRoot: temporary.root,
    projectDirectory: temporary.root
  });
  await symlink(external, join(workspace, "linked-task"));
  const component = join(data, "components", "cadquery");
  await mkdir(component, { recursive: true });
  await writeFile(
    join(component, "install.json"),
    JSON.stringify({ phase: "cancelled", message: "fixture" })
  );
  const environment = join(data, "science-environments", "general");
  const generation = "8eeefbca-8a94-45f4-88ce-230583c6aa41";
  await mkdir(join(environment, "generations", generation, "bin"), { recursive: true });
  await symlink(join(external, "keep.txt"), join(environment, "generations", generation, "bin", "python"));
  await writeFile(
    join(environment, "ready.json"),
    JSON.stringify({
      version: 1,
      generation,
      specVersion: "atria-science-general-v1",
      sourcePython: join(external, "keep.txt")
    })
  );
  await new GlobalWorkspaceCatalog(join(runtime, "workspaces.json")).register(workspace);
  await mkdir(join(workspace, "applications", "instances"), { recursive: true });
  await writeFile(
    join(workspace, "applications", "instances", "index.json"),
    JSON.stringify({
      version: 1,
      instances: [],
      aliases: {}
    })
  );
  const tabs = new WorkbenchTabStore(join(runtime, "workbench-tabs.json"));
  for (const taskId of ["old-task", "active-task", "job-task", "orphan-task"])
    await tabs.open({ kind: "conversation", taskId });
  await tabs.open({ kind: "application", appInstanceId: "app-orphan" });

  const run = (...args) =>
    spawnSync(process.execPath, [resolve("scripts/prune-legacy-data.mjs"), "--root", data, ...args], {
      encoding: "utf8"
    });
  const preview = run("--preview");
  assert.equal(preview.status, 0, preview.stderr);
  const plan = JSON.parse(preview.stdout);
  assert.ok(
    plan.items.some((item) => item.kind === "task" && item.id === "old-task" && item.action === "remove")
  );
  assert.ok(
    plan.items.some((item) => item.kind === "task" && item.id === "active-task" && item.action === "retain")
  );
  assert.ok(
    plan.items.some((item) => item.kind === "task" && item.id === "job-task" && item.action === "retain")
  );
  assert.ok(
    plan.items.some((item) => item.kind === "component" && item.id === "cadquery" && item.action === "remove")
  );
  assert.ok(
    plan.items.some(
      (item) => item.kind === "science-environment" && item.id === "general" && item.action === "remove"
    )
  );
  assert.deepEqual(plan.tabsToRemove.sort(), [
    "conversation:old-task",
    "conversation:orphan-task",
    "window:app-orphan"
  ]);
  await access(join(workspace, "old-task", "task.json"));
  for (const id of ["../external", "linked-task"]) {
    const denied = run("--preview", "--task", id);
    assert.notEqual(denied.status, 0, id);
    await access(join(external, "keep.txt"));
  }
  await writeFile(join(runtime, "backend-instance.json"), "{}");
  const busy = run("--preview");
  assert.equal(busy.status, 0, busy.stderr);
  assert.ok(JSON.parse(busy.stdout).items.every((item) => item.action === "retain"));
  const busyApply = run("--apply");
  assert.equal(busyApply.status, 0, busyApply.stderr);
  assert.ok((await tabs.read()).tabs.some((tab) => tab.taskId === "orphan-task"));
  assert.ok((await tabs.read()).tabs.some((tab) => tab.appInstanceId === "app-orphan"));
  await access(join(workspace, "old-task", "task.json"));
  await rm(join(runtime, "backend-instance.json"));
  const applied = run("--apply");
  assert.equal(applied.status, 0, applied.stderr);
  await assert.rejects(access(join(workspace, "old-task")));
  await assert.rejects(access(temporary.root));
  await assert.rejects(access(component));
  await assert.rejects(access(environment));
  await access(join(workspace, "active-task", "task.json"));
  await access(join(workspace, "job-task", "task.json"));
  await access(join(external, "keep.txt"));
  assert.equal(await readFile(join(data, "config.json"), "utf8"), "fixture configuration");
  assert.equal(await readFile(join(data, "credentials.json"), "utf8"), "fixture credentials");
  assert.deepEqual(
    (await tabs.read()).tabs.map((tab) => tab.taskId),
    ["active-task", "job-task"]
  );
  const repeated = run("--apply");
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(
    (await tabs.read()).tabs.map((tab) => tab.taskId),
    ["active-task", "job-task"]
  );
});

test("cleanup preserves a shared tab when another workspace may own the same task ID", async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "cowork-prune-shared-tab-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "home");
  const workspace = join(data, "workspace");
  const runtime = join(data, "runtime");
  const external = join(root, "other-workspace");
  await mkdir(runtime, { recursive: true });
  await new LocalWorkspaceStore(workspace).createTask("shared-task");
  await new LocalWorkspaceStore(external).createTask("shared-task");
  const catalog = new GlobalWorkspaceCatalog(join(runtime, "workspaces.json"));
  await catalog.register(workspace);
  await catalog.register(external);
  const tabs = new WorkbenchTabStore(join(runtime, "workbench-tabs.json"));
  await tabs.open({ kind: "conversation", taskId: "shared-task" });
  const result = spawnSync(
    process.execPath,
    [resolve("scripts/prune-legacy-data.mjs"), "--root", data, "--task", "shared-task", "--apply"],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(access(join(workspace, "shared-task")));
  await access(join(external, "shared-task", "task.json"));
  assert.deepEqual(
    (await tabs.read()).tabs.map((tab) => tab.taskId),
    ["shared-task"]
  );
});
