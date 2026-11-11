import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";

/**
 * What a real Main process is actually asked.
 *
 * Two strict local providers stand in for two accounts. The only evidence used
 * is the request each one received — path, key, model and reasoning effort —
 * so a role that resolves to the wrong connection, or a settings change that
 * rewrites an in-flight request, shows up as the wrong account being called.
 */

async function provider(t, label, { hold, api = "openai-completions" } = {}) {
  const requests = [];
  const failures = [];
  const expectedPath = api === "openai-responses" ? "/v1/responses" : "/v1/chat/completions";
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET") return response.end(JSON.stringify({ data: [{ id: label }] }));
      let raw = "";
      for await (const chunk of request.setEncoding("utf8")) raw += chunk;
      const body = JSON.parse(raw);
      requests.push({ authorization: request.headers.authorization, body, path: request.url, api });
      const gate = hold?.(requests.length);
      if (gate) await gate;
      if (request.url !== expectedPath) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end('{"error":{"message":"unexpected path"}}');
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(protocolStream(api, { text: `${label} 已完成` }));
    } catch (error) {
      failures.push(error.stack ?? error.message);
      response.destroy(error);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  return {
    label,
    base: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    failures
  };
}

function client(dashboard) {
  return async (path, body, method) => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };
}

const userText = (body) =>
  (body.messages ?? body.input ?? [])
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    )
    .join("\n");

async function createProject(request, dashboard, name) {
  const directory = join(dashboard.root, `project-${name}`);
  await mkdir(directory, { recursive: true });
  const created = await request("/api/projects", {
    projectName: `项目 ${name}`,
    projectDirectory: directory
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.project;
}

async function saveConnection(request, value) {
  const saved = await request("/api/model-settings", {
    api: "openai-completions",
    supportsImages: false,
    supportsReasoningEffort: true,
    ...value
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return saved.body;
}

async function createTask(request, projectId, taskId) {
  const created = await request("/api/tasks", { taskId, goal: `${taskId} 的目标`, projectId });
  assert.equal(created.status, 201, JSON.stringify(created.body));
}

async function startRun(request, taskId, body) {
  const started = await request(`/api/tasks/${taskId}/run`, { prompt: `请处理 ${taskId}。`, ...body });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return started.body;
}

async function settle(request, taskId, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const detail = await request(`/api/tasks/${taskId}`);
    if (detail.status === 200 && !detail.body.runtime.active && detail.body.task.status === "completed")
      return detail.body;
    await delay(50);
  }
  assert.fail(`Main ${taskId} did not settle`);
}

async function spawnedPayload(dashboard, taskId, runId) {
  const path = join(dashboard.workspaceRoot, taskId, "runs", runId, "run_events.jsonl");
  const lines = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const spawned = lines.filter((event) => event.type === "main.run_spawned");
  assert.equal(spawned.length, 1, `expected one spawn event in ${path}`);
  return { payload: spawned[0].payload, raw: lines.map((line) => JSON.stringify(line)).join("\n") };
}

const waitFor = async (check, message, timeout = 20_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(message);
};

test(
  "real Main runs use the host default, project override and one-off connection without changing in-flight work",
  { timeout: 180_000 },
  async (t) => {
    const a = await provider(t, "连接A");
    const b = await provider(t, "连接B", { api: "openai-responses" });
    const dashboard = await startDashboard({ defaultProject: false });
    t.after(() => dashboard.stop());
    const request = client(dashboard);
    const keyA = "{{SECRET_9v2tq1wm}}";
    const keyB = "{{SECRET_w3zzm6aq}}";
    const first = await saveConnection(request, {
      profileName: "连接 A",
      baseUrl: a.base,
      model: "model-a",
      apiKey: keyA,
      reasoningEffort: "low"
    });
    const withB = await saveConnection(request, {
      profileId: "",
      profileName: "连接 B",
      baseUrl: b.base,
      model: "model-b",
      api: "openai-responses",
      apiKey: keyB,
      reasoningEffort: "high"
    });
    const profileA = withB.profiles.find((profile) => profile.name === "连接 A");
    const profileB = withB.profiles.find((profile) => profile.name === "连接 B");
    assert.ok(first.activeProfileId);
    assert.ok(profileA && profileB);
    await saveConnection(request, {
      profileId: profileA.id,
      profileName: "连接 A",
      baseUrl: a.base,
      model: "model-a",
      apiKey: "",
      reasoningEffort: "low",
      activate: true
    });
    const projectA = await createProject(request, dashboard, "a");
    const projectB = await createProject(request, dashboard, "b");

    // The existing active connection is still the default when no role is set.
    await createTask(request, projectA.projectId, "role-default");
    await startRun(request, "role-default");
    await settle(request, "role-default");
    assert.equal(a.requests.length, 1);
    assert.equal(b.requests.length, 0);
    assert.equal(a.requests[0].authorization, `Bearer ${keyA}`, "the host store supplied the key");
    assert.equal(a.requests[0].body.model, "model-a");
    assert.equal(a.requests[0].body.reasoning_effort, "low");
    assert.match(userText(a.requests[0].body), /role-default/);

    const configText = await readFile(join(dashboard.root, "config.json"), "utf8");
    const storedProfiles = JSON.parse(configText).modelConnections.profiles;
    const contextA = storedProfiles.find((profile) => profile.id === profileA.id).contextId;
    const contextB = storedProfiles.find((profile) => profile.id === profileB.id).contextId;
    const credentialsText = await readFile(join(dashboard.root, "credentials.json"), "utf8");
    assert.equal(configText.includes(keyA) || configText.includes(keyB), false);
    assert.equal(JSON.parse(credentialsText).modelConnections[profileA.id], keyA);
    assert.equal(JSON.parse(credentialsText).modelConnections[profileB.id], keyB);
    const publicText = JSON.stringify(await request("/api/model-settings"));
    assert.equal(publicText.includes(keyA) || publicText.includes(keyB), false);

    // Host default: the next Run switches connection, model and reasoning profile.
    const hosted = await request("/api/model-settings/roles", { role: "main", profileId: profileB.id });
    assert.equal(hosted.status, 200, JSON.stringify(hosted.body));
    await createTask(request, projectA.projectId, "role-host");
    const hostRun = await startRun(request, "role-host");
    await settle(request, "role-host");
    assert.equal(b.requests.length, 1, "the host role reached connection B");
    assert.equal(a.requests.length, 1);
    assert.equal(b.requests[0].authorization, `Bearer ${keyB}`);
    assert.equal(b.requests[0].path, "/v1/responses", "the role connection's protocol is pinned");
    assert.equal(b.requests[0].body.model, "model-b");
    assert.equal(b.requests[0].body.reasoning.effort, "high", "the role connection's profile is pinned");
    assert.match(userText(b.requests[0].body), /role-host/);
    const hostSnapshot = await spawnedPayload(dashboard, "role-host", hostRun.runId);
    assert.deepEqual(hostSnapshot.payload.modelSelection, {
      role: "main",
      source: "host",
      connectionId: contextB,
      connectionName: "连接 B",
      model: "model-b",
      api: "openai-responses",
      thinkingLevel: "high",
      supportsImages: false,
      projectId: projectA.projectId
    });
    assert.equal(hostSnapshot.raw.includes(keyB), false, "the Run record never stores a key");

    // Project override: project A moves to connection A while project B keeps the host default.
    await request("/api/model-settings/roles", {
      role: "main",
      projectId: projectA.projectId,
      profileId: profileA.id
    });
    await createTask(request, projectA.projectId, "role-project-a");
    await startRun(request, "role-project-a");
    await settle(request, "role-project-a");
    assert.equal(a.requests.length, 2);
    assert.equal(a.requests[1].body.model, "model-a");
    assert.equal(a.requests[1].body.reasoning_effort, "low");
    assert.equal(b.requests.length, 1);
    await createTask(request, projectB.projectId, "role-project-b");
    await startRun(request, "role-project-b");
    await settle(request, "role-project-b");
    assert.equal(b.requests.length, 2, "project B is unaffected by project A's override");
    assert.equal(b.requests[1].body.model, "model-b");

    // Two sessions in one project: a one-off selection never rewrites the project.
    await createTask(request, projectA.projectId, "role-once");
    const onceRun = await startRun(request, "role-once", { profileId: profileB.id, model: "model-once" });
    await settle(request, "role-once");
    assert.equal(b.requests.length, 3);
    assert.equal(b.requests[2].body.model, "model-once");
    assert.equal(a.requests.length, 2, "the explicit session did not leak onto the other provider");
    const onceSnapshot = await spawnedPayload(dashboard, "role-once", onceRun.runId);
    assert.equal(onceSnapshot.payload.modelSelection.source, "explicit");
    assert.equal(onceSnapshot.payload.modelSelection.connectionId, contextB);
    assert.equal(onceSnapshot.payload.modelSelection.model, "model-once");
    const scoped = await request(`/api/model-settings?projectId=${projectA.projectId}`);
    assert.equal(
      scoped.body.modelRoles.roles.find((role) => role.role === "main").project.profileId,
      profileA.id,
      "a one-off choice leaves the saved project override alone"
    );
    await createTask(request, projectA.projectId, "role-after-once");
    await startRun(request, "role-after-once");
    await settle(request, "role-after-once");
    assert.equal(a.requests.length, 3, "the next default Run returns to the project override");
    assert.equal(a.requests[2].body.model, "model-a");

    // An explicit reference that no longer exists refuses the launch instead of switching accounts.
    await createTask(request, projectA.projectId, "role-missing");
    const refused = await request("/api/tasks/role-missing/run", {
      prompt: "不应启动",
      profileId: "deleted-connection"
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.match(refused.body.error, /deleted-connection/);
    assert.match(refused.body.error, /不存在/);
    assert.equal(a.requests.length, 3);
    assert.equal(b.requests.length, 3);
    const missing = await request("/api/tasks/role-missing");
    assert.equal(missing.body.runtime.active, false);
    assert.notEqual(missing.body.task.status, "running");

    // In-flight Runs keep the connection they were admitted with; the next Run reads the change.
    let release;
    let armed = false;
    const holdGate = () => {
      if (!armed) return undefined;
      armed = false;
      return new Promise((done) => (release = done));
    };
    const heldProvider = await provider(t, "连接B", { hold: holdGate });
    const heldSaved = await saveConnection(request, {
      profileId: "",
      profileName: "连接 B 挂起",
      baseUrl: heldProvider.base,
      model: "model-held",
      apiKey: "{{SECRET_held00001}}",
      reasoningEffort: "high"
    });
    const heldProfile = heldSaved.profiles.find((profile) => profile.name === "连接 B 挂起");
    await request("/api/model-settings/roles", { role: "main", profileId: heldProfile.id });
    await createTask(request, projectB.projectId, "role-in-flight");
    armed = true;
    const inFlight = await startRun(request, "role-in-flight");
    await waitFor(
      () => heldProvider.requests.length === 1,
      "the in-flight Run never reached its admitted connection"
    );
    assert.equal(heldProvider.requests[0].body.model, "model-held");
    assert.equal(heldProvider.requests[0].body.reasoning_effort, "high");
    const changed = await request("/api/model-settings/roles", { role: "main", profileId: profileA.id });
    assert.equal(changed.status, 200, "a role change is allowed while another Run is in flight");
    release();
    await settle(request, "role-in-flight");
    const inFlightSnapshot = await spawnedPayload(dashboard, "role-in-flight", inFlight.runId);
    assert.equal(inFlightSnapshot.payload.modelSelection.connectionName, "连接 B 挂起");
    await createTask(request, projectB.projectId, "role-next");
    await startRun(request, "role-next");
    await settle(request, "role-next");
    assert.equal(a.requests.length, 4, "the next Run uses the new host default");
    assert.equal(a.requests[3].body.model, "model-a");

    assert.deepEqual(heldProvider.failures, []);
    assert.deepEqual(a.failures, []);
    assert.deepEqual(b.failures, []);
  }
);

test(
  "a real CLI launch reads the same host Main role and its connection profile",
  { timeout: 120_000 },
  async (t) => {
    const a = await provider(t, "连接A");
    const b = await provider(t, "连接B");
    const root = await mkdtemp(join(tmpdir(), "atria-role-cli-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const configPath = join(root, "config.json");
    const projectDirectory = join(root, "project");
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          modelConnections: {
            version: 1,
            activeId: "cli-a",
            profiles: [
              {
                id: "cli-a",
                name: "连接 A",
                baseUrl: a.base,
                model: "model-a",
                apiKey: "{{SECRET_clikeya1}}",
                api: "openai-completions",
                thinkingFormat: "auto",
                reasoningEffort: "low",
                supportsReasoningEffort: true,
                supportsPromptCacheKey: false,
                mainMaxTokens: 8192,
                subagentMaxTokens: 8192,
                contextWindow: 128000,
                supportsImages: false
              },
              {
                id: "cli-b",
                name: "连接 B",
                baseUrl: b.base,
                model: "model-b",
                apiKey: "{{SECRET_clikeyb2}}",
                api: "openai-completions",
                thinkingFormat: "auto",
                reasoningEffort: "high",
                supportsReasoningEffort: true,
                supportsPromptCacheKey: false,
                mainMaxTokens: 4096,
                subagentMaxTokens: 2048,
                contextWindow: 64000,
                supportsImages: false
              }
            ]
          },
          roleModels: { version: 1, host: { main: { profileId: "cli-b" } } }
        },
        null,
        2
      )
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_|SERPER_|EXA_)/.test(name))
    );
    Object.assign(env, {
      ATRIA_HOME: join(root, "home"),
      PI_CODING_AGENT_DIR: join(root, "pi"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      COWORK_CONFIG: configPath,
      COWORK_HARNESS_ROOT: resolve("."),
      COWORK_WORKSPACE: join(root, "workspace"),
      COWORK_GLOBAL_INDEX: join(root, "global.json"),
      COWORK_PROJECT_DIR: projectDirectory,
      COWORK_DISABLE_WATCH_SUPERVISOR: "1"
    });
    const child = spawn(
      process.execPath,
      ["scripts/start-pi.mjs", "--print", "--no-session", "请确认 CLI 角色连接。"],
      { cwd: resolve("."), env, stdio: ["ignore", "pipe", "pipe"] }
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const [code] = await once(child, "close");
    assert.equal(code, 0, output);
    assert.equal(b.requests.length, 1, output);
    assert.equal(a.requests.length, 0, "the CLI did not fall back to the active connection");
    assert.equal(b.requests[0].authorization, "Bearer {{SECRET_clikeyb2}}");
    assert.equal(b.requests[0].body.model, "model-b");
    assert.equal(b.requests[0].body.reasoning_effort, "high");
    assert.match(output, /连接B 已完成/);
  }
);

test(
  "the CLI reports a broken role reference instead of borrowing another account",
  { timeout: 60_000 },
  async (t) => {
    const a = await provider(t, "连接A");
    const root = await mkdtemp(join(tmpdir(), "atria-role-cli-broken-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      join(root, "config.json"),
      JSON.stringify({
        modelConnections: {
          version: 1,
          activeId: "cli-a",
          profiles: [
            {
              id: "cli-a",
              name: "连接 A",
              baseUrl: a.base,
              model: "model-a",
              apiKey: "{{SECRET_clibroken}}",
              api: "openai-completions",
              reasoningEffort: "low",
              supportsReasoningEffort: true,
              supportsPromptCacheKey: false,
              mainMaxTokens: 8192,
              subagentMaxTokens: 8192,
              contextWindow: 128000
            }
          ]
        },
        roleModels: { version: 1, host: { main: { profileId: "gone" } } }
      })
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_|SERPER_|EXA_)/.test(name))
    );
    Object.assign(env, {
      ATRIA_HOME: join(root, "home"),
      PI_CODING_AGENT_DIR: join(root, "pi"),
      PI_OFFLINE: "1",
      COWORK_CONFIG: join(root, "config.json"),
      COWORK_HARNESS_ROOT: resolve("."),
      COWORK_WORKSPACE: join(root, "workspace"),
      COWORK_GLOBAL_INDEX: join(root, "global.json"),
      COWORK_PROJECT_DIR: join(root, "project"),
      COWORK_DISABLE_WATCH_SUPERVISOR: "1"
    });
    const child = spawn(process.execPath, ["scripts/start-pi.mjs", "--print", "--no-session", "不应启动"], {
      cwd: resolve("."),
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const [code] = await once(child, "close");
    assert.equal(code, 1, output);
    assert.match(output, /gone/);
    assert.match(output, /不存在/);
    assert.equal(a.requests.length, 0, "a broken role never falls back to the active account");
  }
);
