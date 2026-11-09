import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { backendEnvironment } = require("../desktop/backend.cjs");

test("desktop leaves model and search configuration under the execution host", async () => {
  const previous = Object.fromEntries(
    ["COWORK_API_BASE", "COWORK_API_KEY", "COWORK_MODEL", "COWORK_EXA_API_KEY"].map((key) => [
      key,
      process.env[key]
    ])
  );
  for (const key of Object.keys(previous)) delete process.env[key];
  try {
    const env = await backendEnvironment({
      userData: "/fixture/data",
      appRoot: process.cwd(),
      workspaceRoot: "/fixture/workspace",
      globalIndex: "/fixture/global",
      tabsIndex: "/fixture/tabs",
      piAgentDir: "/fixture/pi",
      configPath: "/fixture/config"
    });
    for (const key of Object.keys(previous)) assert.equal(env[key], undefined, key);
    assert.equal(env.COWORK_CONFIG, "/fixture/config");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("completion notices follow the selected backend across replay and recovery", async () => {
  const { createTaskNotifications } = await import("../web/assets/controllers/task-notifications.js");
  const sent = [];
  const notices = createTaskNotifications({ notify: (notice) => sent.push(notice) });
  const task = { taskId: "task-one", status: "running", activeRunId: "run-one", title: "Report" };
  notices.snapshot({ backendId: "backend-a", tasks: [task] });
  const finished = { ...task, status: "completed", completedAt: "2026-01-01T00:00:00Z" };
  const event = {
    backendId: "backend-a",
    scope: "task",
    type: "task.changed",
    objectId: task.taskId,
    payload: finished
  };
  notices.event(event);
  notices.event(event);
  notices.snapshot({ backendId: "backend-a", tasks: [finished] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].backendId, "backend-a");
  assert.equal(sent[0].taskId, "task-one");
  notices.snapshot({ backendId: "backend-b", tasks: [{ ...task, title: "Other" }] });
  notices.event(event);
  assert.equal(sent.length, 1);
  notices.snapshot({ backendId: "backend-b", tasks: [finished] });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].backendId, "backend-b");
});

test("desktop suppresses repeated or foreign completion notices across window recreation", () => {
  const { createDesktopNotifications } = require("../desktop/notifications.cjs");
  let selected = "backend-a";
  const shown = [];
  const notices = createDesktopNotifications({
    getBackendId: () => selected,
    supported: () => true,
    show: (value) => shown.push(value)
  });
  const notice = {
    backendId: "backend-a",
    taskId: "task-one",
    completionId: "run-one",
    title: "Done",
    body: "Report"
  };
  assert.equal(notices.notify(notice), true);
  assert.equal(notices.notify(notice), false);
  selected = "backend-b";
  assert.equal(notices.notify(notice), false);
  assert.equal(notices.notify({ ...notice, backendId: "backend-b" }), true);
  assert.equal(shown.length, 2);
  selected = "backend-a";
  assert.equal(notices.notify(notice), false);
});

test("desktop session credentials are encrypted per backend and recover after a failed write", async (t) => {
  const { createSessionCredentialStore } = require("../desktop/session-credentials.cjs");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "cowork-client-credentials-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let fail = false;
  const storage = {
    isEncryptionAvailable: async () => !fail,
    encryptString: async (value) => Buffer.from(value).map((byte) => byte ^ 0x5a),
    decryptString: async (value) =>
      Buffer.from(value)
        .map((byte) => byte ^ 0x5a)
        .toString()
  };
  const store = createSessionCredentialStore({ userData: root, storage });
  const first = { sessionId: "session-a", token: "sess_private_fixture_a" };
  await store.write("backend-a", first);
  assert.deepEqual(await store.read("backend-a"), first);
  assert.equal((await readFile(join(root, "client-sessions.json"), "utf8")).includes(first.token), false);
  fail = true;
  await assert.rejects(store.write("backend-b", { sessionId: "session-b", token: "secret-b" }), /存储/);
  fail = false;
  assert.deepEqual(await store.read("backend-a"), first);
  await store.write("backend-b", { sessionId: "session-b", token: "secret-b" });
  assert.equal((await store.read("backend-b")).token, "secret-b");
  assert.deepEqual(await store.read("backend-a"), first);
});

test("host keeps the session secret, reuses it after restart, and reports revocation", async (t) => {
  const { createBackendAuthorization } = require("../desktop/backend-authorization.cjs");
  const { createSessionCredentialStore } = require("../desktop/session-credentials.cjs");
  const { createServer } = await import("node:http");
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "cowork-client-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = {
    isEncryptionAvailable: async () => true,
    encryptString: async (value) => Buffer.from(value).map((byte) => byte ^ 0x5a),
    decryptString: async (value) =>
      Buffer.from(value)
        .map((byte) => byte ^ 0x5a)
        .toString()
  };
  const sessions = createSessionCredentialStore({ userData: root, storage });
  let revoked = false,
    minted = 0;
  let instance;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/backend" && req.headers["x-atria-token"] === "bootstrap") {
      res.end(
        JSON.stringify({
          ...instance,
          protocol: { version: "1.0", minClientVersion: "1.0", capabilities: [] }
        })
      );
    } else if (
      req.url === "/api/session" &&
      req.method === "POST" &&
      req.headers["x-atria-token"] === "bootstrap"
    ) {
      minted += 1;
      res.end(
        JSON.stringify({
          session: { sessionId: `session-${minted}`, token: `secret-${minted}` },
          backend: instance,
          protocol: { version: "1.0", minClientVersion: "1.0", capabilities: [] }
        })
      );
    } else if (
      req.url === "/api/session" &&
      req.headers["x-atria-token"] === `secret-${minted}` &&
      !revoked
    ) {
      res.end(JSON.stringify({ current: { kind: "session", sessionId: `session-${minted}` } }));
    } else {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { code: "session_revoked", message: "revoked" } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  instance = {
    version: 1,
    backendId: "backend-a",
    createdAt: "2026-01-01",
    startedAt: "2026-01-01",
    pid: process.pid,
    port,
    url: `http://127.0.0.1:${port}`,
    token: "bootstrap"
  };
  await mkdir(join(root, "runtime"));
  await writeFile(join(root, "runtime/backend-identity.json"), JSON.stringify(instance));
  await writeFile(join(root, "runtime/backend-instance.json"), JSON.stringify(instance));
  const host = createBackendAuthorization({ appRoot: process.cwd(), sessionStore: sessions });
  const selected = await host.select(root);
  const input = {
    baseUrl: selected.url,
    backendId: selected.backendId,
    clientName: "test",
    protocolVersion: "1.0"
  };
  const created = await host.authorize(input);
  assert.equal(created.session.token, undefined);
  assert.equal(JSON.stringify(created).includes("secret-1"), false);
  assert.equal(host.requestToken(selected), "secret-1");
  const next = createBackendAuthorization({ appRoot: process.cwd(), sessionStore: sessions });
  const reselected = await next.select(root);
  assert.equal((await next.authorize({ ...input, reuse: true })).session.sessionId, "session-1");
  assert.equal(minted, 1);
  revoked = true;
  await assert.rejects(next.authorize({ ...input, reuse: true }), /revoked/);
  assert.equal(next.requestToken(reselected), undefined);
  revoked = false;
  assert.equal((await next.authorize(input)).session.sessionId, "session-2");
});

test("host injects credentials only for the current desktop capability and selected backend", () => {
  const { createSessionTransport } = require("../desktop/session-transport.cjs");
  let selected = { backendId: "backend-a", url: "http://127.0.0.1:31337" };
  const transport = createSessionTransport({
    getSelected: () => selected,
    requestToken: () => "host-secret"
  });
  const nonce = transport.rotate();
  const headers = (url, extra = {}) => transport.authorize(new Request(url, { headers: extra })).headers;
  const granted = headers(`${selected.url}/api/models`, { "x-cowork-desktop-nonce": nonce });
  assert.equal(granted.get("x-atria-token"), "host-secret");
  assert.equal(granted.has("x-cowork-desktop-nonce"), false);
  assert.equal(headers(`${selected.url}/api/models`).has("x-atria-token"), false);
  assert.equal(
    headers("http://127.0.0.1:31338/api/models", {
      "x-cowork-desktop-nonce": nonce,
      "x-atria-token": "host-secret"
    }).has("x-atria-token"),
    false
  );
  assert.equal(
    headers(`${selected.url}/assets/app.js`, { "x-cowork-desktop-nonce": nonce }).has("x-atria-token"),
    false
  );
  transport.rotate();
  assert.equal(
    headers(`${selected.url}/api/models`, { "x-cowork-desktop-nonce": nonce }).has("x-atria-token"),
    false
  );
  selected = { backendId: "backend-b", url: "http://127.0.0.1:31338" };
  assert.equal(
    headers("http://127.0.0.1:31337/api/models", { "x-cowork-desktop-nonce": transport.nonce() }).has(
      "x-atria-token"
    ),
    false
  );
});

test("bundled protocol forwards a marked request without exposing its capability to the backend", async () => {
  const { createSessionTransport } = require("../desktop/session-transport.cjs");
  const { createBundledWebHandler } = require("../desktop/bundled-web.cjs");
  const selected = { backendId: "backend-a", url: "http://127.0.0.1:31337" };
  const transport = createSessionTransport({
    getSelected: () => selected,
    requestToken: () => "session-fixture"
  });
  const marker = transport.rotate();
  const seen = [];
  const handler = createBundledWebHandler({
    root: process.cwd(),
    getOrigin: () => selected.url,
    authorizeRequest: (request) => transport.authorize(request),
    fetch: async (request) => {
      seen.push({
        session: request.headers.get("x-atria-token"),
        marker: request.headers.get("x-cowork-desktop-nonce")
      });
      return new Response(null, { status: request.headers.has("x-atria-token") ? 200 : 401 });
    }
  });
  assert.equal(
    (
      await handler(
        new Request(`${selected.url}/api/models`, { headers: { "x-cowork-desktop-nonce": marker } })
      )
    ).status,
    200
  );
  assert.equal((await handler(new Request(`${selected.url}/api/models`))).status, 401);
  assert.deepEqual(seen, [
    { session: "session-fixture", marker: null },
    { session: null, marker: null }
  ]);
});

test("shared management client uses a host-managed session without a renderer token", async () => {
  const { createManagementClient } = await import("../web/assets/controllers/management-client.js");
  const requests = [],
    inputs = [],
    writes = [],
    removed = [];
  const protocol = {
    version: "1.0",
    minClientVersion: "1.0",
    capabilities: ["session.authorize", "events.snapshot", "events.stream"]
  };
  const client = createManagementClient({
    hostManagedSession: true,
    authorizeSession: async (input) => {
      inputs.push(input);
      return { session: { sessionId: "session-a" }, backend: { backendId: "backend-a" }, protocol };
    },
    storage: {
      getItem: () => null,
      setItem: (_key, value) => writes.push(value),
      removeItem: (key) => removed.push(key)
    },
    fetch: async (url, options) => {
      requests.push({ url, headers: options.headers });
      if (url.startsWith("/api/events/stream")) {
        return new Response(
          new ReadableStream({
            start(controller) {
              options.signal.addEventListener("abort", () => controller.close(), { once: true });
            }
          })
        );
      }
      if (url === "/api/events/snapshot")
        return Response.json({ backendId: "backend-a", cursor: 0, revisions: {}, tasks: [] });
      return Response.json({ ok: true });
    }
  });
  assert.equal((await client.connect()).status, "connected");
  assert.equal(inputs[0].reuse, true);
  assert.deepEqual(await client.request("/api/models"), { ok: true });
  assert.ok(requests.every((request) => !request.headers?.["x-atria-token"]));
  assert.deepEqual(writes, []);
  assert.deepEqual(removed, ["cowork.management.sessions.v1"]);
  client.stop();
});

test("settings edits remain bound to the backend where they were opened", async () => {
  const { createSettingsBackend } = await import("../web/assets/controllers/settings-backend.js");
  let selected = "backend-a";
  const calls = [];
  const settings = createSettingsBackend({
    identity: () => selected,
    api: async (path, options) => {
      calls.push({ backend: selected, path, options });
      return { configured: true };
    }
  });
  settings.bind();
  await settings.request("/api/model-settings", { method: "GET" });
  selected = "backend-b";
  await assert.rejects(settings.request("/api/model-settings", { method: "POST", body: "{}" }), /后端已切换/);
  assert.equal(calls.length, 1);
  settings.bind();
  await settings.request("/api/web-search-settings", { method: "POST", body: "{}" });
  assert.equal(calls.at(-1).backend, "backend-b");
});

test("tray exposes a localized show and quit menu and releases its native listener", () => {
  const { createDesktopTray } = require("../desktop/tray.cjs");
  let instance;
  const calls = [];
  class Tray {
    constructor(image) {
      this.image = image;
      instance = this;
    }
    setToolTip(value) {
      this.tooltip = value;
    }
    setContextMenu(menu) {
      this.menu = menu;
    }
    on(name, listener) {
      this[name] = listener;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const image = { resize: () => image, setTemplateImage: () => {} };
  const tray = createDesktopTray({
    Tray,
    Menu: { buildFromTemplate: (items) => items },
    nativeImage: { createFromPath: () => image },
    icon: "/fixture/icon.png",
    platform: "darwin",
    language: "en",
    show: () => calls.push("show"),
    quit: () => calls.push("quit")
  });
  assert.equal(tray.supported, true);
  assert.equal(instance.menu[0].label, "Show Formicand");
  instance.click();
  instance.menu[2].click();
  assert.deepEqual(calls, ["show", "quit"]);
  tray.setLanguage("zh-CN");
  assert.equal(instance.menu[0].label, "显示 Formicand");
  tray.dispose();
  assert.equal(instance.destroyed, true);
});

test(
  "two real backends keep desktop settings and client sessions isolated",
  { timeout: 120000 },
  async (t) => {
    for (const name of Object.keys(process.env))
      if (/^(?:COWORK_|ATRIA_|PI_|ELECTRON_|EXA_|SERPER_)/.test(name)) delete process.env[name];
    const { createManagementClient } = await import("../web/assets/controllers/management-client.js");
    const { createSettingsBackend } = await import("../web/assets/controllers/settings-backend.js");
    const { createBackendAuthorization } = require("../desktop/backend-authorization.cjs");
    const { createSessionCredentialStore } = require("../desktop/session-credentials.cjs");
    const { createSessionTransport } = require("../desktop/session-transport.cjs");
    const { desktopPaths, prepareDesktopData } = require("../desktop/paths.cjs");
    const { connectBackend } = require("../desktop/backend.cjs");
    const { mkdtemp, writeFile, rm, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "cowork-desktop-two-hosts-"));
    const processes = [];
    let client;
    t.after(async () => {
      client?.stop();
      for (const process of processes) await process.stop();
      await rm(root, { recursive: true, force: true });
    });
    for (const name of ["a", "b"]) {
      const paths = desktopPaths(process.cwd(), join(root, name), {});
      await prepareDesktopData(paths, "test");
      await writeFile(paths.configPath, "{}\n");
      processes.push(await connectBackend(paths, undefined, process.execPath));
    }
    const storage = {
      isEncryptionAvailable: async () => true,
      encryptString: async (value) => Buffer.from(value).map((byte) => byte ^ 0x5a),
      decryptString: async (value) =>
        Buffer.from(value)
          .map((byte) => byte ^ 0x5a)
          .toString()
    };
    const store = createSessionCredentialStore({ userData: join(root, "client"), storage });
    const host = createBackendAuthorization({ appRoot: process.cwd(), sessionStore: store });
    let selected = await host.select(join(root, "a"));
    const transport = createSessionTransport({
      getSelected: () => selected,
      requestToken: (expected) => host.requestToken(expected)
    });
    const nonce = transport.rotate();
    client = createManagementClient({
      hostManagedSession: true,
      transportHeaders: { "x-cowork-desktop-nonce": nonce },
      authorizeSession: (input) =>
        host.authorize({ ...input, baseUrl: selected.url, backendId: selected.backendId }),
      fetch: (url, options) => {
        const absolute = new URL(url, selected.url).href;
        return fetch(transport.authorize(new Request(absolute, options)));
      }
    });
    assert.equal((await client.connect()).status, "connected");
    const identity = () => {
      const current = client.state();
      return current.status === "connected"
        ? `${current.backendId}:${current.pid}:${current.startedAt}`
        : null;
    };
    const settings = createSettingsBackend({
      identity,
      api: (path, options) => client.request(path, options)
    });
    settings.bind();
    assert.equal((await settings.request("/api/model-settings")).configured, false);
    selected = await host.select(join(root, "b"));
    assert.equal((await client.switchBackend({ baseUrl: "" })).status, "connected");
    await assert.rejects(
      settings.request("/api/model-settings", { method: "POST", body: "{}" }),
      /后端已切换/
    );
    settings.bind();
    const modelKey = "fixture-model-secret",
      searchKey = "fixture-search-secret";
    const model = await settings.request("/api/model-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profileName: "B",
        baseUrl: "https://example.invalid/v1",
        model: "fixture-model",
        api: "openai-responses",
        apiKey: modelKey
      })
    });
    const search = await settings.request("/api/web-search-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "exa", exaApiKey: searchKey })
    });
    assert.equal(model.configured, true);
    assert.equal(search.authenticated, true);
    assert.equal(JSON.stringify([model, search]).includes(modelKey), false);
    assert.equal(JSON.stringify([model, search]).includes(searchKey), false);
    assert.deepEqual(JSON.parse(await readFile(join(root, "a", "model-config.json"), "utf8")), {});
    const b = await readFile(join(root, "b", "credentials.json"), "utf8");
    assert.ok(b.includes(modelKey) && b.includes(searchKey));
    for (const instance of processes) process.kill(instance.pid, 0);
  }
);

test("legacy single-connection ciphertext is reported before migration and preserved", async (t) => {
  const { createModelSettings } = await import("../dist/src/dashboard/model-settings.js");
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "cowork-old-single-key-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  process.env.COWORK_CONFIG = join(root, "model-config.json");
  const config = { baseUrl: "https://fixture.invalid", model: "legacy" };
  await writeFile(process.env.COWORK_CONFIG, JSON.stringify(config));
  await writeFile(join(root, "model-secret.bin"), "fixture-ciphertext");
  const settings = createModelSettings(root, config, () => false);
  const value = settings.status();
  assert.equal(value.credentialUnavailable, true);
  assert.match(value.credentialError, /迁移/);
  await assert.rejects(settings.test({}), /迁移/);
  assert.equal(await readFile(join(root, "model-secret.bin"), "utf8"), "fixture-ciphertext");
  delete process.env.COWORK_CONFIG;
});

test(
  "catalog reconnect and backend switch retire listeners without duplicate completion notices",
  { timeout: 15000 },
  async (t) => {
    const { createManagementEventClient } = await import("../web/assets/controllers/management-events.js");
    const { createTaskNotifications } = await import("../web/assets/controllers/task-notifications.js");
    const { createServer } = await import("node:http");
    const servers = [];
    const clients = [];
    const createHost = async (backendId) => {
      const streams = new Set();
      let closed = 0;
      const server = createServer((request, response) => {
        if (request.url === "/api/events/snapshot") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              backendId,
              cursor: 0,
              revisions: {},
              tasks: [{ taskId: "task-one", status: "running", activeRunId: "run-one" }]
            })
          );
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        response.write(": connected\n\n");
        streams.add(response);
        response.on("close", () => {
          streams.delete(response);
          closed += 1;
        });
      });
      await new Promise((done) => server.listen(0, "127.0.0.1", done));
      servers.push(server);
      return {
        url: `http://127.0.0.1:${server.address().port}`,
        streams,
        closed: () => closed,
        send(record) {
          for (const stream of streams) stream.write(`data: ${JSON.stringify(record)}\n\n`);
        },
        disconnect() {
          for (const stream of streams) stream.destroy();
        }
      };
    };
    t.after(async () => {
      for (const client of clients) client.stop();
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      }
    });
    const until = async (predicate) => {
      for (let index = 0; index < 200; index++) {
        if (predicate()) return;
        await new Promise((done) => setTimeout(done, 25));
      }
      throw new Error("timed out waiting for the catalog stream");
    };
    const a = await createHost("backend-a"),
      b = await createHost("backend-b");
    const delivered = [];
    const notifications = createTaskNotifications({ notify: (notice) => delivered.push(notice) });
    const client = createManagementEventClient({
      backendId: "backend-a",
      baseUrl: a.url,
      retryDelayMs: 25,
      onSnapshot: (snapshot) => notifications.snapshot(snapshot),
      onEvent: (event) => notifications.event(event)
    });
    clients.push(client);
    const record = (backendId, seq, revision) => ({
      backendId,
      seq,
      revision,
      eventId: `${backendId}:${seq}`,
      scope: "task",
      objectId: "task-one",
      type: "task.changed",
      payload: {
        taskId: "task-one",
        status: "completed",
        completedAt: "2026-01-01T00:00:00Z",
        title: "fixture"
      }
    });
    await client.start();
    await until(() => a.streams.size === 1);
    a.send(record("backend-a", 1, 1));
    await until(() => delivered.length === 1);
    a.disconnect();
    await until(() => a.closed() >= 1);
    await until(() => a.streams.size === 1);
    a.send(record("backend-a", 1, 1));
    a.send(record("backend-a", 2, 2));
    await until(() => client.state().cursor === 2);
    assert.equal(delivered.length, 1);
    await client.switchBackend({ backendId: "backend-b", baseUrl: b.url });
    await until(() => a.streams.size === 0 && b.streams.size === 1);
    b.send(record("backend-a", 3, 3));
    b.send(record("backend-b", 1, 1));
    await until(() => delivered.length === 2);
    assert.deepEqual(
      delivered.map((notice) => notice.backendId),
      ["backend-a", "backend-b"]
    );
    client.stop();
    await until(() => b.streams.size === 0);
  }
);
