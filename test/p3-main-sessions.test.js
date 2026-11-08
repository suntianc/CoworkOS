import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { startDashboard } from "./dashboard-fixture.mjs";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";
import {
  PROJECT_DATA_ENGINES,
  startPostgresProjectDatabase,
  startProjectDataDashboard
} from "./p3-storage-fixture.mjs";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";
import { SqliteDatabase } from "../dist/src/storage/project-data/sqlite-database.js";
import { PROJECT_DATA_MIGRATIONS } from "../dist/src/storage/project-data/migrations.js";

/**
 * Persistent project Main sessions against the real Dashboard, the real Pi
 * launcher and the storage the service actually opened.
 *
 * Each session owns one Task as its history container, so the Pi transcript
 * lives where it always did; what this file proves is that two sessions never
 * share a transcript, that a session carries requirement after requirement,
 * and that switching project, restarting the backend or reading an old Task
 * keeps every one of those identities apart.
 */
async function provider(t) {
  const requests = [];
  const failures = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET") return response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      const raw = await readFixtureRequestBody(request);
      const body = JSON.parse(raw);
      requests.push(body);
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
  // A freshly admitted Run is recorded before its process registers; wait for
  // the durable outcome instead of the first "no active process" sample.
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const detail = await request(`/api/tasks/${encodeURIComponent(taskId)}`);
    if (detail.status === 200 && !detail.body.runtime.active && detail.body.task.status === status)
      return detail.body;
    await delay(50);
  }
  assert.fail(`Main ${taskId} did not settle to ${status}`);
}

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

async function requirement(request, projectId, title, content) {
  const created = await request(`/api/projects/${encodeURIComponent(projectId)}/ledger`, {
    action: "create",
    title,
    content
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.requirement;
}

async function sessions(request, projectId) {
  const listed = await request(`/api/projects/${encodeURIComponent(projectId)}/main-sessions`);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.projectId, projectId);
  return listed.body.sessions;
}

const sessionDirectory = (dashboard, taskId) =>
  join(dashboard.workspaceRoot, taskId, "sessions", "main", "pi");

const transcriptFiles = (directory) => readdir(directory).catch(() => []);

test(
  "two Main sessions keep their own Pi history and one session carries requirement after requirement",
  { timeout: 120_000 },
  async (t) => {
    const local = await provider(t);
    const dashboard = await startDashboard({
      modelEndpoint: local.base,
      model: "fixture-model",
      defaultProject: false
    });
    t.after(() => dashboard.stop());
    const request = client(dashboard);
    const a = await createProject(request, dashboard, "a");
    const b = await createProject(request, dashboard, "b");

    const first = await requirement(request, a.projectId, "登录记住设备", "同一台设备 30 天内不再验证。");
    const created = await request(`/api/projects/${encodeURIComponent(a.projectId)}/main-sessions`, {
      action: "create",
      title: "登录改造",
      requirementId: first.requirementId
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const sessionOne = created.body.session;
    assert.equal(sessionOne.projectId, a.projectId);
    assert.equal(sessionOne.entryKind, "internal");
    assert.equal(sessionOne.kind, "regular");
    assert.equal(sessionOne.currentRequirementId, first.requirementId);
    assert.equal(sessionOne.currentRequirementTitle, "登录记住设备");
    assert.equal(sessionOne.projectDirectory, a.projectDirectory);
    assert.equal(sessionOne.local, true);
    assert.match(sessionOne.taskId, /^task-/);

    // The requirement names the session that accepted it, not just a Task.
    const attached = await request(
      `/api/projects/${encodeURIComponent(a.projectId)}/ledger/${encodeURIComponent(first.requirementId)}`
    );
    assert.equal(attached.status, 200);
    assert.deepEqual(
      attached.body.requirement.references
        .filter((reference) => reference.kind !== "delivery")
        .map((reference) => [reference.kind, reference.value])
        .sort(),
      [
        ["session", sessionOne.sessionId],
        ["task", sessionOne.taskId]
      ]
    );

    // A second session in the same project is a different conversation.
    const second = await request(`/api/projects/${encodeURIComponent(a.projectId)}/main-sessions`, {
      action: "create",
      title: "报表导出"
    });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const sessionTwo = second.body.session;
    assert.notEqual(sessionTwo.sessionId, sessionOne.sessionId);
    assert.notEqual(sessionTwo.taskId, sessionOne.taskId);

    const runOne = await request(`/api/tasks/${encodeURIComponent(sessionOne.taskId)}/run`, {
      prompt: "请完成登录改造。",
      mainSessionId: sessionOne.sessionId,
      requirementId: first.requirementId
    });
    assert.equal(runOne.status, 202, JSON.stringify(runOne.body));
    assert.equal(runOne.body.sessionId, sessionOne.sessionId);
    const settledOne = await settle(request, sessionOne.taskId, "completed");
    assert.equal(local.requests.length, 1);
    assert.match(userText(local.requests[0]), /请完成登录改造/);
    assert.equal((await transcriptFiles(sessionDirectory(dashboard, sessionOne.taskId))).length, 1);
    assert.deepEqual(await transcriptFiles(sessionDirectory(dashboard, sessionTwo.taskId)), []);

    const runTwo = await request(`/api/tasks/${encodeURIComponent(sessionTwo.taskId)}/run`, {
      prompt: "请导出本季度报表。",
      mainSessionId: sessionTwo.sessionId
    });
    assert.equal(runTwo.status, 202, JSON.stringify(runTwo.body));
    await settle(request, sessionTwo.taskId, "completed");
    assert.equal(local.requests.length, 2);
    // The second conversation never saw the first one's words.
    assert.doesNotMatch(userText(local.requests[1]), /请完成登录改造/);
    assert.match(userText(local.requests[1]), /请导出本季度报表/);
    assert.equal((await transcriptFiles(sessionDirectory(dashboard, sessionTwo.taskId))).length, 1);

    // Finishing a requirement ends that Run; the session stays and takes the next one.
    const delivered = await request(
      `/api/projects/${encodeURIComponent(a.projectId)}/ledger/${encodeURIComponent(first.requirementId)}`,
      { action: "update", requirementId: first.requirementId, expectedRevision: 1, status: "delivered" }
    );
    assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
    const next = await requirement(request, a.projectId, "导出月度报表", "管理员每月导出一次。");
    const switched = await request(
      `/api/projects/${encodeURIComponent(a.projectId)}/main-sessions/${encodeURIComponent(sessionOne.sessionId)}`,
      { action: "select_requirement", requirementId: next.requirementId }
    );
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    assert.equal(switched.body.session.currentRequirementId, next.requirementId);

    const runThree = await request(`/api/tasks/${encodeURIComponent(sessionOne.taskId)}/run`, {
      prompt: "接着做报表导出。",
      mainSessionId: sessionOne.sessionId,
      requirementId: next.requirementId
    });
    assert.equal(runThree.status, 202, JSON.stringify(runThree.body));
    await settle(request, sessionOne.taskId, "completed");
    assert.equal(local.requests.length, 3);
    // The session's own history is resumed: the earlier requirement is context.
    assert.match(userText(local.requests[2]), /请完成登录改造/);
    assert.match(userText(local.requests[2]), /接着做报表导出/);
    assert.doesNotMatch(userText(local.requests[2]), /请导出本季度报表/);
    assert.equal((await transcriptFiles(sessionDirectory(dashboard, sessionOne.taskId))).length, 1);
    assert.equal(settledOne.task.taskId, sessionOne.taskId);

    // The ledger keeps both requirements pointing at the same accepting session.
    const secondAttached = await request(
      `/api/projects/${encodeURIComponent(a.projectId)}/ledger/${encodeURIComponent(next.requirementId)}`
    );
    assert.deepEqual(
      secondAttached.body.requirement.references.map((reference) => [reference.kind, reference.value]).sort(),
      [
        ["session", sessionOne.sessionId],
        ["task", sessionOne.taskId]
      ]
    );
    const listedA = await sessions(request, a.projectId);
    const viewOne = listedA.find((session) => session.sessionId === sessionOne.sessionId);
    assert.equal(viewOne.currentRequirementId, next.requirementId);
    assert.equal(viewOne.currentRequirementTitle, "导出月度报表");
    assert.deepEqual(
      viewOne.runs.map((run) => [run.state, run.requirementId ?? null]),
      [
        ["completed", next.requirementId],
        ["completed", first.requirementId]
      ]
    );
    // Project B has no session and therefore no story from A.
    assert.deepEqual(await sessions(request, b.projectId), []);

    // A restart restores each project's sessions, directories and Run ownership.
    await dashboard.restart();
    const afterRestart = await sessions(request, a.projectId);
    const restored = afterRestart.find((session) => session.sessionId === sessionOne.sessionId);
    assert.equal(restored.taskId, sessionOne.taskId);
    assert.equal(restored.projectDirectory, a.projectDirectory);
    assert.equal(restored.currentRequirementId, next.requirementId);
    assert.equal(restored.activeRunId, null);
    assert.deepEqual(
      restored.runs.map((run) => run.runId).sort(),
      viewOne.runs.map((run) => run.runId).sort()
    );
    assert.equal(
      afterRestart.find((session) => session.sessionId === sessionTwo.sessionId).taskId,
      sessionTwo.taskId
    );
    assert.deepEqual(await sessions(request, b.projectId), []);

    // A→B→A: project B keeps its own directory and no borrowed history.
    const bRequirement = await requirement(request, b.projectId, "B 项目需求", "只在 B 项目。");
    const bSession = await request(`/api/projects/${encodeURIComponent(b.projectId)}/main-sessions`, {
      action: "create",
      title: "B 会话",
      requirementId: bRequirement.requirementId
    });
    assert.equal(bSession.status, 201, JSON.stringify(bSession.body));
    const bRun = await request(`/api/tasks/${encodeURIComponent(bSession.body.session.taskId)}/run`, {
      prompt: "只处理 B 项目。",
      mainSessionId: bSession.body.session.sessionId,
      requirementId: bRequirement.requirementId
    });
    assert.equal(bRun.status, 202);
    await settle(request, bSession.body.session.taskId, "completed");
    assert.match(userText(local.requests[3]), /只处理 B 项目/);
    assert.doesNotMatch(userText(local.requests[3]), /请完成登录改造|接着做报表导出/);
    const aAgain = await sessions(request, a.projectId);
    assert.equal(aAgain.length, 2);
    assert.ok(aAgain.every((session) => session.projectId === a.projectId));
    const bAgain = await sessions(request, b.projectId);
    assert.equal(bAgain.length, 1);
    assert.equal(bAgain[0].projectDirectory, b.projectDirectory);

    // Continuing A after the switch resumes A's transcript, not B's.
    const runFour = await request(`/api/tasks/${encodeURIComponent(sessionOne.taskId)}/run`, {
      prompt: "回到 A 项目继续。",
      mainSessionId: sessionOne.sessionId,
      requirementId: next.requirementId
    });
    assert.equal(runFour.status, 202, JSON.stringify(runFour.body));
    await settle(request, sessionOne.taskId, "completed");
    assert.match(userText(local.requests[4]), /请完成登录改造/);
    assert.match(userText(local.requests[4]), /回到 A 项目继续/);
    assert.doesNotMatch(userText(local.requests[4]), /只处理 B 项目/);
    // A run posted with a mismatched session never enters the other conversation.
    const sameProject = await request(`/api/tasks/${encodeURIComponent(sessionOne.taskId)}/run`, {
      prompt: "错投到同项目的另一会话。",
      mainSessionId: sessionTwo.sessionId
    });
    assert.equal(sameProject.status, 409, JSON.stringify(sameProject.body));
    assert.match(sameProject.body.error, /不属于当前会话/);
    const otherProject = await request(`/api/tasks/${encodeURIComponent(sessionOne.taskId)}/run`, {
      prompt: "错投到别的项目会话。",
      mainSessionId: bSession.body.session.sessionId
    });
    assert.equal(otherProject.status, 404, JSON.stringify(otherProject.body));
    assert.equal(local.requests.length, 5);
    assert.deepEqual(local.failures, []);
  }
);

test(
  "an old Task history is adopted lazily and continues in its original Pi file",
  { timeout: 120_000 },
  async (t) => {
    const local = await provider(t);
    const dashboard = await startDashboard({
      modelEndpoint: local.base,
      model: "fixture-model",
      defaultProject: false
    });
    t.after(() => dashboard.stop());
    const request = client(dashboard);
    const project = await createProject(request, dashboard, "legacy");

    // A conversation from before this change: a Task with Pi history and no session row.
    const created = await request("/api/tasks", {
      taskId: "legacy-task",
      goal: "升级前的会话",
      projectId: project.projectId
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const directory = sessionDirectory(dashboard, "legacy-task");
    // Pi compares the transcript cwd to the real path; temp roots can be symlinked.
    const history = SessionManager.create(await realpath(project.projectDirectory), directory);
    history.appendMessage({ role: "user", content: "升级前的旧会话内容", timestamp: 1 });
    history.appendMessage({ role: "assistant", content: [{ type: "text", text: "旧回答" }], timestamp: 2 });
    const originalPath = history.getSessionFile();
    // Pi defers its first file until an assistant response; write the transcript
    // the way the launcher does so this really is history from before the change.
    await writeFile(
      originalPath,
      [history.getHeader(), ...history.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      { mode: 0o600 }
    );
    const originalHeader = history.getHeader();

    const listed = await sessions(request, project.projectId);
    assert.equal(listed.length, 1);
    const adopted = listed[0];
    assert.equal(adopted.taskId, "legacy-task");
    assert.equal(adopted.entryKind, "internal");
    assert.equal(adopted.kind, "regular");
    assert.equal(adopted.local, true);
    assert.equal(adopted.title, "升级前的会话");
    // Adoption reads the old rows; it does not rewrite the Task snapshot.
    assert.equal(
      JSON.parse(await readFile(join(dashboard.workspaceRoot, "legacy-task", "task.json"), "utf8")).goal,
      "升级前的会话"
    );

    const run = await request("/api/tasks/legacy-task/run", {
      prompt: "继续升级前的会话。",
      mainSessionId: adopted.sessionId
    });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    await settle(request, "legacy-task", "completed");
    assert.equal(local.requests.length, 1);
    // The new turn saw the history that was already there.
    assert.match(userText(local.requests[0]), /升级前的旧会话内容/);
    assert.match(userText(local.requests[0]), /继续升级前的会话/);
    // It also continued the same transcript rather than forking a new directory.
    const files = (await transcriptFiles(directory)).filter((name) => name.endsWith(".jsonl"));
    assert.deepEqual(files, [originalPath.split("/").at(-1)]);
    const resumed = SessionManager.open(originalPath, directory);
    assert.equal(resumed.getHeader().id, originalHeader.id);
    assert.equal(resumed.getHeader().cwd, originalHeader.cwd);
    assert.ok(resumed.getBranch().some((entry) => entry.type === "message" && entry.message.role === "user"));

    // The adopted session is a normal one afterwards: its Run is owned and listed.
    const after = await sessions(request, project.projectId);
    assert.equal(after.length, 1);
    assert.deepEqual(
      after[0].runs.map((entry) => entry.runId),
      [run.body.runId]
    );
    assert.equal(after[0].activeRunId, null);
    assert.deepEqual(local.failures, []);
  }
);

/**
 * The session store is shared fact too, so its contract runs on the engine the
 * project actually opened. This half only proves persistence, scope and the
 * backup boundary; the Pi transcript above is local and never moves.
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

async function openService(fixture, engine, info) {
  const config =
    engine === "sqlite"
      ? { sqlite: { path: info.target } }
      : { engine, postgres: { connectionString: postgres.connectionString } };
  const runtime = new ProjectDataRuntime({
    config,
    configPath: join(fixture.root, "config.json"),
    dataRoot: fixture.root,
    env: {}
  });
  return { service: await runtime.service(), close: () => runtime.close() };
}

for (const engine of PROJECT_DATA_ENGINES) {
  test(`${engine}: Main session records stay project-scoped and survive restart and restore`, async (t) => {
    const f = await startProjectDataDashboard(t, engine, { postgres });
    const request = client(f);
    const a = await createProject(request, f, `scope-${engine}`);
    const b = await createProject(request, f, `other-${engine}`);
    const info = await request("/api/project-data");
    assert.equal(info.status, 200);
    assert.equal(info.body.schemaVersion, 5);
    const opened = await openService(f, engine, info.body);
    t.after(() => opened.close());

    // The HTTP project catalog is local; the shared row is written when a
    // backend first uses the project's shared data.
    for (const project of [a, b])
      await opened.service.ensureProject({
        projectId: project.projectId,
        projectName: project.projectName,
        projectDirectory: project.projectDirectory,
        backendId: "backend_fixture"
      });
    const requirement = await opened.service.createRequirement(a.projectId, {
      title: "共享需求",
      content: "两种引擎都一样。"
    });
    const created = await opened.service.createMainSession(a.projectId, {
      title: "外部接续会话",
      entryKind: "external",
      kind: "continuation",
      backendId: "backend_fixture",
      taskId: "task-shared",
      requirementId: requirement.requirementId
    });
    assert.equal(created.session.entryKind, "external");
    assert.equal(created.session.kind, "continuation");
    assert.equal(created.session.currentRequirementId, requirement.requirementId);
    assert.equal(created.currentRequirementTitle, "共享需求");

    const recorded = await opened.service.recordMainSessionRun(a.projectId, created.session.sessionId, {
      runId: "run-shared",
      taskId: "task-shared",
      requirementId: requirement.requirementId
    });
    assert.equal(recorded.state, "running");
    assert.equal(
      await opened.service.settleMainSessionRun(a.projectId, "task-shared", "run-shared", "completed"),
      1
    );
    const listed = await opened.service.listMainSessions(a.projectId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].runs[0].state, "completed");
    assert.deepEqual(await opened.service.listMainSessions(b.projectId), []);
    // A run cannot be attached to another project's history container.
    await assert.rejects(
      opened.service.recordMainSessionRun(a.projectId, created.session.sessionId, {
        runId: "run-wrong",
        taskId: "task-elsewhere"
      }),
      /不属于该会话/
    );

    // The snapshot carries the board and session tables in foreign-key order.
    const entry = await opened.service.publishBoardEntry(
      a.projectId,
      {
        title: "共享看板需求",
        content: "看板与会话一起备份。",
        source: { kind: "external", reference: "fixture" },
        requestId: "publish-main-sessions"
      },
      { backendId: "backend_fixture", actor: { id: "host", host: true } }
    );
    assert.equal(entry.state, "pending");
    const boardEvents = await opened.service.boardEvents(a.projectId, entry.boardId);
    assert.equal(boardEvents.length, 1);
    const backupPath = join(f.root, `main-sessions-${engine}.json`);
    const backup = await opened.service.backupTo(backupPath);
    assert.equal(backup.counts.project_data_main_sessions, 1);
    assert.equal(backup.counts.project_data_main_session_runs, 1);
    assert.equal(backup.counts.project_data_board_entries, 1);
    assert.equal(backup.counts.project_data_board_events, 1);
    await opened.service.createMainSession(a.projectId, {
      title: "备份后新增",
      backendId: "backend_fixture",
      taskId: "task-after-backup"
    });
    assert.equal((await opened.service.listMainSessions(a.projectId)).length, 2);
    const restored = await opened.service.restoreFrom(backupPath);
    assert.equal(restored.counts.project_data_main_sessions, 1);
    assert.equal(restored.counts.project_data_board_entries, 1);
    const afterRestore = await opened.service.listMainSessions(a.projectId);
    assert.equal(afterRestore.length, 1);
    assert.equal(afterRestore[0].runs[0].runId, "run-shared");
    // The board projection comes back with its session and ledger rows.
    assert.deepEqual(
      (await opened.service.boardEntries(a.projectId)).map((item) => [item.boardId, item.state]),
      [[entry.boardId, "pending"]]
    );
    assert.equal((await opened.service.boardEvents(a.projectId, entry.boardId)).length, 1);

    // A format-2 snapshot without the session tables is refused explicitly and
    // changes nothing, so an older backup cannot silently drop sessions.
    const partial = JSON.parse(await readFile(backupPath, "utf8"));
    delete partial.tables.project_data_main_sessions;
    const partialPath = join(f.root, `main-sessions-partial-${engine}.json`);
    await writeFile(partialPath, JSON.stringify(partial));
    await assert.rejects(opened.service.restoreFrom(partialPath), /备份文件格式不完整/);
    assert.equal((await opened.service.listMainSessions(a.projectId)).length, 1);

    // A restart reads the session back from the engine through the HTTP view.
    await f.restart();
    const views = (await request(`/api/projects/${encodeURIComponent(a.projectId)}/main-sessions`)).body
      .sessions;
    assert.equal(views.length, 1);
    assert.equal(views[0].sessionId, created.session.sessionId);
    assert.equal(views[0].title, "外部接续会话");
    assert.equal(views[0].currentRequirementTitle, "共享需求");
    // This backend does not hold the fixture's history container, so it is remote.
    assert.equal(views[0].local, false);
    assert.deepEqual(
      (await request(`/api/projects/${encodeURIComponent(b.projectId)}/main-sessions`)).body.sessions,
      []
    );
  });
}

/**
 * The three shipped versions apply in their own order. A database built from a
 * branch that had v1+v3 must still receive v2; a v2 database must receive v3
 * without losing its board or ledger rows.
 */
async function legacyDatabase(t, versions) {
  const directory = await mkdtemp(join(tmpdir(), "coworkos-main-sessions-upgrade-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "project-data.sqlite");
  const database = await SqliteDatabase.open(path);
  await database.execute(
    "CREATE TABLE project_data_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  for (const version of versions) {
    const migration = PROJECT_DATA_MIGRATIONS.find((entry) => entry.version === version);
    assert.ok(migration, `migration v${version} exists`);
    for (const statement of migration.statements) await database.execute(statement);
    await database.execute("INSERT INTO project_data_migrations (version, applied_at) VALUES (?, ?)", [
      version,
      "2026-01-01T00:00:00.000Z"
    ]);
  }
  await database.execute(
    "INSERT INTO project_data_projects (project_id, project_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ["project_upgrade", "旧项目", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]
  );
  await database.execute(
    `INSERT INTO project_data_requirements
       (project_id, requirement_id, title, content, source_kind, source_reference, status, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "project_upgrade",
      "requirement_upgrade",
      "旧需求",
      "升级不能丢。",
      "internal",
      null,
      "open",
      1,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    ]
  );
  return { directory, path, database };
}

test("a v2 database upgrades to v3 and keeps its board and ledger records", async (t) => {
  const database = await legacyDatabase(t, [1, 2]);
  // Board data written under v2 survives the v3 upgrade.
  await database.database.execute(
    `INSERT INTO project_data_board_entries
       (project_id, board_id, requirement_id, entry_kind, state, revision, backend_id, publish_request_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "project_upgrade",
      "board_legacy",
      "requirement_upgrade",
      "external",
      "pending",
      1,
      "backend_legacy",
      "publish_legacy",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    ]
  );
  await database.database.close();
  const runtime = new ProjectDataRuntime({
    config: { sqlite: { path: database.path } },
    env: {},
    configPath: join(database.directory, "config.json"),
    dataRoot: database.directory,
    backendId: "backend_upgrade"
  });
  const service = await runtime.service();
  t.after(() => runtime.close());
  assert.equal(service.description.schemaVersion, 5);
  assert.deepEqual(
    (await service.queryRequirements("project_upgrade")).map((requirement) => requirement.title),
    ["旧需求"]
  );
  assert.deepEqual(
    (await service.boardEntries("project_upgrade")).map((board) => board.boardId),
    ["board_legacy"]
  );
  // v3 tables exist and are usable after the upgrade.
  const session = await service.createMainSession("project_upgrade", {
    title: "升级后的会话",
    backendId: "backend_upgrade",
    taskId: "task-upgrade"
  });
  assert.deepEqual(
    (await service.listMainSessions("project_upgrade")).map((record) => record.session.sessionId),
    [session.session.sessionId]
  );
});

test("a v1+v3 database applies the missing v2 instead of skipping it", async (t) => {
  const database = await legacyDatabase(t, [1, 3]);
  await database.database.execute(
    `INSERT INTO project_data_main_sessions
       (project_id, session_id, title, entry_kind, kind, backend_id, task_id, current_requirement_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "project_upgrade",
      "session_legacy",
      "分支上的会话",
      "internal",
      "regular",
      "backend_legacy",
      "task_legacy",
      "requirement_upgrade",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    ]
  );
  await database.database.close();
  const runtime = new ProjectDataRuntime({
    config: { sqlite: { path: database.path } },
    env: {},
    configPath: join(database.directory, "config.json"),
    dataRoot: database.directory,
    backendId: "backend_upgrade"
  });
  const service = await runtime.service();
  t.after(() => runtime.close());
  assert.equal(service.description.schemaVersion, 5);
  const sessions = await service.listMainSessions("project_upgrade");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].session.sessionId, "session_legacy");
  assert.equal(sessions[0].currentRequirementTitle, "旧需求");
  // v2 is applied even though a higher version was already recorded.
  const published = await service.publishBoardEntry(
    "project_upgrade",
    {
      title: "补做的看板需求",
      content: "v2 表在 v3 之后补齐。",
      source: { kind: "external", reference: "升级验证" },
      requestId: "publish-late-v2"
    },
    { backendId: "backend_upgrade", actor: { id: "host", host: true } }
  );
  assert.equal(published.state, "pending");
  // Publishing the board need adds its own requirement; the old one stays.
  assert.deepEqual(
    (await service.queryRequirements("project_upgrade")).map((requirement) => requirement.title).sort(),
    ["旧需求", "补做的看板需求"].sort()
  );
});
