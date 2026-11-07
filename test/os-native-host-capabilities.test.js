import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createDashboardApplication } from "../dist/src/dashboard/application.js";
import { installComputerUse } from "../web/assets/controllers/computer-use.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const hostToken = "native-host-fixture-token";
const require = createRequire(import.meta.url);
const { createComputerHost } = require("../desktop/computer-host.cjs");
const {
  createComputerPolicyController,
  createComputerPolicyStore
} = require("../desktop/computer-policy.cjs");
const repositoryRoot = resolve(".");
const backendEntry = join(repositoryRoot, "dist/src/cli/backend.js");

async function dashboardFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "cowork-native-host-"));
  const environment = { ...process.env };
  for (const key of Object.keys(process.env))
    if (/^(COWORK_|ATRIA_|PI_|ELECTRON_)/.test(key)) delete process.env[key];
  Object.assign(process.env, {
    ATRIA_HOME: root,
    COWORK_WORKSPACE: join(root, "workspace"),
    COWORK_CONFIG: join(root, "config.json"),
    COWORK_API_TOKEN: hostToken,
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_OFFLINE: "1"
  });
  await writeFile(join(root, "config.json"), "{}\n");
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const identity = { backendId: "native_fixture", pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" };
  const app = createDashboardApplication({
    projectRoot: resolve("."),
    port,
    backendIdentity: identity,
    ...options
  });
  app.server.listen(port, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => {
    await app.stop();
    for (const key of Object.keys(process.env))
      if (/^(COWORK_|ATRIA_|PI_|ELECTRON_)/.test(key)) delete process.env[key];
    Object.assign(process.env, environment);
    await rm(root, { recursive: true, force: true });
  });
  async function request(path, { token = hostToken, body, approval } = {}) {
    const response = await fetch(`${app.dashboardUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-atria-token": token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(approval ? { "x-computer-approval": approval } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  }
  const host = (input, token, approval) =>
    request("/api/host/computer", { token, approval, body: { ...identity, input } });
  return { request, host, identity, root, url: app.dashboardUrl };
}

test("client sessions can inspect and pause but cannot prompt or grant host permissions", async (t) => {
  let prompts = 0;
  let approvals = 0;
  const fixture = await dashboardFixture(t, {
    computerApprovalAuthenticate: async () => (++approvals, true),
    computerDriver: {
      status: async () => ({ available: true, screenRecording: false, accessibility: false, windows: [] }),
      requestPermissions: async () => (++prompts, { requested: true }),
      observe: async () => {
        throw new Error("unexpected observation");
      },
      act: async () => {
        throw new Error("unexpected action");
      }
    }
  });
  const session = await fixture.request("/api/session", {
    body: { clientName: "remote fixture", protocolVersion: "1.0" }
  });
  assert.equal(session.status, 201);
  const token = session.body.session.token;
  assert.equal((await fixture.request("/api/computer/status", { token })).status, 200);
  assert.equal((await fixture.host({ operation: "pause" }, token)).status, 200);
  assert.equal(
    (await fixture.host({ operation: "permissions", permission: "screenRecording" }, token)).status,
    403
  );
  assert.equal(
    (await fixture.request("/api/host/computer/approve", { token, body: fixture.identity })).status,
    403
  );
  assert.equal(prompts, 0);
  assert.equal(approvals, 0);
  assert.equal((await fixture.host({ operation: "permissions", permission: "accessibility" })).status, 200);
  assert.equal(prompts, 1);
  const approved = await fixture.request("/api/host/computer/approve", { body: fixture.identity });
  assert.equal(approved.status, 200);
  const enable = { operation: "policy", enabled: true, mode: "control" };
  assert.equal((await fixture.host(enable, token, approved.body.approval.token)).status, 403);
  assert.equal((await fixture.host(enable, hostToken, approved.body.approval.token)).status, 200);
});

test("web settings show execution-host permissions without requesting the client device", async (t) => {
  let status = { available: true, screenRecording: false, accessibility: true, windows: [] };
  let prompts = 0;
  const fixture = await dashboardFixture(t, {
    computerDriver: {
      status: async () => status,
      requestPermissions: async () => (++prompts, { requested: true }),
      observe: async () => {
        throw new Error("unexpected observation");
      },
      act: async () => {
        throw new Error("unexpected action");
      }
    }
  });
  const session = await fixture.request("/api/session", {
    body: { clientName: "web fixture", protocolVersion: "1.0" }
  });
  const token = session.body.session.token;
  const { window, document } = parseHTML(`
    <div id="profile-modal"><div id="profile-settings-tools"></div></div>
    <button id="user-menu-button"></button><main id="conversation"></main>`);
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = window;
  globalThis.document = document;
  t.after(() => {
    window.dispatchEvent(new window.Event("pagehide"));
    globalThis.window = previous.window;
    globalThis.document = previous.document;
  });
  let heldStatus;
  let pendingStatus;
  const controller = installComputerUse({
    api: async (path) => {
      const result = await fixture.request(path, { token });
      assert.equal(result.status, 200);
      if (path === "/api/computer/status" && heldStatus) {
        const held = heldStatus;
        heldStatus = undefined;
        pendingStatus.resolve();
        await held.promise;
      }
      return result.body;
    },
    getSelectedTaskId: () => null,
    getTaskLabel: () => "",
    showToast: () => {}
  });
  const permissions = document.querySelector("[data-computer-permissions]");
  const state = document.querySelector("[data-computer-state]");
  await waitFor(() => permissions.textContent.includes("屏幕录制"));
  assert.match(permissions.textContent, /执行主机/);
  assert.match(permissions.textContent, /屏幕录制：未开启/);
  assert.match(permissions.textContent, /辅助功能：已开启/);
  assert.equal(document.querySelector(".computer-permission-actions").hidden, true);
  assert.equal(prompts, 0);
  status = {
    available: true,
    screenRecording: true,
    accessibility: true,
    controlAvailable: false,
    windows: [],
    reason: "无图形桌面"
  };
  document.querySelector("#user-menu-button").click();
  await waitFor(() => permissions.textContent.includes("无图形桌面"));
  assert.match(state.textContent, /不可用/);
  assert.match(permissions.textContent, /执行主机/);
  assert.equal(prompts, 0);
  heldStatus = Promise.withResolvers();
  pendingStatus = Promise.withResolvers();
  const old = heldStatus;
  document.querySelector("#user-menu-button").click();
  await pendingStatus.promise;
  controller.reset();
  status = { available: true, screenRecording: true, accessibility: false, windows: [] };
  await controller.refresh();
  assert.match(permissions.textContent, /辅助功能：未开启/);
  old.resolve();
  await new Promise((done) => setTimeout(done, 20));
  assert.match(permissions.textContent, /辅助功能：未开启/);
  assert.doesNotMatch(permissions.textContent, /无图形桌面/);
});

test("host permission recovery and takeover invalidate old observations and target identities", async (t) => {
  const target = {
    pid: 11,
    windowId: 12,
    bundleId: "fixture.window",
    application: "Fixture",
    title: "Probe"
  };
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  let holdObservation = false;
  let screenRecording = false;
  let permissionPrompts = 0;
  let confirmations = 0;
  const effects = [];
  const fixture = await dashboardFixture(t, {
    computerApprovalAuthenticate: async () => (++confirmations, true),
    computerDriver: {
      status: async () => ({
        available: true,
        screenRecording,
        accessibility: true,
        controlAvailable: true,
        postEventAccess: true,
        windows: [target]
      }),
      requestPermissions: async () => (++permissionPrompts, { requested: true }),
      observe: async () => {
        if (holdObservation) {
          started.resolve();
          await gate.promise;
        }
        return {
          width: 1,
          height: 1,
          image:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          frame: { x: 0, y: 0, width: 1, height: 1 }
        };
      },
      act: async (_target, action) => {
        effects.push(action.type);
      }
    }
  });
  const instance = { ...fixture.identity, url: fixture.url, token: hostToken };
  let inspected = instance;
  const computer = createComputerHost({ expected: instance, inspect: async () => inspected });
  const backend = { computer };
  const store = createComputerPolicyStore(fixture.root);
  await store.load();
  let settingsOpened = 0;
  const controller = createComputerPolicyController({
    store,
    getBackend: () => backend,
    registerTakeover: () => undefined,
    openPermissionSettings: async () => {
      settingsOpened++;
    }
  });
  await controller.initialize(backend);
  const denied = await controller.request({ operation: "permissions", permission: "screenRecording" });
  assert.equal(denied.screenRecording, false);
  assert.equal(permissionPrompts, 1);
  assert.equal(settingsOpened, 1);
  await assert.rejects(
    controller.request({ operation: "policy", enabled: true, mode: "control" }),
    /系统权限/
  );
  assert.equal(confirmations, 0);
  screenRecording = true;
  assert.equal(
    (await controller.request({ operation: "permissions", permission: "screenRecording" })).screenRecording,
    true
  );
  assert.equal(permissionPrompts, 1);
  assert.equal(
    (await controller.request({ operation: "policy", enabled: true, mode: "control" })).enabled,
    true
  );
  assert.equal(confirmations, 1);

  const session = await fixture.request("/api/session", {
    body: { clientName: "task fixture", protocolVersion: "1.0" }
  });
  const token = session.body.session.token;
  assert.equal(
    (await fixture.request("/api/tasks", { token, body: { taskId: "native-task", goal: "probe" } })).status,
    201
  );
  const select = await fixture.request("/api/tasks/native-task/computer/select", {
    token,
    body: { pid: target.pid, windowId: target.windowId, mode: "control" }
  });
  assert.equal(select.status, 200);
  const sessionId = select.body.session.sessionId;
  const observed = await fixture.request("/api/tasks/native-task/computer/observe", {
    token,
    body: { sessionId }
  });
  assert.equal(observed.status, 200);
  const action = { sessionId, observationId: observed.body.observationId, action: { type: "activate" } };
  holdObservation = true;
  const late = fixture.request("/api/tasks/native-task/computer/observe", { token, body: { sessionId } });
  await started.promise;
  const queued = fixture.request("/api/tasks/native-task/computer/act", { token, body: action });
  await controller.request({ operation: "pause" });
  gate.resolve();
  assert.notEqual((await late).status, 200);
  assert.notEqual((await queued).status, 200);
  assert.deepEqual(effects, []);
  await controller.request({ operation: "resume" });
  assert.notEqual(
    (await fixture.request("/api/tasks/native-task/computer/act", { token, body: action })).status,
    200
  );
  holdObservation = false;
  const current = await fixture.request("/api/tasks/native-task/computer", { token });
  assert.notEqual(current.body.session.sessionId, sessionId);
  const fresh = await fixture.request("/api/tasks/native-task/computer/observe", {
    token,
    body: { sessionId: current.body.session.sessionId }
  });
  assert.equal(fresh.status, 200);
  const acted = await fixture.request("/api/tasks/native-task/computer/act", {
    token,
    body: {
      sessionId: current.body.session.sessionId,
      observationId: fresh.body.observationId,
      action: { type: "activate" }
    }
  });
  assert.equal(acted.status, 200);
  assert.deepEqual(effects, ["activate"]);
  inspected = { ...instance, startedAt: "2026-01-02T00:00:00.000Z" };
  await assert.rejects(computer({ operation: "permissions", permission: "screenRecording" }), /身份已改变/);
  assert.equal(permissionPrompts, 1);
  inspected = instance;
  await controller.request({ operation: "policy", enabled: false, mode: "control" });
  assert.notEqual(
    (
      await fixture.request("/api/tasks/native-task/computer/observe", {
        token,
        body: { sessionId: current.body.session.sessionId }
      })
    ).status,
    200
  );
});

test(
  "an independent backend completes a code task after its client exits without a graphical host",
  { timeout: 150_000 },
  async (t) => {
    const base = await mkdtemp(join(tmpdir(), "cowork-headless-host-"));
    const home = join(base, "home");
    const project = join(base, "project");
    const userHome = join(base, "user");
    for (const directory of [home, project, userHome, join(base, "workspace")])
      await mkdir(directory, { recursive: true });
    const config = join(base, "config.json");
    await writeFile(config, "{}\n");
    const executable = join(base, "headless-computer-fixture");
    await writeFile(
      executable,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({available:false,screenRecording:false,accessibility:false,controlAvailable:false,windows:[],reason:"fixture: no graphical desktop"}));\n`,
      { mode: 0o755 }
    );
    const release = Promise.withResolvers();
    const received = Promise.withResolvers();
    const failures = [];
    let step = 0;
    const report = "headless fixture result\n";
    const model = await modelProtocolFixture("openai-completions", async (request) => {
      try {
        if (step === 0) {
          received.resolve();
          await release.promise;
        }
        switch (step++) {
          case 0:
            return {
              name: "bash",
              arguments: { command: `${process.execPath} ${join(project, "check-permission.mjs")}` }
            };
          case 1:
            return { name: "read", arguments: { path: join(project, "input.txt") } };
          case 2:
            assert.match(
              JSON.stringify(request.messages.findLast((message) => message.role === "tool")?.content),
              /fixture input/
            );
            return { name: "write", arguments: { path: join(project, "result.txt"), content: report } };
          default:
            return { text: "完成。" };
        }
      } catch (error) {
        failures.push(error.message);
        return { text: "fixture failed" };
      }
    });
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(COWORK_|ATRIA_|PI_|ELECTRON_|SERPER_|EXA_)/.test(key))
    );
    const env = {
      ...inherited,
      HOME: userHome,
      ATRIA_HOME: home,
      PI_CODING_AGENT_DIR: join(base, "pi"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      COWORK_HARNESS_ROOT: repositoryRoot,
      COWORK_WORKSPACE: join(base, "workspace"),
      COWORK_GLOBAL_INDEX: join(home, "runtime/workspaces.json"),
      COWORK_TABS_INDEX: join(home, "runtime/tabs.json"),
      COWORK_CONFIG: config,
      COWORK_DISABLE_WATCH_SUPERVISOR: "1",
      COWORK_COMPUTER_USE_EXECUTABLE: executable,
      COWORK_API_BASE: model.baseUrl,
      COWORK_API_KEY: "local-fixture",
      COWORK_MODEL: "protocol-fixture",
      COWORK_REASONING_EFFORT: "off",
      COWORK_SUPPORTS_REASONING_EFFORT: "0"
    };
    let instance;
    let backendPid;
    t.after(async () => {
      release.resolve();
      try {
        if (backendPid) {
          const stopped = await runProcess(process.execPath, [backendEntry, "stop"], env);
          if (stopped.code !== 0) {
            try {
              process.kill(backendPid, "SIGKILL");
            } catch (error) {
              if (error.code !== "ESRCH") throw error;
            }
          }
          assert.equal(stopped.code, 0, stopped.stderr);
          assert.equal(JSON.parse(stopped.stdout).state, "stopped");
        }
      } finally {
        await model.close();
        await rm(base, { recursive: true, force: true });
      }
    });
    await writeFile(join(project, "input.txt"), "fixture input\n");
    await writeFile(
      join(project, "check-permission.mjs"),
      `
import { writeFile } from "node:fs/promises";
const url = process.env.COWORK_DASHBOARD_URL;
const headers = {"x-atria-token": process.env.COWORK_API_TOKEN, "content-type": "application/json"};
await writeFile(${JSON.stringify(join(project, "run-credential.txt"))}, process.env.COWORK_API_TOKEN);
const info = await (await fetch(url + "/api/backend", {headers})).json();
const response = await fetch(url + "/api/host/computer", {
  method:"POST", headers,
  body:JSON.stringify({backendId:info.backendId, pid:info.pid, startedAt:info.startedAt,
    input:{operation:"permissions",permission:"screenRecording"}})
});
await writeFile(${JSON.stringify(join(project, "permission-status.txt"))}, String(response.status));
`
    );
    const started = await runProcess(process.execPath, [backendEntry, "start"], env);
    assert.equal(started.code, 0, started.stderr);
    const startedState = JSON.parse(started.stdout);
    assert.equal(startedState.state, "started");
    backendPid = startedState.pid;
    instance = JSON.parse(await readFile(join(home, "runtime/backend-instance.json"), "utf8"));
    assert.equal(instance.pid, startedState.pid);
    const call = async (path) => {
      const response = await fetch(`${instance.url}${path}`, {
        headers: { "x-atria-token": instance.token }
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const status = await call("/api/computer/status");
    assert.equal(status.available, false);
    assert.ok(status.reason);
    if (process.platform === "darwin") assert.equal(status.reason, "fixture: no graphical desktop");
    const client = join(base, "client.mjs");
    await writeFile(
      client,
      `
const [url, token, project] = process.argv.slice(2);
const headers = {"x-atria-token": token, "content-type": "application/json"};
async function post(path, body) {
  const response = await fetch(url + path, {method:"POST", headers, body:JSON.stringify(body)});
  const result = await response.json();
  if (!response.ok) throw new Error(path + " " + JSON.stringify(result));
  return result;
}
const created = await post("/api/projects", {projectName:"Headless", projectDirectory:project});
await post("/api/tasks", {taskId:"headless-task", goal:"write result", projectId:created.project.projectId});
await post("/api/tasks/headless-task/run", {prompt:"Read input.txt and write result.txt."});
process.stdout.write("client exited");
`
    );
    const clientResult = await runProcess(
      process.execPath,
      [client, instance.url, instance.token, project],
      env
    );
    assert.equal(clientResult.code, 0, clientResult.stderr);
    assert.equal(clientResult.stdout, "client exited");
    await received.promise;
    assert.equal((await call("/api/tasks/headless-task")).runtime.active, true);
    release.resolve();
    await waitFor(async () => {
      const task = await call("/api/tasks/headless-task");
      return !task.runtime.active && task.task.status === "completed";
    }, 60_000);
    assert.deepEqual(failures, []);
    assert.equal(await readFile(join(project, "permission-status.txt"), "utf8"), "403");
    assert.equal(await readFile(join(project, "result.txt"), "utf8"), report);
    assert.equal((await call("/api/backend")).pid, instance.pid);
    assert.equal((await call("/api/computer/status")).available, false);
    const runCredential = await readFile(join(project, "run-credential.txt"), "utf8");
    const stopped = await runProcess(process.execPath, [backendEntry, "stop"], env);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(JSON.parse(stopped.stdout).state, "stopped");
    backendPid = undefined;
    const restarted = await runProcess(process.execPath, [backendEntry, "start"], env);
    assert.equal(restarted.code, 0, restarted.stderr);
    const restartedState = JSON.parse(restarted.stdout);
    backendPid = restartedState.pid;
    const priorIdentity = instance.backendId;
    instance = JSON.parse(await readFile(join(home, "runtime/backend-instance.json"), "utf8"));
    assert.equal(instance.backendId, priorIdentity);
    assert.notEqual(instance.pid, startedState.pid);
    assert.equal(
      (await fetch(`${instance.url}/api/computer/status`, { headers: { "x-atria-token": runCredential } }))
        .status,
      401
    );
    assert.equal((await call("/api/computer/access")).policy.enabled, false);
  }
);

async function runProcess(entry, args, env) {
  const child = spawn(entry, args, { cwd: repositoryRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const [code] = await once(child, "close");
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for fixture result");
    await new Promise((done) => setTimeout(done, 10));
  }
}
