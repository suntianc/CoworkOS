import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { parseHTML } from "linkedom";
import { startDashboard } from "./dashboard-fixture.mjs";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";
import { createMainCapacityController } from "../web/assets/controllers/main-capacity.js";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";

const run = promisify(execFile);

/**
 * The external Main lifecycle: a slot is one running process, and the program
 * — not a page button — releases it and starts the next demand.
 *
 * The fake model tags each request with the demand that produced it, so
 * "started exactly once" is a fact about processes, not about intent. Every
 * process this file stops is found by its own argv (the disposable Task it
 * serves) and killed by that recorded pid.
 */
async function provider(t) {
  const requests = [];
  const failures = [];
  const holdTags = new Set();
  const waiters = new Map();
  const tagOf = (body) => {
    const text = (body.messages ?? [])
      .filter((message) => message.role === "user")
      .map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content)
      )
      .join("\n");
    // A resumed session carries earlier tagged turns, so the newest tag wins.
    return [...text.matchAll(/\[tag:([a-z0-9-]+)\]/g)].at(-1)?.[1];
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET") return response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      const body = JSON.parse(await readFixtureRequestBody(request));
      const tag = tagOf(body);
      requests.push({ tag, body });
      if (tag && holdTags.has(tag))
        await new Promise((resolve) => {
          const list = waiters.get(tag) ?? [];
          list.push(resolve);
          waiters.set(tag, list);
        });
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(protocolStream("openai-completions", { text: `完成 ${tag ?? ""}` }));
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
    base: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    failures,
    hold(...tags) {
      for (const tag of tags) holdTags.add(tag);
    },
    release(tag) {
      holdTags.delete(tag);
      for (const resolve of waiters.get(tag) ?? []) resolve();
      waiters.delete(tag);
    },
    tags: () => requests.map((entry) => entry.tag)
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

const waitFor = async (check, message, timeout = 30_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(message);
};

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

async function externalSession(request, projectId, title, kind = "regular") {
  const created = await request(`/api/projects/${encodeURIComponent(projectId)}/main-sessions`, {
    action: "create",
    title,
    entryKind: "external",
    ...(kind === "continuation" ? { kind } : {})
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.session;
}

const runTask = (request, taskId, body) => request(`/api/tasks/${encodeURIComponent(taskId)}/run`, body);
const taskDetail = (request, taskId) => request(`/api/tasks/${encodeURIComponent(taskId)}`);
const capacity = (request) => request("/api/main-capacity");
const cancel = (request, taskId) =>
  request(`/api/tasks/${encodeURIComponent(taskId)}/action`, { action: "cancel" });

async function settle(request, taskId, status, timeout = 30_000) {
  await waitFor(
    async () => {
      const detail = await taskDetail(request, taskId);
      return detail.status === 200 && !detail.body.runtime.active;
    },
    `Main ${taskId} did not settle`,
    timeout
  );
  const detail = await taskDetail(request, taskId);
  assert.equal(detail.body.task.status, status, JSON.stringify(detail.body.task));
  return detail.body;
}

/** The processes this test owns: their argv names the Task or Task directory. */
async function ownProcesses(root, marker) {
  const { stdout } = await run("ps", ["-ax", "-o", "pid=,command="], { maxBuffer: 8 * 1024 * 1024 });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(root) && line.includes(marker))
    .map((line) => Number(line.split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Run a CLI child with a bound; a timeout stops the group this test started. */
async function captured(args, { env, timeoutMs = 60_000 } = {}) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, timeoutMs);
  const result = await exited;
  clearTimeout(timer);
  child.stdout.destroy();
  child.stderr.destroy();
  return { ...result, stdout, stderr };
}

async function waitForPid(root, marker) {
  let found = [];
  await waitFor(async () => {
    found = await ownProcesses(root, marker);
    return found.length > 0;
  }, `no owned process for ${marker}`);
  return found;
}

test(
  "completion, crash, cancellation and a failed start release the slot and advance the queue",
  { timeout: 240_000 },
  async (t) => {
    const local = await provider(t);
    const dashboard = await startDashboard({
      modelEndpoint: local.base,
      model: "fixture-model",
      defaultProject: false,
      config: { mainCapacity: { resident: 1, continuation: 0 } }
    });
    t.after(() => dashboard.stop());
    const request = client(dashboard);
    const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    const projects = {};
    const sessions = {};
    for (const name of names) {
      projects[name] = await createProject(request, dashboard, `life-${name}`);
      sessions[name] = await externalSession(request, projects[name].projectId, name);
    }
    // A process this test never owns must survive every cleanup path.
    const decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const decoyAlive = () => {
      try {
        process.kill(decoy.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    t.after(() => decoy.kill("SIGKILL"));

    local.hold("alpha", "bravo", "charlie", "delta", "foxtrot");
    const started = await runTask(request, sessions.alpha.taskId, {
      prompt: "[tag:alpha] 处理 alpha。",
      mainSessionId: sessions.alpha.sessionId
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.equal(started.body.status, "running");

    for (const name of ["bravo", "charlie", "delta"]) {
      const queued = await runTask(request, sessions[name].taskId, {
        prompt: `[tag:${name}] 处理 ${name}。`,
        mainSessionId: sessions[name].sessionId
      });
      assert.equal(queued.body.status, "queued", JSON.stringify(queued.body));
    }
    // The same demand cannot join the queue twice while it owns a position.
    const repeated = await runTask(request, sessions.bravo.taskId, {
      prompt: "[tag:bravo] 处理 bravo。",
      mainSessionId: sessions.bravo.sessionId
    });
    assert.equal(repeated.body.status, "duplicate", JSON.stringify(repeated.body));
    assert.equal((await capacity(request)).body.queued.length, 3);
    // A queued demand created no Run and left the Task untouched.
    const waiting = await taskDetail(request, sessions.bravo.taskId);
    assert.equal(waiting.body.runtime.active, false);
    assert.equal(waiting.body.task.activeRunId ?? null, null);

    // The page reads the same facts the service reports.
    const view = await capacity(request);
    assert.equal(view.body.running.length, 1);
    assert.equal(view.body.running[0].taskId, sessions.alpha.taskId);
    assert.deepEqual(
      view.body.queued.map((entry) => [entry.taskId, entry.position]),
      [
        [sessions.bravo.taskId, 1],
        [sessions.charlie.taskId, 2],
        [sessions.delta.taskId, 3]
      ]
    );

    // Completion releases the slot and starts the first waiting demand.
    local.release("alpha");
    await settle(request, sessions.alpha.taskId, "completed");
    await waitFor(async () => {
      const now = await capacity(request);
      return now.body.running.some((entry) => entry.taskId === sessions.bravo.taskId);
    }, "bravo did not start after alpha completed");
    await waitFor(() => local.tags().includes("bravo"), "bravo never reached the model");

    // A crash of the running process releases the slot as failure advances it.
    // The launcher is a process group leader; kill that whole group (the Main)
    // by the pid this test recorded, never by name.
    const crashed = await waitForPid(dashboard.workspaceRoot, sessions.bravo.taskId);
    for (const pid of crashed) process.kill(-pid, "SIGKILL");
    await settle(request, sessions.bravo.taskId, "failed");
    await waitFor(async () => {
      const now = await capacity(request);
      return now.body.running.some((entry) => entry.taskId === sessions.charlie.taskId);
    }, "charlie did not start after bravo crashed");

    // Cancellation releases the slot immediately.
    const cancelled = await cancel(request, sessions.charlie.taskId);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    await waitFor(async () => {
      const now = await capacity(request);
      return now.body.running.some((entry) => entry.taskId === sessions.delta.taskId);
    }, "delta did not start after charlie was cancelled");

    // A demand whose Task is gone fails to start without leaking the slot, and
    // the queue still reaches the demand behind it.
    const doomed = await runTask(request, sessions.echo.taskId, {
      prompt: "[tag:echo] 处理 echo。",
      mainSessionId: sessions.echo.sessionId
    });
    assert.equal(doomed.body.status, "queued", JSON.stringify(doomed.body));
    const behind = await runTask(request, sessions.foxtrot.taskId, {
      prompt: "[tag:foxtrot] 处理 foxtrot。",
      mainSessionId: sessions.foxtrot.sessionId
    });
    assert.equal(behind.body.status, "queued", JSON.stringify(behind.body));
    await rm(join(dashboard.workspaceRoot, sessions.echo.taskId), { recursive: true, force: true });
    local.release("delta");
    await settle(request, sessions.delta.taskId, "completed");
    await waitFor(async () => {
      const now = await capacity(request);
      return now.body.running.some((entry) => entry.taskId === sessions.foxtrot.taskId);
    }, "foxtrot did not start after the failed start of echo");
    assert.equal((await capacity(request)).body.queued.length, 0);
    local.release("foxtrot");
    await settle(request, sessions.foxtrot.taskId, "completed");
    await waitFor(async () => (await capacity(request)).body.running.length === 0, "slots were not released");

    // Each demand ran at most once, and the failed one never ran at all. A
    // cancellation that lands before the model call leaves no request behind.
    const tags = local.tags();
    for (const name of ["alpha", "bravo", "delta", "foxtrot"])
      assert.equal(tags.filter((tag) => tag === name).length, 1, `${name}: ${JSON.stringify(tags)}`);
    assert.ok(tags.filter((tag) => tag === "charlie").length <= 1, JSON.stringify(tags));
    assert.equal(tags.includes("echo"), false);
    // The session history keeps every Run that belonged to it.
    const bravo = await request(
      `/api/projects/${encodeURIComponent(projects.bravo.projectId)}/main-sessions`
    );
    assert.deepEqual(
      bravo.body.sessions[0].runs.map((entry) => entry.state),
      ["failed"]
    );
    const alpha = await request(
      `/api/projects/${encodeURIComponent(projects.alpha.projectId)}/main-sessions`
    );
    assert.deepEqual(
      alpha.body.sessions[0].runs.map((entry) => entry.state),
      ["completed"]
    );
    // Cleanup never touched a process this Ticket does not own.
    assert.equal(decoyAlive(), true);
    assert.deepEqual(local.failures, []);
  }
);

test("a cancelled queued demand never starts", { timeout: 120_000 }, async (t) => {
  const local = await provider(t);
  const dashboard = await startDashboard({
    modelEndpoint: local.base,
    model: "fixture-model",
    defaultProject: false,
    config: { mainCapacity: { resident: 1, continuation: 0 } }
  });
  t.after(() => dashboard.stop());
  const request = client(dashboard);
  const runningProject = await createProject(request, dashboard, "cancel-a");
  const waitingProject = await createProject(request, dashboard, "cancel-b");
  const runningSession = await externalSession(request, runningProject.projectId, "cancel-a");
  const waitingSession = await externalSession(request, waitingProject.projectId, "cancel-b");
  local.hold("cancel-a");
  await runTask(request, runningSession.taskId, {
    prompt: "[tag:cancel-a] 运行中。",
    mainSessionId: runningSession.sessionId
  });
  const queued = await runTask(request, waitingSession.taskId, {
    prompt: "[tag:cancel-b] 排队中。",
    mainSessionId: waitingSession.sessionId
  });
  assert.equal(queued.body.status, "queued", JSON.stringify(queued.body));
  const cancelled = await cancel(request, waitingSession.taskId);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  await waitFor(
    async () => (await capacity(request)).body.queued.length === 0,
    "the cancelled demand stayed in the queue"
  );
  local.release("cancel-a");
  await settle(request, runningSession.taskId, "completed");
  await delay(500);
  assert.equal(local.tags().includes("cancel-b"), false);
  const detail = await taskDetail(request, waitingSession.taskId);
  assert.equal(detail.body.task.status, "cancelled");
  assert.deepEqual(local.failures, []);
});

test(
  "a restarted backend keeps a live demand, releases a dead one and advances the queue",
  { timeout: 240_000 },
  async (t) => {
    const local = await provider(t);
    const dashboard = await startDashboard({
      modelEndpoint: local.base,
      model: "fixture-model",
      defaultProject: false,
      config: { mainCapacity: { resident: 1, continuation: 0 } }
    });
    t.after(() => dashboard.stop());
    const request = client(dashboard);
    const first = await createProject(request, dashboard, "restart-a");
    const second = await createProject(request, dashboard, "restart-b");
    const firstSession = await externalSession(request, first.projectId, "restart-a");
    const secondSession = await externalSession(request, second.projectId, "restart-b");
    local.hold("first", "second");

    const started = await runTask(request, firstSession.taskId, {
      prompt: "[tag:first] 运行第一个需求。",
      mainSessionId: firstSession.sessionId
    });
    assert.equal(started.body.status, "running", JSON.stringify(started.body));
    const queued = await runTask(request, secondSession.taskId, {
      prompt: "[tag:second] 运行第二个需求。",
      mainSessionId: secondSession.sessionId
    });
    assert.equal(queued.body.status, "queued", JSON.stringify(queued.body));

    // A hard backend crash leaves the detached Main running: the new backend
    // must keep its slot, then release it when the process actually ends.
    const oldPid = dashboard.child.pid;
    const exited = once(dashboard.child, "exit");
    dashboard.child.kill("SIGKILL");
    await exited;
    await dashboard.restart();
    const restored = await capacity(request);
    assert.equal(restored.body.running.length, 1, JSON.stringify(restored.body));
    assert.equal(restored.body.running[0].taskId, firstSession.taskId);
    assert.deepEqual(
      restored.body.queued.map((entry) => entry.taskId),
      [secondSession.taskId]
    );
    assert.notEqual(dashboard.child.pid, oldPid);

    // The orphaned Main is this test's own process: stop it by the pid it was
    // recorded under. The new backend must then reconcile the dead claim and
    // start the demand that waited through the restart.
    const orphaned = await ownProcesses(dashboard.workspaceRoot, firstSession.taskId);
    assert.ok(orphaned.length > 0, "the orphaned Main was not found by its Task");
    for (const pid of orphaned) process.kill(-pid, "SIGKILL");
    // A read during the hand-off must not reclaim the reservation before the
    // dispatched process exists, so this poll is also the race regression.
    let latest = {};
    await waitFor(
      async () => {
        latest = (await capacity(request)).body;
        return latest.running.some((entry) => entry.taskId === secondSession.taskId);
      },
      `the queued demand did not start after the orphaned Main exited: ${JSON.stringify(latest)}`,
      45_000
    );
    await waitFor(() => local.tags().includes("second"), "the queued demand never reached the model");
    local.release("second");
    await settle(request, secondSession.taskId, "completed");
    await waitFor(async () => (await capacity(request)).body.running.length === 0, "slots were not released");
    // The first Run's ownership is still recorded even though its process
    // outlived the backend that started it.
    const history = await request(`/api/projects/${encodeURIComponent(first.projectId)}/main-sessions`);
    assert.equal(history.body.sessions[0].runs.length, 1);
    assert.equal(history.body.sessions[0].runs[0].runId, started.body.runId);
    assert.deepEqual(local.failures, []);
  }
);

test("the worker and the CLI spend the same budget as the page", { timeout: 240_000 }, async (t) => {
  const local = await provider(t);
  const dashboard = await startDashboard({
    modelEndpoint: local.base,
    model: "fixture-model",
    defaultProject: false,
    config: { mainCapacity: { resident: 1, continuation: 0 } }
  });
  t.after(() => dashboard.stop());
  const request = client(dashboard);
  const pageProject = await createProject(request, dashboard, "shared-page");
  const pageSession = await externalSession(request, pageProject.projectId, "page");
  const workerProject = await createProject(request, dashboard, "shared-worker");
  const workerSession = await externalSession(request, workerProject.projectId, "worker");
  const cliProject = await createProject(request, dashboard, "shared-cli");
  const cliSession = await externalSession(request, cliProject.projectId, "cli");

  local.hold("page");
  const untagged = () => local.requests.filter((entry) => entry.tag === undefined).length;
  const started = await runTask(request, pageSession.taskId, {
    prompt: "[tag:page] 页面需求。",
    mainSessionId: pageSession.sessionId
  });
  assert.equal(started.body.status, "running", JSON.stringify(started.body));
  await waitFor(async () => {
    const now = await capacity(request);
    return now.body.running.some((entry) => entry.taskId === pageSession.taskId);
  }, "the page run did not take the external slot");

  // Give the worker a durable wake so it really tries to start a Main.
  const wakeRunId = `main-${workerSession.taskId}`;
  const workerInbox = join(
    dashboard.workspaceRoot,
    workerSession.taskId,
    "runs",
    wakeRunId,
    "agents",
    "main"
  );
  await mkdir(workerInbox, { recursive: true });
  const workerTaskPath = join(dashboard.workspaceRoot, workerSession.taskId, "task.json");
  await writeFile(
    workerTaskPath,
    JSON.stringify({ ...JSON.parse(await readFile(workerTaskPath, "utf8")), activeRunId: wakeRunId })
  );
  await writeFile(
    join(workerInbox, "inbox-store.json"),
    JSON.stringify([
      {
        messageId: "worker-wake",
        recipientAgentId: "main",
        kind: "human_command",
        eventId: "worker-wake-event",
        priority: 100,
        state: "ready",
        payload: { type: "human.message", message: "继续", delivery: "steer" },
        createdAt: new Date().toISOString()
      }
    ])
  );
  const workerEnv = {
    ...dashboard.env,
    COWORK_WORKSPACE: dashboard.workspaceRoot,
    COWORK_TASK_ID: workerSession.taskId
  };
  const worker = async (taskId = workerSession.taskId) => {
    const { stdout, stderr, code } = await captured(["scripts/main-worker.mjs", "--task", taskId, "--once"], {
      env: { ...workerEnv, COWORK_TASK_ID: taskId },
      timeoutMs: 90_000
    });
    const receipt = stdout
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line))
      .at(-1);
    return { ...receipt, exitCode: code, stderr };
  };
  const refused = await worker();
  assert.equal(refused.started, false, JSON.stringify(refused));
  assert.equal(refused.reason, "main_capacity_queued");
  assert.equal(refused.position, 1);
  assert.deepEqual(await ownProcesses(dashboard.workspaceRoot, workerSession.taskId), []);
  // The worker's demand joined the program's queue, not a private retry.
  assert.deepEqual(
    (await capacity(request)).body.queued.map((entry) => [entry.taskId, entry.origin]),
    [[workerSession.taskId, "worker"]]
  );

  // The interactive CLI launcher is refused the same way while the budget is full.
  const cli = await captured(
    [
      "scripts/start-pi.mjs",
      "--print",
      "--session-dir",
      join(dashboard.workspaceRoot, cliSession.taskId, "sessions", "main", "pi")
    ],
    {
      env: {
        ...dashboard.env,
        COWORK_WORKSPACE: dashboard.workspaceRoot,
        COWORK_TASK_ID: cliSession.taskId
      },
      timeoutMs: 60_000
    }
  );
  assert.notEqual(cli.code, 0, JSON.stringify(cli));
  assert.match(`${cli.stderr}\n${cli.stdout}`, /名额已满/);
  assert.deepEqual(await ownProcesses(dashboard.workspaceRoot, cliSession.taskId), []);

  // Freeing the page's slot lets the program start the worker's demand.
  local.release("page");
  await settle(request, pageSession.taskId, "completed");
  await waitFor(async () => {
    const now = await capacity(request);
    return now.body.running.some((entry) => entry.taskId === workerSession.taskId);
  }, "the worker demand did not start from the queue");
  await waitFor(() => untagged() === 1, "the worker demand never reached the model");
  await settle(request, workerSession.taskId, "completed");

  // With a free slot the worker starts its own Main through the same gate.
  const freshProject = await createProject(request, dashboard, "shared-worker2");
  const freshSession = await externalSession(request, freshProject.projectId, "worker2");
  const freshRunId = `main-${freshSession.taskId}`;
  const freshInbox = join(dashboard.workspaceRoot, freshSession.taskId, "runs", freshRunId, "agents", "main");
  const freshTask = join(dashboard.workspaceRoot, freshSession.taskId, "task.json");
  await mkdir(freshInbox, { recursive: true });
  await writeFile(
    freshTask,
    JSON.stringify({ ...JSON.parse(await readFile(freshTask, "utf8")), activeRunId: freshRunId })
  );
  // An interrupted checkpoint is the other durable wake the worker honours.
  await writeFile(
    join(dashboard.workspaceRoot, freshSession.taskId, "runs", freshRunId, "checkpoint.json"),
    JSON.stringify({ state: { status: "running" } })
  );
  const allowed = await worker(freshSession.taskId);
  assert.equal(allowed.started, true, JSON.stringify(allowed));
  await waitFor(
    () => untagged() === 2,
    `the worker's own Main never reached the model: ${JSON.stringify(allowed)}`
  );
  await waitFor(
    async () => (await capacity(request)).body.running.length === 0,
    "the worker slot was not released"
  );
  assert.deepEqual(local.failures, []);
});

test(
  "the capacity page shows running and waiting Mains from the service",
  { timeout: 120_000 },
  async (t) => {
    const local = await provider(t);
    const dashboard = await startDashboard({
      modelEndpoint: local.base,
      model: "fixture-model",
      defaultProject: false,
      config: { mainCapacity: { resident: 1, continuation: 0 } }
    });
    t.after(() => dashboard.stop());
    const request = client(dashboard);
    const project = await createProject(request, dashboard, "ui-a");
    const other = await createProject(request, dashboard, "ui-b");
    const session = await externalSession(request, project.projectId, "ui-a");
    const waiting = await externalSession(request, other.projectId, "ui-b");
    local.hold("ui-a");
    await runTask(request, session.taskId, {
      prompt: "[tag:ui-a] 页面运行。",
      mainSessionId: session.sessionId
    });
    await runTask(request, waiting.taskId, {
      prompt: "[tag:ui-b] 页面等待。",
      mainSessionId: waiting.sessionId
    });

    const previous = { window: globalThis.window, document: globalThis.document, CSS: globalThis.CSS };
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    });
    const { window, document } = parseHTML(readFileSync("web/index.html", "utf8"));
    globalThis.window = window;
    globalThis.document = document;
    globalThis.CSS = { escape: (value) => value };
    window.HTMLElement.prototype.getClientRects ??= () => [];
    const api = async (path, options) => {
      const response = await fetch(`${dashboard.base}${path}`, options);
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error ?? `请求失败：${response.status}`);
      }
      return response.json();
    };
    const controller = createMainCapacityController({ api });
    controller.open();
    await waitFor(
      () => controller.view && controller.isOpen() && controller.view.running.length > 0,
      "the capacity page did not load the service view"
    );
    await waitFor(
      () => document.querySelector("[data-running]")?.textContent.includes("项目 ui-a"),
      "the running Main is not shown"
    );
    assert.match(document.querySelector("[data-running]").textContent, /常规/);
    assert.match(document.querySelector("[data-queued]").textContent, /第 1 位/);
    assert.match(document.querySelector("[data-queued]").textContent, /项目 ui-b/);
    assert.equal(document.querySelector('[name="resident"]').value, "1");
    assert.equal(document.querySelector('[name="continuation"]').value, "0");
    local.release("ui-a");
    await settle(request, session.taskId, "completed");
    controller.close();
    assert.deepEqual(local.failures, []);
  }
);

/**
 * A strict local provider per account: what the Main process was actually asked
 * (path, Authorization, model) is the only evidence that a role resolution
 * really switched connection.
 */
async function accountProvider(t, label, api = "openai-completions") {
  const requests = [];
  const failures = [];
  const held = new Set();
  const waiters = new Map();
  const expectedPath = api === "openai-responses" ? "/v1/responses" : "/v1/chat/completions";
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET") return response.end(JSON.stringify({ data: [{ id: label }] }));
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const text = (body.messages ?? body.input ?? [])
        .filter((message) => message.role === "user")
        .map((message) =>
          typeof message.content === "string" ? message.content : JSON.stringify(message.content)
        )
        .join("\n");
      const tag = [...text.matchAll(/\[tag:([a-z0-9-]+)\]/g)].at(-1)?.[1];
      requests.push({ tag, authorization: request.headers.authorization, body, path: request.url, api });
      if (tag && held.has(tag))
        await new Promise((resolve) => {
          const list = waiters.get(tag) ?? [];
          list.push(resolve);
          waiters.set(tag, list);
        });
      if (response.destroyed) return;
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
    failures,
    hold(tag) {
      held.add(tag);
    },
    release(tag) {
      held.delete(tag);
      for (const resolve of waiters.get(tag) ?? []) resolve();
      waiters.delete(tag);
    },
    tags: () => requests.map((entry) => entry.tag)
  };
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

async function spawnPayload(dashboard, taskId, runId) {
  const lines = (
    await readFile(join(dashboard.workspaceRoot, taskId, "runs", runId, "run_events.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const spawned = lines.filter((event) => event.type === "main.run_spawned");
  assert.equal(spawned.length, 1);
  return spawned[0].payload;
}

test(
  "a queued external Main fixes host and project defaults when it gets a slot and keeps explicit choices",
  { timeout: 240_000 },
  async (t) => {
    const a = await accountProvider(t, "连接A", "openai-completions");
    const b = await accountProvider(t, "连接B", "openai-responses");
    const dashboard = await startDashboard({
      defaultProject: false,
      config: { mainCapacity: { resident: 1, continuation: 0 } }
    });
    t.after(() => dashboard.stop());
    const request = client(dashboard);
    const keyA = "{{SECRET_qa94md1s}}";
    const keyB = "{{SECRET_z7h2k4pc}}";
    await saveConnection(request, {
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
    const hosted = await request("/api/model-settings/roles", { role: "main", profileId: profileA.id });
    assert.equal(hosted.status, 200, JSON.stringify(hosted.body));

    const projects = {};
    const sessions = {};
    for (const name of ["inflight", "queued", "explicit"]) {
      projects[name] = await createProject(request, dashboard, `model-${name}`);
      sessions[name] = await externalSession(request, projects[name].projectId, name);
    }

    // One Main is already running on connection A while the default changes.
    a.hold("inflight");
    const inflight = await runTask(request, sessions.inflight.taskId, {
      prompt: "[tag:inflight] 在途运行。",
      mainSessionId: sessions.inflight.sessionId
    });
    assert.equal(inflight.body.status, "running", JSON.stringify(inflight.body));
    await waitFor(() => a.tags().includes("inflight"), "the in-flight Run never reached connection A");

    // Two demands wait without resolving a default yet.
    const queued = await runTask(request, sessions.queued.taskId, {
      prompt: "[tag:queued] 排队需求。",
      mainSessionId: sessions.queued.sessionId
    });
    assert.equal(queued.body.status, "queued", JSON.stringify(queued.body));
    const explicit = await runTask(request, sessions.explicit.taskId, {
      prompt: "[tag:explicit] 显式选择。",
      mainSessionId: sessions.explicit.sessionId,
      profileId: profileB.id,
      model: "model-explicit"
    });
    assert.equal(explicit.body.status, "queued", JSON.stringify(explicit.body));
    assert.equal(b.requests.length, 0, "a queued demand must not call any account yet");
    // Nothing secret enters the public capacity state while the demands wait.
    const queuedState = await readFile(join(dashboard.root, "main-capacity", "state.json"), "utf8");
    assert.equal(queuedState.includes(keyA) || queuedState.includes(keyB), false);
    assert.match(queuedState, /model-explicit/, "the explicit model is kept with the demand");
    assert.match(queuedState, /profileId/, "the explicit connection is kept with the demand");

    // While they wait, the host default and the project default both move to B.
    const hostSwitch = await request("/api/model-settings/roles", {
      role: "main",
      profileId: profileB.id
    });
    assert.equal(hostSwitch.status, 200, JSON.stringify(hostSwitch.body));
    const projectSwitch = await request("/api/model-settings/roles", {
      role: "main",
      projectId: projects.queued.projectId,
      profileId: profileB.id
    });
    assert.equal(projectSwitch.status, 200, JSON.stringify(projectSwitch.body));
    assert.equal(a.requests.length, 1, "the in-flight Run is untouched by the role change");
    assert.equal(b.requests.length, 0);

    a.release("inflight");
    await settle(request, sessions.inflight.taskId, "completed");
    await waitFor(() => b.tags().includes("queued"), "the queued demand did not start");
    await settle(request, sessions.queued.taskId, "completed");
    await waitFor(() => b.tags().includes("explicit"), "the explicit demand did not start");
    await settle(request, sessions.explicit.taskId, "completed");

    // The in-flight Run kept connection A; both waiting demands reached B.
    const inflightRequest = a.requests.find((entry) => entry.tag === "inflight");
    assert.equal(inflightRequest.authorization, `Bearer ${keyA}`);
    assert.equal(inflightRequest.body.model, "model-a");
    const queuedRequest = b.requests.find((entry) => entry.tag === "queued");
    assert.equal(queuedRequest.authorization, `Bearer ${keyB}`, "the new host/project default is used");
    assert.equal(queuedRequest.path, "/v1/responses", "the role profile is pinned");
    assert.equal(queuedRequest.body.model, "model-b");
    const explicitRequest = b.requests.find((entry) => entry.tag === "explicit");
    assert.equal(explicitRequest.authorization, `Bearer ${keyB}`);
    assert.equal(explicitRequest.body.model, "model-explicit", "the explicit model survives the wait");
    assert.equal(a.requests.length, 1);

    // The recorded snapshots agree with what was actually called.
    const storedProfiles = JSON.parse(await readFile(join(dashboard.root, "config.json"), "utf8"))
      .modelConnections.profiles;
    const contextA = storedProfiles.find((profile) => profile.id === profileA.id).contextId;
    const inflightSnapshot = await spawnPayload(dashboard, sessions.inflight.taskId, inflight.body.runId);
    assert.equal(inflightSnapshot.modelSelection.connectionId, contextA);
    const queuedSnapshot = await spawnPayload(dashboard, sessions.queued.taskId, queued.body.runId);
    assert.equal(queuedSnapshot.modelSelection.source, "project");
    assert.equal(queuedSnapshot.modelSelection.model, "model-b");
    const explicitSnapshot = await spawnPayload(dashboard, sessions.explicit.taskId, explicit.body.runId);
    assert.equal(explicitSnapshot.modelSelection.source, "explicit");
    assert.equal(explicitSnapshot.modelSelection.model, "model-explicit");
    for (const snapshot of [inflightSnapshot, queuedSnapshot, explicitSnapshot])
      assert.equal(JSON.stringify(snapshot).includes(keyA) || JSON.stringify(snapshot).includes(keyB), false);

    // Two config writers interleaved: both settings survive.
    const [roleSave, quotaSave] = await Promise.all([
      request("/api/model-settings/roles", { role: "main", profileId: profileA.id }),
      request("/api/main-capacity", { action: "configure", resident: 2, continuation: 0 })
    ]);
    assert.equal(roleSave.status, 200, JSON.stringify(roleSave.body));
    assert.equal(quotaSave.status, 200, JSON.stringify(quotaSave.body));
    const configText = await readFile(join(dashboard.root, "config.json"), "utf8");
    const config = JSON.parse(configText);
    assert.equal(config.mainCapacity.resident, 2, configText);
    assert.equal(config.roleModels?.host?.main?.profileId, profileA.id, configText);
    assert.equal(config.modelConnections.profiles.length, 2, configText);
    const settings = await request("/api/model-settings");
    assert.equal(settings.status, 200);
    assert.equal(
      settings.body.modelRoles.roles.find((role) => role.role === "main").host.profileId,
      profileA.id
    );
    assert.equal((await capacity(request)).body.settings.resident, 2);
    assert.deepEqual(a.failures, []);
    assert.deepEqual(b.failures, []);
  }
);

test(
  "a durable human answer waits in the queue when the budget is full and continues after release",
  { timeout: 180_000 },
  async (t) => {
    const local = await provider(t);
    const dashboard = await startDashboard({
      modelEndpoint: local.base,
      model: "fixture-model",
      defaultProject: false,
      config: { mainCapacity: { resident: 1, continuation: 0 } }
    });
    t.after(() => dashboard.stop());
    const request = client(dashboard);
    const blocker = await createProject(request, dashboard, "answer-blocker");
    const answerProject = await createProject(request, dashboard, "answer-project");
    const blockerSession = await externalSession(request, blocker.projectId, "blocker");
    const answerSession = await externalSession(request, answerProject.projectId, "answer");

    // A completed conversation is the history container the answer resumes.
    const first = await runTask(request, answerSession.taskId, {
      prompt: "[tag:first-turn] 先完成一轮。",
      mainSessionId: answerSession.sessionId
    });
    assert.equal(first.body.status, "running", JSON.stringify(first.body));
    await settle(request, answerSession.taskId, "completed");
    const answerRunId = (await taskDetail(request, answerSession.taskId)).body.task.activeRunId;
    assert.ok(answerRunId);
    // Persist the answer where the askhuman flow leaves it.
    const inbox = join(dashboard.workspaceRoot, answerSession.taskId, "runs", answerRunId, "agents", "main");
    await mkdir(inbox, { recursive: true });
    await writeFile(
      join(inbox, "inbox-store.json"),
      JSON.stringify([
        {
          messageId: "human-answer-1",
          recipientAgentId: "main",
          kind: "human_command",
          eventId: "human-answer-event-1",
          priority: 120,
          state: "ready",
          payload: {
            type: "human.answer",
            question: "部署到哪个环境？",
            answer: "[tag:answer-turn] 只在预发布验证。"
          },
          createdAt: new Date().toISOString()
        }
      ])
    );

    local.hold("blocker");
    const blocking = await runTask(request, blockerSession.taskId, {
      prompt: "[tag:blocker] 占住唯一名额。",
      mainSessionId: blockerSession.sessionId
    });
    assert.equal(blocking.body.status, "running", JSON.stringify(blocking.body));
    await waitFor(
      async () => (await capacity(request)).body.running.length === 1,
      "the blocking Main did not take the slot"
    );

    // The answer arrives while the budget is full: it must wait, not be lost.
    const resumed = await request(`/api/tasks/${encodeURIComponent(answerSession.taskId)}/human/resume`, {});
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.status, "queued", JSON.stringify(resumed.body));
    const queuedView = await capacity(request);
    assert.deepEqual(
      queuedView.body.queued.map((entry) => [entry.taskId, entry.origin]),
      [[answerSession.taskId, "internal"]]
    );
    const waiting = await taskDetail(request, answerSession.taskId);
    assert.equal(waiting.body.runtime.active, false);
    assert.equal(waiting.body.task.status, "completed");

    // Freeing the slot resumes the durable answer through the program's queue.
    local.release("blocker");
    await settle(request, blockerSession.taskId, "completed");
    await waitFor(
      async () =>
        (await capacity(request)).body.running.some((entry) => entry.taskId === answerSession.taskId),
      "the queued answer did not resume after the slot was released"
    );
    await waitFor(() => local.tags().includes("answer-turn"), "the answer never reached the model");
    await settle(request, answerSession.taskId, "completed");
    assert.deepEqual((await capacity(request)).body.queued, []);

    // A watch wake is a durable demand too: with the budget full it waits in
    // the same queue and starts when a slot frees. Wait for the completed Run
    // to release its slot before filling it again.
    await waitFor(
      async () => (await capacity(request)).body.running.length === 0,
      "the answer Run did not release its slot"
    );
    local.hold("blocker-again");
    const blockingAgain = await runTask(request, blockerSession.taskId, {
      prompt: "[tag:blocker-again] 再次占住唯一名额。",
      mainSessionId: blockerSession.sessionId
    });
    assert.equal(blockingAgain.body.status, "running", JSON.stringify(blockingAgain.body));
    let latestWake = {};
    const wakeDeadline = Date.now() + 20_000;
    while (Date.now() < wakeDeadline) {
      latestWake = (await capacity(request)).body;
      if (latestWake.running.some((entry) => entry.taskId === blockerSession.taskId)) break;
      await delay(50);
    }
    assert.ok(
      latestWake.running.some((entry) => entry.taskId === blockerSession.taskId),
      `the second blocking Main did not take the slot: ${JSON.stringify(latestWake)} tags=${JSON.stringify(local.tags())} task=${JSON.stringify((await taskDetail(request, blockerSession.taskId)).body.task)}`
    );
    const woken = await request(`/api/tasks/${encodeURIComponent(answerSession.taskId)}/events`, {
      type: "external.event",
      payload: { kind: "fixture" },
      wake: true
    });
    assert.equal(woken.status, 202, JSON.stringify(woken.body));
    assert.equal(woken.body.wake.status, "queued", JSON.stringify(woken.body.wake));
    await waitFor(
      async () =>
        (await capacity(request)).body.queued.some((entry) => entry.taskId === answerSession.taskId),
      "the wake did not join the queue"
    );
    local.release("blocker-again");
    await settle(request, blockerSession.taskId, "completed");
    await waitFor(
      async () =>
        (await capacity(request)).body.running.some((entry) => entry.taskId === answerSession.taskId),
      "the queued wake did not start after the slot was released"
    );
    await settle(request, answerSession.taskId, "completed");
    assert.deepEqual((await capacity(request)).body.queued, []);
    assert.deepEqual(local.failures, []);
  }
);

test(
  "a shared session outage never drops a known external Task or counts it as zero",
  { timeout: 180_000 },
  async (t) => {
    const authority = await startDashboard({ defaultProject: false });
    t.after(() => authority.stop());
    const instance = await readBackendInstance(backendPaths(join(authority.root, "home")));
    assert.ok(instance.value?.token, "the authority published its local credential");
    const secondary = await startDashboard({
      defaultProject: false,
      config: {
        projectData: { authority: { url: authority.base, token: instance.value.token } },
        mainCapacity: { resident: 1, continuation: 0 }
      }
    });
    t.after(() => secondary.stop());
    const request = client(secondary);
    const project = await createProject(request, secondary, "outage");
    const session = await externalSession(request, project.projectId, "outage");
    const statePath = join(secondary.root, "main-capacity", "state.json");
    const known = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(
      known.externalTasks.map((entry) => entry.taskId),
      [session.taskId]
    );

    await authority.stop();

    // A read degrades visibly instead of reporting zero saved sessions.
    const view = await capacity(request);
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.equal(view.body.settings.resident, 1);
    assert.equal(view.body.projectsComplete, false, JSON.stringify(view.body));
    assert.match(String(view.body.projectsError), /不可达|共享|storage|fetch/i);
    // A create cannot pass a limit it cannot count.
    const refused = await request(`/api/projects/${encodeURIComponent(project.projectId)}/main-sessions`, {
      action: "create",
      title: "blocked",
      entryKind: "external"
    });
    assert.notEqual(refused.status, 201, JSON.stringify(refused.body));
    assert.match(String(refused.body.error), /不可达|共享|storage|fetch|无法读取/i);
    // The CLI and worker still see this backend's external identity, so they
    // cannot mistake the Task for an internal conversation and bypass the cap.
    const { openMainCapacityGate } = await import("../scripts/main-capacity-gate.mjs");
    const gate = await openMainCapacityGate({
      taskId: session.taskId,
      cwd: process.cwd(),
      env: secondary.env
    });
    assert.deepEqual(gate?.external, {
      taskId: session.taskId,
      projectId: project.projectId,
      sessionId: session.sessionId,
      kind: "regular"
    });
    const afterRead = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(
      afterRead.externalTasks.map((entry) => entry.taskId),
      [session.taskId]
    );

    // Restarting while the authority is unreachable fails explicitly and does
    // not rewrite the local index with an empty list.
    await assert.rejects(secondary.restart(), (error) => {
      assert.doesNotMatch(String(error), new RegExp(instance.value.token));
      return true;
    });
    const afterRestart = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(
      afterRestart.externalTasks.map((entry) => entry.taskId),
      [session.taskId]
    );
  }
);
