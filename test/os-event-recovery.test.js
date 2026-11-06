import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createCatalogEvents } from "../dist/src/dashboard/catalog-events.js";
import { EventLedger } from "../dist/src/dashboard/event-ledger.js";
import { createManagementEventClient } from "../web/assets/controllers/management-events.js";

/**
 * Recovery across the snapshot/event handoff.
 *
 * A client that reconnects must land on the authoritative catalog, not a
 * best-effort replay: the snapshot names the cursor it was taken at, the stream
 * continues from it, duplicates and reordering never re-apply a change, an
 * expired cursor sends the client back for a snapshot, and a backend that
 * committed state without writing its event recovers the missing event on the
 * next start. Every case runs against real backend processes and temporary data
 * roots; the ordering rules of the shared client are driven through its public
 * transport seam with records the real backend produced.
 */

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const backendEntry = join(repositoryRoot, "dist/src/cli/backend.js");

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

function isolatedEnv(overrides) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_|SERPER_)/.test(name))
  );
  return { ...inherited, ...overrides };
}

async function createRoot(prefix, overrides = {}) {
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
    ...overrides
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
  assert.equal(result.code, 0, `${args.join(" ")} failed: ${result.err || result.out}`);
  return JSON.parse(result.out);
}

const startBackend = (env) => backendCommand(["start"], env);
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

async function api(root, method, path, body, credential) {
  const instance = await readInstance(root);
  const token = credential === undefined ? instance.token : credential;
  const headers = {};
  if (token) headers["x-atria-token"] = token;
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

async function waitFor(description, check, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await delay(50);
  }
}

async function authorize(root, clientName = "恢复客户端") {
  const created = await api(root, "POST", "/api/session", { clientName, protocolVersion: "1.0" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.session;
}

async function stopQuietly(root) {
  try {
    await runProcess(process.execPath, [backendEntry, "stop"], root.env);
  } catch {
    /* fall through to the recorded pid */
  }
  try {
    const instance = JSON.parse(await readFile(instancePath(root), "utf8"));
    if (instance.pid && alive(instance.pid)) process.kill(instance.pid, "SIGKILL");
  } catch {
    /* no record or the process is gone */
  }
}

const snapshotOf = async (root, token) => {
  const response = await api(root, "GET", "/api/events/snapshot", undefined, token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
};

async function createProject(root, token, name, directory, operationId) {
  await mkdir(directory, { recursive: true });
  const response = await api(
    root,
    "POST",
    "/api/projects",
    { projectName: name, projectDirectory: directory, operationId },
    token
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.project;
}

async function createTask(root, token, input) {
  const response = await api(root, "POST", "/api/tasks", input, token);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

/** Read SSE frames until `enough` says so; returns the status and records. */
async function readStream(instance, token, cursor, enough, timeoutMs = 20_000) {
  const controller = new AbortController();
  const response = await fetch(`${instance.url}/api/events/stream?cursor=${cursor}`, {
    headers: { "x-atria-token": token, accept: "text/event-stream" },
    signal: controller.signal
  });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    controller.abort();
    return { status: response.status, body, records: [] };
  }
  const records = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    while (!enough(records)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
        if (data) records.push(JSON.parse(data));
      }
    }
  } catch {
    /* the abort that ends the read is deliberate */
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return { status: response.status, records };
}

const authenticatedFetch =
  (token) =>
  (url, options = {}) =>
    fetch(url, { ...options, headers: { ...(options.headers || {}), "x-atria-token": token } });

/**
 * A transport whose stream bodies the test controls.
 *
 * The snapshot comes from the caller; each stream connection is a real SSE body
 * the test writes into. That makes delivery order, duplication and the identity
 * a record names controllable, which is what a stale socket or a backend switch
 * looks like from the client's side. `serve` can preload a connection's backlog
 * so a reconnect replays from the cursor the client asked for.
 */
function controllableTransport({ snapshot, serve }) {
  const streams = [];
  const cursors = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes("/api/events/snapshot"))
      return new Response(JSON.stringify(snapshot()), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    const cursor = Number(new URL(url).searchParams.get("cursor"));
    cursors.push(cursor);
    let sink;
    let entry;
    const body = new ReadableStream({
      start(controller) {
        sink = controller;
        entry = { controller, cancelled: false };
        streams.push(entry);
        for (const record of serve?.(cursor) ?? [])
          controller.enqueue(new TextEncoder().encode(frame(record)));
      },
      cancel() {
        if (entry) entry.cancelled = true;
      }
    });
    // A real fetch cancels its body when the request is aborted; the fake does
    // the same so "the old connection is closed" is observable here too.
    options.signal?.addEventListener(
      "abort",
      () => {
        if (entry) entry.cancelled = true;
        try {
          sink?.close();
        } catch {
          /* already closed */
        }
      },
      { once: true }
    );
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const frame = (record) => `id: ${record.eventId ?? "test"}\ndata: ${JSON.stringify(record)}\n\n`;
  const newest = () => [...streams].reverse().find((entry) => !entry.cancelled)?.controller;
  return {
    fetch: fetchImpl,
    cursors,
    streams,
    push(record) {
      const controller = newest();
      try {
        controller?.enqueue(new TextEncoder().encode(frame(record)));
      } catch {
        /* the client already dropped this stream */
      }
    },
    cancelled() {
      return streams.filter((entry) => entry.cancelled).length;
    }
  };
}

// ---------------------------------------------------------------------------
// The ledger's own contract: sequence, revision, retention and recovery.
// ---------------------------------------------------------------------------

test("the ledger keeps sequence, revisions and retention across a restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "events");
  const ledger = await EventLedger.open(directory, "backend_test", { maxRecords: 4 });
  const task = (version, title) => ({
    taskId: "task-a",
    title,
    status: "created",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: `2026-01-01T00:00:${String(version).padStart(2, "0")}.000Z`,
    version
  });
  const project = (updatedAt) => ({ projectId: "project-a", projectName: "项目", updatedAt });

  const first = await ledger.publish({
    scope: "task",
    objectId: "task-a",
    type: "task.changed",
    payload: task(1, "一")
  });
  assert.equal(first.seq, 1);
  assert.equal(first.revision, 1);
  assert.equal(first.eventId, "backend_test:1");
  const second = await ledger.publish({
    scope: "task",
    objectId: "task-a",
    type: "task.changed",
    payload: task(2, "二")
  });
  assert.equal(second.seq, 2);
  assert.equal(second.revision, 2, "an object revision counts only its own events");
  const other = await ledger.publish({
    scope: "project",
    objectId: "project-a",
    type: "project.changed",
    payload: project("2026-01-01T00:00:00.000Z")
  });
  assert.equal(other.seq, 3);
  assert.equal(other.revision, 1, "each object starts at revision 1");
  assert.deepEqual(
    ledger.replay(0).map((record) => record.seq),
    [1, 2, 3]
  );
  assert.deepEqual(
    ledger.replay(2).map((record) => record.seq),
    [3]
  );
  assert.equal(ledger.canReplay(0), true);
  assert.equal(ledger.canReplay(4), false, "a cursor beyond the sequence needs a snapshot");

  // Reopening keeps the sequence and object revisions: a client cached before
  // the restart is still valid and the next event continues instead of restarting.
  const reopened = await EventLedger.open(directory, "backend_test", { maxRecords: 4 });
  assert.equal(reopened.cursor(), 3);
  const fourth = await reopened.publish({
    scope: "task",
    objectId: "task-a",
    type: "task.changed",
    payload: task(3, "三")
  });
  assert.equal(fourth.seq, 4);
  assert.equal(fourth.revision, 3);

  // Reconciliation publishes only what is missing, never rolls back, and keeps
  // the cursor where it was when nothing changed.
  const stable = await reopened.reconcile({
    projects: [project("2026-01-01T00:00:00.000Z")],
    tasks: [task(3, "三")]
  });
  assert.equal(stable.cursor, 4, "an unchanged catalog publishes nothing");
  const newer = await reopened.reconcile({
    projects: [project("2026-01-01T00:00:00.000Z")],
    tasks: [task(4, "四")]
  });
  assert.equal(newer.cursor, 5, "a committed change with no event is published");
  assert.equal(newer.revisions["task:task-a"], 4);
  const older = await reopened.reconcile({
    projects: [project("2026-01-01T00:00:00.000Z")],
    tasks: [task(3, "三")]
  });
  assert.equal(older.cursor, 5, "an older catalog read never rolls a published object back");

  // Retention: the log keeps the newest records, the persisted index keeps the
  // objects and their revisions, and an older cursor is refused, not skipped.
  for (let version = 5; version <= 9; version += 1)
    await reopened.reconcile({
      projects: [project("2026-01-01T00:00:00.000Z")],
      tasks: [task(version, String(version))]
    });
  assert.ok(reopened.cursor() >= 9);
  assert.ok(reopened.earliest() > 1, "the oldest records were compacted");
  assert.equal(reopened.canReplay(0), false, "a cursor before the retained window is refused");
  assert.equal(reopened.canReplay(reopened.earliest() - 1), true);
  assert.equal(
    reopened.replay(reopened.earliest() - 1).every((record) => record.seq >= reopened.earliest()),
    true
  );
  const afterCompaction = await EventLedger.open(directory, "backend_test", { maxRecords: 4 });
  const next = await afterCompaction.publish({
    scope: "task",
    objectId: "task-a",
    type: "task.changed",
    payload: task(100, "一百")
  });
  assert.ok(next.revision > 9, "compaction keeps object revisions, not just the log");

  // A deletion is published only for an object this process already saw in a
  // complete catalog: an unreadable root must not erase subscriptions.
  const fresh = await EventLedger.open(join(root, "events-2"), "backend_test", { maxRecords: 8 });
  await fresh.reconcile({ projects: [], tasks: [task(1, "一")] });
  const before = fresh.cursor();
  const deleted = await fresh.reconcile({ projects: [], tasks: [] });
  assert.ok(deleted.cursor > before, "a task that vanished publishes a tombstone");
  const tombstone = fresh.replay(before).find((record) => record.type === "task.deleted");
  assert.equal(tombstone.objectId, "task-a");
  assert.deepEqual(tombstone.payload, {});
  const repeated = await fresh.reconcile({ projects: [], tasks: [] });
  assert.equal(repeated.cursor, deleted.cursor, "a tombstone is published once");
  const stale = await fresh.reconcile({ projects: [], tasks: [task(1, "一")] });
  assert.equal(
    stale.cursor,
    deleted.cursor,
    "a catalog read from before the deletion cannot revive the object"
  );
  const recreated = await fresh.reconcile({ projects: [], tasks: [task(2, "二")] });
  assert.ok(recreated.cursor > stale.cursor, "an object that came back with a newer revision is published");
  await fresh.close();
  await afterCompaction.close();
  await reopened.close();
  await ledger.close();
});

// ---------------------------------------------------------------------------
// A subscription's own resources: timers and listeners end with it.
// ---------------------------------------------------------------------------

test("a subscription releases its timers and listeners on reset and on disconnect", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-events-subscribe-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // Track the real interval handles the subscription creates, so "ended" is
  // proven by the handles going away, not by a callback that became a no-op.
  const created = new Set();
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (callback, ms, ...rest) => {
    const handle = realSetInterval(callback, ms, ...rest);
    created.add(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    created.delete(handle);
    return realClearInterval(handle);
  };
  t.after(() => {
    for (const handle of created) realClearInterval(handle);
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  });
  const baseline = created.size;

  const ledger = await EventLedger.open(join(root, "events"), "backend_subscribe", { maxRecords: 4 });
  t.after(() => ledger.close());
  let published = 0;
  const publishProject = async (name) => {
    published += 1;
    await ledger.publish({
      scope: "project",
      objectId: `project-${name}`,
      type: "project.changed",
      payload: {
        projectId: `project-${name}`,
        projectName: name,
        updatedAt: new Date(1_700_000_000_000 + published).toISOString()
      }
    });
  };
  // Publishing inside this read makes a live subscriber fall behind the
  // retained window while its own emit is in flight: no timing race, and the
  // reset happens on the poll that was already running.
  let burst = 0;
  const service = createCatalogEvents({
    ledger: Promise.resolve(ledger),
    readCatalog: async () => {
      const count = burst;
      burst = 0;
      for (let index = 0; index < count; index += 1) await publishProject(`burst-${published}`);
      return { projects: [], tasks: [] };
    },
    pollMs: 20,
    reconcileMs: 0
  });
  /** One HTTP/1.1 response as the stream sees it, including its real close event. */
  const connection = () => {
    const request = new EventEmitter();
    const response = new EventEmitter();
    const frames = [];
    let ended = false;
    response.writeHead = () => {};
    response.write = (chunk) => {
      frames.push(String(chunk));
      return true;
    };
    response.end = () => {
      ended = true;
      response.emit("close");
    };
    return { request, response, frames, ended: () => ended };
  };

  // Repeated subscribe → reset → close cycles must each return to the baseline,
  // not accumulate one leaked pair per round.
  for (let round = 1; round <= 3; round += 1) {
    await publishProject(`round-${round}-seed`);
    const stream = connection();
    await service.subscribe(stream.request, stream.response, ledger.cursor());
    assert.equal(created.size, baseline + 2, `round ${round} owns exactly the poll and keep-alive timers`);
    assert.equal(stream.request.listenerCount("close"), 1);
    assert.equal(stream.response.listenerCount("close"), 1);

    burst = 12; // more than the retained window, so this subscriber is now behind
    await waitFor(`round ${round} to reset`, () => stream.ended(), 5_000);
    assert.equal(created.size, baseline, `round ${round} released both timers`);
    assert.equal(stream.request.listenerCount("close"), 0, "the request keeps no listener");
    assert.equal(stream.response.listenerCount("close"), 0, "the response keeps no listener");
    assert.equal(
      stream.frames.some((frame) => frame.includes("stream.reset")),
      true,
      "the client learns why the stream ended"
    );

    // The emit that ended the response keeps no writing into it, and a repeated
    // close event is not a second teardown.
    const written = stream.frames.length;
    await delay(150);
    assert.equal(stream.frames.length, written, `round ${round} wrote nothing after settling`);
    stream.request.emit("close");
    stream.response.emit("close");
    assert.equal(created.size, baseline, `round ${round} ignored the repeated close`);
  }

  // A plain client disconnect goes through the same end path.
  const stream = connection();
  await service.subscribe(stream.request, stream.response, ledger.cursor());
  assert.equal(created.size, baseline + 2);
  stream.request.emit("close");
  assert.equal(created.size, baseline, "a disconnect releases both timers");
  assert.equal(stream.request.listenerCount("close"), 0);
  assert.equal(stream.response.listenerCount("close"), 0);
  const written = stream.frames.length;
  await delay(150);
  assert.equal(stream.frames.length, written, "a disconnected subscription writes nothing more");
});

// ---------------------------------------------------------------------------
// AC1: the snapshot/subscription handoff.
// ---------------------------------------------------------------------------

test("a change made between the snapshot and the subscription is replayed once and the view matches the backend", async (t) => {
  const root = await createRoot("atria-recovery-handoff-");
  t.after(async () => {
    await stopQuietly(root);
    await rm(root.base, { recursive: true, force: true });
  });
  await startBackend(root.env);
  const session = await authorize(root);
  const instance = await readInstance(root);
  const project = await createProject(root, session.token, "恢复项目", root.project, "op-project");
  await createTask(root, session.token, {
    taskId: "first-task",
    goal: "第一个真实任务",
    projectId: project.projectId,
    operationId: "op-first"
  });
  const before = await snapshotOf(root, session.token);
  assert.equal(before.backendId, instance.backendId);
  assert.ok(before.cursor > 0, "the snapshot names the sequence it was taken at");
  const cursor = before.cursor;
  assert.ok(before.tasks.some((task) => task.taskId === "first-task"));
  assert.equal(before.revisions["task:first-task"], 1);

  // The handoff window, made real: these changes commit after the snapshot
  // response was produced and before the stream is opened, which is exactly the
  // gap that must be replayed rather than lost.
  let changed = false;
  const written = [];
  const handingOff = async (url, options = {}) => {
    const response = await fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), "x-atria-token": session.token }
    });
    if (!String(url).includes("/api/events/snapshot") || changed) return response;
    changed = true;
    const snapshot = await response.clone().json();
    written.push(
      await createTask(root, session.token, {
        taskId: "second-task",
        goal: "交接期间创建的任务",
        projectId: project.projectId,
        operationId: "op-second"
      })
    );
    const renamed = await api(
      root,
      "PATCH",
      "/api/tasks/first-task",
      { title: "交接期间改名的任务" },
      session.token
    );
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    written.push(
      await createProject(
        root,
        session.token,
        "交接期间的项目",
        join(root.base, "handoff-project"),
        "op-handoff"
      )
    );
    assert.equal(snapshot.cursor, cursor, "the snapshot given to the client was taken before these changes");
    return response;
  };

  const applied = [];
  const snapshots = [];
  const resets = [];
  const client = createManagementEventClient({
    backendId: instance.backendId,
    baseUrl: instance.url,
    fetch: handingOff,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onEvent: (event) => applied.push(event),
    onReset: (reset) => resets.push(reset)
  });
  t.after(() => client.stop());
  await client.start();
  await waitFor("the subscription to replay the handoff events", () => applied.length >= 3, 20_000);

  assert.equal(written.length, 2);
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.cursor),
    [cursor],
    "the client starts from the snapshot it was given"
  );
  assert.deepEqual(resets, [], "a valid cursor needs no reset");
  assert.deepEqual(
    applied.map((event) => event.seq),
    [cursor + 1, cursor + 2, cursor + 3],
    "the handoff events arrive in sequence order with no duplicate"
  );
  assert.deepEqual(
    applied.map((event) => `${event.scope}:${event.objectId}`).sort(),
    [`project:${written[1].projectId}`, "task:first-task", "task:second-task"].sort(),
    "one event per changed object: the rename and the creation are separate changes"
  );

  // Fold the events onto the snapshot the way a client view does, then compare
  // with a fresh authoritative read.
  const folded = new Map(snapshots[0].tasks.map((task) => [task.taskId, task]));
  for (const event of applied) {
    if (event.type === "task.deleted") folded.delete(event.objectId);
    else if (event.scope === "task") folded.set(event.objectId, event.payload);
  }
  const after = await snapshotOf(root, session.token);
  assert.deepEqual(
    [...folded.keys()].sort(),
    after.tasks.map((task) => task.taskId).sort(),
    "the snapshot plus its events names exactly the authoritative tasks"
  );
  assert.equal(folded.get("second-task").goal, "交接期间创建的任务");
  assert.equal(folded.get("first-task").title, "交接期间改名的任务", "the rename arrived as its own event");
  assert.equal(client.state().cursor, cursor + 3);

  // A client that snapshots after those changes and then receives the same
  // records must not apply any of them again: revisions make replay onto a
  // newer snapshot a no-op, which is a reconnect after a slow frame.
  const history = await readStream(instance, session.token, 0, (records) => records.length >= 4);
  const replaying = [];
  const transport = controllableTransport({
    snapshot: () => after,
    serve: (from) => history.records.filter((record) => record.seq > from)
  });
  const replayer = createManagementEventClient({
    backendId: instance.backendId,
    baseUrl: instance.url,
    fetch: transport.fetch,
    onEvent: (event) => replaying.push(event)
  });
  t.after(() => replayer.stop());
  await replayer.start();
  await delay(300);
  assert.deepEqual(replaying, [], "events already folded into the snapshot are stale, not re-applied");
  assert.equal(replayer.state().cursor, after.cursor, "stale records do not move the cursor");
});

// ---------------------------------------------------------------------------
// AC2: duplicates, ordering, expiry, and no re-execution on resubscribe.
// ---------------------------------------------------------------------------

test("an expired cursor refuses the subscription and sends the client back for a snapshot", async (t) => {
  const root = await createRoot("atria-recovery-expiry-", { COWORK_EVENT_LEDGER_RECORDS: "4" });
  t.after(async () => {
    await stopQuietly(root);
    await rm(root.base, { recursive: true, force: true });
  });
  await startBackend(root.env);
  const session = await authorize(root);
  const instance = await readInstance(root);
  for (let index = 0; index < 6; index += 1)
    await createProject(
      root,
      session.token,
      `项目 ${index}`,
      join(root.base, `project-${index}`),
      `op-${index}`
    );
  const stale = await snapshotOf(root, session.token);
  assert.ok(stale.cursor > 4, "the sequence is longer than the retained window");
  for (let index = 6; index < 11; index += 1)
    await createProject(
      root,
      session.token,
      `项目 ${index}`,
      join(root.base, `project-${index}`),
      `op-${index}`
    );

  // A cursor before the retained window is refused explicitly, with the code a
  // client branches on; it is never silently restarted from a later sequence.
  const refused = await readStream(instance, session.token, 0, () => false, 5_000);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "cursor_expired");
  const missing = await api(root, "GET", "/api/events/stream", undefined, session.token);
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "cursor_required");
  const future = await readStream(instance, session.token, 10_000, () => false, 5_000);
  assert.equal(future.status, 409);
  assert.equal(future.body.code, "cursor_unknown");

  // The client turns that refusal into a fresh snapshot and keeps going.
  const snapshots = [];
  const resets = [];
  const accepted = controllableTransport({ snapshot: () => stale, serve: () => [] });
  let refusedOnce = false;
  const client = createManagementEventClient({
    backendId: instance.backendId,
    baseUrl: instance.url,
    fetch: async (url, options = {}) => {
      if (!String(url).includes("/api/events/stream")) return accepted.fetch(url, options);
      if (!refusedOnce) {
        refusedOnce = true;
        return new Response(JSON.stringify({ error: "游标已过期", code: "cursor_expired" }), {
          status: 409,
          headers: { "content-type": "application/json" }
        });
      }
      return accepted.fetch(url, options);
    },
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onReset: (reset) => resets.push(reset)
  });
  t.after(() => client.stop());
  await client.start();
  await waitFor("the refused cursor to reset the client", () => resets.length === 1, 10_000);
  assert.deepEqual(
    resets.map((reset) => reset.reason),
    ["cursor_expired"],
    "the refusal is reported as a reset, not as a silent skip"
  );
  assert.equal(snapshots.length, 2, "the reset takes a new snapshot");
  assert.ok(snapshots.every((snapshot) => snapshot.cursor === stale.cursor));
  assert.equal(client.state().cursor, stale.cursor);
  assert.deepEqual(accepted.cursors, [stale.cursor], "the retry subscribes from the new snapshot");
});

test("duplicate and out-of-order records never apply twice and a gap is replayed in order", async (t) => {
  const root = await createRoot("atria-recovery-order-");
  t.after(async () => {
    await stopQuietly(root);
    await rm(root.base, { recursive: true, force: true });
  });
  await startBackend(root.env);
  const session = await authorize(root);
  const instance = await readInstance(root);
  const project = await createProject(root, session.token, "顺序项目", root.project, "op-order-project");
  const before = await snapshotOf(root, session.token);
  const taskIds = ["order-one", "order-two", "order-three"];
  for (const [index, taskId] of taskIds.entries())
    await createTask(root, session.token, {
      taskId,
      goal: `第 ${index + 1} 个`,
      projectId: project.projectId,
      operationId: `op-${taskId}`
    });
  const history = await readStream(instance, session.token, before.cursor, (records) => records.length >= 3);
  assert.equal(history.records.length, 3, "three real changes produced three events");
  const [one, two, three] = history.records;
  assert.deepEqual(
    history.records.map((record) => record.seq),
    [before.cursor + 1, before.cursor + 2, before.cursor + 3]
  );

  const applied = [];
  const resets = [];
  let connections = 0;
  const transport = controllableTransport({
    snapshot: () => before,
    serve: (cursor) => {
      connections += 1;
      // The first connection delivers nothing: the test reorders the arrival.
      // Every later connection replays the retained backlog from the cursor the
      // client asked for, the way the server does.
      return connections === 1 ? [] : history.records.filter((record) => record.seq > cursor);
    }
  });
  const client = createManagementEventClient({
    backendId: instance.backendId,
    baseUrl: instance.url,
    fetch: transport.fetch,
    onEvent: (event) => applied.push(event),
    onReset: (reset) => resets.push(reset)
  });
  t.after(() => client.stop());
  await client.start();
  transport.push(three);
  await waitFor("the gap to be replayed", () => applied.length >= 3, 10_000);
  assert.deepEqual(
    applied.map((event) => event.seq),
    [before.cursor + 1, before.cursor + 2, before.cursor + 3],
    "the out-of-order record waited for the replay instead of jumping the sequence"
  );
  assert.deepEqual(
    applied.map((event) => event.objectId),
    taskIds,
    "the objects arrive in the order they changed"
  );
  assert.deepEqual(resets, [], "a replayable gap needs no snapshot");
  assert.deepEqual(
    transport.cursors,
    [before.cursor, before.cursor],
    "the gap reconnects from the applied cursor"
  );

  // Re-delivering records the client already applied is a no-op: sequence
  // identity, not payload equality, decides what is new.
  transport.push(one);
  transport.push(two);
  await delay(250);
  assert.equal(applied.length, 3, "duplicates never reach the consumer");
  assert.equal(client.state().cursor, before.cursor + 3);
});

test("reconnecting a client does not execute an operation again and receipts stay per identity", async (t) => {
  const root = await createRoot("atria-recovery-retry-");
  t.after(async () => {
    await stopQuietly(root);
    await rm(root.base, { recursive: true, force: true });
  });
  await startBackend(root.env);
  const session = await authorize(root, "断线客户端");
  const other = await authorize(root, "另一个客户端");
  const instance = await readInstance(root);
  const project = await createProject(root, session.token, "重试项目", root.project, "op-retry-project");
  const create = {
    taskId: "retried-task",
    goal: "重连后仍然只有一件任务",
    projectId: project.projectId,
    operationId: "op-retried-create"
  };

  // A subscribed client, so the committed change is observed as an event.
  const applied = [];
  const client = createManagementEventClient({
    backendId: instance.backendId,
    baseUrl: instance.url,
    fetch: authenticatedFetch(session.token),
    onEvent: (event) => applied.push(event)
  });
  t.after(() => client.stop());
  await client.start();

  // The command lands but its response is lost with the connection.
  const abandoned = connect(instance.port, "127.0.0.1");
  abandoned.setEncoding("utf8");
  abandoned.on("data", () => {
    /* no reader: the response is lost on purpose */
  });
  abandoned.on("error", () => undefined);
  await new Promise((done) => abandoned.on("connect", done));
  abandoned.write(
    [
      "POST /api/tasks HTTP/1.1",
      `Host: 127.0.0.1:${instance.port}`,
      "Connection: close",
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(JSON.stringify(create))}`,
      `x-atria-token: ${session.token}`,
      "",
      JSON.stringify(create)
    ].join("\r\n")
  );
  await delay(300);
  abandoned.destroy();
  const saved = await waitFor("the command result to be saved", async () => {
    const receipt = await api(root, "GET", "/api/operations/op-retried-create", undefined, session.token);
    return receipt.status === 200 ? receipt.body : undefined;
  });
  assert.equal(saved.body.taskId, "retried-task");
  const delivered = await waitFor("the committed Task to arrive as an event", () =>
    applied.find((event) => event.objectId === "retried-task")
  );
  assert.equal(delivered.type, "task.changed");

  // Reconnect: the snapshot already contains the committed Task, so its event
  // is not applied twice, and neither path re-runs the command.
  client.stop();
  const snapshots = [];
  const reconnected = createManagementEventClient({
    backendId: instance.backendId,
    baseUrl: instance.url,
    fetch: authenticatedFetch(session.token),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onEvent: (event) => applied.push(event)
  });
  t.after(() => reconnected.stop());
  await reconnected.start();
  await delay(300);
  assert.equal(
    applied.filter((event) => event.objectId === "retried-task").length,
    1,
    "the reconnect replays no already-committed Task twice"
  );
  assert.equal(snapshots[0].tasks.filter((task) => task.taskId === "retried-task").length, 1);

  // Retrying with the same operation id returns the saved result, not a second
  // Task, and another identity never reads that receipt.
  const retried = await api(root, "POST", "/api/tasks", create, session.token);
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  assert.equal(retried.headers["x-cowork-replayed"], "1");
  assert.equal(retried.body.taskId, "retried-task");
  const list = await snapshotOf(root, session.token);
  assert.equal(list.tasks.filter((task) => task.taskId === "retried-task").length, 1);
  assert.equal(
    (await api(root, "GET", "/api/operations/op-retried-create", undefined, other.token)).status,
    404,
    "one client never reads another client's receipt"
  );
  const revoked = await api(root, "DELETE", `/api/session/${session.sessionId}`, undefined, session.token);
  assert.equal(revoked.status, 200);
  const afterRevoke = await api(root, "GET", "/api/events/snapshot", undefined, session.token);
  assert.equal(afterRevoke.status, 401);
  assert.equal(afterRevoke.body.code, "session_revoked");
});

test("changes written outside the management routes become events for a live subscription", async (t) => {
  const root = await createRoot("atria-recovery-writer-");
  t.after(async () => {
    await stopQuietly(root);
    await rm(root.base, { recursive: true, force: true });
  });
  await startBackend(root.env);
  const session = await authorize(root);
  const instance = await readInstance(root);
  const project = await createProject(root, session.token, "后台项目", root.project, "op-writer-project");
  const applied = [];
  const client = createManagementEventClient({
    backendId: instance.backendId,
    baseUrl: instance.url,
    fetch: authenticatedFetch(session.token),
    onEvent: (event) => applied.push(event)
  });
  t.after(() => client.stop());
  await client.start();

  // Renaming a project is a management write and publishes immediately.
  const renamed = await api(
    root,
    "PATCH",
    `/api/projects/${project.projectId}`,
    { projectName: "后台项目（已重命名）", operationId: "op-writer-rename" },
    session.token
  );
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  const renaming = await waitFor("the project rename to arrive", () =>
    applied.find((event) => event.scope === "project")
  );
  assert.equal(renaming.payload.projectName, "后台项目（已重命名）");

  // Creating a goal creates a Task without going through the management
  // routes. A live subscription still learns about it: the catalog is
  // reconciled while someone is listening.
  const goal = await api(
    root,
    "POST",
    "/api/goals",
    {
      brief: { title: "后台目标", objective: "验证非管理写入也进入事件" },
      scope: "background",
      requestId: "writer-goal-1"
    },
    session.token
  );
  assert.equal(goal.status, 201, JSON.stringify(goal.body));
  const goalTaskId = goal.body.taskId;
  const created = await waitFor(
    "the goal's Task to arrive without an explicit publish",
    () => applied.find((event) => event.objectId === goalTaskId && event.type === "task.changed"),
    15_000
  );
  assert.equal(created.payload.taskId, goalTaskId);
  const listed = await snapshotOf(root, session.token);
  assert.ok(listed.tasks.some((task) => task.taskId === goalTaskId));

  // A deleted Task publishes a tombstone, and the client's revision for it
  // moves forward instead of keeping the removed object alive.
  const doomed = await createTask(root, session.token, {
    taskId: "doomed-task",
    goal: "即将删除",
    projectId: project.projectId,
    operationId: "op-doomed"
  });
  assert.equal(doomed.taskId, "doomed-task");
  await waitFor("the created Task to arrive", () =>
    applied.find((event) => event.objectId === "doomed-task")
  );
  const deleted = await api(root, "DELETE", "/api/tasks/doomed-task", undefined, session.token);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  const tombstone = await waitFor("the deletion to arrive", () =>
    applied.find((event) => event.objectId === "doomed-task" && event.type === "task.deleted")
  );
  assert.deepEqual(tombstone.payload, {});
  assert.ok(
    tombstone.revision >
      applied.find((event) => event.objectId === "doomed-task" && event.type === "task.changed").revision,
    "a tombstone is a newer revision of the object"
  );
  const afterDelete = await snapshotOf(root, session.token);
  assert.equal(
    afterDelete.tasks.some((task) => task.taskId === "doomed-task"),
    false,
    "the authoritative catalog no longer lists the deleted Task"
  );
  assert.equal(client.state().cursor, tombstone.seq);
});

// ---------------------------------------------------------------------------
// AC3: a crash between the state commit and the event, and backend switching.
// ---------------------------------------------------------------------------

test("a crash after the state commit and before the event heals from the durable state on restart", async (t) => {
  const root = await createRoot("atria-recovery-crash-", {
    COWORK_EVENT_FAULT_INJECT: "crash:task:recovered-task@2"
  });
  t.after(async () => {
    await stopQuietly(root);
    await rm(root.base, { recursive: true, force: true });
  });
  await startBackend(root.env);
  const session = await authorize(root);
  const instance = await readInstance(root);
  const project = await createProject(root, session.token, "崩溃项目", root.project, "op-crash-project");
  await createTask(root, session.token, {
    taskId: "recovered-task",
    goal: "崩溃前提交的任务",
    projectId: project.projectId,
    operationId: "op-crash-task"
  });
  const before = await snapshotOf(root, session.token);
  assert.equal(
    before.revisions["task:recovered-task"],
    1,
    "the first publish for this task is the one the next event must follow"
  );

  // The rename commits to disk; its event never reaches the log because the
  // process is killed inside the append. This is the crash window, with a real
  // process and a real SIGKILL.
  const crashed = api(
    root,
    "PATCH",
    "/api/tasks/recovered-task",
    { title: "崩溃前提交的新标题" },
    session.token
  ).catch((error) => ({ error }));
  await waitFor("the backend to die inside the event append", async () => !alive(instance.pid), 20_000);
  await crashed;

  const ledgerLines = await readFile(join(root.home, "runtime", "events", "events.jsonl"), "utf8").catch(
    () => ""
  );
  assert.equal(
    ledgerLines
      .split("\n")
      .filter(Boolean)
      .some((line) => line.includes("崩溃前提交的新标题")),
    false,
    "the event was not written before the crash"
  );

  // Restart: the committed title is authoritative, and the missing event is
  // recovered so a subscriber resuming from its old cursor learns about it.
  delete root.env.COWORK_EVENT_FAULT_INJECT;
  const restarted = await startBackend(root.env);
  assert.equal(restarted.backendId, instance.backendId, "the same backend identity comes back");
  const restartedInstance = await readInstance(root);
  const restored = await api(root, "GET", "/api/tasks/recovered-task", undefined, session.token);
  assert.equal(restored.status, 200);
  assert.equal(
    restored.body.task.title,
    "崩溃前提交的新标题",
    "the business state was committed before the crash"
  );
  const after = await snapshotOf(root, session.token);
  assert.ok(
    after.revisions["task:recovered-task"] > before.revisions["task:recovered-task"],
    "the recovered snapshot carries a newer object revision"
  );
  const resumed = await readStream(
    restartedInstance,
    session.token,
    before.cursor,
    (records) => records.length >= 1
  );
  const recovery = resumed.records.find((record) => record.objectId === "recovered-task");
  assert.ok(recovery, "the missing event is published after the restart");
  assert.equal(recovery.type, "task.changed");
  assert.equal(recovery.payload.title, "崩溃前提交的新标题");
  assert.equal(recovery.backendId, instance.backendId);
  assert.equal(
    resumed.records.filter((record) => record.objectId === "recovered-task").length,
    1,
    "recovery publishes the object once, not once per restart"
  );
  const again = await snapshotOf(root, session.token);
  assert.equal(again.revisions["task:recovered-task"], after.revisions["task:recovered-task"]);
});

test("a client bound to one backend rejects a late record from the backend it switched away from", async (t) => {
  const first = await createRoot("atria-recovery-switch-a-");
  const second = await createRoot("atria-recovery-switch-b-");
  t.after(async () => {
    await stopQuietly(first);
    await stopQuietly(second);
    await rm(first.base, { recursive: true, force: true });
    await rm(second.base, { recursive: true, force: true });
  });
  await startBackend(first.env);
  await startBackend(second.env);
  const firstSession = await authorize(first, "旧后端客户端");
  const secondSession = await authorize(second, "新后端客户端");
  const firstInstance = await readInstance(first);
  const secondInstance = await readInstance(second);
  assert.notEqual(firstInstance.backendId, secondInstance.backendId, "two data roots are two backends");
  await createProject(first, firstSession.token, "旧后端项目", first.project, "op-project");
  await createProject(second, secondSession.token, "新后端项目", second.project, "op-project");
  const firstSnapshot = await snapshotOf(first, firstSession.token);
  const secondSnapshot = await snapshotOf(second, secondSession.token);

  // The old backend publishes a real change after the client has switched.
  const lateProject = await createProject(
    first,
    firstSession.token,
    "旧后端的迟到项目",
    join(first.base, "later"),
    "op-late"
  );
  const lateHistory = await readStream(
    firstInstance,
    firstSession.token,
    firstSnapshot.cursor,
    (records) => records.length >= 1
  );
  const late = lateHistory.records[0];
  assert.equal(late.scope, "project");
  assert.equal(late.payload.projectId, lateProject.projectId);

  // The transport serves both backends' connections; the snapshot answer
  // follows whichever identity the client is bound to, as a real page would.
  let bound = firstInstance.backendId;
  const transport = controllableTransport({
    snapshot: () => (bound === secondInstance.backendId ? secondSnapshot : firstSnapshot),
    serve: () => []
  });
  const applied = [];
  const resets = [];
  const snapshots = [];
  const client = createManagementEventClient({
    backendId: firstInstance.backendId,
    baseUrl: firstInstance.url,
    fetch: transport.fetch,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onEvent: (event) => applied.push(event),
    onReset: (reset) => resets.push(reset)
  });
  t.after(() => client.stop());
  await client.start();
  assert.equal(client.state().backendId, firstInstance.backendId);
  assert.equal(client.state().cursor, firstSnapshot.cursor);
  assert.equal(snapshots.length, 1);
  const firstConnection = transport.streams.length;
  assert.equal(firstConnection, 1);

  bound = secondInstance.backendId;
  await client.switchBackend({ backendId: secondInstance.backendId, baseUrl: secondInstance.url });
  assert.deepEqual(
    resets.map((reset) => reset.reason),
    ["backend_switched"],
    "switching drops the old view instead of merging two backends"
  );
  assert.equal(transport.streams[0].cancelled, true, "the old connection is closed, not left draining");
  assert.equal(client.state().backendId, secondInstance.backendId);
  assert.equal(client.state().cursor, secondSnapshot.cursor);
  assert.deepEqual(
    Object.keys(client.state().revisions)
      .filter((key) => key.startsWith("project:"))
      .sort(),
    [`project:${secondSnapshot.projects[0].projectId}`],
    "the revision cache belongs to the new backend only"
  );

  // The late record now arrives on the live connection — a proxy replay, an old
  // socket draining, a stale response: it must not enter the new view, even
  // when its sequence would fit the new backend's cursor.
  transport.push(late);
  transport.push({ ...late, seq: secondSnapshot.cursor + 1 });
  await delay(300);
  assert.deepEqual(applied, [], "records naming another backend are dropped");
  assert.equal(client.state().cursor, secondSnapshot.cursor);
  assert.equal(client.state().backendId, secondInstance.backendId);
});
