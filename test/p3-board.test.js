import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { before, after, test } from "node:test";
import { startDashboard } from "./dashboard-fixture.mjs";
import {
  PROJECT_DATA_ENGINES,
  startPostgresProjectDatabase,
  startProjectDataDashboard
} from "./p3-storage-fixture.mjs";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";
import { SqliteDatabase } from "../dist/src/storage/project-data/sqlite-database.js";
import { PROJECT_DATA_MIGRATIONS } from "../dist/src/storage/project-data/migrations.js";

/**
 * The board contract on both real engines.
 *
 * One backend owns the authority (its SQLite file or a disposable PostgreSQL),
 * a second one has its own data root and reaches the same facts through the
 * authenticated client. Nothing is faked in memory: every read goes back
 * through the authority's database, and a restart has to survive on disk.
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

async function createProject(fixture, name, projectId) {
  const directory = join(fixture.root, `project-${name}`);
  await mkdir(directory, { recursive: true });
  const response = await fixture.request("/api/projects", {
    projectName: `项目 ${name}`,
    projectDirectory: directory,
    ...(projectId ? { projectId } : {})
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.project;
}

async function secondaryBackend(t, authority) {
  const instance = await readBackendInstance(backendPaths(join(authority.root, "home")));
  assert.ok(instance.value?.token, "the authority published its local credential");
  const dashboard = await startDashboard({
    defaultProject: false,
    config: {
      projectData: { authority: { url: authority.base, token: instance.value.token } }
    }
  });
  t.after(() => dashboard.stop());
  return { ...dashboard, request: requestFor(dashboard), authorityToken: instance.value.token };
}

function requestFor(dashboard) {
  return async (path, body, method = "POST", headers = {}) => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };
}

const board = (_fixture, projectId) => `/api/projects/${encodeURIComponent(projectId)}/board`;
const ledger = (_fixture, projectId) => `/api/projects/${encodeURIComponent(projectId)}/ledger`;

async function publish(fixture, projectId, requestId, overrides = {}) {
  return fixture.request(board(fixture, projectId), {
    action: "publish",
    requestId,
    title: "共享看板需求",
    content: "两个后端看到同一条待认领需求。",
    source: { kind: "external", reference: "控制入口" },
    ...overrides
  });
}

async function action(fixture, projectId, input) {
  return fixture.request(board(fixture, projectId), input);
}

for (const engine of PROJECT_DATA_ENGINES) {
  test(`${engine}: two data roots share one ledger and board through the authority`, async (t) => {
    const authority = await startProjectDataDashboard(t, engine, { postgres });
    const project = await createProject(authority, `shared-${engine}`);
    const backend = await secondaryBackend(t, authority);
    const secondaryProject = await createProject(backend, `secondary-${engine}`, project.projectId);
    assert.equal(secondaryProject.projectId, project.projectId, "the shared project id is reused");

    // Shared ledger: an internal need written through one backend is readable
    // through the other, and it stays out of the board.
    const internal = await authority.request(ledger(authority, project.projectId), {
      action: "create",
      title: "内部需求",
      content: "内部新工作只写入台账。",
      source: { kind: "internal" }
    });
    assert.equal(internal.status, 201, JSON.stringify(internal.body));
    const sharedRead = await backend.request(ledger(backend, project.projectId), { action: "query" });
    assert.equal(sharedRead.status, 200, JSON.stringify(sharedRead.body));
    assert.deepEqual(
      sharedRead.body.requirements.map((requirement) => requirement.title),
      ["内部需求"]
    );
    assert.deepEqual(
      (await authority.request(board(authority, project.projectId), undefined, "GET")).body.entries,
      []
    );
    assert.deepEqual(
      (await backend.request(board(backend, project.projectId), undefined, "GET")).body.entries,
      []
    );

    // A controlled external entry publishes the requirement and its board item
    // together. The secondary backend sees the same board through the API.
    const published = await publish(backend, project.projectId, "publish-shared");
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const entry = published.body.entry;
    assert.equal(entry.state, "pending");
    assert.equal(entry.revision, 1);
    assert.equal(entry.entryKind, "external");
    assert.equal(entry.source.kind, "external");
    assert.ok(!("projectDirectory" in entry), "a board item carries no execution directory");
    const seenByAuthority = await authority.request(board(authority, project.projectId), undefined, "GET");
    assert.deepEqual(seenByAuthority.body.entries, [entry], "both backends see the same board item");

    // Replaying the publish request returns the committed item and appends nothing.
    const replayPublish = await publish(backend, project.projectId, "publish-shared");
    assert.equal(replayPublish.status, 201, JSON.stringify(replayPublish.body));
    assert.equal(replayPublish.body.entry.boardId, entry.boardId);
    assert.equal(replayPublish.body.entry.requirementId, entry.requirementId);
    const requirements = await backend.request(ledger(backend, project.projectId), { action: "query" });
    assert.equal(requirements.body.requirements.length, 2, "the replayed publish made no second requirement");

    // Two backends claim at the same revision: exactly one wins, the other gets
    // a locatable conflict and sees the winner's ownership.
    const claims = await Promise.all([
      action(authority, project.projectId, {
        action: "claim",
        boardId: entry.boardId,
        expectedRevision: 1,
        requestId: "claim-authority"
      }),
      action(backend, project.projectId, {
        action: "claim",
        boardId: entry.boardId,
        expectedRevision: 1,
        requestId: "claim-secondary"
      })
    ]);
    const winners = claims.filter((claim) => claim.status === 200);
    const losers = claims.filter((claim) => claim.status === 409);
    assert.equal(winners.length, 1, JSON.stringify(claims));
    assert.equal(losers.length, 1, JSON.stringify(claims));
    assert.equal(losers[0].body.code, "revision_conflict");
    assert.equal(losers[0].body.currentRevision, 2);
    const winnerIndex = claims.indexOf(winners[0]);
    const winner = winnerIndex === 0 ? authority : backend;
    const loser = winnerIndex === 0 ? backend : authority;
    const claimed = winners[0].body.entry;
    assert.equal(claimed.state, "claimed");
    assert.equal(claimed.revision, 2);
    assert.equal(claimed.assignment.kind, "user");
    const bothSeeClaim = await Promise.all([
      authority.request(board(authority, project.projectId), undefined, "GET"),
      backend.request(board(backend, project.projectId), undefined, "GET")
    ]);
    assert.deepEqual(bothSeeClaim[0].body.entries, bothSeeClaim[1].body.entries);
    assert.equal(bothSeeClaim[0].body.entries[0].assignment.actorId, claimed.assignment.actorId);

    // A replayed claim returns the committed result without a second event.
    const winningRequest = winnerIndex === 0 ? "claim-authority" : "claim-secondary";
    const claimReplay = await action(winner, project.projectId, {
      action: "claim",
      boardId: entry.boardId,
      expectedRevision: 1,
      requestId: winningRequest
    });
    assert.equal(claimReplay.status, 200, JSON.stringify(claimReplay.body));
    assert.equal(claimReplay.body.entry.revision, 2);
    const history = await authority.request(
      `${board(authority, project.projectId)}/${encodeURIComponent(entry.boardId)}`,
      undefined,
      "GET"
    );
    assert.deepEqual(
      history.body.events.map((event) => event.kind),
      ["published", "claimed"],
      "a replay appended no event"
    );

    // Pause keeps the owner. A different actor cannot take it, and only the
    // owner (or the serving host) can release it back to the pending pool.
    const paused = await action(winner, project.projectId, {
      action: "pause",
      boardId: entry.boardId,
      expectedRevision: 2,
      requestId: "pause-owner"
    });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    assert.equal(paused.body.entry.state, "paused");
    assert.equal(paused.body.entry.assignment.actorId, claimed.assignment.actorId, "pause keeps the owner");
    const claimWhilePaused = await action(loser, project.projectId, {
      action: "claim",
      boardId: entry.boardId,
      expectedRevision: 3,
      requestId: "claim-paused"
    });
    assert.equal(claimWhilePaused.status, 409);
    assert.equal(claimWhilePaused.body.code, "board_state_conflict");
    const released = await action(winner, project.projectId, {
      action: "release",
      boardId: entry.boardId,
      expectedRevision: 3,
      requestId: "release-owner"
    });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal(released.body.entry.state, "pending");
    assert.ok(!("assignment" in released.body.entry), "release clears ownership");
    const reclaimed = await action(loser, project.projectId, {
      action: "claim",
      boardId: entry.boardId,
      expectedRevision: 4,
      requestId: "claim-after-release"
    });
    assert.equal(reclaimed.status, 200, JSON.stringify(reclaimed.body));
    const cancelled = await action(loser, project.projectId, {
      action: "cancel",
      boardId: entry.boardId,
      expectedRevision: 5,
      requestId: "cancel-owner"
    });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.entry.state, "cancelled");
    const cancelledEverywhere = await Promise.all([
      authority.request(board(authority, project.projectId), undefined, "GET"),
      backend.request(board(backend, project.projectId), undefined, "GET")
    ]);
    assert.equal(cancelledEverywhere[0].body.entries[0].state, "cancelled");
    assert.deepEqual(cancelledEverywhere[0].body.entries, cancelledEverywhere[1].body.entries);

    // A Main claims through its Task binding. Both backends read the same
    // handler identity (backend, project, Task) — never a directory.
    const mainEntry = (await publish(authority, project.projectId, "publish-main")).body.entry;
    const task = await authority.request("/api/tasks", {
      taskId: "task-main",
      goal: "处理看板需求",
      projectId: project.projectId
    });
    assert.equal(task.status, 201, JSON.stringify(task.body));
    const mainClaim = await authority.request(`/api/tasks/task-main/board`, {
      action: "claim",
      boardId: mainEntry.boardId,
      expectedRevision: 1,
      requestId: "claim-main"
    });
    assert.equal(mainClaim.status, 200, JSON.stringify(mainClaim.body));
    const handler = mainClaim.body.entry.assignment.handler;
    assert.deepEqual(Object.keys(handler).sort(), ["backendId", "projectId", "taskId"]);
    assert.equal(handler.projectId, project.projectId);
    assert.equal(handler.taskId, "task-main");
    assert.equal(mainClaim.body.entry.assignment.kind, "main");
    const handlerSeenBySecondary = await backend.request(
      `${board(backend, project.projectId)}/${encodeURIComponent(mainEntry.boardId)}`,
      undefined,
      "GET"
    );
    assert.deepEqual(handlerSeenBySecondary.body.entry.assignment, mainClaim.body.entry.assignment);

    // A different authenticated actor may not release someone else's claim.
    const authzEntry = (await publish(authority, project.projectId, "publish-authz")).body.entry;
    const firstSession = await authority.request("/api/session", {
      clientName: "board-claimer",
      protocolVersion: "1.0"
    });
    assert.equal(firstSession.status, 201, JSON.stringify(firstSession.body));
    const sessionToken = firstSession.body.session.token;
    const sessionClaim = await authority.request(
      board(authority, project.projectId),
      {
        action: "claim",
        boardId: authzEntry.boardId,
        expectedRevision: 1,
        requestId: "claim-session"
      },
      "POST",
      { "x-atria-token": sessionToken }
    );
    assert.equal(sessionClaim.status, 200, JSON.stringify(sessionClaim.body));
    const foreignRelease = await backend.request(board(backend, project.projectId), {
      action: "release",
      boardId: authzEntry.boardId,
      expectedRevision: 2,
      requestId: "release-foreign"
    });
    assert.equal(foreignRelease.status, 403);
    assert.equal(foreignRelease.body.code, "board_assignee_required");
    const ownerRelease = await authority.request(
      board(authority, project.projectId),
      {
        action: "release",
        boardId: authzEntry.boardId,
        expectedRevision: 2,
        requestId: "release-session"
      },
      "POST",
      { "x-atria-token": sessionToken }
    );
    assert.equal(ownerRelease.status, 200, JSON.stringify(ownerRelease.body));
    assert.equal(ownerRelease.body.entry.state, "pending");

    // An external absolute path is an opaque source label, never this host's
    // execution directory: each backend keeps its own catalog binding.
    const remotePath = "/srv/another-host/repository";
    const opaque = await publish(backend, project.projectId, "publish-path", {
      title: "来自另一台机器的需求",
      content: "入口只给出一个不透明的绝对路径。",
      source: { kind: "external", reference: remotePath },
      projectDirectory: remotePath
    });
    assert.equal(opaque.status, 201, JSON.stringify(opaque.body));
    assert.equal(opaque.body.entry.source.reference, remotePath);
    const catalog = await backend.request("/api/tasks", undefined, "GET");
    const localProject = catalog.body.projects.find((item) => item.projectId === project.projectId);
    assert.equal(
      localProject.projectDirectory,
      secondaryProject.projectDirectory,
      "the local catalog owns execution paths"
    );
    const authorityCatalog = await authority.request("/api/tasks", undefined, "GET");
    const authorityProject = authorityCatalog.body.projects.find(
      (item) => item.projectId === project.projectId
    );
    assert.equal(authorityProject.projectDirectory, project.projectDirectory);

    // Offline: a stopped authority is reported as unavailable, the caller does
    // not pretend a claim succeeded, and the committed ownership is unchanged.
    const offlineEntry = (await publish(authority, project.projectId, "publish-offline")).body.entry;
    const stopped = once(authority.child, "exit");
    authority.child.kill("SIGTERM");
    await stopped;
    const offlineRead = await backend.request(board(backend, project.projectId), undefined, "GET");
    assert.equal(offlineRead.status, 503, JSON.stringify(offlineRead.body));
    assert.equal(offlineRead.body.code, "storage_unavailable");
    const offlineClaim = await action(backend, project.projectId, {
      action: "claim",
      boardId: offlineEntry.boardId,
      expectedRevision: 1,
      requestId: "claim-offline"
    });
    assert.equal(offlineClaim.status, 503, JSON.stringify(offlineClaim.body));
    await authority.restart();
    const afterRestart = await backend.request(board(backend, project.projectId), undefined, "GET");
    assert.equal(afterRestart.status, 200, JSON.stringify(afterRestart.body));
    const stillPending = afterRestart.body.entries.find((item) => item.boardId === offlineEntry.boardId);
    assert.equal(stillPending.state, "pending", "a failed offline claim changed nothing");
    assert.ok(!("assignment" in stillPending));

    // Revoked authentication is reported, never retried with the host credential
    // and never transferred to another owner.
    const sessions = await authority.request("/api/session", undefined, "GET", {
      "x-atria-token": backend.authorityToken
    });
    const clientSession = sessions.body.sessions.find(
      (session) => session.clientName === "project-data-client"
    );
    assert.ok(clientSession, "the secondary backend authorized one scoped session");
    const revoked = await authority.request(
      `/api/session/${encodeURIComponent(clientSession.sessionId)}`,
      undefined,
      "DELETE",
      { "x-atria-token": backend.authorityToken }
    );
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    const revokedRead = await backend.request(board(backend, project.projectId), undefined, "GET");
    assert.equal(revokedRead.status, 401, JSON.stringify(revokedRead.body));
    assert.equal(revokedRead.body.code, "shared_auth_failed");
    const revokedClaim = await action(backend, project.projectId, {
      action: "claim",
      boardId: offlineEntry.boardId,
      expectedRevision: 1,
      requestId: "claim-revoked"
    });
    assert.equal(revokedClaim.status, 401, JSON.stringify(revokedClaim.body));
    const unchanged = await authority.request(board(authority, project.projectId), undefined, "GET");
    const stillUnowned = unchanged.body.entries.find((item) => item.boardId === offlineEntry.boardId);
    assert.equal(stillUnowned.state, "pending");
    assert.ok(!("assignment" in stillUnowned), "revocation did not transfer ownership");
    const retainedClaim = unchanged.body.entries.find((item) => item.boardId === mainEntry.boardId);
    assert.equal(retainedClaim.state, "claimed", "an existing claim survives the secondary backend's outage");
    assert.deepEqual(retainedClaim.assignment, mainClaim.body.entry.assignment);

    // The remote view reports the authority's engine but no credential.
    const remoteInfo = await backend.request("/api/project-data", undefined, "GET");
    assert.equal(remoteInfo.status, 200);
    assert.equal(remoteInfo.body.engine, engine);
    assert.equal(remoteInfo.body.target, authority.base);
    assert.ok(!JSON.stringify(remoteInfo.body).includes(backend.authorityToken));
  });
}

test("a v1 project database upgrades in place and keeps its ledger", async (t) => {
  const directory = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join("/tmp", "coworkos-board-upgrade-"))
  );
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const path = join(directory, "project-data.sqlite");
  const database = await SqliteDatabase.open(path);
  await database.execute(
    "CREATE TABLE project_data_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  for (const statement of PROJECT_DATA_MIGRATIONS[0].statements) await database.execute(statement);
  await database.execute("INSERT INTO project_data_migrations (version, applied_at) VALUES (1, ?)", [
    "2026-01-01T00:00:00.000Z"
  ]);
  await database.execute(
    "INSERT INTO project_data_projects (project_id, project_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ["project_legacy", "旧项目", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]
  );
  await database.execute(
    `INSERT INTO project_data_requirements
       (project_id, requirement_id, title, content, source_kind, source_reference, status, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "project_legacy",
      "requirement_legacy",
      "旧需求",
      "v1 数据不能丢。",
      "internal",
      null,
      "open",
      1,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    ]
  );
  await database.close();

  const runtime = new ProjectDataRuntime({
    config: { sqlite: { path } },
    env: {},
    configPath: join(directory, "config.json"),
    dataRoot: directory
  });
  const service = await runtime.service();
  t.after(() => runtime.close());
  // v1 and v2 keep their meaning; v3 adds project Main sessions and v4 adds
  // development records. Each missing version is applied on its own, so the
  // final schema is the latest one.
  assert.equal(service.description.schemaVersion, 7);
  const requirements = await service.queryRequirements("project_legacy");
  assert.deepEqual(
    requirements.map((requirement) => requirement.title),
    ["旧需求"]
  );
  assert.deepEqual(await service.boardEntries("project_legacy"), []);
  const entry = await service.publishBoardEntry(
    "project_legacy",
    {
      title: "升级后的看板需求",
      content: "v2 表在同一个数据库里可用。",
      source: { kind: "external", reference: "升级验证" },
      requestId: "publish-upgrade"
    },
    { backendId: "backend_upgrade", actor: { id: "host", host: true } }
  );
  assert.equal(entry.state, "pending");
  // The same upgrade makes the session tables available without touching v1.
  const session = await service.createMainSession("project_legacy", {
    title: "升级后的会话",
    backendId: "backend_upgrade",
    taskId: "task-upgrade"
  });
  assert.equal(session.session.title, "升级后的会话");
  assert.deepEqual(
    (await service.listMainSessions("project_legacy")).map((record) => record.session.sessionId),
    [session.session.sessionId]
  );
});
