import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { readJsonLines } from "../dist/src/dashboard/event-stream.js";
import { ExperimentProgramStore } from "../dist/src/runtime/experiment-program-store.js";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { DurableScheduler } from "../dist/src/runtime/scheduler.js";

const run = promisify(execFile);
const messageText = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("");
const lastToolText = (body) => messageText(body.messages.findLast((message) => message.role === "tool"));
const toolJson = (body) =>
  JSON.parse(messageText(body.messages.findLast((message) => message.role === "tool")));
const userText = (body) =>
  body.messages
    .filter((message) => message.role === "user")
    .map(messageText)
    .join("\n");
const systemText = (body) =>
  body.messages
    .filter((message) => ["system", "developer"].includes(message.role))
    .map(messageText)
    .join("\n");
const isSubagent = (body) => systemText(body).includes("You are a CoworkOS Subagent");
const git = (cwd, args) =>
  run("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((result) => result.stdout.trim());

/** A bare Main process; the caller owns its providers and configuration file. */
function spawnMain({ root, project, workspace, taskId, runId, prompt, env = {} }) {
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
      "--no-session",
      "--session-id",
      runId,
      "--session-dir",
      join(root, "sessions"),
      prompt
    ],
    {
      cwd: resolve("."),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...inherited,
        ATRIA_HOME: join(root, "atria"),
        COWORK_CONFIG: join(root, "config.json"),
        COWORK_WORKSPACE: workspace,
        COWORK_PROJECT_DIR: project,
        COWORK_TASK_ID: taskId,
        COWORK_RUN_ID: runId,
        COWORK_PROJECT_WRITE: "1",
        COWORK_GLOBAL_INDEX: join(root, "index.json"),
        COWORK_TABS_INDEX: join(root, "tabs.json"),
        COWORK_DASHBOARD_URL: "",
        COWORK_DISABLE_WATCH_SUPERVISOR: "1",
        COWORK_MODEL_API: "openai-completions",
        COWORK_REASONING_EFFORT: "off",
        COWORK_SUPPORTS_REASONING_EFFORT: "0",
        COWORK_WEB_TOOLS: "0",
        COWORK_MAX_ATTEMPTS: "1",
        COWORK_SUBAGENT_TIMEOUT_MS: "60000",
        PI_CODING_AGENT_DIR: join(root, "pi"),
        PI_OFFLINE: "1",
        ...env
      }
    }
  );
  let output = "";
  const record = (chunk) => {
    output = `${output}${chunk}`.slice(-40_000);
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  const exited = once(child, "exit");
  return {
    child,
    get output() {
      return output;
    },
    exit: exited,
    async kill() {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      await exited;
    }
  };
}

/** The execution host's public configuration: connections plus role bindings. */
async function writeHostConfig(root, { connections, host, projects }) {
  await writeFile(
    join(root, "config.json"),
    `${JSON.stringify(
      {
        modelConnections: { version: 1, activeId: connections[0].id, profiles: connections },
        roleModels: { version: 1, host, ...(projects ? { projects } : {}) }
      },
      null,
      2
    )}\n`
  );
}

/** The durable queue of one Main Run, read as the runtime writes it. */
async function readQueue(workspace, taskId, runId) {
  return JSON.parse(await readFile(join(workspace, taskId, "runs", runId, "queue.json"), "utf8"));
}

/** Move every leased item past its lease so a restarted Main may reclaim it. */
async function expireLeases(workspace, taskId, runId) {
  const path = join(workspace, taskId, "runs", runId, "queue.json");
  const items = JSON.parse(await readFile(path, "utf8"));
  for (const item of items) if (item.lease) item.lease.expiresAt = "2000-01-01T00:00:00.000Z";
  await writeFile(path, `${JSON.stringify(items, null, 2)}\n`);
}

/**
 * Clear the locks the killed Main may have died holding.
 *
 * The runtime reclaims an abandoned lock on a stale window (minutes) or when a
 * caller opts into dead-owner recovery, which is the right behaviour for a real
 * host restart. This fixture restarts immediately and owns this tree: the killed
 * process is the only one that ever wrote here, so every leftover lock is stale.
 */
async function clearLocks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name.endsWith(".lock")) {
      await rm(path, { recursive: true, force: true });
      continue;
    }
    await clearLocks(path);
  }
}

async function experimentRuns(workspace, taskId) {
  const store = new ExperimentProgramStore(workspace);
  const programs = await store.listPrograms(taskId);
  const runs = [];
  for (const program of programs) runs.push(...(await store.listRuns(taskId, program.experimentId)));
  return runs;
}

/**
 * A strict local provider that records the account, model and body of every
 * request. A role resolving to the wrong connection shows up as a request on
 * the wrong server, which is the only evidence this test trusts.
 */
async function provider(t, label, handle) {
  const requests = [];
  const failures = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET") return response.end(JSON.stringify({ data: [{ id: label }] }));
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const entry = {
        label,
        authorization: request.headers.authorization,
        model: body.model,
        body,
        path: request.url
      };
      requests.push(entry);
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(400, { "content-type": "application/json" });
        return response.end('{"error":{"message":"unexpected path"}}');
      }
      const reply = await handle(entry, requests);
      try {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(protocolStream("openai-completions", reply ?? { text: `${label} 已完成` }));
      } catch {
        /* the caller cancelled this request */
      }
    } catch (error) {
      failures.push(error.stack ?? error.message);
      try {
        response.destroy(error);
      } catch {
        /* the socket is already gone */
      }
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  return { label, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests, failures };
}

const client = (dashboard) => async (path, body, method) => {
  const response = await fetch(`${dashboard.base}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
};

const waitFor = async (check, message, timeout = 60_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(message);
};

const settle = async (request, taskId, timeout = 120_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const detail = await request(`/api/tasks/${taskId}`);
    if (detail.status === 200 && !detail.body.runtime.active && detail.body.task.status === "completed")
      return detail.body;
    await delay(50);
  }
  const stuck = await request(`/api/tasks/${taskId}`);
  assert.fail(`Main ${taskId} did not settle: ${JSON.stringify(stuck.body.progress)}`);
};

async function makeRepository(directory) {
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.email", "fixture@example.test"]);
  await git(directory, ["config", "user.name", "Fixture"]);
  await writeFile(join(directory, "tracked.txt"), "committed\n");
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "baseline"]);
  return directory;
}

/** Every text file under a directory, so a leaked secret cannot hide in one. */
async function readTree(directory) {
  const parts = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) parts.push(await readTree(path));
    else if (entry.isFile()) parts.push(await readFile(path, "utf8").catch(() => ""));
  }
  return parts.join("\n");
}

test(
  "three Executors and two Reviewers start together, cancel without affecting each other, and keep their attribution",
  { timeout: 240_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-p4-roles-"));
    const repository = await makeRepository(join(root, "repository"));
    const dashboard = await startDashboard({
      defaultProject: false,
      env: { COWORK_PROJECT_WRITE: "1", COWORK_DISABLE_WATCH_SUPERVISOR: "1" }
    });
    t.after(async () => {
      await dashboard.stop();
      await rm(root, { recursive: true, force: true });
    });
    const request = client(dashboard);
    const created = await request("/api/projects", {
      projectName: "角色并发项目",
      projectDirectory: repository
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const project = created.body.project;
    const requirement = await request(`/api/projects/${encodeURIComponent(project.projectId)}/ledger`, {
      action: "create",
      title: "同时推进五项工作",
      content: "需要三项实现工作与两项独立审查。"
    });
    assert.equal(requirement.status, 201, JSON.stringify(requirement.body));
    const configured = await request(`/api/projects/${encodeURIComponent(project.projectId)}/merge-config`, {
      repository,
      targetBranch: "main"
    });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    const development = await request(`/api/projects/${encodeURIComponent(project.projectId)}/developments`, {
      action: "create",
      requirementId: requirement.body.requirement.requirementId,
      goal: "五项工作在同一需求现场推进",
      completionCriteria: ["三项实现与两项审查均返回结论"],
      route: "full"
    });
    assert.equal(development.status, 201, JSON.stringify(development.body));
    const workspace = development.body.development.workspace.directory;
    const developmentId = development.body.development.developmentId;
    assert.equal(development.body.development.workspace.state, "ready");
    const taskId = "role-lifecycle";
    assert.equal(
      (await request("/api/tasks", { taskId, goal: "同时推进五项工作", projectId: project.projectId }))
        .status,
      201
    );

    const failures = [];
    const workItems = {};
    const arrived = new Set();
    let mainSteps = 0;
    let reachedObservation;
    const observation = new Promise((done) => {
      reachedObservation = done;
    });
    let capacityChecked;
    const capacityReady = new Promise((done) => {
      capacityChecked = done;
    });
    let release;
    const barrier = new Promise((done) => {
      release = done;
    });
    let failTest;
    const scriptFailure = new Promise((_, reject) => {
      failTest = reject;
    });
    const identityOf = (body) => {
      const text = userText(body);
      const match = text.match(/工作项 ([A-E])/);
      return match ? match[1] : "main";
    };
    const fixture = await provider(t, "本地夹具", async (entry) => {
      try {
        if (!isSubagent(entry.body)) {
          const step = mainSteps++;
          if (step <= 4) {
            const label = "ABCDE"[step];
            const role = label === "D" || label === "E" ? "reviewer" : "executor";
            return {
              name: "call_subagent",
              arguments: {
                task: `${role === "reviewer" ? "审查者" : "执行者"}工作项 ${label}：在需求现场完成本项工作并返回证据。`,
                mode: "async",
                role,
                developmentId
              }
            };
          }
          if (step === 5) return { name: "get_subagent_status", arguments: {} };
          if (step === 6) {
            const status = toolJson(entry.body);
            assert.ok(Array.isArray(status.agents), JSON.stringify(status).slice(0, 400));
            for (const agent of status.agents) workItems[identityOfTask(agent.task)] = agent.callId;
            assert.deepEqual(Object.keys(workItems).sort(), ["A", "B", "C", "D", "E"]);
            reachedObservation(status);
            // The test inspects capacity and status while all five are in
            // flight; only then are they allowed to answer.
            await capacityReady;
            release();
            return {
              name: "cancel_subagent",
              arguments: { callId: workItems.C, reason: "改由其余工作项覆盖" }
            };
          }
          if (step === 7) {
            const cancelled = toolJson(entry.body);
            assert.equal(cancelled.callId, workItems.C);
            assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
            return {
              name: "wait_for_subagents",
              arguments: { callIds: Object.values(workItems), timeoutMs: 60_000 }
            };
          }
          if (step === 8) {
            const waited = toolJson(entry.body);
            assert.deepEqual(waited.pending, []);
            assert.equal(waited.timedOut, false);
            const statuses = new Map(waited.calls.map((call) => [call.callId, call.status]));
            assert.equal(statuses.get(workItems.C), "cancelled");
            for (const label of ["A", "B", "D", "E"])
              assert.equal(statuses.get(workItems[label]), "completed");
            return { text: "五项工作已完成，其中一项按需取消。" };
          }
          return { text: "五项工作已完成，其中一项按需取消。" };
        }
        const label = identityOf(entry.body);
        arrived.add(label);
        await barrier;
        // One Executor stays busy in a real command so Main can cancel it
        // while the other four finish independently.
        if (label === "C")
          return {
            name: "run_command",
            arguments: {
              command: process.execPath,
              args: ["-e", "setTimeout(() => {}, 120000)"]
            }
          };
        return { text: `${label} 完成：已在本工作项内检查现场。` };
      } catch (error) {
        failures.push(error.stack ?? error.message);
        release();
        capacityChecked();
        failTest(error);
        return { text: "角色并发夹具失败。" };
      }
    });
    t.after(() => {
      release();
      capacityChecked();
    });
    const saved = await request("/api/model-settings", {
      profileName: "本地夹具",
      baseUrl: fixture.baseUrl,
      model: "protocol-fixture",
      api: "openai-completions",
      supportsReasoningEffort: false,
      supportsImages: false,
      apiKey: "role-lifecycle-local-key"
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    // Quota tracking makes "does not occupy a Main slot" observable.
    const capacityConfigured = await request("/api/main-capacity", { resident: 1, continuation: 0 });
    assert.equal(capacityConfigured.status, 200, JSON.stringify(capacityConfigured.body));

    const started = await request(`/api/tasks/${taskId}/run`, {
      prompt: "同时推进三项实现与两项独立审查，按需要组织子任务。"
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));

    const observed = await Promise.race([observation, scriptFailure]);
    assert.equal(arrived.size, 5, "all five work items reached the model together");
    const observedAgents = observed.agents;
    assert.equal(observedAgents.length, 5);
    assert.deepEqual(observedAgents.map((agent) => agent.role).sort(), [
      "executor",
      "executor",
      "executor",
      "reviewer",
      "reviewer"
    ]);
    // Every work item runs in its own checkout, never the requirement's
    // integration site and never another item's tree.
    for (const agent of observedAgents) {
      assert.notEqual(agent.workspace, workspace);
      assert.equal(agent.status, "running", "every work item is actively working at the observation point");
      assert.equal(agent.developmentId, developmentId);
    }
    assert.equal(new Set(observedAgents.map((agent) => agent.workspace)).size, 5);
    const capacity = await request("/api/main-capacity");
    assert.equal(capacity.status, 200, JSON.stringify(capacity.body));
    assert.equal(capacity.body.configured, true, "the quota view is live while the items run");
    // Five active work items, no Main demand waiting and no work item holding a
    // Main slot: subagents never take the Main budget.
    assert.deepEqual(capacity.body.queued, [], "no Main demand was queued behind the five work items");
    assert.deepEqual(capacity.body.running, [], "no work item registered as a Main slot");
    capacityChecked();

    const settledDetail = await settle(request, taskId);
    assert.deepEqual(failures, [], failures.join("\n"));
    const runEvents = await readJsonLines(
      join(dashboard.workspaceRoot, taskId, "runs", started.body.runId, "run_events.jsonl"),
      5_000
    );
    assert.equal(
      runEvents.filter((event) => event.type === "main.run_spawned").length,
      1,
      "the five work items ran inside the one Main run"
    );
    assert.equal(new Set(runEvents.map((event) => event.runId)).size, 1);

    const agents = settledDetail.progress.agents;
    assert.equal(agents.length, 5);
    assert.equal(new Set(agents.map((agent) => agent.agentId)).size, 5, "each work item keeps its identity");
    assert.deepEqual(
      agents
        .filter((agent) => agent.role === "executor")
        .map((agent) => agent.callId)
        .sort(),
      [workItems.A, workItems.B, workItems.C].sort()
    );
    assert.deepEqual(
      agents
        .filter((agent) => agent.role === "reviewer")
        .map((agent) => agent.callId)
        .sort(),
      [workItems.D, workItems.E].sort()
    );
    for (const agent of agents) {
      assert.notEqual(agent.workspace, workspace);
      assert.equal(agent.model, "protocol-fixture");
    }
    assert.equal(new Set(agents.map((agent) => agent.workspace)).size, 5);
    assert.equal(agents.filter((agent) => agent.status === "succeeded").length, 4);
    const cancelled = agents.find((agent) => agent.callId === workItems.C);
    assert.equal(cancelled.status, "cancelled");

    // No key reaches a shared record or a public response.
    const shared = await readTree(dashboard.workspaceRoot);
    assert.equal(shared.includes("role-lifecycle-local-key"), false);
    assert.equal(JSON.stringify(settledDetail).includes("role-lifecycle-local-key"), false);

    // A backend restart reconciles the same attribution from durable records.
    await dashboard.restart();
    const restored = await request(`/api/tasks/${taskId}`);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.task.status, "completed");
    assert.deepEqual(
      restored.body.progress.agents.map((agent) => [agent.callId, agent.role, agent.status, agent.workspace]),
      agents.map((agent) => [agent.callId, agent.role, agent.status, agent.workspace]),
      "a restarted backend keeps every work item's identity, role, site and outcome"
    );
  }
);

/** The letter of a work item, read from its own task text. */
function identityOfTask(task) {
  const match = String(task ?? "").match(/工作项 ([A-E])/);
  assert.ok(match, `work item text names its label: ${task}`);
  return match[1];
}

const connection = (id, name, baseUrl, model, apiKey) => ({
  id,
  name,
  baseUrl,
  model,
  apiKey,
  api: "openai-completions",
  thinkingFormat: "auto",
  reasoningEffort: "off",
  supportsReasoningEffort: false,
  supportsPromptCacheKey: false,
  mainMaxTokens: 4096,
  subagentMaxTokens: 2048,
  contextWindow: 64000,
  supportsImages: false
});

test(
  "executor and reviewer role bindings reach the model requests of a real Main process",
  { timeout: 240_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-p4-role-models-"));
    const project = join(root, "project");
    const workspace = join(root, "workspace");
    await mkdir(project, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const taskId = "role-models";
    const runId = "role-models-run";
    await new LocalWorkspaceStore(workspace).createTask(taskId, {
      goal: "角色模型接线",
      projectId: "proj-roles",
      projectDirectory: project
    });

    const keys = {
      main: "role-main-key",
      host: "role-host-key",
      project: "role-project-key",
      explicit: "role-explicit-key"
    };
    const mainProvider = await provider(t, "主连接", async (entry) => {
      try {
        if (isSubagent(entry.body)) return { text: "审查者完成：结论已返回。" };
        const step = mainSteps++;
        if (step === 0) return call("执行者工作项 A：主机默认角色。");
        if (step === 1) {
          await writeConfig({ project: "exec-project" });
          return call("执行者工作项 B：项目覆盖角色。");
        }
        if (step === 2) return call("执行者工作项 C：显式选择连接。", { profileId: "exec-explicit" });
        if (step === 3) return call("执行者工作项 D：在途连接保持不变。");
        if (step === 4) return call("执行者工作项 E：之后的启动读取新配置。");
        if (step === 5) {
          await writeConfig({ project: "gone" });
          return call("执行者工作项 F：失效的角色引用。");
        }
        if (step === 6) {
          assert.match(lastToolText(entry.body), /gone/, "the failure names the missing connection");
          assert.match(lastToolText(entry.body), /不存在/);
          return call("审查者工作项 G：未配置 Reviewer 时沿用 Main 的连接。", { role: "reviewer" });
        }
        if (step === 7) {
          assert.match(lastToolText(entry.body), /审查者完成/, "the Reviewer's result reached Main");
          return { text: "角色模型接线完成。" };
        }
        return { text: "角色模型接线完成。" };
      } catch (error) {
        failures.push(error.stack ?? error.message);
        return { text: "角色模型夹具失败。" };
      }
    });
    const hostProvider = await provider(t, "主机执行", async () => ({ text: "执行者 A 完成。" }));
    const projectProvider = await provider(t, "项目执行", async (entry) => {
      // The binding changes while this request is already in flight; the next
      // launch must read the new value, this one must keep its connection.
      if (entry.body.messages.some((message) => messageText(message).includes("工作项 D")))
        await writeConfig({ project: "exec-host" });
      const label = entry.body.messages.some((message) => messageText(message).includes("工作项 D"))
        ? "D"
        : "B";
      return { text: `执行者 ${label} 完成。` };
    });
    const explicitProvider = await provider(t, "显式执行", async () => ({ text: "执行者 C 完成。" }));

    const agentsConfig = () => ({
      version: 1,
      activeId: "main-a",
      profiles: [
        connection("main-a", "主连接", mainProvider.baseUrl, "main-model", keys.main),
        connection("exec-host", "主机执行", hostProvider.baseUrl, "host-model", keys.host),
        connection("exec-project", "项目执行", projectProvider.baseUrl, "project-model", keys.project),
        connection("exec-explicit", "显式执行", explicitProvider.baseUrl, "explicit-model", keys.explicit)
      ]
    });
    const failures = [];
    let mainSteps = 0;
    const writeConfig = async ({ project: binding }) => {
      const roleModels = {
        version: 1,
        host: { executor: { profileId: "exec-host" } },
        ...(binding === undefined ? {} : { projects: { "proj-roles": { executor: { profileId: binding } } } })
      };
      await writeFile(
        join(root, "config.json"),
        `${JSON.stringify({ modelConnections: agentsConfig(), roleModels }, null, 2)}\n`
      );
    };
    const call = (task, extra = {}) => ({
      name: "call_subagent",
      arguments: { task, mode: "sync", role: "executor", ...extra }
    });
    await writeConfig({ project: undefined });

    const main = spawnMain({
      root,
      project,
      workspace,
      taskId,
      runId,
      prompt: "依次验证执行者与审查者的模型角色。",
      env: {
        COWORK_API_BASE: mainProvider.baseUrl,
        COWORK_API_KEY: keys.main,
        COWORK_MODEL: "main-model"
      }
    });
    t.after(async () => {
      if (main.child.exitCode === null && main.child.signalCode === null) {
        try {
          process.kill(-main.child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
        await main.exit.catch(() => {});
      }
      await rm(root, { recursive: true, force: true });
    });
    const [code] = await main.exit;
    assert.equal(code, 0, `${main.output}\n${failures.join("\n")}`);
    assert.deepEqual(failures, [], failures.join("\n"));

    // Host default, project override, explicit connection: one request each, on
    // the connection the role resolved to, with that connection's own key.
    assert.equal(hostProvider.requests.length, 2, main.output);
    assert.deepEqual(
      hostProvider.requests.map((entry) => entry.authorization),
      [`Bearer ${keys.host}`, `Bearer ${keys.host}`]
    );
    assert.deepEqual(
      hostProvider.requests.map((entry) => entry.model),
      ["host-model", "host-model"]
    );
    assert.match(userText(hostProvider.requests[0].body), /工作项 A/);
    assert.equal(projectProvider.requests.length, 2);
    assert.deepEqual(
      projectProvider.requests.map((entry) => entry.authorization),
      [`Bearer ${keys.project}`, `Bearer ${keys.project}`]
    );
    assert.deepEqual(
      projectProvider.requests.map((entry) => entry.model),
      ["project-model", "project-model"]
    );
    assert.equal(explicitProvider.requests.length, 1);
    assert.equal(explicitProvider.requests[0].authorization, `Bearer ${keys.explicit}`);
    assert.equal(explicitProvider.requests[0].model, "explicit-model");
    // E launched after the binding changed while D was in flight.
    assert.equal(
      hostProvider.requests.filter((entry) => userText(entry.body).includes("工作项 E")).length,
      1,
      "a later launch reads the new binding"
    );
    // F failed on the missing connection, without reaching any provider.
    for (const entry of [...hostProvider.requests, ...projectProvider.requests, ...explicitProvider.requests])
      assert.equal(userText(entry.body).includes("工作项 F"), false);
    // G had no Reviewer binding and kept Main's own connection.
    assert.equal(mainProvider.requests.filter((entry) => isSubagent(entry.body)).length, 1);
    const reviewer = mainProvider.requests.find((entry) => isSubagent(entry.body));
    assert.equal(reviewer.authorization, `Bearer ${keys.main}`);
    assert.equal(reviewer.model, "main-model");
    assert.match(userText(reviewer.body), /工作项 G/);

    // The durable selection snapshot is non-sensitive and names the role.
    const events = (await readFile(join(workspace, taskId, "runs", runId, "run_events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const selections = events
      .filter((event) => event.type === "call.model_selected")
      .map((event) => event.payload.modelSelection);
    assert.equal(selections.length, 6, JSON.stringify(selections));
    assert.ok(selections.every((snapshot) => snapshot.role === "executor" || snapshot.role === "reviewer"));
    // The Reviewer had no binding: its record says it kept Main's connection.
    assert.deepEqual(
      selections
        .filter((snapshot) => snapshot.role === "reviewer")
        .map((snapshot) => [snapshot.source, snapshot.model]),
      [["active", "main-model"]]
    );
    assert.ok(
      selections.some(
        (snapshot) => snapshot.connectionName === "项目执行" && snapshot.model === "project-model"
      )
    );
    const shared = await readTree(join(workspace, taskId));
    for (const key of Object.values(keys)) assert.equal(shared.includes(key), false, "no key in shared data");
  }
);

test(
  "a queued work item reads its role binding when it actually starts, and a cancelled waiter is not blocked",
  { timeout: 180_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-p4-start-"));
    const project = join(root, "project");
    const workspace = join(root, "workspace");
    await mkdir(project, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const taskId = "role-start";
    const runId = "role-start-run";
    await new LocalWorkspaceStore(workspace).createTask(taskId, {
      goal: "角色在启动时解析",
      projectId: "proj-roles",
      projectDirectory: project
    });

    const failures = [];
    let mainSteps = 0;
    const calls = {};
    let configEdited;
    const edited = new Promise((done) => {
      configEdited = done;
    });
    let release;
    const gate = new Promise((done) => {
      release = done;
    });
    let heldA = 0;
    const oldProvider = await provider(t, "旧执行", async (entry) => {
      if (userText(entry.body).includes("工作项 A") && heldA++ === 0) await gate;
      return { text: "A 完成（旧连接）。" };
    });
    const newProvider = await provider(t, "新执行", async () => ({ text: "B 完成（新连接）。" }));
    const reviewProvider = await provider(t, "审查连接", async () => ({ text: "C 不应运行。" }));
    const mainProvider = await provider(t, "主连接", async (entry) => {
      try {
        if (isSubagent(entry.body)) return { text: "无关子项完成。" };
        const step = mainSteps++;
        const call = (task, extra = {}) => ({
          name: "call_subagent",
          arguments: { task, mode: "async", role: "executor", ...extra }
        });
        if (step === 0) return call("执行者工作项 A：先运行并等待。");
        if (step === 1) {
          calls.a = toolJson(entry.body);
          return call("执行者工作项 B：等待 A 完成。", { dependsOn: [calls.a.callId] });
        }
        if (step === 2) {
          calls.b = toolJson(entry.body);
          return call("审查者工作项 C：等待 A 完成。", {
            role: "reviewer",
            dependsOn: [calls.a.callId]
          });
        }
        if (step === 3) {
          calls.c = toolJson(entry.body);
          return call("审查者工作项 D：等待 A 完成。", {
            role: "reviewer",
            dependsOn: [calls.a.callId]
          });
        }
        if (step === 4) {
          calls.d = toolJson(entry.body);
          return { name: "cancel_subagent", arguments: { callId: calls.d.callId, reason: "不再需要" } };
        }
        if (step === 5) {
          const cancelled = toolJson(entry.body);
          assert.equal(cancelled.callId, calls.d.callId);
          assert.equal(cancelled.status, "cancelled");
          return { name: "get_subagent_status", arguments: {} };
        }
        if (step === 6) {
          const status = toolJson(entry.body);
          const byCall = new Map(status.agents.map((agent) => [agent.callId, agent]));
          const cancelledWaiter = byCall.get(calls.d.callId);
          assert.equal(cancelledWaiter.status, "cancelled", "a cancelled waiter owns its terminal state");
          assert.equal(cancelledWaiter.blocked, undefined);
          assert.equal(byCall.get(calls.a.callId).status, "running");
          for (const blocked of [calls.b, calls.c]) {
            const waiting = byCall.get(blocked.callId);
            assert.equal(waiting.status, "queued");
            assert.equal(waiting.blocked, true);
            assert.deepEqual(waiting.dependsOn, [calls.a.callId]);
          }
          // The test rewrites the host configuration while A is still running
          // and B/C are queued; only then is A allowed to finish.
          await edited;
          release();
          return {
            name: "wait_for_subagents",
            arguments: { callIds: [calls.a.callId, calls.b.callId, calls.c.callId], timeoutMs: 60_000 }
          };
        }
        if (step === 7) {
          const waited = toolJson(entry.body);
          const byCall = new Map(waited.calls.map((call) => [call.callId, call]));
          assert.equal(byCall.get(calls.a.callId).status, "completed");
          assert.equal(byCall.get(calls.b.callId).status, "completed");
          assert.equal(byCall.get(calls.c.callId).status, "failed", JSON.stringify(waited).slice(0, 800));
          return { name: "get_task_status", arguments: { resultCallIds: [calls.c.callId] } };
        }
        if (step === 8) {
          const status = toolJson(entry.body);
          const gone = status.coordination.calls.find((call) => call.callId === calls.c.callId);
          assert.equal(gone.status, "failed");
          assert.match(gone.error, /exec-review/);
          assert.match(gone.error, /不存在/);
          return { text: "启动时解析完成。" };
        }
        return { text: "启动时解析完成。" };
      } catch (error) {
        failures.push(error.stack ?? error.message);
        release();
        configEdited();
        return { text: "启动时解析夹具失败。" };
      }
    });
    const keys = {
      main: "start-main-key",
      old: "start-old-key",
      next: "start-new-key",
      review: "start-review-key"
    };
    const connections = [
      connection("main-a", "主连接", mainProvider.baseUrl, "main-model", keys.main),
      connection("exec-old", "旧执行", oldProvider.baseUrl, "old-model", keys.old),
      connection("exec-new", "新执行", newProvider.baseUrl, "new-model", keys.next),
      connection("exec-review", "审查连接", reviewProvider.baseUrl, "review-model", keys.review)
    ];
    await writeHostConfig(root, {
      connections,
      host: { executor: { profileId: "exec-old" }, reviewer: { profileId: "exec-review" } }
    });

    const main = spawnMain({
      root,
      project,
      workspace,
      taskId,
      runId,
      prompt: "按依赖顺序推进工作项。",
      env: {
        COWORK_API_BASE: mainProvider.baseUrl,
        COWORK_API_KEY: keys.main,
        COWORK_MODEL: "main-model"
      }
    });
    t.after(async () => {
      release();
      configEdited();
      await main.kill();
      await rm(root, { recursive: true, force: true });
    });

    // Wait until all four items exist and the first one is really running.
    await waitFor(async () => {
      const queue = await readQueue(workspace, taskId, runId).catch(() => []);
      return queue.length === 4 && heldA === 1;
    }, "the four work items were not dispatched");
    // Change the executor binding and drop the reviewer connection while the
    // dependent items are still queued.
    await writeHostConfig(root, {
      connections: connections.filter((entry) => entry.id !== "exec-review"),
      host: { executor: { profileId: "exec-new" }, reviewer: { profileId: "exec-review" } }
    });
    configEdited();

    const [code] = await main.exit;
    assert.equal(code, 0, `${main.output}\n${failures.join("\n")}`);
    assert.deepEqual(failures, [], failures.join("\n"));

    // A started on the connection it was launched with; B waited and read the
    // binding edited while it waited; C failed on the removed connection.
    assert.equal(oldProvider.requests.length, 1, main.output);
    assert.equal(oldProvider.requests[0].authorization, `Bearer ${keys.old}`);
    assert.equal(oldProvider.requests[0].model, "old-model");
    assert.equal(newProvider.requests.length, 1);
    assert.equal(newProvider.requests[0].authorization, `Bearer ${keys.next}`);
    assert.equal(newProvider.requests[0].model, "new-model");
    assert.match(userText(newProvider.requests[0].body), /工作项 B/);
    assert.equal(reviewProvider.requests.length, 0, "a removed binding never reaches its old provider");
    for (const entry of [...oldProvider.requests, ...newProvider.requests])
      assert.equal(userText(entry.body).includes("工作项 C"), false);

    const queue = await readQueue(workspace, taskId, runId);
    const byCall = new Map(queue.map((item) => [item.stepId, item]));
    assert.equal(byCall.get(calls.c.callId).status, "failed");
    assert.match(byCall.get(calls.c.callId).error, /exec-review/);
    assert.equal(byCall.get(calls.d.callId).status, "cancelled");
    const events = (await readFile(join(workspace, taskId, "runs", runId, "run_events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const selections = events
      .filter((event) => event.type === "call.model_selected")
      .map((event) => ({ callId: event.callId, snapshot: event.payload.modelSelection }));
    assert.deepEqual(
      selections.map((selection) => [selection.callId, selection.snapshot.model]).sort(),
      [
        [calls.a.callId, "old-model"],
        [calls.b.callId, "new-model"]
      ].sort()
    );
    assert.equal(
      selections.some((selection) => selection.callId === calls.c.callId),
      false,
      "a refused start records no selection"
    );
    // No work item mislabels a start refusal as a delivery problem.
    assert.equal(main.output.includes("Async callback delivery deferred"), false);
  }
);

test(
  "a recovered queued item whose binding is gone is settled with its reason instead of being re-driven",
  { timeout: 240_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-p4-recovery-"));
    const project = join(root, "project");
    const workspace = join(root, "workspace");
    await mkdir(project, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const taskId = "role-recovery";
    const runId = "role-recovery-run";
    await new LocalWorkspaceStore(workspace).createTask(taskId, {
      goal: "重启恢复",
      projectId: "proj-roles",
      projectDirectory: project
    });

    const failures = [];
    const calls = {};
    let release;
    const gate = new Promise((done) => {
      release = done;
    });
    let heldA = 0;
    const oldProvider = await provider(t, "旧执行", async (entry) => {
      if (userText(entry.body).includes("工作项 A") && heldA++ === 0) await gate;
      return { text: "A 完成。" };
    });
    const reviewProvider = await provider(t, "审查连接", async () => ({ text: "C 不应运行。" }));
    let firstSteps = 0;
    const firstProvider = await provider(t, "第一轮主连接", async (entry) => {
      try {
        if (isSubagent(entry.body)) return { text: "无关子项完成。" };
        const step = firstSteps++;
        const call = (task, extra = {}) => ({
          name: "call_subagent",
          arguments: { task, mode: "async", role: "executor", ...extra }
        });
        if (step === 0) return call("执行者工作项 A：被中断的工作项。");
        if (step === 1) {
          calls.a = toolJson(entry.body);
          return call("执行者工作项 B：等待 A 的工作项。", { dependsOn: [calls.a.callId] });
        }
        if (step === 2) {
          calls.b = toolJson(entry.body);
          return call("审查者工作项 C：等待 A 的审查。", {
            role: "reviewer",
            dependsOn: [calls.a.callId]
          });
        }
        if (step === 3) {
          calls.c = toolJson(entry.body);
          return { name: "get_subagent_status", arguments: {} };
        }
        return { text: "第一轮结束。" };
      } catch (error) {
        failures.push(error.stack ?? error.message);
        return { text: "第一轮夹具失败。" };
      }
    });
    let secondSteps = 0;
    let secondVerified;
    const verified = new Promise((done) => {
      secondVerified = done;
    });
    const secondProvider = await provider(t, "第二轮主连接", async (entry) => {
      try {
        if (isSubagent(entry.body)) return { text: "无关子项完成。" };
        const step = secondSteps++;
        if (step === 0) return { name: "wait_for_subagents", arguments: { timeoutMs: 60_000 } };
        if (step === 1) {
          const waited = toolJson(entry.body);
          const byCall = new Map(waited.calls.map((call) => [call.callId, call]));
          const durable = (await readQueue(workspace, taskId, runId)).map((item) => [
            item.stepId,
            item.status,
            item.error
          ]);
          assert.equal(
            byCall.get(calls.a.callId).status,
            "completed",
            `durable=${JSON.stringify(durable)} waited=${JSON.stringify(waited).slice(0, 400)}`
          );
          assert.equal(byCall.get(calls.b.callId).status, "completed", JSON.stringify(durable));
          assert.equal(byCall.get(calls.c.callId).status, "failed", JSON.stringify(waited).slice(0, 800));
          return { name: "get_task_status", arguments: { resultCallIds: [calls.c.callId] } };
        }
        if (step === 2) {
          const status = toolJson(entry.body);
          const gone = status.coordination.calls.find((call) => call.callId === calls.c.callId);
          assert.equal(gone.status, "failed");
          assert.match(gone.error, /exec-review/);
          return { name: "get_subagent_status", arguments: {} };
        }
        if (step === 3) {
          const status = toolJson(entry.body);
          const failed = status.agents.find((agent) => agent.callId === calls.c.callId);
          assert.equal(failed.status, "failed");
          assert.match(failed.error, /exec-review/);
          secondVerified();
          return { text: "恢复完成。" };
        }
        secondVerified();
        return { text: "恢复完成。" };
      } catch (error) {
        failures.push(error.stack ?? error.message);
        secondVerified();
        return { text: "第二轮夹具失败。" };
      }
    });
    const keys = {
      main1: "recovery-main-one",
      main2: "recovery-main-two",
      old: "recovery-old-key",
      review: "recovery-review-key"
    };
    const connections = [
      connection("main-a", "主连接", firstProvider.baseUrl, "main-model", keys.main1),
      connection("exec-old", "旧执行", oldProvider.baseUrl, "old-model", keys.old),
      connection("exec-review", "审查连接", reviewProvider.baseUrl, "review-model", keys.review)
    ];
    await writeHostConfig(root, {
      connections,
      host: { executor: { profileId: "exec-old" }, reviewer: { profileId: "exec-review" } }
    });

    const first = spawnMain({
      root,
      project,
      workspace,
      taskId,
      runId,
      prompt: "先推进三项工作。",
      env: {
        COWORK_API_BASE: firstProvider.baseUrl,
        COWORK_API_KEY: keys.main1,
        COWORK_MODEL: "main-model"
      }
    });
    t.after(async () => {
      release();
      await first.kill();
      await rm(root, { recursive: true, force: true });
    });
    await waitFor(async () => {
      const queue = await readQueue(workspace, taskId, runId).catch(() => []);
      return queue.length === 3 && heldA === 1;
    }, "the first Main did not dispatch the three work items");
    // The process died before it read back C's dispatch result; the durable
    // queue still carries every item's identity, which is what a restarted Main
    // has to work from too.
    const firstQueue = await readQueue(workspace, taskId, runId);
    const callIdOf = (label) =>
      firstQueue.find((item) => String(item.payload?.task ?? "").includes(`工作项 ${label}`))?.stepId;
    calls.a = { callId: callIdOf("A") };
    calls.b = { callId: callIdOf("B") };
    calls.c = { callId: callIdOf("C") };
    assert.ok(calls.a.callId && calls.b.callId && calls.c.callId, JSON.stringify(firstQueue));
    // The process dies with A running and B/C queued; move the leases past
    // their expiry so the next Main may reclaim them, then break the Reviewer
    // binding's connection before anything restarts.
    await first.kill();
    await clearLocks(root);
    await expireLeases(workspace, taskId, runId);
    await writeHostConfig(root, {
      connections: connections.filter((entry) => entry.id !== "exec-review"),
      host: { executor: { profileId: "exec-old" }, reviewer: { profileId: "exec-review" } }
    });

    const second = spawnMain({
      root,
      project,
      workspace,
      taskId,
      runId,
      prompt: "恢复并核对被中断的工作项。",
      env: {
        COWORK_API_BASE: secondProvider.baseUrl,
        COWORK_API_KEY: keys.main2,
        COWORK_MODEL: "main-model"
      }
    });
    t.after(() => second.kill());
    // Wait for the assertions the second Main makes through its own tools, then
    // stop it: whether it exits on its own is not part of the behaviour here.
    await Promise.race([
      verified,
      delay(60_000).then(async () =>
        assert.fail(
          `the recovered Main never observed the outcome; failures=${JSON.stringify(failures)} exit=${second.child.exitCode}/${second.child.signalCode} output=${second.output.slice(-2000)}`
        )
      )
    ]);
    await second.kill();
    assert.deepEqual(failures, [], failures.join("\n"));

    const queue = await readQueue(workspace, taskId, runId);
    const byCall = new Map(queue.map((item) => [item.stepId, item]));
    assert.equal(byCall.get(calls.a.callId).status, "completed");
    assert.equal(byCall.get(calls.b.callId).status, "completed");
    const refused = byCall.get(calls.c.callId);
    assert.equal(refused.status, "failed", JSON.stringify(queue).slice(0, 900));
    assert.match(refused.error, /exec-review/);
    assert.match(refused.error, /不存在/);
    assert.equal(reviewProvider.requests.length, 0);

    // The failure surfaced through the normal lifecycle: one callback, one run
    // event, and a settled experiment row — not a silent drop.
    const inbox = JSON.parse(
      await readFile(join(workspace, taskId, "runs", runId, "agents", "main", "inbox-store.json"), "utf8")
    );
    const callbacks = inbox.filter(
      (message) => message.kind === "callback" && message.callId === calls.c.callId
    );
    assert.equal(callbacks.length, 1, "one durable callback carries the refusal");
    assert.match(callbacks[0].payload.error, /exec-review/);
    const events = (await readFile(join(workspace, taskId, "runs", runId, "run_events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const failureEvent = events.find(
      (event) => event.type === "run.failed" && event.callId === calls.c.callId
    );
    assert.ok(failureEvent, "the run records why the recovered item failed");
    assert.match(failureEvent.payload.error, /exec-review/);
    const runs = await experimentRuns(workspace, taskId);
    const refusedRun = runs.find((entry) => entry.callId === calls.c.callId);
    assert.equal(refusedRun.status, "failed");
    assert.match(refusedRun.error, /exec-review/);
    assert.ok(
      runs.every((entry) => entry.finishedAt !== undefined),
      "no experiment row is left unfinished"
    );

    // A third restart must not re-drive the terminal item or duplicate its callback.
    const leasesBefore = events.filter(
      (event) => event.type === "step.leased" && event.callId === calls.c.callId
    ).length;
    let thirdTouched;
    const touched = new Promise((done) => {
      thirdTouched = done;
    });
    const thirdProvider = await provider(t, "第三轮主连接", async (entry) => {
      if (isSubagent(entry.body)) return { text: "无关子项完成。" };
      thirdTouched();
      return { text: "无需恢复。" };
    });
    const third = spawnMain({
      root,
      project,
      workspace,
      taskId,
      runId,
      prompt: "再次启动确认没有重复恢复。",
      env: {
        COWORK_API_BASE: thirdProvider.baseUrl,
        COWORK_API_KEY: "recovery-main-three",
        COWORK_MODEL: "main-model"
      }
    });
    t.after(() => third.kill());
    await Promise.race([
      touched,
      delay(30_000).then(() => assert.fail("the third start never reached the model"))
    ]);
    await third.kill();
    const queueAfter = await readQueue(workspace, taskId, runId);
    assert.equal(
      queueAfter.find((item) => item.stepId === calls.c.callId).status,
      "failed",
      "a restart neither revives nor re-drives a terminal item"
    );
    const inboxAfter = JSON.parse(
      await readFile(join(workspace, taskId, "runs", runId, "agents", "main", "inbox-store.json"), "utf8")
    );
    assert.equal(
      inboxAfter.filter((message) => message.kind === "callback" && message.callId === calls.c.callId).length,
      1,
      "the refusal callback is not duplicated"
    );
    const eventsAfter = (await readFile(join(workspace, taskId, "runs", runId, "run_events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(
      eventsAfter.filter((event) => event.type === "step.leased" && event.callId === calls.c.callId).length,
      leasesBefore,
      "a restart does not re-lease the failed item"
    );
    assert.equal(thirdProvider.requests.filter((entry) => isSubagent(entry.body)).length, 0);
  }
);

test(
  "a refused delegation leaves no name, experiment row or misleading delivery warning",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-p4-refusal-"));
    const project = join(root, "project");
    const workspace = join(root, "workspace");
    await mkdir(project, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const taskId = "role-refusal";
    const runId = "role-refusal-run";
    await new LocalWorkspaceStore(workspace).createTask(taskId, {
      goal: "拒绝路径",
      projectId: "proj-roles",
      projectDirectory: project
    });
    const failures = [];
    let mainSteps = 0;
    const mainProvider = await provider(t, "主连接", async (entry) => {
      try {
        if (isSubagent(entry.body)) return { text: "执行者完成。" };
        const step = mainSteps++;
        if (step === 0)
          return {
            name: "call_subagent",
            arguments: {
              task: "执行者工作项 A：引用了不存在的前置。",
              mode: "async",
              role: "executor",
              dependsOn: ["call-does-not-exist"]
            }
          };
        if (step === 1) {
          assert.match(lastToolText(entry.body), /call-does-not-exist/);
          assert.match(lastToolText(entry.body), /不存在/);
          return {
            name: "call_subagent",
            arguments: { task: "执行者工作项 B：普通委派。", mode: "sync", role: "executor" }
          };
        }
        if (step === 2) {
          const accepted = toolJson(entry.body);
          assert.equal(accepted.status, "succeeded", JSON.stringify(accepted).slice(0, 500));
          assert.equal(accepted.name, "Ara", "a refused call must not consume a team name");
          return { text: "拒绝路径完成。" };
        }
        return { text: "拒绝路径完成。" };
      } catch (error) {
        failures.push(error.stack ?? error.message);
        return { text: "拒绝路径夹具失败。" };
      }
    });
    await writeHostConfig(root, {
      connections: [connection("main-a", "主连接", mainProvider.baseUrl, "main-model", "refusal-main")],
      host: { executor: { profileId: "main-a" } }
    });
    const main = spawnMain({
      root,
      project,
      workspace,
      taskId,
      runId,
      prompt: "先发一个引用错误前置的委派，再发普通委派。",
      env: {
        COWORK_API_BASE: mainProvider.baseUrl,
        COWORK_API_KEY: "refusal-main",
        COWORK_MODEL: "main-model"
      }
    });
    t.after(async () => {
      await main.kill();
      await rm(root, { recursive: true, force: true });
    });
    const [code] = await main.exit;
    assert.equal(code, 0, `${main.output}\n${failures.join("\n")}`);
    assert.deepEqual(failures, [], failures.join("\n"));

    const queue = await readQueue(workspace, taskId, runId);
    assert.equal(queue.length, 1, "the refused call never entered the durable queue");
    assert.equal(queue[0].status, "completed");
    // One delegation reached the Task's experiment ledger; the refused call
    // never opened a row. A succeeded text-only round is discarded again, so
    // the count that matters is the program's run counter.
    const store = new ExperimentProgramStore(workspace);
    const programs = await store.listPrograms(taskId);
    assert.equal(programs.length, 1, "only the accepted call created the Task ledger");
    assert.equal(programs[0].runCount, 1, "the refused call opened no experiment row");
    const runs = await experimentRuns(workspace, taskId);
    assert.ok(
      runs.every((run) => run.finishedAt !== undefined),
      "no experiment row is left unfinished"
    );
    assert.equal(main.output.includes("Async callback delivery deferred"), false);
  }
);

test("recovery settles an item it cannot even re-enter instead of leaving it queued", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-p4-refused-recovery-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskId = "refused-recovery";
  const runId = "refused-recovery-run";
  const store = new LocalWorkspaceStore(workspace);
  await store.createTask(taskId, { goal: "恢复拒绝", projectDirectory: join(root, "project") });
  await store.createRun(taskId, runId);
  const runPath = join(workspace, taskId, "runs", runId);
  const agentId = "subagent_1";
  await new DurableScheduler(join(runPath, "queue.json")).enqueue({
    stepId: "call-refused",
    taskId,
    runId,
    agentId,
    importance: "normal",
    payload: {
      task: "执行者工作项 A：恢复时已无法重新进入。",
      delegation: { role: "executor" },
      mode: "async"
    }
  });
  // The per-agent checkpoint is unreadable, so the runtime cannot even re-enter
  // the attempt; the refusal must still land on the durable item.
  const checkpoint = join(runPath, "agents", "subagents", agentId, "checkpoint.json");
  await mkdir(join(runPath, "agents", "subagents", agentId), { recursive: true });
  await writeFile(checkpoint, "{not json");

  const coordinator = new CoordinatorRuntime();
  const recovered = await coordinator.recoverRun({
    taskId,
    runId,
    workspaceRoot: workspace,
    baseUrl: "http://127.0.0.1:1",
    apiKey: "unused",
    model: "unused"
  });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, "failed");
  assert.ok(recovered[0].error);

  const item = (await readQueue(workspace, taskId, runId)).find((entry) => entry.stepId === "call-refused");
  assert.equal(item.status, "failed", "a refused recovery is terminal, not left queued");
  assert.ok(item.error.length > 0, "the durable item keeps the reason");
  const inbox = JSON.parse(
    await readFile(join(runPath, "agents", "main", "inbox-store.json"), "utf8")
  ).filter((message) => message.kind === "callback" && message.callId === "call-refused");
  assert.equal(inbox.length, 1, "the reason reaches Main through one callback");

  // A second pass has nothing to re-drive and adds no duplicate callback.
  const again = await coordinator.recoverRun({
    taskId,
    runId,
    workspaceRoot: workspace,
    baseUrl: "http://127.0.0.1:1",
    apiKey: "unused",
    model: "unused"
  });
  assert.deepEqual(again, []);
  const inboxAgain = JSON.parse(
    await readFile(join(runPath, "agents", "main", "inbox-store.json"), "utf8")
  ).filter((message) => message.kind === "callback" && message.callId === "call-refused");
  assert.equal(inboxAgain.length, 1);
});
