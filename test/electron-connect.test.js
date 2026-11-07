import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createManagementClient } from "../web/assets/controllers/management-client.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

/**
 * The desktop client of the standalone backend.
 *
 * These cases stand at the seam between a client's lifetime and the data
 * root's one serving process: the same instance is reused by every entry, the
 * shared management protocol carries authorization and switching between two
 * backends with different credentials, and a Task accepted by a desktop
 * session keeps running after that session is gone.
 */

const require = createRequire(import.meta.url);
const { connectBackend } = require("../desktop/backend.cjs");
const { desktopPaths, prepareDesktopData } = require("../desktop/paths.cjs");
const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const backendEntry = join(repositoryRoot, "dist/src/cli/backend.js");
const dashboardEntry = join(repositoryRoot, "dist/src/cli/dashboard.js");

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

function isolatedEnv(overrides = {}) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_|ELECTRON_)/.test(name))
  );
  return { ...inherited, ...overrides };
}

async function createRoot(prefix, extra = {}) {
  const base = await mkdtemp(join(tmpdir(), prefix));
  const home = join(base, "home");
  const workspace = join(base, "workspace");
  const project = join(base, "project");
  const userHome = join(base, "user-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(userHome, { recursive: true });
  const configPath = join(base, "config.json");
  await writeFile(configPath, "{}");
  const env = isolatedEnv({
    HOME: userHome,
    ATRIA_HOME: home,
    PI_CODING_AGENT_DIR: join(base, "pi"),
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    COWORK_HARNESS_ROOT: repositoryRoot,
    COWORK_WORKSPACE: workspace,
    COWORK_GLOBAL_INDEX: join(home, "runtime", "workspaces.json"),
    COWORK_TABS_INDEX: join(home, "runtime", "tabs.json"),
    COWORK_CONFIG: configPath,
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    COWORK_SUPERVISOR_INTERVAL_MS: "1000",
    ...extra
  });
  return { base, home, workspace, project, userHome, configPath, env };
}

function runProcess(entry, args, env, timeoutMs = 60_000) {
  const child = spawn(entry, args, { cwd: repositoryRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => {
    out += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    err += String(chunk);
  });
  const closed = new Promise((done, fail) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`${entry} ${args.join(" ")} timed out\n${out}\n${err}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      done(code);
    });
  });
  return closed.then((code) => ({ code, out: out.trim(), err: err.trim() }));
}

async function backendCommand(args, env) {
  const result = await runProcess(process.execPath, [backendEntry, ...args], env);
  return { ...result, body: result.out ? JSON.parse(result.out) : undefined };
}

async function readRecord(home) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const value = JSON.parse(await readFile(join(home, "runtime", "backend-instance.json"), "utf8"));
      if (value.pid && value.url && value.token) return value;
    } catch {
      /* the record is published after the listener is ready */
    }
    await delay(25);
  }
  throw new Error("backend did not publish an instance record");
}

async function api(instance, method, path, body) {
  const headers = { "x-atria-token": instance.token };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${instance.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000)
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

async function waitFor(description, check, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await delay(50);
  }
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

/**
 * The host's per-backend credential.
 *
 * The desktop owns the instance record of each data root it connects to and
 * presents that backend's own host credential; a request for one backend never
 * carries another backend's credential.
 */
function hostFetch(credentials, seen) {
  return (url, init = {}) => {
    const origin = new URL(url).origin;
    const authorization = init.method === "POST" && String(url).endsWith("/api/session");
    const token = authorization ? credentials.get(origin) : undefined;
    if (seen) seen.push({ origin, path: new URL(url).pathname, token });
    return fetch(url, {
      ...init,
      headers: { ...init.headers, ...(token ? { "x-atria-token": token } : {}) }
    });
  };
}

async function desktopConnect(root, settings = {}, appRoot = repositoryRoot) {
  const paths = desktopPaths(appRoot, root.home, {});
  await prepareDesktopData(paths, "0.1.0");
  // The host writes the empty configuration a fresh installation starts with.
  await writeFile(paths.configPath, "{}\n", { flag: "wx" }).catch(() => undefined);
  return connectBackend(paths, settings, process.execPath);
}

async function stopRoot(root) {
  await backendCommand(["stop"], root.env).catch(() => undefined);
}

test(
  "desktop authorization binds a chosen data root to its live identity",
  { timeout: 120_000 },
  async (t) => {
    const left = await createRoot("atria-host-left-");
    const right = await createRoot("atria-host-right-");
    t.after(async () => {
      await stopRoot(left);
      await stopRoot(right);
      await rm(left.base, { recursive: true, force: true });
      await rm(right.base, { recursive: true, force: true });
    });
    const a = await desktopConnect(left);
    const b = await desktopConnect(right);
    const { createBackendAuthorization } = require("../desktop/backend-authorization.cjs");
    const seen = [];
    const host = createBackendAuthorization({
      appRoot: repositoryRoot,
      fetchImpl: (url, options) => {
        seen.push({ origin: new URL(url).origin, token: options.headers["x-atria-token"] });
        return fetch(url, options);
      }
    });
    const first = await host.select(left.home);
    assert.equal(first.backendId, a.backendId);
    const aSession = await host.authorize({
      baseUrl: a.url,
      backendId: a.backendId,
      clientName: "test",
      protocolVersion: "1.0"
    });
    assert.equal(aSession.backend.backendId, a.backendId);
    await host.select(right.home);
    await assert.rejects(
      host.authorize({ baseUrl: a.url, backendId: b.backendId, clientName: "test", protocolVersion: "1.0" }),
      /不一致/
    );
    const bSession = await host.authorize({
      baseUrl: b.url,
      backendId: b.backendId,
      clientName: "test",
      protocolVersion: "1.0"
    });
    assert.equal(bSession.backend.backendId, b.backendId);
    assert.notEqual(aSession.session.token, bSession.session.token);
    assert.equal((await api(b, "DELETE", `/api/session/${bSession.session.sessionId}`)).status, 200);
    assert.equal(
      (
        await host.authorize({
          baseUrl: b.url,
          backendId: b.backendId,
          clientName: "test",
          protocolVersion: "1.0"
        })
      ).backend.backendId,
      b.backendId
    );
    await assert.rejects(host.select(join(right.base, "missing")));
    const identityFile = join(right.home, "runtime", "backend-identity.json");
    const oldIdentity = await readFile(identityFile, "utf8");
    await writeFile(
      identityFile,
      JSON.stringify({ version: 1, backendId: "backend_replaced", createdAt: "fixture" })
    );
    try {
      await assert.rejects(
        host.authorize({
          baseUrl: b.url,
          backendId: b.backendId,
          clientName: "test",
          protocolVersion: "1.0"
        }),
        /身份/
      );
    } finally {
      await writeFile(identityFile, oldIdentity);
    }
  }
);

test("desktop waits for host authorization before business requests", { timeout: 120_000 }, async (t) => {
  const root = await createRoot("atria-auth-gate-");
  t.after(async () => {
    await stopRoot(root);
    await rm(root.base, { recursive: true, force: true });
  });
  const instance = await desktopConnect(root);
  const { createBackendAuthorization } = require("../desktop/backend-authorization.cjs");
  const host = createBackendAuthorization({ appRoot: repositoryRoot });
  await host.select(root.home);
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  let calls = 0;
  const client = createManagementClient({
    baseUrl: instance.url,
    authorizeSession: async ({ clientName, protocolVersion }) => {
      await gate;
      return host.authorize({
        baseUrl: instance.url,
        backendId: instance.backendId,
        clientName,
        protocolVersion
      });
    },
    fetch: (url, options) => {
      calls++;
      return fetch(url, options);
    }
  });
  t.after(() => client.stop());
  await assert.rejects(client.request("/api/tasks"), { code: "backend_connecting" });
  const connecting = client.connect({ baseUrl: instance.url });
  await assert.rejects(client.request("/api/tasks"), { code: "backend_connecting" });
  await assert.rejects(client.blob("/api/files/example"), { code: "backend_connecting" });
  await assert.rejects(client.openStream("/api/events"), { code: "backend_connecting" });
  await assert.rejects(client.upload({ name: "test" }), { code: "backend_connecting" });
  assert.equal(calls, 0);
  release();
  assert.equal((await connecting).status, "connected");
  assert.ok(Array.isArray((await client.request("/api/tasks")).tasks));
});

test("late pre-session refusal cannot revoke a newly authorized session", { timeout: 120_000 }, async (t) => {
  const root = await createRoot("atria-auth-race-");
  t.after(async () => {
    await stopRoot(root);
    await rm(root.base, { recursive: true, force: true });
  });
  const instance = await desktopConnect(root);
  let releaseSession, releaseOld;
  const allowSession = new Promise((done) => {
    releaseSession = done;
  });
  const allowOld = new Promise((done) => {
    releaseOld = done;
  });
  const transport = hostFetch(new Map([[instance.url, instance.token]]));
  const client = createManagementClient({
    baseUrl: instance.url,
    fetch: async (url, options) => {
      if (url.endsWith("/api/session") && options.method === "POST") await allowSession;
      if (url.endsWith("/api/old")) {
        await allowOld;
        return new Response(JSON.stringify({ error: "old refusal" }), { status: 401 });
      }
      return transport(url, options);
    }
  });
  t.after(() => client.stop());
  const connecting = client.connect({ baseUrl: instance.url });
  const old = client.request("/api/old").catch((error) => error);
  releaseSession();
  assert.equal((await connecting).status, "connected");
  releaseOld();
  assert.equal((await old).status, 401);
  assert.equal(client.state().status, "connected");
});

test(
  "one data root is served by one instance across backend start, desktop attach and the development dashboard",
  { timeout: 120_000 },
  async (t) => {
    const root = await createRoot("atria-connect-owner-");
    t.after(async () => {
      await stopRoot(root);
      await rm(root.base, { recursive: true, force: true });
    });
    const started = await backendCommand(["start"], root.env);
    assert.equal(started.code, 0, started.err);
    assert.equal(started.body.state, "started");
    const instance = await readRecord(root.home);

    // A desktop launch finds the running instance instead of starting a second writer.
    const desktop = await desktopConnect(root);
    assert.equal(desktop.backendId, instance.backendId);
    assert.equal(desktop.pid, instance.pid);
    assert.equal(desktop.url, instance.url);
    const served = await api(desktop, "GET", "/api/backend");
    assert.equal(served.status, 200);
    assert.equal(served.body.backendId, instance.backendId);

    // The development dashboard reuses the same instance on its own port instead
    // of listening as a second server for the same data root.
    const dashboard = await runProcess(process.execPath, [dashboardEntry], {
      ...root.env,
      COWORK_UI_PORT: "3897"
    });
    assert.equal(dashboard.code, 0, dashboard.err);
    assert.match(dashboard.out, /already served/u);
    await assert.rejects(fetch("http://127.0.0.1:3897/api/tasks", { signal: AbortSignal.timeout(1_000) }));

    // Two concurrent starts still resolve to the one instance.
    const [first, second] = await Promise.all([
      backendCommand(["start"], root.env),
      backendCommand(["start"], root.env)
    ]);
    for (const result of [first, second]) {
      assert.equal(result.code, 0, result.err);
      assert.equal(result.body.pid, instance.pid);
      assert.equal(result.body.backendId, instance.backendId);
    }
    const record = await readRecord(root.home);
    assert.equal(record.pid, instance.pid);
    assert.equal(alive(record.pid), true);
    const status = await backendCommand(["status"], root.env);
    assert.equal(status.body.state, "running");
    assert.equal(status.body.pid, instance.pid);
  }
);

test(
  "two isolated backends with different bootstrap credentials authorize, switch and reauthorize after revocation",
  { timeout: 120_000 },
  async (t) => {
    const left = await createRoot("atria-connect-left-");
    const right = await createRoot("atria-connect-right-");
    t.after(async () => {
      await stopRoot(left);
      await stopRoot(right);
      await rm(left.base, { recursive: true, force: true });
      await rm(right.base, { recursive: true, force: true });
    });
    const a = await desktopConnect(left);
    const b = await desktopConnect(right);
    assert.notEqual(a.backendId, b.backendId);
    assert.notEqual(a.token, b.token);
    for (const [root, instance, name] of [
      [left, a, "左侧项目"],
      [right, b, "右侧项目"]
    ]) {
      const project = await api(instance, "POST", "/api/projects", {
        projectName: name,
        projectDirectory: root.project
      });
      assert.equal(project.status, 201, JSON.stringify(project.body));
    }

    const credentials = new Map([
      [a.url, a.token],
      [b.url, b.token]
    ]);
    const seen = [];
    const client = createManagementClient({
      baseUrl: a.url,
      fetch: hostFetch(credentials, seen),
      storage: memoryStorage(),
      targetStorage: memoryStorage()
    });
    t.after(() => client.stop());

    const first = await client.connect({ baseUrl: a.url });
    assert.equal(first.status, "connected", JSON.stringify(first));
    assert.equal(client.state().backendId, a.backendId);
    const leftSnapshot = await client.snapshot();
    assert.deepEqual(
      leftSnapshot.projects.map((project) => project.projectName),
      ["左侧项目"]
    );

    // Switching retires the old identity: the view carries B's identity and only
    // the projects that backend owns.
    assert.equal((await client.switchBackend({ baseUrl: b.url })).status, "connected");
    assert.equal(client.state().backendId, b.backendId);
    const rightSnapshot = await client.snapshot();
    assert.deepEqual(
      rightSnapshot.projects.map((project) => project.projectName),
      ["右侧项目"]
    );
    const toRight = seen.filter((entry) => entry.origin === new URL(b.url).origin);
    assert.ok(
      toRight.some((entry) => entry.path === "/api/session" && entry.token === b.token),
      "the right backend authorizes with its own host credential"
    );
    assert.ok(
      !toRight.some((entry) => entry.token === a.token),
      "the left backend's host credential is never presented to the right one"
    );

    // Revoking the session ends the connection with a clear state; the host
    // credential reauthorizes it.
    const revoked = await api(b, "DELETE", `/api/session/${client.state().sessionId}`);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    const refused = await client.request("/api/tasks").then(
      () => undefined,
      (error) => error
    );
    assert.equal(refused?.status, 401);
    assert.equal(client.state().status, "unauthorized");
    assert.equal((await client.authorize()).status, "connected");
    assert.equal(client.state().backendId, b.backendId);

    // A credential the backend does not accept is unauthorized, not "empty".
    const stranger = createManagementClient({
      baseUrl: a.url,
      fetch: hostFetch(new Map([[a.url, "not-the-host-credential"]]), []),
      storage: memoryStorage()
    });
    t.after(() => stranger.stop());
    assert.equal((await stranger.connect({ baseUrl: a.url })).status, "unauthorized");
    assert.equal(stranger.state().error.code, "unauthorized");

    // An incompatible protocol is named with both versions instead of being
    // reported as a broken backend.
    const future = createManagementClient({
      baseUrl: a.url,
      protocolVersion: "9.0",
      fetch: hostFetch(credentials, []),
      storage: memoryStorage()
    });
    t.after(() => future.stop());
    assert.equal((await future.connect({ baseUrl: a.url })).status, "incompatible");
    assert.match(future.state().error.message, /9\.0/u);

    // A backend that is not listening is a connection failure with a network flag.
    const probe = await new Promise((done) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        server.close(() => done(port));
      });
    });
    const offline = createManagementClient({
      baseUrl: `http://127.0.0.1:${probe}`,
      fetch: hostFetch(credentials, []),
      storage: memoryStorage()
    });
    t.after(() => offline.stop());
    assert.equal((await offline.connect({ baseUrl: `http://127.0.0.1:${probe}` })).status, "failed");
    assert.equal(offline.state().error.code, "network");
  }
);

test(
  "a task accepted by a desktop session keeps running after that session exits and the next launch reads it",
  { timeout: 180_000 },
  async (t) => {
    const root = await createRoot("atria-connect-continue-");
    let model;
    t.after(async () => {
      await stopRoot(root);
      await model?.close();
      await rm(root.base, { recursive: true, force: true });
    });
    const report = "# 连接报告\n\n输入已核对。\n";
    let release;
    const gate = new Promise((done) => {
      release = done;
    });
    let gated = false;
    let step = 0;
    const failures = [];
    model = await modelProtocolFixture("openai-completions", async (request) => {
      if (!gated) {
        gated = true;
        // Hold the first answer until the desktop client that started the run is gone.
        await gate;
      }
      try {
        const last = request.messages.findLast((message) => message.role === "tool");
        switch (step++) {
          case 0:
            return { name: "read", arguments: { path: join(root.project, "input.txt") } };
          case 1:
            assert.match(JSON.stringify(last.content), /连接输入/u);
            return { name: "write", arguments: { path: join(root.project, "report.md"), content: report } };
          default:
            return { text: "报告已生成。" };
        }
      } catch (error) {
        failures.push(error.message);
        return { text: "回归失败。" };
      }
    });
    await writeFile(join(root.project, "input.txt"), "连接输入");
    const settings = {
      baseUrl: model.baseUrl,
      apiKey: "local-fixture",
      model: "protocol-fixture"
    };

    // A desktop session: attach, accept the Task, start the Run, then exit. It
    // never calls stop — quitting must leave the execution host and its Run alive.
    const clientPath = join(root.base, "desktop-session.mjs");
    await writeFile(
      clientPath,
      `
import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(join(repositoryRoot, "package.json"))});
const { connectBackend } = require(${JSON.stringify(join(repositoryRoot, "desktop/backend.cjs"))});
const { desktopPaths, prepareDesktopData } = require(${JSON.stringify(
        join(repositoryRoot, "desktop/paths.cjs")
      )});
const { home, project } = JSON.parse(process.argv[2]);
const settings = JSON.parse(process.argv[3]);
const paths = desktopPaths(${JSON.stringify(repositoryRoot)}, home, {});
await prepareDesktopData(paths, "0.1.0");
const { writeFile } = await import("node:fs/promises");
await writeFile(paths.configPath, "{}", { flag: "wx" }).catch(() => undefined);
const backend = await connectBackend(paths, settings, process.execPath);
const headers = { "content-type": "application/json", "x-atria-token": backend.token };
const call = async (path, body) => {
  const response = await fetch(backend.url + path, { method: "POST", headers, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(path + " " + response.status + " " + JSON.stringify(value));
  return value;
};
const created = await call("/api/projects", { projectName: "连接项目", projectDirectory: project });
await call("/api/tasks", { taskId: "connect-task", goal: "读取输入并写出报告", projectId: created.project.projectId });
await call("/api/tasks/connect-task/run", { prompt: "读取 input.txt，写出 report.md。" });
process.stdout.write(JSON.stringify({ url: backend.url, token: backend.token, pid: backend.pid, backendId: backend.backendId }));
await new Promise((done) => setTimeout(done, 50));
process.stdout.write("\\nstarted");
`
    );
    const session = await runProcess(
      process.execPath,
      [clientPath, JSON.stringify({ home: root.home, project: root.project }), JSON.stringify(settings)],
      root.env
    );
    assert.equal(session.code, 0, session.err);
    const [identityLine, marker] = session.out.split("\n");
    assert.equal(marker, "started");
    const identity = JSON.parse(identityLine);

    // The disconnecting client left the execution host and the Run running.
    assert.equal(alive(identity.pid), true);
    const record = await readRecord(root.home);
    assert.equal(record.pid, identity.pid);
    const during = await api(identity, "GET", "/api/tasks/connect-task");
    assert.equal(during.status, 200);
    assert.equal(during.body.runtime.active, true, "the Run must outlive the desktop session");

    // The next launch reads the same instance and the same Task.
    const relaunched = await desktopConnect(root, settings);
    assert.equal(relaunched.backendId, identity.backendId);
    assert.equal(relaunched.pid, identity.pid);
    const same = await api(relaunched, "GET", "/api/tasks/connect-task");
    assert.equal(same.body.task.taskId, "connect-task");
    assert.equal(same.body.runtime.active, true);

    release();
    const finished = await waitFor("the task to finish without its client", async () => {
      const current = await api(relaunched, "GET", "/api/tasks/connect-task");
      return !current.body.runtime.active ? current.body : undefined;
    });
    assert.deepEqual(failures, []);
    assert.equal(finished.task.status, "completed");
    assert.equal(await readFile(join(root.project, "report.md"), "utf8"), report);
  }
);
