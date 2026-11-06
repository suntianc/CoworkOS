import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { connectBackend } = require("../desktop/backend.cjs");
const { desktopPaths, prepareDesktopData } = require("../desktop/paths.cjs");
const root = resolve(new URL("..", import.meta.url).pathname);

async function call(instance, operation, credential = instance.token, headers = {}) {
  const response = await fetch(`${instance.url}/api/host/computer`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(credential ? { "x-atria-token": credential } : {}),
      ...headers
    },
    body: JSON.stringify({ backendId: instance.backendId, pid: instance.pid, input: operation }),
    signal: AbortSignal.timeout(10000)
  });
  return { status: response.status, body: await response.json() };
}

async function access(instance) {
  const response = await fetch(`${instance.url}/api/computer/access`, {
    headers: { "x-atria-token": instance.token }
  });
  assert.equal(response.status, 200);
  return response.json();
}

test(
  "desktop host reaches only its verified independent backend computer controller",
  { timeout: 90000 },
  async (t) => {
    const base = await mkdtemp(join(tmpdir(), "cowork-computer-host-"));
    const env = { ...process.env };
    for (const key of Object.keys(process.env))
      if (/^(COWORK_|PI_|ATRIA_|ELECTRON_)/.test(key)) delete process.env[key];
    process.env.COWORK_DISABLE_WATCH_SUPERVISOR = "1";
    process.env.PI_OFFLINE = "1";
    process.env.PI_TELEMETRY = "0";
    const paths = desktopPaths(root, join(base, "home"), {});
    let backend;
    t.after(async () => {
      if (backend) await backend.stop();
      for (const key of Object.keys(process.env))
        if (/^(COWORK_|PI_|ATRIA_|ELECTRON_)/.test(key)) delete process.env[key];
      Object.assign(process.env, env);
      await rm(base, { recursive: true, force: true });
    });
    await prepareDesktopData(paths, "test");
    await writeFile(paths.configPath, "{}\n");
    backend = await connectBackend(paths, {}, process.execPath);
    assert.equal(typeof backend.computer, "function");
    const status = await backend.computer({ operation: "status" });
    assert.equal(typeof status.available, "boolean");
    await backend.computer({ operation: "policy", enabled: true, mode: "control" });
    assert.equal((await access(backend)).policy.enabled, true);
    await backend.computer({ operation: "pause" });
    assert.equal((await access(backend)).paused, true);
    await backend.computer({ operation: "resume" });
    assert.equal((await access(backend)).paused, false);
    await backend.computer({ operation: "policy", enabled: false, mode: "control" });
    assert.equal((await access(backend)).policy.enabled, false);
    assert.equal(
      (await call(backend, { operation: "policy", enabled: true, mode: "control" }, null)).status,
      403
    );
    const authorization = await fetch(`${backend.url}/api/session`, {
      method: "POST",
      headers: { "x-atria-token": backend.token, "content-type": "application/json" },
      body: JSON.stringify({ clientName: "test", protocolVersion: "1.0" })
    });
    const session = (await authorization.json()).session.token;
    assert.equal((await call(backend, { operation: "pause" }, session)).status, 403);
    assert.equal(
      (await call(backend, { operation: "pause" }, null, { cookie: `atria-session=${backend.token}` }))
        .status,
      403
    );
    assert.equal(
      (await call(backend, { operation: "pause" }, null, { authorization: `Bearer ${backend.token}` }))
        .status,
      403
    );
    assert.equal(
      (await call(backend, { operation: "pause" }, backend.token, { origin: backend.url })).status,
      403
    );
    assert.equal(
      (await call(backend, { operation: "pause" }, backend.token, { "sec-fetch-site": "same-origin" }))
        .status,
      403
    );
    assert.equal((await call({ ...backend, backendId: "wrong" }, { operation: "pause" })).status, 409);
    assert.equal((await call(backend, { operation: "permissions", permission: "all" })).status, 400);
  }
);

test(
  "choosing a second host binds computer control to that host and invalidates old handles",
  { timeout: 90000 },
  async (t) => {
    const base = await mkdtemp(join(tmpdir(), "cowork-computer-target-"));
    const env = { ...process.env };
    for (const key of Object.keys(process.env))
      if (/^(COWORK_|PI_|ATRIA_|ELECTRON_)/.test(key)) delete process.env[key];
    process.env.COWORK_DISABLE_WATCH_SUPERVISOR = "1";
    process.env.PI_OFFLINE = "1";
    process.env.PI_TELEMETRY = "0";
    const hosts = [];
    t.after(async () => {
      for (const host of hosts) await host.stop();
      for (const key of Object.keys(process.env))
        if (/^(COWORK_|PI_|ATRIA_|ELECTRON_)/.test(key)) delete process.env[key];
      Object.assign(process.env, env);
      await rm(base, { recursive: true, force: true });
    });
    for (const name of ["a", "b"]) {
      const paths = desktopPaths(root, join(base, name), {});
      await prepareDesktopData(paths, "test");
      await writeFile(paths.configPath, "{}\n");
      hosts.push(await connectBackend(paths, {}, process.execPath));
    }
    const { createBackendAuthorization } = require("../desktop/backend-authorization.cjs");
    const authorization = createBackendAuthorization({ appRoot: root });
    const a = await authorization.select(join(base, "a"));
    assert.equal(a.pid, hosts[0].pid);
    assert.equal(a.startedAt, hosts[0].startedAt);
    const aHandle = authorization.computerBackend(a);
    const candidate = await authorization.prepare(join(base, "b"));
    assert.equal((await authorization.verifySelected(a)).backendId, a.backendId);
    const staleCandidate = await authorization.prepare(join(base, "b"));
    await aHandle.computer({ operation: "policy", enabled: true, mode: "control" });
    assert.equal((await access(hosts[0])).policy.enabled, true);
    assert.equal((await access(hosts[1])).policy.enabled, false);
    const b = authorization.commit(candidate);
    assert.throws(() => authorization.commit(staleCandidate), /切换/);
    const bHandle = authorization.computerBackend(b);
    await assert.rejects(aHandle.computer({ operation: "policy", enabled: false, mode: "control" }), /切换/);
    await bHandle.computer({ operation: "policy", enabled: true, mode: "control" });
    assert.equal((await access(hosts[1])).policy.enabled, true);
    await bHandle.computer({ operation: "policy", enabled: false, mode: "control" });
    assert.equal((await access(hosts[0])).policy.enabled, true);
    await aHandle.pauseRetired();
    assert.equal((await access(hosts[0])).paused, true);
    assert.equal((await access(hosts[1])).paused, false);
    await assert.rejects(authorization.verifySelected(a), /身份/);

    let release, started;
    const held = new Promise((done) => {
      release = done;
    });
    const began = new Promise((done) => {
      started = done;
    });
    const racing = createBackendAuthorization({
      appRoot: root,
      fetchImpl: async (url, options) => {
        const response = await fetch(url, options);
        if (url.endsWith("/api/session")) {
          started();
          await held;
        }
        return response;
      }
    });
    const old = await racing.select(join(base, "a"));
    const pending = racing.authorize({
      ...old,
      baseUrl: old.url,
      clientName: "race",
      protocolVersion: "1.0"
    });
    await began;
    await racing.select(join(base, "b"));
    release();
    await assert.rejects(pending, /切换/);
  }
);

test(
  "open development dashboard keeps ordinary API open while host control requires its instance token",
  { timeout: 90000 },
  async (t) => {
    const base = await mkdtemp(join(tmpdir(), "cowork-open-dashboard-"));
    const paths = desktopPaths(root, join(base, "home"), {});
    await prepareDesktopData(paths, "test");
    await writeFile(paths.configPath, "{}\n");
    const port = await new Promise((done, fail) => {
      const server = createServer();
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => {
        const value = server.address().port;
        server.close(() => done(value));
      });
    });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(COWORK_|PI_|ATRIA_|ELECTRON_)/.test(key))
    );
    const child = spawn(process.execPath, [join(root, "dist/src/cli/dashboard.js")], {
      cwd: root,
      env: {
        ...env,
        ATRIA_HOME: paths.userData,
        COWORK_UI_PORT: String(port),
        COWORK_HARNESS_ROOT: root,
        COWORK_CONFIG: paths.configPath,
        COWORK_WORKSPACE: paths.workspaceRoot,
        COWORK_GLOBAL_INDEX: paths.globalIndex,
        COWORK_TABS_INDEX: paths.tabsIndex,
        PI_CODING_AGENT_DIR: paths.piAgentDir,
        COWORK_DISABLE_WATCH_SUPERVISOR: "1",
        PI_OFFLINE: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const exited = new Promise((done) => child.once("exit", done));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
      await rm(base, { recursive: true, force: true });
    });
    let record;
    for (let i = 0; i < 400; i++) {
      try {
        record = JSON.parse(await readFile(join(paths.userData, "runtime/backend-instance.json"), "utf8"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await new Promise((done) => setTimeout(done, 25));
    }
    assert.ok(record);
    const openResponse = await fetch(`${record.url}/api/backend`);
    assert.equal(openResponse.status, 200);
    assert.equal((await call(record, { operation: "pause" }, null)).status, 403);
    assert.equal(
      (await call(record, { operation: "pause" }, record.token, { origin: record.url })).status,
      403
    );
    const hostResponse = await call(record, { operation: "status" });
    assert.equal(hostResponse.status, 200);
    assert.equal(typeof hostResponse.body.result.available, "boolean");
    const attached = await connectBackend(paths, {}, process.execPath);
    assert.equal(attached.pid, child.pid);
    assert.equal(typeof (await attached.computer({ operation: "status" })).available, "boolean");
    const { createBackendAuthorization } = require("../desktop/backend-authorization.cjs");
    const authorization = createBackendAuthorization({ appRoot: root });
    const identity = await authorization.select(paths.userData);
    assert.equal(identity.pid, child.pid);
    assert.equal(
      typeof (await authorization.computerBackend(identity).computer({ operation: "status" })).available,
      "boolean"
    );
  }
);

test(
  "host HTTP bridge dispatches named permission requests and restores persisted policy",
  { timeout: 90000 },
  async (t) => {
    const base = await mkdtemp(join(tmpdir(), "cowork-computer-permission-"));
    const previous = { ...process.env };
    for (const key of Object.keys(process.env))
      if (/^(COWORK_|PI_|ATRIA_|ELECTRON_)/.test(key)) delete process.env[key];
    process.env.ATRIA_HOME = base;
    process.env.COWORK_HARNESS_ROOT = root;
    process.env.COWORK_WORKSPACE = join(base, "workspace");
    process.env.COWORK_DISABLE_WATCH_SUPERVISOR = "1";
    process.env.PI_OFFLINE = "1";
    process.env.COWORK_API_TOKEN = "synthetic-host-token";
    const port = await new Promise((done, fail) => {
      const server = createServer();
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => {
        const value = server.address().port;
        server.close(() => done(value));
      });
    });
    process.env.COWORK_UI_PORT = String(port);
    const calls = [];
    const status = {
      available: true,
      screenRecording: false,
      accessibility: true,
      postEventAccess: true,
      windows: []
    };
    const driver = {
      async status() {
        calls.push("status");
        return { ...status };
      },
      async requestPermissions(permission) {
        calls.push(permission);
        status[permission] = true;
        return { requested: true };
      },
      async observe() {
        throw new Error("unused");
      },
      async act() {
        throw new Error("unused");
      }
    };
    const { createDashboardApplication } = await import("../dist/src/dashboard/application.js");
    const app = createDashboardApplication({
      port,
      computerDriver: driver,
      backendIdentity: { backendId: "backend_permission_fixture", startedAt: "2026-01-01T00:00:00.000Z" }
    });
    await new Promise((done, fail) => {
      app.server.once("error", fail);
      app.server.listen(port, "127.0.0.1", done);
    });
    t.after(async () => {
      await app.stop();
      for (const key of Object.keys(process.env))
        if (/^(COWORK_|PI_|ATRIA_|ELECTRON_)/.test(key)) delete process.env[key];
      Object.assign(process.env, previous);
      await rm(base, { recursive: true, force: true });
    });
    const instance = {
      url: `http://127.0.0.1:${port}`,
      token: "synthetic-host-token",
      pid: process.pid,
      backendId: "backend_permission_fixture"
    };
    const {
      createComputerPolicyStore,
      createComputerPolicyController
    } = require("../desktop/computer-policy.cjs");
    const store = createComputerPolicyStore(base);
    await store.load();
    await store.save({ enabled: true, mode: "control" });
    const backend = {
      async computer(input) {
        const r = await call(instance, input);
        if (r.status !== 200) throw new Error(JSON.stringify(r.body));
        return r.body.result;
      }
    };
    const controller = createComputerPolicyController({
      store,
      getBackend: () => backend,
      registerTakeover: () => null
    });
    await controller.initialize(backend);
    assert.equal((await access(instance)).policy.enabled, true);
    const permission = await controller.request({ operation: "permissions", permission: "screenRecording" });
    assert.equal(permission.screenRecording, true);
    assert.deepEqual(calls, ["status", "screenRecording", "status"]);
    await controller.request({ operation: "pause" });
    assert.equal((await access(instance)).paused, true);
    await controller.request({ operation: "resume" });
    assert.equal((await access(instance)).paused, false);
    await controller.request({ operation: "policy", enabled: false, mode: "control" });
    assert.equal((await access(instance)).policy.enabled, false);
  }
);
