import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";
import {
  PROJECT_DATA_ENGINES,
  startPostgresProjectDatabase,
  startProjectDataDashboard
} from "./p3-storage-fixture.mjs";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";

/**
 * The whole P3 product on one real stack, on both engines.
 *
 * One backend owns the authority (its SQLite file or a disposable PostgreSQL),
 * a second backend has its own data root and reaches the same project facts
 * through the authenticated gateway. Mains are real Pi processes talking to a
 * local fake model, so "which conversation saw what" and "who took the slot"
 * are facts about processes and persisted rows, not about constructed objects.
 *
 * The same scenarios file covers both engines: each run has its own data root,
 * its own free ports, its own database and its own container, and everything
 * this test starts is stopped by its own handle or recorded pid.
 */
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

/** A local fake model that tags each request with the demand that produced it. */
async function provider(t, label) {
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
    // A resumed conversation carries earlier tagged turns, so the newest tag wins.
    return [...text.matchAll(/\[tag:([a-z0-9-]+)\]/g)].at(-1)?.[1];
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET") return response.end(JSON.stringify({ data: [{ id: label }] }));
      const body = JSON.parse(await readFixtureRequestBody(request));
      const tag = tagOf(body);
      requests.push({ tag, body, authorization: request.headers.authorization });
      if (tag && holdTags.has(tag))
        await new Promise((resolve) => {
          const list = waiters.get(tag) ?? [];
          list.push(resolve);
          waiters.set(tag, list);
        });
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(protocolStream("openai-completions", { text: `完成 ${tag ?? label}` }));
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
    hold(...tags) {
      for (const tag of tags) holdTags.add(tag);
    },
    release(tag) {
      holdTags.delete(tag);
      for (const resolve of waiters.get(tag) ?? []) resolve();
      waiters.delete(tag);
    },
    tags: () => requests.map((entry) => entry.tag),
    tagged(tag) {
      return requests.filter((entry) => entry.tag === tag);
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

const waitFor = async (check, message, timeout = 45_000) => {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    last = await check();
    if (last) return;
    await delay(50);
  }
  assert.fail(`${message}${last === undefined ? "" : `（最后观察：${JSON.stringify(last)}）`}`);
};

const userText = (body) =>
  (body.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    )
    .join("\n");

async function createProject(backend, name, projectId) {
  const directory = join(backend.root, `project-${name}`);
  await mkdir(directory, { recursive: true });
  const response = await backend.request("/api/projects", {
    projectName: `项目 ${name}`,
    projectDirectory: directory,
    ...(projectId ? { projectId } : {})
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.project;
}

/** A second backend with its own data root, reading the authority through its scoped credential. */
async function startSecondaryBackend(t, authority, config = {}) {
  const instance = await readBackendInstance(backendPaths(join(authority.root, "home")));
  assert.ok(instance.value?.token, "the authority published its local credential");
  const dashboard = await startDashboard({
    defaultProject: false,
    config: {
      projectData: { authority: { url: authority.base, token: instance.value.token } },
      ...config
    }
  });
  t.after(() => dashboard.stop());
  return { ...dashboard, request: client(dashboard), authorityToken: instance.value.token };
}

async function saveConnection(request, value) {
  const saved = await request("/api/model-settings", {
    api: "openai-completions",
    supportsImages: false,
    supportsReasoningEffort: true,
    reasoningEffort: "low",
    ...value
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return saved.body;
}

const profileNamed = (saved, name) => {
  const profile = saved.profiles.find((entry) => entry.name === name);
  assert.ok(profile, `missing connection ${name}`);
  return profile;
};

const ledger = (projectId) => `/api/projects/${encodeURIComponent(projectId)}/ledger`;
const board = (projectId) => `/api/projects/${encodeURIComponent(projectId)}/board`;
const sessions = (projectId) => `/api/projects/${encodeURIComponent(projectId)}/main-sessions`;

async function requirement(request, projectId, title, content) {
  const created = await request(ledger(projectId), {
    action: "create",
    title,
    content,
    source: { kind: "internal", reference: "内部会话" }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.requirement;
}

async function createSession(request, projectId, input) {
  const created = await request(sessions(projectId), { action: "create", ...input });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.session;
}

const listSessions = async (request, projectId) => {
  const listed = await request(sessions(projectId));
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  return listed.body.sessions;
};

const runTask = (request, taskId, body) => request(`/api/tasks/${encodeURIComponent(taskId)}/run`, body);
const taskDetail = (request, taskId) => request(`/api/tasks/${encodeURIComponent(taskId)}`);
const capacity = (request) => request("/api/main-capacity");
const cancel = (request, taskId) =>
  request(`/api/tasks/${encodeURIComponent(taskId)}/action`, { action: "cancel" });

async function settle(request, taskId, status, timeout = 60_000) {
  await waitFor(
    async () => {
      const detail = await taskDetail(request, taskId);
      return detail.status === 200 && !detail.body.runtime.active && detail.body.task.status === status;
    },
    `Main ${taskId} did not settle to ${status}`,
    timeout
  );
  return (await taskDetail(request, taskId)).body;
}

const sessionDirectory = (dashboard, taskId) =>
  join(dashboard.workspaceRoot, taskId, "sessions", "main", "pi");

const transcriptFiles = (directory) => readdir(directory).catch(() => []);

async function runDirectory(dashboard, taskId, runId) {
  const directory = join(dashboard.workspaceRoot, taskId, "runs", runId, "run_events.jsonl");
  const text = await readFile(directory, "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function selectionFor(dashboard, taskId, runId) {
  const events = await runDirectory(dashboard, taskId, runId);
  const spawned = events.filter((event) => event.type === "main.run_spawned");
  assert.equal(spawned.length, 1, `expected exactly one spawn event for ${taskId}/${runId}`);
  return spawned[0].payload.modelSelection;
}

/** The newest committed Run of a Task: a queued demand gets its id only after admission. */
async function latestSelection(dashboard, taskId) {
  const runs = join(dashboard.workspaceRoot, taskId, "runs");
  const entries = await readdir(runs, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(runs, entry.name, "run_events.jsonl");
    const info = await stat(file).catch(() => undefined);
    if (!info) continue;
    candidates.push({ runId: entry.name, mtime: info.mtimeMs });
  }
  candidates.sort((left, right) => right.mtime - left.mtime);
  assert.ok(candidates.length, `no committed Run under ${runs}`);
  return selectionFor(dashboard, taskId, candidates[0].runId);
}

const externalRegular = (view) => view.running.filter((entry) => entry.kind === "regular");
const externalContinuation = (view) => view.running.filter((entry) => entry.kind === "continuation");

for (const engine of PROJECT_DATA_ENGINES) {
  test(
    `${engine}: two backends share one authority for ledger-only work, board claims and separate Main histories`,
    { timeout: 300_000 },
    async (t) => {
      const hostModel = await provider(t, "authority");
      const secondaryModel = await provider(t, "secondary");
      const authority = await startProjectDataDashboard(t, engine, {
        postgres,
        config: { mainCapacity: { resident: 1, continuation: 1 } }
      });
      const request = client(authority);
      await saveConnection(request, {
        profileName: "主机默认",
        baseUrl: hostModel.base,
        model: "fixture-model",
        apiKey: "fixture-host-key"
      });
      const secondary = await startSecondaryBackend(t, authority, {
        mainCapacity: { resident: 1, continuation: 1 }
      });
      await saveConnection(secondary.request, {
        profileName: "执行主机",
        baseUrl: secondaryModel.base,
        model: "fixture-secondary",
        apiKey: "fixture-secondary-key"
      });

      const a = await createProject(authority, `shared-${engine}-a`);
      const b = await createProject(authority, `shared-${engine}-b`);
      // The same shared project id on the second backend, with its own local directory.
      const aOnSecondary = await createProject(secondary, `secondary-${engine}-a`, a.projectId);
      const bOnSecondary = await createProject(secondary, `secondary-${engine}-b`, b.projectId);
      assert.equal(aOnSecondary.projectId, a.projectId);
      assert.equal(bOnSecondary.projectId, b.projectId);
      assert.notEqual(aOnSecondary.projectDirectory, a.projectDirectory);

      // An internal need is ledger-only: the other backend reads it, and neither
      // backend's board shows an item.
      const internal = await requirement(
        request,
        a.projectId,
        "登录记住设备",
        "同一台设备 30 天内不再验证。"
      );
      const sharedLedger = await secondary.request(ledger(a.projectId), { action: "query" });
      assert.equal(sharedLedger.status, 200, JSON.stringify(sharedLedger.body));
      assert.deepEqual(
        sharedLedger.body.requirements.map((entry) => entry.requirementId),
        [internal.requirementId]
      );
      assert.deepEqual((await request(board(a.projectId))).body.entries, []);
      assert.deepEqual((await secondary.request(board(a.projectId))).body.entries, []);

      // A controlled external entry publishes the requirement and its board item
      // from the second backend; the authority reads the same item.
      const published = await secondary.request(board(a.projectId), {
        action: "publish",
        requestId: "publish-external",
        title: "外部发布的需求",
        content: "受控入口发布的共享看板需求。",
        source: { kind: "external", reference: "控制入口" }
      });
      assert.equal(published.status, 201, JSON.stringify(published.body));
      const entry = published.body.entry;
      assert.equal(entry.state, "pending");
      assert.equal(entry.entryKind, "external");
      assert.deepEqual((await request(board(a.projectId))).body.entries, [entry]);

      // Both backends claim at the same revision: exactly one wins.
      const claims = await Promise.all([
        request(board(a.projectId), {
          action: "claim",
          boardId: entry.boardId,
          expectedRevision: 1,
          requestId: "claim-authority"
        }),
        secondary.request(board(a.projectId), {
          action: "claim",
          boardId: entry.boardId,
          expectedRevision: 1,
          requestId: "claim-secondary"
        })
      ]);
      const winners = claims.filter((claim) => claim.status === 200);
      const losers = claims.filter((claim) => claim.status === 409);
      assert.equal(winners.length, 1, JSON.stringify(claims.map((claim) => claim.body)));
      assert.equal(losers.length, 1, JSON.stringify(claims.map((claim) => claim.body)));
      assert.equal(losers[0].body.code, "revision_conflict");
      assert.equal(losers[0].body.currentRevision, 2);
      const claimed = winners[0].body.entry;
      assert.equal(claimed.state, "claimed");
      assert.equal(claimed.revision, 2);
      const bothRead = await Promise.all([
        request(board(a.projectId)),
        secondary.request(board(a.projectId))
      ]);
      assert.deepEqual(bothRead[0].body.entries, bothRead[1].body.entries);
      assert.deepEqual(bothRead[0].body.entries[0].assignment, claimed.assignment);

      // Two internal Main sessions in project A, plus an external one saved by
      // the second backend: one project, several sessions, one per host history.
      const s1 = await createSession(request, a.projectId, {
        title: "登录改造",
        requirementId: internal.requirementId
      });
      const s2 = await createSession(request, a.projectId, { title: "报表导出" });
      const s3 = await createSession(secondary.request, a.projectId, {
        title: "外部处理",
        entryKind: "external"
      });
      const s4 = await createSession(secondary.request, b.projectId, {
        title: "B 项目外部",
        entryKind: "external"
      });
      assert.equal(s3.entryKind, "external");
      assert.equal(s3.projectId, a.projectId);

      // The shared rows are visible to both backends; only the owning backend
      // sees a session as local, and a foreign session cannot be run here.
      const seenByAuthority = await listSessions(request, a.projectId);
      const seenBySecondary = await listSessions(secondary.request, a.projectId);
      assert.deepEqual(
        seenByAuthority.map((session) => session.sessionId).sort(),
        [s1.sessionId, s2.sessionId, s3.sessionId].sort()
      );
      assert.equal(seenByAuthority.find((session) => session.sessionId === s3.sessionId).local, false);
      assert.equal(seenBySecondary.find((session) => session.sessionId === s1.sessionId).local, false);
      assert.equal(seenBySecondary.find((session) => session.sessionId === s3.sessionId).local, true);
      // A local Task may not borrow another backend's session either.
      const localTask = await secondary.request("/api/tasks", {
        taskId: `local-${engine}`,
        goal: "第二个后端的本地任务",
        projectId: a.projectId
      });
      assert.equal(localTask.status, 201, JSON.stringify(localTask.body));
      const foreignRun = await secondary.request("/api/tasks/local-" + engine + "/run", {
        prompt: "[tag:foreign] 不应启动。",
        mainSessionId: s1.sessionId
      });
      assert.equal(foreignRun.status, 409, JSON.stringify(foreignRun.body));
      assert.equal(foreignRun.body.code, "remote_session");
      // The other direction: the Task itself lives in the second backend's data
      // root, so the authority refuses before any session check can succeed.
      const reverseForeignRun = await request(`/api/tasks/${encodeURIComponent(s3.taskId)}/run`, {
        prompt: "[tag:reverse-foreign] 不应启动。",
        mainSessionId: s3.sessionId
      });
      assert.ok([400, 409].includes(reverseForeignRun.status), JSON.stringify(reverseForeignRun.body));
      assert.equal(reverseForeignRun.body.runtime, undefined);
      assert.deepEqual(hostModel.tags(), []);
      assert.deepEqual(secondaryModel.tags(), []);

      // First requirement in session one, on the owning backend.
      const started = await runTask(request, s1.taskId, {
        prompt: "[tag:login] 请完成登录改造。",
        mainSessionId: s1.sessionId,
        requirementId: internal.requirementId
      });
      assert.equal(started.status, 202, JSON.stringify(started.body));
      assert.equal(started.body.status, "running");
      await settle(request, s1.taskId, "completed");
      assert.equal(hostModel.tagged("login").length, 1);
      assert.match(userText(hostModel.tagged("login")[0].body), /请完成登录改造/);
      assert.equal((await transcriptFiles(sessionDirectory(authority, s1.taskId))).length, 1);
      assert.deepEqual(await transcriptFiles(sessionDirectory(authority, s2.taskId)), []);

      // The same project's second session is a different conversation.
      const secondRun = await runTask(request, s2.taskId, {
        prompt: "[tag:report] 请导出本季度报表。",
        mainSessionId: s2.sessionId
      });
      assert.equal(secondRun.status, 202, JSON.stringify(secondRun.body));
      await settle(request, s2.taskId, "completed");
      assert.match(userText(hostModel.tagged("report")[0].body), /请导出本季度报表/);
      assert.doesNotMatch(userText(hostModel.tagged("report")[0].body), /请完成登录改造/);
      assert.equal((await transcriptFiles(sessionDirectory(authority, s2.taskId))).length, 1);

      // Project B's conversation on the second backend never sees project A's words.
      const bRun = await runTask(secondary.request, s4.taskId, {
        prompt: "[tag:project-b] 只处理 B 项目。",
        mainSessionId: s4.sessionId
      });
      assert.equal(bRun.status, 202, JSON.stringify(bRun.body));
      await settle(secondary.request, s4.taskId, "completed");
      assert.match(userText(secondaryModel.tagged("project-b")[0].body), /只处理 B 项目/);
      assert.doesNotMatch(
        userText(secondaryModel.tagged("project-b")[0].body),
        /请完成登录改造|请导出本季度报表/
      );

      // The external conversation saved by the second backend runs there, with
      // that host's own connection and its own Pi history.
      const externalRun = await runTask(secondary.request, s3.taskId, {
        prompt: "[tag:external] 处理外部需求。",
        mainSessionId: s3.sessionId
      });
      assert.equal(externalRun.status, 202, JSON.stringify(externalRun.body));
      await settle(secondary.request, s3.taskId, "completed");
      assert.equal(secondaryModel.tagged("external").length, 1);
      assert.doesNotMatch(
        userText(secondaryModel.tagged("external")[0].body),
        /请完成登录改造|只处理 B 项目/
      );
      assert.equal((await transcriptFiles(sessionDirectory(secondary, s3.taskId))).length, 1);
      assert.equal(hostModel.tagged("external").length, 0, "the second host kept its own credential");

      // Finishing a requirement ends only that Run; the session takes the next
      // requirement and resumes its own history after the A→B→A switch.
      const delivered = await request(
        `${ledger(a.projectId)}/${encodeURIComponent(internal.requirementId)}`,
        {
          action: "update",
          requirementId: internal.requirementId,
          expectedRevision: 1,
          status: "delivered"
        }
      );
      assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
      const next = await requirement(request, a.projectId, "导出月度报表", "管理员每月导出一次。");
      const switched = await request(`${sessions(a.projectId)}/${encodeURIComponent(s1.sessionId)}`, {
        action: "select_requirement",
        requirementId: next.requirementId
      });
      assert.equal(switched.status, 200, JSON.stringify(switched.body));
      assert.equal(switched.body.session.currentRequirementId, next.requirementId);
      const resumedRun = await runTask(request, s1.taskId, {
        prompt: "[tag:login-next] 接着做报表导出。",
        mainSessionId: s1.sessionId,
        requirementId: next.requirementId
      });
      assert.equal(resumedRun.status, 202, JSON.stringify(resumedRun.body));
      await settle(request, s1.taskId, "completed");
      const resumedText = userText(hostModel.tagged("login-next")[0].body);
      assert.match(resumedText, /请完成登录改造/);
      assert.match(resumedText, /接着做报表导出/);
      assert.doesNotMatch(resumedText, /请导出本季度报表|只处理 B 项目|处理外部需求/);
      assert.equal(
        (await transcriptFiles(sessionDirectory(authority, s1.taskId))).length,
        1,
        "the resumed turn appended to the same Pi transcript"
      );
      // The second requirement on the same session names that session and Task.
      const attached = await request(`${ledger(a.projectId)}/${encodeURIComponent(next.requirementId)}`);
      assert.deepEqual(attached.body.requirement.references.map((reference) => reference.kind).sort(), [
        "session",
        "task"
      ]);
      assert.equal(
        attached.body.requirement.references.find((reference) => reference.kind === "session").value,
        s1.sessionId
      );

      // Every Run record and the fake model agree on how many demands ran.
      const finalSessions = await listSessions(request, a.projectId);
      const sessionOne = finalSessions.find((session) => session.sessionId === s1.sessionId);
      assert.deepEqual(sessionOne.runs.map((run) => run.state).sort(), ["completed", "completed"]);
      assert.equal(sessionOne.activeRunId, null);
      assert.deepEqual(hostModel.failures, []);
      assert.deepEqual(secondaryModel.failures, []);
      t.diagnostic(
        `${engine}: authority ${authority.root}, secondary ${secondary.root}, postgres ${postgres.serverVersion}`
      );
    }
  );

  test(
    `${engine}: fixed slots queue, the Main model override and a restart reconcile the shared facts`,
    { timeout: 300_000 },
    async (t) => {
      const hostModel = await provider(t, "authority");
      const projectModel = await provider(t, "project");
      const authority = await startProjectDataDashboard(t, engine, {
        postgres,
        config: { mainCapacity: { resident: 1, continuation: 1 } }
      });
      const request = client(authority);
      const hostSaved = await saveConnection(request, {
        profileName: "主机默认",
        baseUrl: hostModel.base,
        model: "fixture-model",
        apiKey: "fixture-host-key"
      });
      const withProject = await saveConnection(request, {
        profileId: "",
        profileName: "项目覆盖",
        baseUrl: projectModel.base,
        model: "model-project",
        apiKey: "fixture-project-key"
      });
      const hostProfile = profileNamed(hostSaved, "主机默认");
      const projectProfile = profileNamed(withProject, "项目覆盖");
      const hostRole = await request("/api/model-settings/roles", {
        role: "main",
        profileId: hostProfile.id
      });
      assert.equal(hostRole.status, 200, JSON.stringify(hostRole.body));

      const a = await createProject(authority, `model-${engine}-a`);
      const q1 = await createProject(authority, `queue-${engine}-one`);
      const q2 = await createProject(authority, `queue-${engine}-two`);
      const projectRole = await request("/api/model-settings/roles", {
        role: "main",
        projectId: a.projectId,
        profileId: projectProfile.id
      });
      assert.equal(projectRole.status, 200, JSON.stringify(projectRole.body));

      const externalOne = await createSession(request, q1.projectId, {
        title: "常规一",
        entryKind: "external"
      });
      const externalTwo = await createSession(request, q2.projectId, {
        title: "常规二",
        entryKind: "external"
      });
      const continuation = await createSession(request, q1.projectId, {
        title: "接续一",
        entryKind: "external",
        kind: "continuation"
      });

      // One regular slot: the second regular demand waits while the reserved
      // continuation slot stays with continuation work.
      hostModel.hold("queue-one");
      const running = await runTask(request, externalOne.taskId, {
        prompt: "[tag:queue-one] 运行常规一。",
        mainSessionId: externalOne.sessionId
      });
      assert.equal(running.status, 202, JSON.stringify(running.body));
      assert.equal(running.body.status, "running");
      // The explicit one-off selection is kept while the demand waits.
      const queued = await runTask(request, externalTwo.taskId, {
        prompt: "[tag:queue-two] 运行常规二。",
        mainSessionId: externalTwo.sessionId,
        profileId: projectProfile.id,
        model: "model-queued"
      });
      assert.equal(queued.status, 202, JSON.stringify(queued.body));
      assert.equal(queued.body.status, "queued", JSON.stringify(queued.body));
      const continuationRun = await runTask(request, continuation.taskId, {
        prompt: "[tag:queue-continuation] 运行接续一。",
        mainSessionId: continuation.sessionId
      });
      assert.equal(continuationRun.status, 202, JSON.stringify(continuationRun.body));
      assert.equal(continuationRun.body.status, "running", JSON.stringify(continuationRun.body));

      const full = await capacity(request);
      assert.equal(full.status, 200, JSON.stringify(full.body));
      assert.deepEqual(full.body.settings, { resident: 1, continuation: 1 });
      assert.deepEqual(
        externalRegular(full.body).map((entry) => entry.taskId),
        [externalOne.taskId]
      );
      assert.deepEqual(
        externalContinuation(full.body).map((entry) => entry.taskId),
        [continuation.taskId]
      );
      assert.deepEqual(
        full.body.queued.map((entry) => [entry.taskId, entry.position]),
        [[externalTwo.taskId, 1]]
      );
      const waiting = await taskDetail(request, externalTwo.taskId);
      assert.equal(waiting.body.runtime.active, false);
      assert.equal(waiting.body.task.activeRunId ?? null, null);

      // Freeing the regular slot advances the waiting demand; the explicit
      // connection/model chosen before the wait is the one that runs.
      const cancelled = await cancel(request, externalOne.taskId);
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
      await waitFor(
        async () => (await capacity(request)).body.queued.length === 0,
        "the queued demand never left the queue"
      );
      await waitFor(
        () => projectModel.tagged("queue-two").length === 1,
        "the queued demand never reached its explicit connection"
      );
      await settle(request, externalTwo.taskId, "completed");
      await settle(request, continuation.taskId, "completed");
      hostModel.release("queue-one");
      const drained = await capacity(request);
      assert.deepEqual(drained.body.running, []);
      assert.deepEqual(drained.body.queued, []);
      const queuedRequest = projectModel.tagged("queue-two")[0];
      assert.equal(queuedRequest.authorization, "Bearer fixture-project-key");
      assert.equal(queuedRequest.body.model, "model-queued");
      const queuedSelection = await latestSelection(authority, externalTwo.taskId);
      assert.equal(queuedSelection.source, "explicit");
      assert.equal(queuedSelection.model, "model-queued");

      // Project override beats the host role; another project keeps the host
      // default. Internal sessions spend no external slot.
      const modelSession = await createSession(request, a.projectId, { title: "A 项目内部会话" });
      const projectRun = await runTask(request, modelSession.taskId, {
        prompt: "[tag:model-project] 使用项目覆盖连接。",
        mainSessionId: modelSession.sessionId
      });
      assert.equal(projectRun.status, 202, JSON.stringify(projectRun.body));
      await settle(request, modelSession.taskId, "completed");
      const projectSelection = await selectionFor(authority, modelSession.taskId, projectRun.body.runId);
      assert.equal(projectSelection.source, "project");
      assert.equal(projectSelection.model, "model-project");
      assert.equal(projectModel.tagged("model-project").length, 1);
      assert.equal(hostModel.tagged("model-project").length, 0);

      const hostSession = await createSession(request, q1.projectId, { title: "Q1 项目内部会话" });
      const hostRun = await runTask(request, hostSession.taskId, {
        prompt: "[tag:model-host] 使用主机默认连接。",
        mainSessionId: hostSession.sessionId
      });
      assert.equal(hostRun.status, 202, JSON.stringify(hostRun.body));
      await settle(request, hostSession.taskId, "completed");
      const hostSelection = await selectionFor(authority, hostSession.taskId, hostRun.body.runId);
      assert.equal(hostSelection.source, "host");
      assert.equal(hostSelection.model, "fixture-model");
      assert.match(userText(hostModel.tagged("model-host")[0].body), /使用主机默认连接/);

      // Facts to reconcile across the restart: a revised requirement and a claim
      // written through the authenticated gateway.
      const revised = await request(ledger(a.projectId), {
        action: "create",
        title: "重启前的需求",
        content: "重启后应读回同一修订。"
      });
      assert.equal(revised.status, 201, JSON.stringify(revised.body));
      const updated = await request(ledger(a.projectId), {
        action: "update",
        requirementId: revised.body.requirement.requirementId,
        expectedRevision: 1,
        content: "重启后仍应读到第二次修订。"
      });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      assert.equal(updated.body.requirement.revision, 2);

      const secondary = await startSecondaryBackend(t, authority);
      const aOnSecondary = await createProject(secondary, `restart-${engine}-a`, a.projectId);
      assert.equal(aOnSecondary.projectId, a.projectId);
      const published = await secondary.request(board(a.projectId), {
        action: "publish",
        requestId: "publish-before-restart",
        title: "重启前的看板需求",
        content: "认领状态必须在重启后保持。",
        source: { kind: "external", reference: "控制入口" }
      });
      assert.equal(published.status, 201, JSON.stringify(published.body));
      const claimedBefore = await request(board(a.projectId), {
        action: "claim",
        boardId: published.body.entry.boardId,
        expectedRevision: 1,
        requestId: "claim-before-restart"
      });
      assert.equal(claimedBefore.status, 200, JSON.stringify(claimedBefore.body));
      const assignment = claimedBefore.body.entry.assignment;

      const sessionsBefore = await listSessions(request, a.projectId);
      const runsBefore = sessionsBefore.find((session) => session.sessionId === modelSession.sessionId).runs;
      const hostRequestsBefore = hostModel.requests.length;
      const projectRequestsBefore = projectModel.requests.length;

      // Restart the authority: nothing was in flight, so the reconciliation is
      // "no phantom slot, no dropped fact, no replayed demand".
      await authority.restart();
      const afterRestart = await capacity(request);
      assert.equal(afterRestart.status, 200, JSON.stringify(afterRestart.body));
      assert.deepEqual(afterRestart.body.settings, { resident: 1, continuation: 1 });
      assert.deepEqual(afterRestart.body.running, []);
      assert.deepEqual(afterRestart.body.queued, []);

      // The other backend keeps reading the same facts with its scoped credential.
      const boardAfter = await secondary.request(board(a.projectId));
      assert.equal(boardAfter.status, 200, JSON.stringify(boardAfter.body));
      const entryAfter = boardAfter.body.entries.find(
        (item) => item.boardId === published.body.entry.boardId
      );
      assert.equal(entryAfter.state, "claimed");
      assert.equal(entryAfter.revision, 2);
      assert.deepEqual(entryAfter.assignment, assignment);

      const ledgerAfter = await secondary.request(ledger(a.projectId), { action: "query" });
      const requirementAfter = ledgerAfter.body.requirements.find(
        (entry) => entry.requirementId === revised.body.requirement.requirementId
      );
      assert.equal(requirementAfter.revision, 2);
      assert.equal(requirementAfter.content, "重启后仍应读到第二次修订。");

      const sessionsAfter = await listSessions(request, a.projectId);
      assert.deepEqual(
        sessionsAfter.map((session) => session.sessionId).sort(),
        sessionsBefore.map((session) => session.sessionId).sort()
      );
      const restored = sessionsAfter.find((session) => session.sessionId === modelSession.sessionId);
      assert.deepEqual(
        restored.runs.map((run) => run.runId).sort(),
        runsBefore.map((run) => run.runId).sort()
      );
      assert.equal(restored.activeRunId, null);
      assert.equal(hostModel.requests.length, hostRequestsBefore, "no finished Run was replayed");
      assert.equal(projectModel.requests.length, projectRequestsBefore);

      // The next turn resumes the history that survived the restart and spends
      // exactly one new model request on the project override.
      const resumed = await runTask(request, modelSession.taskId, {
        prompt: "[tag:model-after-restart] 重启后继续。",
        mainSessionId: modelSession.sessionId
      });
      assert.equal(resumed.status, 202, JSON.stringify(resumed.body));
      await settle(request, modelSession.taskId, "completed");
      assert.equal(projectModel.tagged("model-after-restart").length, 1);
      assert.equal(projectModel.requests.length, projectRequestsBefore + 1);
      assert.match(
        userText(projectModel.tagged("model-after-restart")[0].body),
        /使用项目覆盖连接/,
        "the resumed turn saw the pre-restart history"
      );
      const resumedSelection = await selectionFor(authority, modelSession.taskId, resumed.body.runId);
      assert.equal(resumedSelection.source, "project");
      assert.equal((await capacity(request)).body.running.length, 0);
      assert.deepEqual(hostModel.failures, []);
      assert.deepEqual(projectModel.failures, []);
      t.diagnostic(
        `${engine}: restart kept board revision 2, ledger revision 2 and ${sessionsAfter.length} sessions; postgres ${postgres.serverVersion}`
      );
    }
  );
}
