import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createObserveData } from "../web/assets/controllers/observe-data.js";
import { readNodes } from "../web/assets/controllers/node-registry.js";

/**
 * The observation entry's multi-node data port against fake backends.
 *
 * Each fake speaks the documented management protocol on its own origin and
 * checks the token it receives, so a token that leaks from one node to another
 * surfaces as a 401 instead of passing silently. Streams stay open until the
 * test drops the backend, which exercises the same reconnect path the browser
 * uses when a node's process stops.
 */

function memoryStorage(initial = {}) {
  const entries = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    get length() {
      return entries.size;
    },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key)
  };
}

async function until(predicate, message, timeout = 4_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(message);
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function fakeBackend({ origin, backendId, projects = [], tasks = [], requirements = {}, authorize = true }) {
  const encoder = new TextEncoder();
  const requests = [];
  const streams = new Set();
  const events = [];
  const backend = {
    origin,
    backendId,
    projects,
    tasks,
    requirements,
    authorize,
    online: true,
    requests,
    authCount: 0,
    token: undefined,
    /** Stop answering requests and end open streams, like a terminated process. */
    drop() {
      backend.online = false;
      for (const stream of streams) stream.close();
    },
    /** Come back with whatever the caller now records. */
    recover(next = {}) {
      backend.online = true;
      Object.assign(backend, next);
    },
    /** Publish one task change to the open stream. */
    publishTask(task) {
      backend.tasks = backend.tasks.map((entry) => (entry.taskId === task.taskId ? task : entry));
      if (!backend.tasks.some((entry) => entry.taskId === task.taskId))
        backend.tasks = [...backend.tasks, task];
      const record = {
        backendId,
        seq: events.length + 1,
        scope: "task",
        type: "task.changed",
        objectId: task.taskId,
        revision: 1,
        payload: task
      };
      events.push(record);
      for (const stream of streams) stream.send(record);
    },
    requestsFor(path) {
      return requests.filter((entry) => entry.path === path);
    }
  };
  const startedAt = new Date().toISOString();

  function openStream(signal) {
    let closed = false;
    let controller;
    const handle = {
      send(record) {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(record)}\n\n`));
      },
      close() {
        if (closed) return;
        closed = true;
        streams.delete(handle);
        controller.close();
      }
    };
    const stream = new ReadableStream({
      start(next) {
        controller = next;
        streams.add(handle);
        for (const record of events) if (record.seq > 0) handle.send(record);
        signal?.addEventListener("abort", () => handle.close());
      },
      cancel() {
        closed = true;
        streams.delete(handle);
      }
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  async function fetchImpl(input, init = {}) {
    const url = new URL(input);
    const method = init.method || "GET";
    const header = init.headers?.["x-atria-token"];
    requests.push({ method, path: url.pathname, search: url.search, token: header });
    if (!backend.online) throw new TypeError("fetch failed");
    if (url.pathname === "/api/session" && method === "POST") {
      if (!backend.authorize)
        return json(401, { error: { code: "host_credential_required", message: "地址未授权" } });
      backend.authCount += 1;
      backend.token = `${origin}#${backend.authCount}`;
      return json(201, {
        session: { sessionId: `session-${backend.authCount}`, token: backend.token },
        backend: { backendId, pid: 1, startedAt },
        protocol: {
          version: "1.0",
          minClientVersion: "1.0",
          capabilities: ["session.authorize", "events.snapshot", "events.stream"]
        }
      });
    }
    if (header !== undefined && header !== backend.token)
      return json(401, { error: { code: "unauthorized", message: "本地会话未授权" } });
    if (url.pathname === "/api/session" && method === "GET") {
      if (!backend.token || header !== backend.token)
        return json(401, { error: { code: "unauthorized", message: "本地会话未授权" } });
      return json(200, {
        current: { kind: "session", sessionId: `session-${backend.authCount}` },
        sessions: []
      });
    }
    if (url.pathname === "/api/backend")
      return json(200, {
        backendId,
        pid: 1,
        startedAt,
        protocol: {
          version: "1.0",
          minClientVersion: "1.0",
          capabilities: ["session.authorize", "events.snapshot", "events.stream"]
        }
      });
    if (url.pathname === "/api/events/snapshot")
      return json(200, {
        backendId,
        cursor: events.length,
        revisions: {},
        projects: backend.projects,
        tasks: backend.tasks
      });
    if (url.pathname === "/api/events/stream") return openStream(init.signal);
    const ledger = url.pathname.match(/^\/api\/projects\/([^/]+)\/ledger$/);
    if (ledger)
      return json(200, {
        requirements: backend.requirements[decodeURIComponent(ledger[1])] ?? []
      });
    return json(404, { error: { code: "not_found", message: "not found" } });
  }

  backend.fetch = fetchImpl;
  return backend;
}

function project(projectId, projectName) {
  return { projectId, projectName, updatedAt: "2026-11-10T00:00:00.000Z" };
}

function localProvider({ projects, tasks, requirements = {}, status = "online" }) {
  return {
    origin: "http://127.0.0.1:3880",
    name: "本机",
    role: "internal",
    status: () => status,
    snapshot: () => ({ projects, tasks }),
    request: async (path) => {
      const match = path.match(/^\/api\/projects\/([^/]+)\/ledger$/);
      if (match) return { requirements: requirements[decodeURIComponent(match[1])] ?? [] };
      throw new Error(`unexpected local read: ${path}`);
    }
  };
}

function createPort({ backends, local, storage = memoryStorage(), sessionStorage = memoryStorage() }) {
  const dispatch = (input, init) => {
    const origin = new URL(input).origin;
    const backend = backends.get(origin);
    if (!backend) return Promise.reject(new TypeError(`no fake backend at ${origin}`));
    return backend.fetch(input, init);
  };
  return createObserveData({
    storage,
    sessionStorage,
    local,
    fetch: dispatch,
    retryDelayMs: 20,
    maxRetryDelayMs: 80
  });
}

test("each node authorizes, holds its own snapshot and event stream, and one refusal affects only itself", async () => {
  const a = fakeBackend({
    origin: "http://127.0.0.1:4001",
    backendId: "backend-a",
    projects: [project("pa", "甲项目")],
    tasks: [{ taskId: "ta", projectId: "pa", status: "running", title: "甲需求" }],
    requirements: { pa: [{ requirementId: "ra", title: "甲需求", status: "open" }] }
  });
  const b = fakeBackend({
    origin: "http://127.0.0.1:4002",
    backendId: "backend-b",
    authorize: false
  });
  const port = createPort({
    backends: new Map([
      [a.origin, a],
      [b.origin, b]
    ]),
    local: localProvider({
      projects: [project("pl", "本机项目")],
      tasks: [{ taskId: "tl", projectId: "pl", status: "idle", title: "本机需求" }],
      requirements: { pl: [{ requirementId: "rl", title: "本机需求", status: "open" }] }
    })
  });
  port.start();
  await port.addNode({ baseUrl: a.origin, name: "甲节点", role: "internal" });
  await port.addNode({ baseUrl: b.origin, name: "乙节点", role: "external" });

  await until(() => port.statusOf(a.origin) === "online", "node A never came online");
  await until(() => port.statusOf(b.origin) === "unauthorized", "node B never reported the refusal");
  await until(() => port.counts().requirements === 2, "ledger counts were not aggregated");

  const data = port.scoped();
  assert.deepEqual(data.projects.map((entry) => entry.projectId).sort(), ["pa", "pl"]);
  assert.equal(data.projects.find((entry) => entry.projectId === "pa").origins[0], a.origin);
  assert.equal(data.tasks.length, 2);
  assert.equal(port.statusOf(a.origin), "online");
  assert.equal(port.statusOf(b.origin), "unauthorized");
  assert.deepEqual(
    port.nodes().map((entry) => [entry.name, entry.status]),
    [
      ["本机", "online"],
      ["甲节点", "online"],
      ["乙节点", "unauthorized"]
    ]
  );

  a.publishTask({ taskId: "ta2", projectId: "pa", status: "waiting", title: "甲新需求" });
  await until(
    () => port.scoped().tasks.some((task) => task.taskId === "ta2"),
    "node A's live event did not reach the view"
  );
  assert.equal(port.counts().runs, 2);

  // Every request one node saw carried that node's token and never the other's.
  for (const request of a.requests) assert.ok(!request.token || request.token.startsWith(`${a.origin}#`));
  for (const request of b.requests) assert.ok(!request.token || request.token.startsWith(`${b.origin}#`));
  assert.equal(
    b.requests.filter((request) => request.path === "/api/events/stream").length,
    0,
    "a refused node must not start an event stream"
  );
  assert.equal(b.authCount, 0);
  port.dispose();
});

test("a node that goes offline leaves the other streaming and refills its snapshot after recovery", async () => {
  const a = fakeBackend({
    origin: "http://127.0.0.1:4001",
    backendId: "backend-a",
    projects: [project("pa", "甲项目")],
    tasks: [{ taskId: "ta", projectId: "pa", status: "running", title: "甲需求" }]
  });
  const b = fakeBackend({
    origin: "http://127.0.0.1:4002",
    backendId: "backend-b",
    projects: [project("pb", "乙项目")],
    tasks: [{ taskId: "tb", projectId: "pb", status: "idle", title: "乙需求" }]
  });
  const port = createPort({
    backends: new Map([
      [a.origin, a],
      [b.origin, b]
    ]),
    local: localProvider({ projects: [], tasks: [] })
  });
  port.start();
  await port.addNode({ baseUrl: a.origin, name: "甲节点" });
  await port.addNode({ baseUrl: b.origin, name: "乙节点" });
  await until(
    () => port.statusOf(a.origin) === "online" && port.statusOf(b.origin) === "online",
    "both nodes did not come online"
  );

  a.drop();
  await until(() => port.statusOf(a.origin) === "offline", "node A never reported offline");
  assert.equal(port.statusOf(b.origin), "online");
  b.publishTask({ taskId: "tb2", projectId: "pb", status: "running", title: "乙新需求" });
  await until(
    () => port.scoped().tasks.some((task) => task.taskId === "tb2"),
    "node B stopped streaming when node A went offline"
  );
  assert.ok(!port.scoped().tasks.some((task) => task.taskId === "ta"));

  a.recover({
    projects: [project("pa", "甲项目")],
    tasks: [
      { taskId: "ta", projectId: "pa", status: "running", title: "甲需求" },
      { taskId: "ta3", projectId: "pa", status: "running", title: "掉线期间新增" }
    ]
  });
  await until(() => port.statusOf(a.origin) === "online", "node A never reconnected");
  await until(
    () => port.scoped().tasks.some((task) => task.taskId === "ta3"),
    "node A did not refill its snapshot after reconnecting"
  );
  assert.ok(a.requestsFor("/api/events/snapshot").length >= 2, "recovery must take a fresh snapshot");
  for (const request of a.requests) assert.ok(!request.token || request.token.startsWith(`${a.origin}#`));
  for (const request of b.requests) assert.ok(!request.token || request.token.startsWith(`${b.origin}#`));
  port.dispose();
});

test("adding, renaming, disconnecting, reauthorizing and removing a node keep its session on its own origin", async () => {
  const a = fakeBackend({
    origin: "http://127.0.0.1:4001",
    backendId: "backend-a",
    projects: [project("pa", "甲项目")],
    tasks: [{ taskId: "ta", projectId: "pa", status: "running", title: "甲需求" }]
  });
  const storage = memoryStorage();
  const sessionStorage = memoryStorage();
  const port = createPort({
    backends: new Map([[a.origin, a]]),
    local: localProvider({ projects: [], tasks: [] }),
    storage,
    sessionStorage
  });
  port.start();

  await port.addNode({ baseUrl: a.origin, name: "甲节点", role: "external" });
  await until(() => port.statusOf(a.origin) === "online", "added node never came online");
  assert.deepEqual(
    readNodes(storage).map((node) => [node.name, node.role]),
    [["甲节点", "external"]]
  );
  assert.ok(
    [...Array(sessionStorage.length).keys()].some((index) =>
      sessionStorage.key(index).startsWith(`cowork.node.${a.origin}:`)
    ),
    "the node session was not stored under its own origin"
  );
  await assert.rejects(port.addNode({ baseUrl: a.origin, name: "重复" }), /已经添加/);

  port.renameNode(a.origin, "甲节点改名");
  assert.equal(readNodes(storage)[0].name, "甲节点改名");

  port.disconnectNode(a.origin);
  assert.equal(port.statusOf(a.origin), "disconnected");
  assert.equal(
    port.scoped().projects.length,
    0,
    "a disconnected node's stale snapshot must not stay in the view"
  );
  await port.reconnectNode(a.origin);
  assert.equal(port.statusOf(a.origin), "online");
  assert.equal(port.scoped().projects.length, 1);

  await port.reauthorizeNode(a.origin);
  assert.equal(a.authCount, 2);
  const last = a.requests.at(-1);
  assert.equal(last.token, `${a.origin}#2`);

  port.removeNode(a.origin);
  assert.deepEqual(readNodes(storage), []);
  assert.equal(sessionStorage.length, 0, "removing a node must drop this device's session for that origin");
  assert.equal(port.statusOf(a.origin), "absent");
  port.dispose();
});

test("the local node follows the page's own connection and snapshot without a second event channel", async () => {
  let status = "offline";
  let tasks = [];
  const port = createPort({
    backends: new Map(),
    local: {
      ...localProvider({ projects: [project("pl", "本机项目")], tasks: [] }),
      status: () => status,
      snapshot: () => ({ projects: [project("pl", "本机项目")], tasks })
    }
  });
  port.start();
  assert.equal(port.statusOf("http://127.0.0.1:3880"), "offline");
  assert.equal(port.scoped().projects.length, 0);

  status = "online";
  tasks = [{ taskId: "tl", projectId: "pl", status: "running", title: "本机需求" }];
  port.localChanged();
  assert.equal(port.statusOf("http://127.0.0.1:3880"), "online");
  assert.equal(port.counts().runs, 1);
  assert.equal(port.nodes().filter((entry) => entry.local).length, 1);
  port.dispose();
});
