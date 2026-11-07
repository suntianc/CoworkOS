import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createManagementClient } from "../web/assets/controllers/management-client.js";
import { createComposerSession } from "../web/assets/controllers/composer-session.js";
import { createArtifactController } from "../web/assets/controllers/artifact-controller.js";
import { artifactVersion } from "../web/assets/artifacts.js";
import { parseHTML } from "linkedom";

/**
 * The shared Web/Electron client against real backends.
 *
 * Every case drives the documented HTTP protocol through the same module the
 * browser uses: authorize a local session, read the snapshot, follow events,
 * send idempotent commands, and switch backends without letting the old
 * identity reach the new view. Data roots, ports and processes are isolated per
 * case, and none of these assertions reads backend internals.
 */

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const backendEntry = join(repositoryRoot, "dist/src/cli/backend.js");
const HOST_CREDENTIAL = "host-credential-for-os-web-client-protocol";

function isolatedEnv(overrides) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_|SERPER_|EXA_)/.test(name))
  );
  return { ...inherited, PI_OFFLINE: "1", PI_TELEMETRY: "0", ...overrides };
}

async function createRoot(prefix, overrides = {}) {
  const base = await mkdtemp(join(tmpdir(), prefix));
  const home = join(base, "home");
  const workspace = join(base, "workspace");
  const project = join(base, "project");
  const userHome = join(base, "user-home");
  for (const directory of [workspace, project, userHome]) await mkdir(directory, { recursive: true });
  const configPath = join(base, "config.json");
  await writeFile(configPath, "{}");
  const env = isolatedEnv({
    HOME: userHome,
    ATRIA_HOME: home,
    PI_CODING_AGENT_DIR: join(base, "pi"),
    COWORK_HARNESS_ROOT: repositoryRoot,
    COWORK_WORKSPACE: workspace,
    COWORK_GLOBAL_INDEX: join(home, "runtime", "workspaces.json"),
    COWORK_TABS_INDEX: join(home, "runtime", "tabs.json"),
    COWORK_CONFIG: configPath,
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    ...overrides
  });
  return { base, home, workspace, project, env };
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

const instancePath = (root) => join(root.home, "runtime", "backend-instance.json");

async function readInstance(root) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const value = JSON.parse(await readFile(instancePath(root), "utf8"));
      if (value.pid && value.url && value.token) return value;
    } catch {
      /* the record is published after the listener is ready */
    }
    await delay(25);
  }
  throw new Error("backend did not publish an instance record");
}

async function startBackend(root) {
  const result = await runProcess(process.execPath, [backendEntry, "start"], root.env);
  assert.equal(result.code, 0, `backend start failed: ${result.err || result.out}`);
  return readInstance(root);
}

async function stopQuietly(root) {
  try {
    await runProcess(process.execPath, [backendEntry, "stop"], root.env, 15_000);
  } catch {
    /* fall through to the recorded pid */
  }
  try {
    const instance = JSON.parse(await readFile(instancePath(root), "utf8"));
    if (instance.pid) {
      try {
        process.kill(instance.pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    }
  } catch {
    /* no record */
  }
}

/** Host-principal request, used only to set up and revoke a client session. */
async function hostRequest(instance, method, path, body) {
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
  return { status: response.status, body: parsed, headers: Object.fromEntries(response.headers) };
}

async function waitFor(description, check, timeoutMs = 20_000) {
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
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    }
  };
}

/**
 * The host credential a desktop host would install.
 *
 * The test's page stands in for that host: only the authorization call carries
 * it, so every later request is really authenticated by the session the client
 * minted. That is what makes revocation meaningful here.
 */
function hostFetch(instances, overrides = {}) {
  const list = Array.isArray(instances) ? instances : [instances];
  return (url, init = {}) => {
    const headers = { ...(init.headers || {}) };
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = "";
    }
    const instance = list.find((entry) => new URL(entry.url).origin === origin);
    const authorization = init.method === "POST" && String(url).endsWith("/api/session");
    if (authorization && instance && !headers["x-atria-token"]) headers["x-atria-token"] = instance.token;
    const request = { ...init, headers };
    if (overrides.fetch) {
      const replaced = overrides.fetch(url, request);
      if (replaced) return replaced;
    }
    return fetch(url, request);
  };
}

/** A client whose callbacks are collected for assertions. */
function clientFor(instance, extra = {}) {
  const seen = { snapshots: [], events: [], resets: [], statuses: [], states: [] };
  const client = createManagementClient({
    fetch: hostFetch(instance, extra),
    storage: memoryStorage(),
    targetStorage: memoryStorage(),
    events: {
      onSnapshot: (snapshot) => seen.snapshots.push(snapshot),
      onEvent: (record) => seen.events.push(record),
      onReset: (reset) => seen.resets.push(reset),
      onStatus: (status) => seen.statuses.push(status)
    },
    onStateChange: (state) => seen.states.push(state),
    ...(extra.client || {})
  });
  return { client, seen };
}

async function createProject(client, name, directory) {
  const { project } = await client.command("/api/projects", {
    body: { projectName: name, projectDirectory: directory }
  });
  return project;
}

test("opening an artifact reads the bound backend's file through its authorized session", async (t) => {
  const first = await createRoot("cowork-artifact-view-a-", { COWORK_API_TOKEN: "artifact-host-a" });
  const second = await createRoot("cowork-artifact-view-b-", { COWORK_API_TOKEN: "artifact-host-b" });
  const a = await startBackend(first);
  const b = await startBackend(second);
  t.after(async () => {
    await stopQuietly(first);
    await stopQuietly(second);
    await rm(first.base, { recursive: true, force: true });
    await rm(second.base, { recursive: true, force: true });
  });
  const { client } = clientFor([a, b]);
  t.after(() => client.stop());
  const { document, window } = parseHTML(
    '<div id="artifact-drawer"></div><div id="artifact-drawer-scrim"></div>'
  );
  const previousDocument = globalThis.document;
  globalThis.document = document;
  t.after(() => {
    globalThis.document = previousDocument;
  });
  const artifact = { relativePath: "report.md", size: 12 };
  const state = {
    selected: "shared-task",
    detail: { artifacts: [artifact] },
    artifactDrawerOpen: true,
    previewPath: artifact.relativePath,
    openFiles: [artifact.relativePath],
    artifactCache: new Map([
      [
        artifact.relativePath,
        { status: "ready", signature: artifactVersion(artifact), previewKind: "text", content: "preview" }
      ]
    ])
  };
  const opened = [];
  const controller = createArtifactController({
    state,
    $: (selector) => document.querySelector(selector),
    api: (path) => client.request(path),
    showToast: (message) => {
      throw new Error(message);
    },
    renderRightPanel() {},
    getWorkbench: () => ({ editableKinds: new Set() }),
    openArtifactViewer: async (path) => {
      const result = await client.blob(path);
      opened.push({ backendId: client.state().backendId, text: await result.blob.text() });
    }
  });
  for (const [root, instance, body] of [
    [first, a, "artifact from A"],
    [second, b, "artifact from B"]
  ]) {
    const connected = await client.switchBackend({ baseUrl: instance.url });
    assert.equal(connected.status, "connected");
    const project = await createProject(client, `project-${body}`, root.project);
    await client.command("/api/tasks", {
      body: { taskId: "shared-task", goal: body, projectId: project.projectId }
    });
    const directory = join(root.workspace, "shared-task", "artifacts");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "report.md"), body);
    const rawPath = "/api/tasks/shared-task/artifact?path=report.md&raw=1";
    assert.equal((await fetch(instance.url + rawPath)).status, 401, "uncredentialed navigation is refused");
    delete document.querySelector("#artifact-drawer").dataset.signature;
    controller.renderArtifactDrawer();
    document
      .querySelector('#artifact-drawer a[target="_blank"]')
      .dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
    await waitFor(
      "authorized artifact to open",
      () => opened.find((item) => item.backendId === instance.backendId),
      1000
    );
    assert.equal(opened.at(-1).text, body);
  }
  assert.deepEqual(
    opened.map((item) => item.text),
    ["artifact from A", "artifact from B"]
  );
});

test("a file response whose body finishes after switching backends is discarded", async (t) => {
  const first = await createRoot("cowork-artifact-body-a-");
  const second = await createRoot("cowork-artifact-body-b-");
  const a = await startBackend(first);
  const b = await startBackend(second);
  t.after(async () => {
    await stopQuietly(first);
    await stopQuietly(second);
    await rm(first.base, { recursive: true, force: true });
    await rm(second.base, { recursive: true, force: true });
  });
  let releaseBody, bodyStarted;
  const bodyGate = new Promise((resolve) => {
    releaseBody = resolve;
  });
  const started = new Promise((resolve) => {
    bodyStarted = resolve;
  });
  const { client } = clientFor([a, b], {
    fetch: (url, options) => {
      if (!String(url).includes("/artifact?")) return;
      return fetch(url, options).then((response) => ({
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        async blob() {
          bodyStarted();
          await bodyGate;
          return new Blob(["held A"]);
        }
      }));
    }
  });
  t.after(() => client.stop());
  assert.equal((await client.connect({ baseUrl: a.url })).status, "connected");
  const project = await createProject(client, "body race", first.project);
  await client.command("/api/tasks", {
    body: { taskId: "body-race", goal: "body race", projectId: project.projectId }
  });
  const directory = join(first.workspace, "body-race", "artifacts");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "report.md"), "held A");
  const pending = client.blob("/api/tasks/body-race/artifact?path=report.md&raw=1");
  await started;
  assert.equal((await client.switchBackend({ baseUrl: b.url })).backendId, b.backendId);
  releaseBody();
  await assert.rejects(pending, (error) => error.code === "stale_client");
});

for (const status of [200, 401])
  test(`a settings JSON ${status} body finishing after switching A to B and back is discarded`, async (t) => {
    const first = await createRoot("cowork-settings-body-a-");
    const second = await createRoot("cowork-settings-body-b-");
    const a = await startBackend(first);
    const b = await startBackend(second);
    t.after(async () => {
      await stopQuietly(first);
      await stopQuietly(second);
      await rm(first.base, { recursive: true, force: true });
      await rm(second.base, { recursive: true, force: true });
    });
    let releaseBody, bodyStarted;
    const bodyGate = new Promise((resolve) => {
      releaseBody = resolve;
    });
    const started = new Promise((resolve) => {
      bodyStarted = resolve;
    });
    const { client } = clientFor([a, b], {
      fetch: (url, options) => {
        if (!String(url).endsWith("/api/model-settings")) return;
        return fetch(url, options).then((response) => ({
          ok: status === 200,
          status,
          headers: response.headers,
          async text() {
            bodyStarted();
            await bodyGate;
            const text = await response.text();
            return status === 200 ? text : JSON.stringify({ error: "old session revoked" });
          }
        }));
      }
    });
    t.after(() => client.stop());
    assert.equal((await client.connect({ baseUrl: a.url })).backendId, a.backendId);
    const pending = client.request("/api/model-settings");
    await started;
    assert.equal((await client.switchBackend({ baseUrl: b.url })).backendId, b.backendId);
    assert.equal((await client.switchBackend({ baseUrl: a.url })).backendId, a.backendId);
    releaseBody();
    await assert.rejects(pending, (error) => error.code === "stale_client");
    assert.equal(client.state().status, "connected");
    assert.equal(client.state().backendId, a.backendId);
  });

test("cancelling an error response body does not revoke the current session", async (t) => {
  const root = await createRoot("cowork-cancel-error-body-");
  const backend = await startBackend(root);
  t.after(async () => {
    await stopQuietly(root);
    await rm(root.base, { recursive: true, force: true });
  });
  let releaseBody, bodyStarted;
  const bodyGate = new Promise((resolve) => {
    releaseBody = resolve;
  });
  const started = new Promise((resolve) => {
    bodyStarted = resolve;
  });
  const { client } = clientFor(backend, {
    fetch: (url, options) => {
      if (!String(url).endsWith("/api/model-settings")) return;
      return fetch(url, options).then((response) => ({
        ok: false,
        status: 401,
        headers: response.headers,
        async text() {
          bodyStarted();
          await bodyGate;
          return response.text();
        }
      }));
    }
  });
  t.after(() => client.stop());
  assert.equal((await client.connect({ baseUrl: backend.url })).status, "connected");
  const controller = new AbortController();
  const pending = client.request("/api/model-settings", { signal: controller.signal });
  await started;
  controller.abort();
  releaseBody();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(client.state().status, "connected");
});

test("a browser client authorizes, reads projects, follows Task events and downloads an artifact", async (t) => {
  const root = await createRoot("cowork-web-client-", {
    COWORK_API_TOKEN: HOST_CREDENTIAL
  });
  const instance = await startBackend(root);
  t.after(() => stopQuietly(root));
  const { client, seen } = clientFor(instance);
  t.after(() => client.stop());

  const connected = await client.connect({ baseUrl: instance.url });
  assert.equal(connected.status, "connected", JSON.stringify(connected));
  assert.equal(connected.backendId, instance.backendId);
  assert.ok(connected.capabilities.includes("events.snapshot"));
  assert.ok(connected.capabilities.includes("events.stream"));
  assert.match(connected.sessionId, /^session_/);
  // Authorizing spent the host credential once; the session is what is stored.
  const firstSnapshot = await waitFor("the first catalog snapshot", () => seen.snapshots[0]);
  assert.equal(firstSnapshot.backendId, instance.backendId);

  const project = await createProject(client, "浏览器项目", root.project);
  assert.equal(project.projectName, "浏览器项目");
  const projectEvent = await waitFor("project.changed", () =>
    seen.events.find((event) => event.type === "project.changed" && event.objectId === project.projectId)
  );
  assert.equal(projectEvent.backendId, instance.backendId);
  assert.equal(projectEvent.payload.projectName, "浏览器项目");

  const task = await client.command("/api/tasks", {
    body: { taskId: "web-client-task", goal: "整理输入并交付报告", projectId: project.projectId }
  });
  assert.equal(task.taskId, "web-client-task");
  const taskEvent = await waitFor("task.changed", () =>
    seen.events.find((event) => event.type === "task.changed" && event.objectId === task.taskId)
  );
  assert.equal(taskEvent.payload.goal, "整理输入并交付报告");
  assert.equal(taskEvent.payload.projectId, project.projectId);

  // Task detail and model settings are ordinary reads through the same session.
  const detail = await client.request(`/api/tasks/${encodeURIComponent(task.taskId)}`);
  assert.equal(detail.task.taskId, task.taskId);
  const settings = await client.request("/api/model-settings");
  assert.equal(typeof settings.configured, "boolean");
  assert.equal(settings.apiKey, undefined, "a settings read never echoes a key");

  const artifactDirectory = join(root.workspace, task.taskId, "artifacts");
  await mkdir(artifactDirectory, { recursive: true });
  const body = "# 报告\n\n下载内容已核对。\n";
  await writeFile(join(artifactDirectory, "report.md"), body);
  const path = `/api/tasks/${encodeURIComponent(task.taskId)}/artifact?path=report.md&download=1`;
  const downloaded = await client.blob(path);
  assert.equal(await downloaded.blob.text(), body);
  assert.equal(downloaded.fileName, "report.md");

  // Revocation is reported as a state the person can act on, not a silent retry.
  const sessions = await hostRequest(instance, "GET", "/api/session");
  const current = sessions.body.sessions.find((entry) => entry.sessionId === connected.sessionId);
  assert.ok(current, "the host can see the client's session");
  const revoked = await hostRequest(
    instance,
    "DELETE",
    `/api/session/${encodeURIComponent(current.sessionId)}`
  );
  assert.equal(revoked.status, 200);
  await assert.rejects(client.request("/api/tasks"), (error) => {
    assert.equal(error.code, "session_revoked");
    assert.equal(error.status, 401);
    return true;
  });
  const unauthorized = client.state();
  assert.equal(unauthorized.status, "unauthorized");
  assert.equal(unauthorized.backendId, instance.backendId, "the backend identity is retained");

  const reauthorized = await client.authorize();
  assert.equal(reauthorized.status, "connected");
  assert.notEqual(reauthorized.sessionId, connected.sessionId);
  const tasks = await client.request("/api/tasks");
  assert.ok(
    tasks.tasks.some((entry) => entry.taskId === task.taskId),
    "the Task is still on the backend"
  );
});

test("a lost response is reconciled from the command receipt without repeating the command", async (t) => {
  const root = await createRoot("cowork-web-receipt-");
  const instance = await startBackend(root);
  t.after(() => stopQuietly(root));
  let posts = 0;
  let dropResponse = true;
  const { client } = clientFor(instance, {
    fetch: (url, init = {}) => {
      if (init.method !== "POST" || !String(url).endsWith("/api/tasks")) return undefined;
      posts += 1;
      if (!dropResponse) return undefined;
      dropResponse = false;
      // The server applies the command, but the client never sees the answer.
      return fetch(url, init).then(() => {
        throw new TypeError("fetch failed");
      });
    }
  });
  t.after(() => client.stop());
  const connected = await client.connect({ baseUrl: instance.url });
  assert.equal(connected.status, "connected", JSON.stringify(connected));

  const accepted = await client.command("/api/tasks", {
    body: { taskId: "receipt-task", goal: "只应创建一次" }
  });
  assert.equal(accepted.taskId, "receipt-task");
  assert.equal(posts, 1, "the command was sent once; the receipt answered the retry");
  const tasks = await client.request("/api/tasks");
  assert.equal(tasks.tasks.filter((entry) => entry.goal === "只应创建一次").length, 1);
});

test("switching backends drops the old identity, and a late response or event cannot enter the new view", async (t) => {
  const first = await createRoot("cowork-web-switch-a-");
  const second = await createRoot("cowork-web-switch-b-");
  const firstInstance = await startBackend(first);
  const secondInstance = await startBackend(second);
  t.after(() => stopQuietly(first));
  t.after(() => stopQuietly(second));

  let releaseLate;
  const late = new Promise((done) => {
    releaseLate = done;
  });
  let holdList = false;
  let lateResponse;
  const { client, seen } = clientFor([firstInstance, secondInstance], {
    fetch: (url, init = {}) => {
      if (!holdList || !String(url).endsWith("/api/tasks") || init.method === "POST") return undefined;
      holdList = false;
      return fetch(url, init).then(async (response) => {
        lateResponse = { body: await response.json() };
        await late;
        return response;
      });
    }
  });
  t.after(() => client.stop());

  const onA = await client.connect({ baseUrl: firstInstance.url });
  assert.equal(onA.status, "connected", JSON.stringify(onA));
  const projectA = await createProject(client, "后端 A 的项目", first.project);
  const eventA = await waitFor("backend A's project event", () =>
    seen.events.find((event) => event.objectId === projectA.projectId)
  );

  // A read of A starts and is held while the person picks B.
  holdList = true;
  const pendingRead = client.request("/api/tasks").catch((error) => error);
  await waitFor("the held read to reach the server", () => lateResponse);
  const onB = await client.switchBackend({ baseUrl: secondInstance.url });
  assert.equal(onB.status, "connected", JSON.stringify(onB));
  assert.notEqual(onB.backendId, onA.backendId);
  assert.equal(client.state().backendId, secondInstance.backendId);
  assert.ok(seen.resets.some((reset) => reset.reason === "backend_switched"));

  lateResponse.body.tasks.push({ taskId: "leaked-task", goal: "来自后端 A" });
  releaseLate();
  const failed = await pendingRead;
  assert.equal(failed.code, "stale_client");
  assert.equal(client.state().backendId, secondInstance.backendId, "the late response changed nothing");
  const snapshot = await client.snapshot();
  assert.equal(snapshot.backendId, secondInstance.backendId);
  assert.equal(
    snapshot.projects.some((entry) => entry.projectId === projectA.projectId),
    false,
    "backend A's project is not in backend B's catalog"
  );

  // A real event from A reaching B's connection is dropped by identity.
  let injectedOnce = false;
  const injected = clientFor(secondInstance, {
    fetch: (url, init = {}) => {
      if (!String(url).includes("/api/events/stream") || injectedOnce) return undefined;
      return fetch(url, init).then((response) => {
        injectedOnce = true;
        const reader = response.body.getReader();
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            // A real record from the backend the user switched away from.
            controller.enqueue(encoder.encode(`id: foreign\ndata: ${JSON.stringify(eventA)}\n\n`));
          },
          async pull(controller) {
            const { value, done } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
          },
          cancel(reason) {
            return reader.cancel(reason);
          }
        });
        return new Response(stream, {
          status: response.status,
          headers: { "content-type": "text/event-stream" }
        });
      });
    }
  });
  const injectedClient = injected.client;
  t.after(() => injectedClient.stop());
  // Collect the injected client's events through its own callback rather than
  // the helper's array: the assertion is about what the new client applies.
  const connectedB = await injectedClient.connect({ baseUrl: secondInstance.url });
  assert.equal(connectedB.status, "connected", JSON.stringify(connectedB));
  const projectB = await createProject(injectedClient, "后端 B 的项目", second.project);
  await waitFor("backend B's event after the foreign record", () =>
    injected.seen.events.find((event) => event.objectId === projectB.projectId)
  );
  assert.equal(
    injected.seen.events.some((event) => event.objectId === projectA.projectId),
    false,
    "a record from another backend is never applied"
  );
});

test("a client declaring another protocol version gets the backend's actionable refusal", async (t) => {
  const root = await createRoot("cowork-web-protocol-");
  const instance = await startBackend(root);
  t.after(() => stopQuietly(root));
  const { client, seen } = clientFor(instance, { client: { protocolVersion: "2.0" } });
  t.after(() => client.stop());
  const state = await client.connect({ baseUrl: instance.url });
  assert.equal(state.status, "incompatible");
  assert.equal(state.error.code, "protocol_incompatible");
  assert.match(state.error.message, /2\.0/);
  assert.match(state.error.message, /1\.0/);
  assert.equal(seen.snapshots.length, 0, "no catalog read starts for an incompatible protocol");
});

test("a backend without catalog-event capabilities is named instead of half-starting the view", async (t) => {
  const root = await createRoot("cowork-web-capability-");
  const instance = await startBackend(root);
  t.after(() => stopQuietly(root));
  let snapshots = 0;
  const { client, seen } = clientFor(instance, {
    fetch: (url, init = {}) => {
      if (String(url).endsWith("/api/events/snapshot")) snapshots += 1;
      if (init.method !== "POST" || !String(url).endsWith("/api/session")) return undefined;
      return fetch(url, init).then(async (response) => {
        const body = await response.json();
        body.protocol.capabilities = body.protocol.capabilities.filter((name) => name !== "events.stream");
        return new Response(JSON.stringify(body), {
          status: response.status,
          headers: { "content-type": "application/json" }
        });
      });
    }
  });
  t.after(() => client.stop());
  const state = await client.connect({ baseUrl: instance.url });
  assert.equal(state.status, "unsupported");
  assert.deepEqual(state.missingCapabilities, ["events.stream"]);
  assert.equal(state.error.code, "capability_missing");
  assert.match(state.error.message, /events\.stream/);
  assert.equal(seen.snapshots.length, 0);
  assert.equal(snapshots, 0, "the client does not probe a capability it was told is missing");
});

test("another trusted local browser origin may manage this backend, and only when named", async (t) => {
  const first = await createRoot("cowork-web-origin-page-");
  const firstInstance = await startBackend(first);
  const pageOrigin = new URL(firstInstance.url).origin;
  const second = await createRoot("cowork-web-origin-trust-", {
    COWORK_TRUSTED_CLIENT_ORIGINS: pageOrigin
  });
  const secondInstance = await startBackend(second);
  t.after(() => stopQuietly(first));
  t.after(() => stopQuietly(second));

  const crossOrigin = (method, path, extraHeaders = {}) =>
    fetch(`${secondInstance.url}${path}`, {
      method,
      headers: { origin: pageOrigin, ...extraHeaders },
      signal: AbortSignal.timeout(10_000)
    });

  const preflight = await crossOrigin("OPTIONS", "/api/session", {
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type,x-atria-token"
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), pageOrigin);
  assert.match(preflight.headers.get("access-control-allow-headers"), /x-atria-token/);

  const allowed = await crossOrigin("GET", "/api/backend", { "x-atria-token": secondInstance.token });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), pageOrigin);
  const info = await allowed.json();
  assert.equal(info.backendId, secondInstance.backendId);

  // An origin that was not named keeps the original same-origin rule.
  const stranger = await fetch(`${secondInstance.url}/api/backend`, {
    headers: { origin: "http://127.0.0.1:59999" },
    signal: AbortSignal.timeout(10_000)
  });
  assert.equal(stranger.status, 403);

  // A wildcard is not a trusted origin: it is ignored, never interpreted.
  const wildcard = await createRoot("cowork-web-origin-wildcard-", {
    COWORK_TRUSTED_CLIENT_ORIGINS: "*"
  });
  const wildcardInstance = await startBackend(wildcard);
  t.after(() => stopQuietly(wildcard));
  const refused = await fetch(`${wildcardInstance.url}/api/backend`, {
    headers: { origin: pageOrigin, "x-atria-token": wildcardInstance.token },
    signal: AbortSignal.timeout(10_000)
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get("access-control-allow-origin"), null);
});

test("drafts stay with their backend and a legacy draft migrates once", async (t) => {
  const storage = memoryStorage();
  const input = { value: "", addEventListener() {} };
  let attachments = [];
  const session = createComposerSession({
    input,
    getAttachments: () => attachments,
    setAttachments: (files) => {
      attachments = files;
    },
    storage
  });
  t.after(() => session.prepareClose());

  session.activate(null);
  input.value = "旧版草稿";
  session.save();

  session.setBackend("backend_a");
  session.activate(null);
  assert.equal(input.value, "旧版草稿", "the historical draft migrates into the first backend");

  input.value = "后端 A 的草稿";
  session.save();
  session.setBackend("backend_b");
  session.activate(null);
  assert.equal(input.value, "", "backend B starts with its own empty draft");

  input.value = "后端 B 的草稿";
  session.save();
  session.setBackend("backend_a");
  session.activate(null);
  assert.equal(input.value, "后端 A 的草稿", "switching back restores the draft that backend had");

  session.setBackend("backend_b");
  session.activate(null);
  assert.equal(input.value, "后端 B 的草稿");
});
