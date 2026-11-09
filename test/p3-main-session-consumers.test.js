import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { startDashboard } from "./dashboard-fixture.mjs";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";
import { startProjectDataDashboard } from "./p3-storage-fixture.mjs";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";
import { ProjectExperienceStore } from "../dist/src/runtime/project-experience-store.js";

const run = promisify(execFile);

/**
 * The session consumers: the shared session records and a real Pi process
 * talking to a local fake model.
 *
 * The fake model is the observation point for "input entered the selected
 * session": what each process was actually asked is the only claim that
 * matters, so a leaked draft or a late page load shows up as the wrong text in
 * the wrong conversation. The removed Main-session view's own controller tests
 * went with that view; the shared records it read stay covered here.
 */
async function provider(t, { hold = () => false, wait, rejectFirst = false, rejectAfterHold = false } = {}) {
  const requests = [];
  const failures = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET") return response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      const raw = await readFixtureRequestBody(request);
      const body = JSON.parse(raw);
      requests.push(body);
      // No explicit gate keeps the old "hold forever" fixture behavior.
      if (hold() && !wait) return new Promise(() => {});
      if ((rejectFirst && requests.length === 1) || rejectAfterHold) {
        if (hold()) await wait();
        response.writeHead(400, { "content-type": "application/json" });
        response.end('{"error":{"message":"fixture request rejection"}}');
        return;
      }
      if (hold()) await wait();
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
  return { base: `http://127.0.0.1:${server.address().port}/v1`, requests, failures };
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
  (body.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    )
    .join("\n");

async function settle(request, taskId, status) {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const detail = await request(`/api/tasks/${encodeURIComponent(taskId)}`);
    if (detail.status === 200 && !detail.body.runtime.active) {
      assert.equal(detail.body.task.status, status, JSON.stringify(detail.body.task));
      return detail.body;
    }
    await delay(50);
  }
  assert.fail(`Main ${taskId} did not settle to ${status}`);
}

async function createProject(request, dashboard, name, projectId) {
  const directory = join(dashboard.root, `project-${name}`);
  await mkdir(directory, { recursive: true });
  const created = await request("/api/projects", {
    projectName: `项目 ${name}`,
    projectDirectory: directory,
    ...(projectId ? { projectId } : {})
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.project;
}

const waitFor = async (check, message, timeout = 15_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(message);
};

/** Processes this test owns: their argv names the disposable data root. */
async function ownedProcesses(root) {
  const { stdout } = await run("ps", ["-ax", "-o", "pid=,command="], { maxBuffer: 8 * 1024 * 1024 });
  return stdout
    .split("\n")
    .filter((line) => line.includes(root))
    .map((line) => line.trim())
    .filter(Boolean);
}

test("cancel and an abnormal exit leave no Main process this run owns", { timeout: 120_000 }, async (t) => {
  let holding = false;
  const local = await provider(t, { hold: () => holding });
  const dashboard = await startDashboard({
    modelEndpoint: local.base,
    model: "fixture-model",
    defaultProject: false
  });
  const request = client(dashboard);
  const project = await createProject(request, dashboard, "process");
  const created = await request(`/api/projects/${encodeURIComponent(project.projectId)}/main-sessions`, {
    action: "create",
    title: "进程回收"
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const session = created.body.session;

  // Cancel while the model call is still open: the Run ends and its process goes.
  holding = true;
  const started = await request(`/api/tasks/${encodeURIComponent(session.taskId)}/run`, {
    prompt: "这一轮会被取消。",
    mainSessionId: session.sessionId
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await waitFor(() => local.requests.length === 1, "the Main process never reached the model");
  assert.ok((await ownedProcesses(dashboard.root)).length > 0, "the Main process is running before cancel");
  const cancelled = await request(`/api/tasks/${encodeURIComponent(session.taskId)}/action`, {
    action: "cancel"
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.status, "cancelled");
  await waitFor(
    async () => (await ownedProcesses(dashboard.root)).length === 0,
    "a cancelled Main process stayed alive"
  );
  const listed = await request(`/api/projects/${encodeURIComponent(project.projectId)}/main-sessions`);
  assert.equal(listed.body.sessions[0].runs[0].state, "cancelled");

  // An abnormal backend exit must not orphan the process either.
  const again = await request(`/api/tasks/${encodeURIComponent(session.taskId)}/run`, {
    prompt: "这一轮在退出时中止。",
    mainSessionId: session.sessionId
  });
  assert.equal(again.status, 202, JSON.stringify(again.body));
  await waitFor(() => local.requests.length === 2, "the restarted Main never reached the model");
  assert.ok((await ownedProcesses(dashboard.root)).length > 0, "the Main process is running before shutdown");
  await dashboard.stop();
  await waitFor(
    async () => (await ownedProcesses(dashboard.root)).length === 0,
    "the backend exit left its Main process running"
  );
  assert.deepEqual(local.failures, []);
});

/**
 * Two independent backends over one authenticated authority.
 *
 * The session's Task and Pi transcript live on the backend that created it;
 * only the shared identity, the requirement link and Run ownership cross the
 * wire. This proves the remote gateway records what the authority later shows,
 * that a session cannot be run from the wrong backend, and that a board handler
 * identifies exactly one session.
 */
/** The instance record is written during startup; a ready port does not imply the file yet. */
async function backendInstance(dashboard) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = await readBackendInstance(backendPaths(join(dashboard.root, "home")));
    if (record.value) return record.value;
    await delay(25);
  }
  return (await readBackendInstance(backendPaths(join(dashboard.root, "home")))).value;
}

async function secondaryBackend(t, authority, options = {}) {
  const authorityInstance = await backendInstance(authority);
  assert.ok(authorityInstance?.token, "the authority published its local credential");
  const dashboard = await startDashboard({
    defaultProject: false,
    ...options,
    config: { projectData: { authority: { url: authority.base, token: authorityInstance.token } } }
  });
  t.after(() => dashboard.stop());
  const backendId = (await backendInstance(dashboard))?.backendId;
  assert.ok(backendId, "the secondary backend published its identity");
  return {
    ...dashboard,
    backendId,
    request: client(dashboard),
    authorityToken: authorityInstance.token
  };
}

test(
  "two backends share Main session metadata while each keeps its own Task and process",
  { timeout: 120_000 },
  async (t) => {
    const local = await provider(t);
    const authority = await startProjectDataDashboard(t, "sqlite", {});
    const authorityToken = (await backendInstance(authority))?.token;
    assert.ok(authorityToken, "the authority published its local credential");
    const project = await createProject(client(authority), authority, "shared-authority");
    const backend = await secondaryBackend(t, authority, {
      modelEndpoint: local.base,
      model: "fixture-model"
    });
    const secondaryProject = await createProject(
      backend.request,
      backend,
      "shared-secondary",
      project.projectId
    );
    assert.equal(secondaryProject.projectId, project.projectId, "the shared project id is reused");
    const sessionsPath = (projectId) => `/api/projects/${encodeURIComponent(projectId)}/main-sessions`;

    // B writes the requirement and the session through its remote gateway; the
    // Task history container is created in B's own data root.
    const requirement = await backend.request(
      `/api/projects/${encodeURIComponent(project.projectId)}/ledger`,
      {
        action: "create",
        title: "跨后端需求",
        content: "两个后端共享同一会话记录。"
      }
    );
    assert.equal(requirement.status, 201, JSON.stringify(requirement.body));
    const created = await backend.request(sessionsPath(project.projectId), {
      action: "create",
      title: "B 的会话",
      requirementId: requirement.body.requirement.requirementId
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const session = created.body.session;
    assert.equal(session.backendId, backend.backendId);
    assert.equal(session.local, true);
    assert.equal(session.projectDirectory, secondaryProject.projectDirectory);
    assert.equal(session.currentRequirementTitle, "跨后端需求");
    assert.match(session.taskId, /^task-/);

    // The authority sees the same shared record but cannot run its history.
    const authorityView = await authority.request(sessionsPath(project.projectId), undefined, "GET");
    assert.equal(authorityView.status, 200, JSON.stringify(authorityView.body));
    assert.equal(authorityView.body.sessions.length, 1);
    const shared = authorityView.body.sessions[0];
    assert.equal(shared.sessionId, session.sessionId);
    assert.equal(shared.taskId, session.taskId);
    assert.equal(shared.backendId, backend.backendId);
    assert.equal(shared.currentRequirementId, requirement.body.requirement.requirementId);
    assert.equal(shared.local, false, "the authority does not hold B's Task history");
    const authorityTask = await authority.request(
      `/api/tasks/${encodeURIComponent(session.taskId)}`,
      undefined,
      "GET"
    );
    assert.equal(authorityTask.status, 400, "the authority has no such local Task");

    // The requirement records the accepting session on the shared side.
    const requirementDetail = await authority.request(
      `/api/projects/${encodeURIComponent(project.projectId)}/ledger/${encodeURIComponent(
        requirement.body.requirement.requirementId
      )}`,
      undefined,
      "GET"
    );
    assert.deepEqual(
      requirementDetail.body.requirement.references
        .map((reference) => [reference.kind, reference.value])
        .sort(),
      [
        ["session", session.sessionId],
        ["task", session.taskId]
      ]
    );

    // A requirement written by the authority becomes current in B's session.
    const next = await authority.request(`/api/projects/${encodeURIComponent(project.projectId)}/ledger`, {
      action: "create",
      title: "权威侧需求",
      content: "由权威后端写入。"
    });
    const selected = await backend.request(`${sessionsPath(project.projectId)}/${session.sessionId}`, {
      action: "select_requirement",
      requirementId: next.body.requirement.requirementId
    });
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    assert.equal(selected.body.session.currentRequirementId, next.body.requirement.requirementId);
    assert.equal(
      (await authority.request(sessionsPath(project.projectId), undefined, "GET")).body.sessions[0]
        .currentRequirementTitle,
      "权威侧需求"
    );

    // A real Main run on B records and settles its Run through the gateway.
    const run = await backend.request(`/api/tasks/${encodeURIComponent(session.taskId)}/run`, {
      prompt: "在 B 上执行跨后端会话。",
      mainSessionId: session.sessionId,
      requirementId: next.body.requirement.requirementId
    });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    assert.equal(run.body.sessionId, session.sessionId);
    await settle(backend.request, session.taskId, "completed");
    assert.equal(local.requests.length, 1);
    assert.match(userText(local.requests[0]), /在 B 上执行跨后端会话/);

    // The authority reads the completed ownership record, not a second Run.
    const afterRun = (await authority.request(sessionsPath(project.projectId), undefined, "GET")).body
      .sessions[0];
    assert.deepEqual(
      afterRun.runs.map((entry) => [entry.runId, entry.state, entry.taskId, entry.requirementId]),
      [[run.body.runId, "completed", session.taskId, next.body.requirement.requirementId]]
    );
    assert.equal(afterRun.activeRunId, null);

    // A run recorded for the session from the wrong backend is refused.
    const crossWrite = await fetch(
      `${authority.base}/api/projects/${encodeURIComponent(project.projectId)}/main-sessions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-atria-token": authorityToken,
          "x-cowork-backend-id": "backend_somewhere_else"
        },
        body: JSON.stringify({
          action: "record_run",
          sessionId: session.sessionId,
          runId: "run-elsewhere",
          taskId: session.taskId
        })
      }
    );
    assert.equal(crossWrite.status, 403, await crossWrite.text());
    assert.equal(
      (await authority.request(sessionsPath(project.projectId), undefined, "GET")).body.sessions[0].runs
        .length,
      1,
      "a refused write appends no Run"
    );

    // A shared session cannot be driven from B when it belongs to A.
    const authoritySession = await authority.request(sessionsPath(project.projectId), {
      action: "create",
      title: "A 的会话"
    });
    assert.equal(authoritySession.status, 201, JSON.stringify(authoritySession.body));
    const localTaskId = `task-${crypto.randomUUID()}`;
    const localTask = await backend.request("/api/tasks", {
      taskId: localTaskId,
      goal: "B 的本地任务",
      projectId: project.projectId
    });
    assert.equal(localTask.status, 201, JSON.stringify(localTask.body));
    const wrongBackend = await backend.request(`/api/tasks/${encodeURIComponent(localTaskId)}/run`, {
      prompt: "不该在 B 上启动 A 的会话。",
      mainSessionId: authoritySession.body.session.sessionId
    });
    assert.equal(wrongBackend.status, 409, JSON.stringify(wrongBackend.body));
    assert.match(wrongBackend.body.error, /另一台后端/);
    assert.equal(local.requests.length, 1, "the refused run reached no model");

    // A board handler locates exactly one session: the one owning its Task.
    const published = await backend.request(`/api/projects/${encodeURIComponent(project.projectId)}/board`, {
      action: "publish",
      requestId: "publish-handler",
      title: "看板需求",
      content: "认领后能定位处理会话。",
      source: { kind: "external", reference: "控制入口" }
    });
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const claimed = await backend.request(`/api/tasks/${encodeURIComponent(session.taskId)}/board`, {
      action: "claim",
      boardId: published.body.entry.boardId,
      expectedRevision: 1,
      requestId: "claim-handler"
    });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    assert.deepEqual(claimed.body.entry.assignment.handler, {
      backendId: session.backendId,
      projectId: session.projectId,
      taskId: session.taskId
    });
    const located = await fetch(
      `${authority.base}/api/projects/${encodeURIComponent(project.projectId)}/main-sessions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-atria-token": authorityToken,
          "x-cowork-backend-id": session.backendId
        },
        body: JSON.stringify({ action: "find_by_task", taskId: session.taskId })
      }
    );
    assert.equal(located.status, 200);
    const locatedBody = await located.json();
    assert.equal(locatedBody.record.session.sessionId, session.sessionId);
    assert.equal(locatedBody.record.session.projectId, claimed.body.entry.assignment.handler.projectId);
    const missing = await fetch(
      `${authority.base}/api/projects/${encodeURIComponent(project.projectId)}/main-sessions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-atria-token": authorityToken,
          "x-cowork-backend-id": session.backendId
        },
        body: JSON.stringify({ action: "find_by_task", taskId: "task-not-a-session" })
      }
    );
    assert.equal(missing.status, 404);
    assert.deepEqual(local.failures, []);
  }
);

/** A promise a test opens to release a held fake-model response. */
function createGate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}

const sessionsPath = (projectId) => `/api/projects/${encodeURIComponent(projectId)}/main-sessions`;
const ledgerPath = (projectId) => `/api/projects/${encodeURIComponent(projectId)}/ledger`;

async function sharedSession(request, dashboard, name) {
  const directory = join(dashboard.root, `project-${name}`);
  await mkdir(directory, { recursive: true });
  const project = await createProject(request, dashboard, name);
  const created = await request(ledgerPath(project.projectId), {
    action: "create",
    title: `${name} 需求`,
    content: "Run 归属必须保持对应。"
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const requirementId = created.body.requirement.requirementId;
  const session = await request(sessionsPath(project.projectId), {
    action: "create",
    title: `${name} 会话`,
    requirementId
  });
  assert.equal(session.status, 201, JSON.stringify(session.body));
  return { project, requirementId, session: session.body.session };
}

async function sessionView(request, projectId) {
  const listed = await request(sessionsPath(projectId));
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  return listed.body.sessions[0];
}

test(
  "a refused start leaves the active Run and its requirement untouched",
  { timeout: 120_000 },
  async (t) => {
    const gate = createGate();
    const local = await provider(t, { hold: () => true, wait: () => gate.promise });
    const dashboard = await startDashboard({
      modelEndpoint: local.base,
      model: "fixture-model",
      defaultProject: false
    });
    t.after(() => dashboard.stop());
    const request = client(dashboard);
    const { project, requirementId, session } = await sharedSession(request, dashboard, "refused");

    const first = await request(`/api/tasks/${encodeURIComponent(session.taskId)}/run`, {
      prompt: "第一轮会被挂住。",
      mainSessionId: session.sessionId,
      requirementId
    });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    await waitFor(() => local.requests.length === 1, "the first Main never reached the model");
    const before = await sessionView(request, project.projectId);
    assert.equal(before.runs.length, 1);
    assert.equal(before.runs[0].state, "running");
    assert.equal(before.runs[0].requirementId, requirementId);

    // A second prompt while the run is active is refused; the refusal must not
    // touch the live Run, which is the one the running process owns.
    const second = await request(`/api/tasks/${encodeURIComponent(session.taskId)}/run`, {
      prompt: "运行中再发一条。"
    });
    assert.equal(second.status, 400, JSON.stringify(second.body));
    assert.match(second.body.error, /active Main run/);
    const after = await sessionView(request, project.projectId);
    assert.equal(local.requests.length, 1, "the refused request reached no model");
    assert.equal(after.runs.length, 1, "the refused request appended no Run");
    assert.equal(after.runs[0].state, "running");
    assert.equal(after.runs[0].requirementId, requirementId);

    // The real execution still records its own terminal state.
    const cancelled = await request(`/api/tasks/${encodeURIComponent(session.taskId)}/action`, {
      action: "cancel"
    });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.status, "cancelled");
    await waitFor(
      async () => (await sessionView(request, project.projectId)).runs[0].state === "cancelled",
      "the real cancelled Run was not recorded"
    );
    const final = await sessionView(request, project.projectId);
    assert.equal(final.runs[0].requirementId, requirementId);
    assert.deepEqual(local.failures, []);
  }
);

test("two near-simultaneous starts admit exactly one Run", { timeout: 120_000 }, async (t) => {
  const gate = createGate();
  const local = await provider(t, { hold: () => true, wait: () => gate.promise });
  const dashboard = await startDashboard({
    modelEndpoint: local.base,
    model: "fixture-model",
    defaultProject: false
  });
  t.after(() => dashboard.stop());
  const request = client(dashboard);
  const { project, requirementId, session } = await sharedSession(request, dashboard, "racing");

  // Both racers name the same requirement: whichever the serialized admission
  // accepts, the Run's requirement association is the same, so the assertions
  // below do not depend on which HTTP response wins.
  const started = await Promise.all([
    request(`/api/tasks/${encodeURIComponent(session.taskId)}/run`, {
      prompt: "并发请求一。",
      mainSessionId: session.sessionId,
      requirementId
    }),
    request(`/api/tasks/${encodeURIComponent(session.taskId)}/run`, {
      prompt: "并发请求二。",
      mainSessionId: session.sessionId,
      requirementId
    })
  ]);
  assert.deepEqual(started.map((entry) => entry.status).sort(), [202, 400], JSON.stringify(started));
  await waitFor(() => local.requests.length === 1, "exactly one admitted start should reach the model");
  const running = await sessionView(request, project.projectId);
  assert.equal(running.runs.length, 1);
  assert.equal(running.runs[0].state, "running");
  assert.equal(running.runs[0].requirementId, requirementId);

  gate.open();
  await settle(request, session.taskId, "completed");
  const completed = await sessionView(request, project.projectId);
  assert.deepEqual(
    completed.runs.map((entry) => [entry.state, entry.requirementId]),
    [["completed", requirementId]]
  );
  assert.deepEqual(local.failures, []);
});

test("a legitimate retry re-enters running and completes its Run", { timeout: 120_000 }, async (t) => {
  let holding = false;
  const gate = createGate();
  const local = await provider(t, {
    rejectFirst: true,
    hold: () => holding,
    wait: () => gate.promise
  });
  const dashboard = await startDashboard({
    modelEndpoint: local.base,
    model: "fixture-model",
    defaultProject: false
  });
  t.after(() => dashboard.stop());
  const request = client(dashboard);
  const { project, requirementId, session } = await sharedSession(request, dashboard, "retry");

  const first = await request(`/api/tasks/${encodeURIComponent(session.taskId)}/run`, {
    prompt: "第一次会失败，随后重试。",
    mainSessionId: session.sessionId,
    requirementId
  });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  const failed = await settle(request, session.taskId, "failed");
  const failedView = await sessionView(request, project.projectId);
  assert.deepEqual(
    failedView.runs.map((entry) => [entry.runId, entry.state, entry.requirementId]),
    [[first.body.runId, "failed", requirementId]]
  );
  assert.ok(failed.retryRequest?.requestId, "the failed request is retryable");

  // A retry refused before admission leaves the failed record alone.
  const refused = await request(`/api/tasks/${encodeURIComponent(session.taskId)}/run`, {
    resume: true,
    retryRequestId: failed.retryRequest.requestId,
    prompt: "重试时不能附加新消息。"
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  const stillFailed = await sessionView(request, project.projectId);
  assert.deepEqual(
    stillFailed.runs.map((entry) => [entry.state, entry.requirementId]),
    [["failed", requirementId]]
  );

  // The retry runs under the original Run id; it must be running again and
  // keep the requirement the request was originally recorded with.
  holding = true;
  const retry = await request(`/api/tasks/${encodeURIComponent(session.taskId)}/run`, {
    resume: true,
    retryRequestId: failed.retryRequest.requestId
  });
  assert.equal(retry.status, 202, JSON.stringify(retry.body));
  await waitFor(() => local.requests.length === 2, "the retry never reached the model");
  const during = await sessionView(request, project.projectId);
  assert.equal(during.runs.length, 1);
  assert.equal(during.runs[0].runId, first.body.runId);
  assert.equal(during.runs[0].state, "running");
  assert.equal(during.runs[0].requirementId, requirementId);
  assert.equal(during.currentRequirementId, requirementId);

  holding = false;
  gate.open();
  await settle(request, session.taskId, "completed");
  const completed = await sessionView(request, project.projectId);
  assert.deepEqual(
    completed.runs.map((entry) => [entry.runId, entry.state, entry.requirementId]),
    [[first.body.runId, "completed", requirementId]]
  );
  assert.equal(completed.currentRequirementId, requirementId);
  assert.deepEqual(local.failures, []);
});

test(
  "an unreachable authority does not suppress the local experience write",
  { timeout: 120_000 },
  async (t) => {
    let holding = false;
    const gate = createGate();
    // Fail the Run: the Pi runtime only queues experience for a completed run,
    // so a failed Run isolates the dashboard's own finalization path.
    const local = await provider(t, {
      hold: () => holding,
      wait: () => gate.promise,
      rejectAfterHold: true
    });
    const authority = await startProjectDataDashboard(t, "sqlite", {});
    const project = await createProject(client(authority), authority, "experience-authority");
    const backend = await secondaryBackend(t, authority, {
      modelEndpoint: local.base,
      model: "fixture-model"
    });
    const secondaryProject = await createProject(
      backend.request,
      backend,
      "experience-secondary",
      project.projectId
    );
    // Learning is opt-in; enable it before the Run so finalization has a job.
    const store = new ProjectExperienceStore(
      {
        projectId: secondaryProject.projectId,
        projectDirectory: secondaryProject.projectDirectory,
        projectCatalogPath: join(backend.root, "projects.json")
      },
      join(backend.root, "home", "project-experience")
    );
    await store.configure({ enabled: true, learningEnabled: true });

    const requirement = await backend.request(ledgerPath(secondaryProject.projectId), {
      action: "create",
      title: "完成后的本地经验",
      content: "权威服务离线也不能丢掉本地经验入队。"
    });
    const created = await backend.request(sessionsPath(secondaryProject.projectId), {
      action: "create",
      title: "经验会话",
      requirementId: requirement.body.requirement.requirementId
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const session = created.body.session;

    holding = true;
    const run = await backend.request(`/api/tasks/${encodeURIComponent(session.taskId)}/run`, {
      prompt: "这一轮会失败并触发收尾。",
      mainSessionId: session.sessionId,
      requirementId: requirement.body.requirement.requirementId
    });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    await waitFor(() => local.requests.length === 1, "the Main never reached the model");

    // The authority goes away while the Run is still executing. The failed Run
    // then settles its shared record (which fails) and the local experience
    // enqueue must still happen.
    await authority.stop();
    holding = false;
    gate.open();
    await settle(backend.request, session.taskId, "failed");
    await waitFor(
      async () => (await store.read()).pending.some((item) => item.runId === run.body.runId),
      "the local experience write was skipped when the authority was unreachable"
    );
    const pending = (await store.read()).pending.find((item) => item.runId === run.body.runId);
    assert.equal(pending.taskId, session.taskId);
    assert.deepEqual(local.failures, []);
  }
);
