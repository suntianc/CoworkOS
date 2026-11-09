import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseHTML } from "linkedom";
import { startDashboard } from "./dashboard-fixture.mjs";
import { createSettingsPages } from "../web/assets/controllers/settings-pages.js";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";
import {
  PROJECT_DATA_ENGINES,
  startPostgresProjectDatabase,
  startProjectDataDashboard
} from "./p3-storage-fixture.mjs";

/**
 * External Main capacity against the real Dashboard, a real Pi launcher and a
 * local fake model.
 *
 * The budget is a local execution fact, so the proof is process behavior: the
 * fake model shows which Runs were actually asked to work, and the capacity
 * page shows who owns a slot and who is still waiting for one. The shared
 * session rows come from the engine the fixture opened, so the saved-session
 * limit is asserted on both SQLite and PostgreSQL.
 */
async function provider(t) {
  const requests = [];
  const failures = [];
  const hold = { active: false, waiters: [] };
  const gate = () => (hold.active ? new Promise((resolve) => hold.waiters.push(resolve)) : Promise.resolve());
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET") return response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      const body = JSON.parse(await readFixtureRequestBody(request));
      requests.push(body);
      await gate();
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(protocolStream("openai-completions", { text: `第 ${requests.length} 轮完成` }));
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
    hold() {
      hold.active = true;
    },
    release() {
      hold.active = false;
      for (const resolve of hold.waiters.splice(0)) resolve();
    }
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

const waitFor = async (check, message, timeout = 20_000) => {
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

async function createSession(request, projectId, input) {
  return request(`/api/projects/${encodeURIComponent(projectId)}/main-sessions`, {
    action: "create",
    ...input
  });
}

const runTask = (request, taskId, body) => request(`/api/tasks/${encodeURIComponent(taskId)}/run`, body);

const taskDetail = (request, taskId) => request(`/api/tasks/${encodeURIComponent(taskId)}`);
const setCapacity = (request, input) => request("/api/main-capacity", { action: "configure", ...input });
const capacity = (request) => request("/api/main-capacity");
const cancel = (request, taskId) =>
  request(`/api/tasks/${encodeURIComponent(taskId)}/action`, { action: "cancel" });

const externalRegular = (view) => view.running.filter((entry) => entry.kind === "regular");
const externalContinuation = (view) => view.running.filter((entry) => entry.kind === "continuation");

async function settle(request, taskId, status) {
  // A freshly admitted Run is recorded before its process registers, so a read
  // can see "running" with no active process. Wait for the durable outcome.
  await waitFor(async () => {
    const detail = await taskDetail(request, taskId);
    return detail.status === 200 && !detail.body.runtime.active && detail.body.task.status === status;
  }, `Main ${taskId} did not settle to ${status}`);
  return (await taskDetail(request, taskId)).body;
}

let postgres;
before(
  async () => {
    postgres = await startPostgresProjectDatabase();
  },
  { timeout: 180_000 }
);
after(async () => {
  await postgres?.stop();
});

/**
 * The saved-session limit and the running-slot limit are separate facts on both
 * engines: two saved regular sessions are already at the limit before either
 * runs, and a saved session still blocks nothing while another project runs.
 */
for (const engine of PROJECT_DATA_ENGINES) {
  test(
    `${engine}: external quotas bound running Mains and project sessions`,
    { timeout: 180_000 },
    async (t) => {
      const local = await provider(t);
      const dashboard = await startProjectDataDashboard(t, engine, {
        postgres,
        modelEndpoint: local.base,
        model: "fixture-model",
        config: { mainCapacity: { resident: 2, continuation: 1 } }
      });
      const request = client(dashboard);
      const a = await createProject(request, dashboard, `cap-${engine}-a`);
      const b = await createProject(request, dashboard, `cap-${engine}-b`);

      const initial = await capacity(request);
      assert.equal(initial.status, 200, JSON.stringify(initial.body));
      assert.deepEqual(initial.body.settings, { resident: 2, continuation: 1 });
      assert.deepEqual(initial.body.running, []);
      assert.deepEqual(initial.body.queued, []);

      // Two saved regular sessions fill project A's limit; the third is refused
      // even though neither conversation is running.
      const first = await createSession(request, a.projectId, { title: "常规一", entryKind: "external" });
      const second = await createSession(request, a.projectId, { title: "常规二", entryKind: "external" });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(second.status, 201, JSON.stringify(second.body));
      const third = await createSession(request, a.projectId, { title: "常规三", entryKind: "external" });
      assert.equal(third.status, 409, JSON.stringify(third.body));
      assert.match(third.body.error, /上限/);
      // A continuation session is not part of the project's regular limit.
      const continuation = await createSession(request, a.projectId, {
        title: "接续一",
        entryKind: "external",
        kind: "continuation"
      });
      assert.equal(continuation.status, 201, JSON.stringify(continuation.body));
      const internal = await createSession(request, a.projectId, { title: "内部一" });
      assert.equal(internal.status, 201, JSON.stringify(internal.body));
      const other = await createSession(request, b.projectId, { title: "B 常规", entryKind: "external" });
      assert.equal(other.status, 201, JSON.stringify(other.body));

      // A saved session occupies no slot: one external regular Main runs while A
      // still counts two saved sessions.
      local.hold();
      const running = await runTask(request, other.body.session.taskId, {
        prompt: "先运行 B 项目。",
        mainSessionId: other.body.session.sessionId
      });
      assert.equal(running.status, 202, JSON.stringify(running.body));
      assert.equal(running.body.status, "running");
      await waitFor(async () => {
        const view = await capacity(request);
        return externalRegular(view.body).length === 1;
      }, "the first external regular Main did not take a slot");

      const saving = await capacity(request);
      assert.deepEqual(
        Object.fromEntries(
          saving.body.projects.map((project) => [project.projectId, [project.regular, project.continuation]])
        ),
        { [a.projectId]: [2, 1], [b.projectId]: [1, 0] }
      );

      // The second regular Run fills resident; the third waits instead of
      // borrowing the reserved continuation slot.
      const secondRun = await runTask(request, first.body.session.taskId, {
        prompt: "运行 A 项目常规一。",
        mainSessionId: first.body.session.sessionId
      });
      assert.equal(secondRun.status, 202, JSON.stringify(secondRun.body));
      assert.equal(secondRun.body.status, "running");
      const queued = await runTask(request, second.body.session.taskId, {
        prompt: "运行 A 项目常规二。",
        mainSessionId: second.body.session.sessionId
      });
      assert.equal(queued.status, 202, JSON.stringify(queued.body));
      assert.equal(queued.body.status, "queued", JSON.stringify(queued.body));
      const waitingDetail = await taskDetail(request, second.body.session.taskId);
      assert.equal(waitingDetail.body.runtime.active, false);
      assert.equal(waitingDetail.body.task.activeRunId ?? null, null);

      const full = await capacity(request);
      assert.equal(externalRegular(full.body).length, 2);
      assert.deepEqual(
        full.body.queued.map((entry) => [entry.taskId, entry.position]),
        [[second.body.session.taskId, 1]]
      );
      // The continuation slot is still free, and only a continuation may use it.
      assert.equal(externalContinuation(full.body).length, 0);
      const continuationRun = await runTask(request, continuation.body.session.taskId, {
        prompt: "运行接续会话。",
        mainSessionId: continuation.body.session.sessionId
      });
      assert.equal(continuationRun.status, 202, JSON.stringify(continuationRun.body));
      assert.equal(continuationRun.body.status, "running");
      // An internal Main never spends the external budget.
      const internalRun = await runTask(request, internal.body.session.taskId, {
        prompt: "运行内部会话。",
        mainSessionId: internal.body.session.sessionId
      });
      assert.equal(internalRun.status, 202, JSON.stringify(internalRun.body));
      assert.equal(internalRun.body.status, "running");
      const withInternal = await capacity(request);
      assert.equal(externalRegular(withInternal.body).length, 2);
      assert.equal(externalContinuation(withInternal.body).length, 1);
      assert.equal(withInternal.body.queued.length, 1);

      // A reduction below real use is refused with its reason, not applied.
      const reducedRunning = await setCapacity(request, { resident: 1 });
      assert.equal(reducedRunning.status, 409, JSON.stringify(reducedRunning.body));
      assert.match(reducedRunning.body.error, /正在运行 2 个外部常规 Main/);
      assert.deepEqual((await capacity(request)).body.settings, { resident: 2, continuation: 1 });

      // Freeing one regular slot starts exactly the waiting demand, in order.
      local.release();
      const cancelled = await cancel(request, other.body.session.taskId);
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
      await waitFor(async () => {
        const view = await capacity(request);
        return externalRegular(view.body).some((entry) => entry.taskId === second.body.session.taskId);
      }, "the queued demand did not take the freed slot");
      const advanced = await capacity(request);
      assert.equal(advanced.body.queued.length, 0);
      assert.ok(externalRegular(advanced.body).length >= 1);

      await settle(request, first.body.session.taskId, "completed");
      await settle(request, second.body.session.taskId, "completed");
      await settle(request, continuation.body.session.taskId, "completed");
      await settle(request, internal.body.session.taskId, "completed");

      // Saved sessions are still there, so a quota below them is refused too.
      const reducedSessions = await setCapacity(request, { resident: 1 });
      assert.equal(reducedSessions.status, 409, JSON.stringify(reducedSessions.body));
      assert.match(reducedSessions.body.error, /已有 2 个外部常规会话/);
      assert.match(reducedSessions.body.error, new RegExp(`cap-${engine}-a`));

      // Illegal values are refused and leave the readable settings untouched.
      for (const invalid of [{ resident: 0 }, { continuation: -1 }, { resident: 1.5 }, { resident: "2" }]) {
        const refused = await setCapacity(request, invalid);
        assert.equal(refused.status, 400, `${JSON.stringify(invalid)} ${JSON.stringify(refused.body)}`);
      }
      assert.deepEqual((await capacity(request)).body.settings, { resident: 2, continuation: 1 });

      // Raising the quotas is accepted and observable.
      const raised = await setCapacity(request, { resident: 3, continuation: 2 });
      assert.equal(raised.status, 200, JSON.stringify(raised.body));
      assert.deepEqual(raised.body.settings, { resident: 3, continuation: 2 });
      assert.deepEqual((await capacity(request)).body.settings, { resident: 3, continuation: 2 });
      assert.deepEqual(local.failures, []);
    }
  );
}

/**
 * The third regular demand waits behind two running Mains on the default
 * engine, and getting a slot back advances it before the reserved continuation
 * capacity is ever considered.
 */
test(
  "a third external regular Main waits and never borrows the continuation slot",
  { timeout: 180_000 },
  async (t) => {
    const local = await provider(t);
    const dashboard = await startDashboard({
      modelEndpoint: local.base,
      model: "fixture-model",
      defaultProject: false,
      config: { mainCapacity: { resident: 2, continuation: 1 } }
    });
    t.after(() => dashboard.stop());
    const request = client(dashboard);
    const a = await createProject(request, dashboard, "queue-a");
    const b = await createProject(request, dashboard, "queue-b");
    const sessions = {};
    for (const [project, name] of [
      [a, "one"],
      [a, "two"]
    ]) {
      const created = await createSession(request, project.projectId, {
        title: name,
        entryKind: "external"
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      sessions[name] = created.body.session;
    }
    const third = await createSession(request, b.projectId, { title: "three", entryKind: "external" });
    assert.equal(third.status, 201, JSON.stringify(third.body));
    sessions.three = third.body.session;

    local.hold();
    for (const name of ["one", "three"]) {
      const started = await runTask(request, sessions[name].taskId, {
        prompt: `运行 ${name}。`,
        mainSessionId: sessions[name].sessionId
      });
      assert.equal(started.status, 202, JSON.stringify(started.body));
      assert.equal(started.body.status, "running");
    }
    const queued = await runTask(request, sessions.two.taskId, {
      prompt: "运行 two。",
      mainSessionId: sessions.two.sessionId
    });
    assert.equal(queued.body.status, "queued", JSON.stringify(queued.body));

    // Watch the budget while work moves: regular never exceeds two, continuation
    // never exceeds its reserved one, and the queued demand is never a running one.
    local.release();
    const cancelled = await cancel(request, sessions.one.taskId);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    const observed = { regular: 0, continuation: 0 };
    await waitFor(async () => {
      const view = await capacity(request);
      observed.regular = Math.max(observed.regular, externalRegular(view.body).length);
      observed.continuation = Math.max(observed.continuation, externalContinuation(view.body).length);
      assert.ok(observed.regular <= 2, `regular slots exceeded: ${JSON.stringify(view.body.running)}`);
      assert.ok(
        observed.continuation <= 1,
        `continuation slot exceeded: ${JSON.stringify(view.body.running)}`
      );
      return (
        externalRegular(view.body).some((entry) => entry.taskId === sessions.two.taskId) &&
        view.body.queued.length === 0
      );
    }, "the queued demand did not start after a completion and a cancellation");
    assert.ok(observed.regular >= 1 && observed.regular <= 2, JSON.stringify(observed));
    await settle(request, sessions.two.taskId, "completed");
    await settle(request, sessions.three.taskId, "completed");
    const final = await capacity(request);
    assert.deepEqual(final.body.running, []);
    assert.deepEqual(final.body.queued, []);
    assert.deepEqual(local.failures, []);
  }
);

/**
 * The project limit is a hard bound, not a policy hint: two pages saving the
 * last free place must not both succeed. The check and the creation of an
 * external session are one critical section.
 */
test("concurrent external session saves never exceed the project limit", { timeout: 120_000 }, async (t) => {
  const dashboard = await startDashboard({
    defaultProject: false,
    config: { mainCapacity: { resident: 2, continuation: 0 } }
  });
  t.after(() => dashboard.stop());
  const request = client(dashboard);
  const project = await createProject(request, dashboard, "race");
  const first = await createSession(request, project.projectId, { title: "已保存", entryKind: "external" });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  const results = await Promise.all([
    createSession(request, project.projectId, { title: "并发一", entryKind: "external" }),
    createSession(request, project.projectId, { title: "并发二", entryKind: "external" })
  ]);
  assert.deepEqual(
    results.map((result) => result.status).sort(),
    [201, 409],
    JSON.stringify(results.map((result) => result.body))
  );
  const refused = results.find((result) => result.status === 409);
  assert.match(refused.body.error, /上限/);
  const listed = await request(`/api/projects/${encodeURIComponent(project.projectId)}/main-sessions`);
  assert.deepEqual(listed.body.sessions.map((session) => session.title).sort(), ["并发一", "已保存"].sort());
  // The saved sessions still count for the quota check.
  const reduced = await setCapacity(request, { resident: 1 });
  assert.equal(reduced.status, 409, JSON.stringify(reduced.body));
  assert.match(reduced.body.error, /已有 2 个外部常规会话/);
});

/**
 * The quota form loads asynchronously. A person who starts typing before that
 * read comes back must keep their numbers, and saving must write them.
 */
test("the runtime capacity page keeps edited quotas across a background refresh and saves them", async (t) => {
  const { window, document } = parseHTML(readFileSync("web/index.html", "utf8"));
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    CSS: globalThis.CSS,
    location: globalThis.location
  };
  Object.assign(globalThis, {
    window,
    document,
    CSS: { escape: (value) => value },
    location: { origin: "http://127.0.0.1:3880", host: "127.0.0.1:3880" }
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  window.HTMLElement.prototype.getClientRects ??= () => [];
  const sent = [];
  let reads = 0;
  const api = async (path, options) => {
    if (options?.body) {
      const body = JSON.parse(options.body);
      sent.push(body);
      return {
        settings: { resident: body.resident, continuation: body.continuation },
        running: [],
        queued: [],
        projects: []
      };
    }
    reads += 1;
    return { settings: { resident: 2, continuation: 0 }, running: [], queued: [], projects: [] };
  };
  const pages = createSettingsPages({
    root: document.querySelector("#settings-entry"),
    app: document.querySelector("#app-layout"),
    api,
    nodes: () => [{ origin: "https://cloud.example.test", name: "云端", role: "external" }]
  });
  pages.open("capacity");
  for (let index = 0; index < 8; index++) await new Promise((done) => setTimeout(done, 0));
  const continuation = () => document.querySelector('[data-capacity-value="continuation"]');
  assert.equal(document.querySelector('[data-capacity-value="regular"]').textContent, "2");
  assert.equal(continuation().textContent, "0");

  document.querySelector('[aria-label="增加接续 Main"]').click();
  assert.equal(continuation().textContent, "1");
  // A refresh reads the service again but keeps the number the person set.
  pages.open("capacity");
  for (let index = 0; index < 8; index++) await new Promise((done) => setTimeout(done, 0));
  assert.equal(reads, 2);
  assert.equal(continuation().textContent, "1", "a background refresh must not overwrite the edited quota");

  document.querySelector("[data-capacity-save]").click();
  for (let index = 0; index < 8; index++) await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual(sent, [{ resident: 2, continuation: 1 }]);
  assert.equal(continuation().textContent, "1", "the saved value is shown after saving");
});
