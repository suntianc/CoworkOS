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
    for (const agent of observedAgents) {
      assert.equal(agent.workspace, workspace);
      assert.equal(agent.status, "running", "every work item is actively working at the observation point");
    }
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
      assert.equal(agent.workspace, workspace);
      assert.equal(agent.model, "protocol-fixture");
    }
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

    const main = spawnChild();
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

    function spawnChild() {
      const inherited = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            !/^(COWORK_|ATRIA_|PI_|SERPER_|OPENAI_|ANTHROPIC_)/.test(name) && name !== "NODE_OPTIONS"
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
          "依次验证执行者与审查者的模型角色。"
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
            COWORK_API_BASE: mainProvider.baseUrl,
            COWORK_API_KEY: keys.main,
            COWORK_MODEL: "main-model",
            COWORK_MODEL_API: "openai-completions",
            COWORK_REASONING_EFFORT: "off",
            COWORK_SUPPORTS_REASONING_EFFORT: "0",
            COWORK_WEB_TOOLS: "0",
            COWORK_MAX_ATTEMPTS: "1",
            COWORK_SUBAGENT_TIMEOUT_MS: "60000",
            PI_CODING_AGENT_DIR: join(root, "pi"),
            PI_OFFLINE: "1"
          }
        }
      );
      let output = "";
      const record = (chunk) => {
        output = (output + chunk).slice(-40_000);
      };
      child.stdout.on("data", record);
      child.stderr.on("data", record);
      return {
        child,
        get output() {
          return output;
        },
        exit: once(child, "exit")
      };
    }
  }
);
