import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import pg from "pg";
import {
  PROJECT_DATA_ENGINES,
  startPostgresProjectDatabase,
  startProjectDataDashboard
} from "./p3-storage-fixture.mjs";
import { startDashboard } from "./dashboard-fixture.mjs";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";
import { RemoteProjectDataService } from "../dist/src/workspace/project-data-remote.js";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";
import { createProjectDevelopmentService } from "../dist/src/dashboard/project-development-service.js";
import { ProjectDataUnavailableError } from "../dist/src/domain/project-ledger.js";
import { PROJECT_DATA_MIGRATIONS } from "../dist/src/storage/project-data/migrations.js";
import { PostgresDatabase } from "../dist/src/storage/project-data/postgres-database.js";
import { SqliteDatabase } from "../dist/src/storage/project-data/sqlite-database.js";

const run = promisify(execFile);
const git = (cwd, args) =>
  run("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((result) => result.stdout.trim());

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

async function makeRepository(directory) {
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.email", "fixture@example.test"]);
  await git(directory, ["config", "user.name", "Fixture"]);
  await writeFile(join(directory, "baseline.txt"), "baseline\n");
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "baseline"]);
  return directory;
}

async function commitFile(directory, name, content) {
  await writeFile(join(directory, name), content);
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", content]);
  return git(directory, ["rev-parse", "HEAD"]);
}

async function openAuthority(engine, dashboard) {
  const info = await fetch(`${dashboard.base}/api/project-data`).then((response) => response.json());
  const config =
    engine === "sqlite"
      ? { sqlite: { path: info.target } }
      : { engine, postgres: { connectionString: postgres.connectionString } };
  const authority = new ProjectDataRuntime({
    config,
    configPath: join(dashboard.root, "config.json"),
    dataRoot: dashboard.root,
    env: {}
  });
  return { gateway: await authority.service(), close: () => authority.close() };
}

const client = (dashboard) => async (path, body, method) => {
  const response = await fetch(`${dashboard.base}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
};

const projectPath = (projectId, suffix) => `/api/projects/${encodeURIComponent(projectId)}${suffix}`;

const waitFor = async (check, message, timeout = 20_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(message);
};

async function servingInstance(root) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const instance = await readBackendInstance(backendPaths(join(root, "home")));
    if (instance.value?.token && instance.value.backendId) return instance.value;
    await delay(25);
  }
  assert.fail("the backend did not publish its local credential");
}

/**
 * A real HTTP partition in front of the authority.
 *
 * It forwards every request unchanged until the execution host tries to record
 * the target update as merged; then it fails like an unreachable service until
 * the test restores it. Only delivery/merge requests are counted, so the
 * shutdown check can tell whether this host's recovery task is still working.
 */
async function startPartitionProxy(target) {
  let failing = false;
  let triggerMergedUpdate = true;
  let mergeRequests = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = request.url ?? "/";
    let payload = {};
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      /* not JSON */
    }
    if (
      !failing &&
      triggerMergedUpdate &&
      request.method === "POST" &&
      /\/merges$/.test(url) &&
      payload.action === "update" &&
      payload.state === "merged"
    ) {
      triggerMergedUpdate = false;
      failing = true;
    }
    if (/\/(?:merges|deliveries)(?:\/|$)/.test(url)) mergeRequests += 1;
    if (failing) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: "fixture: shared service unreachable", code: "storage_unavailable" })
      );
      return;
    }
    const headers = { ...request.headers };
    delete headers.host;
    delete headers.connection;
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    const upstream = await fetch(`${target}${url}`, {
      method: request.method,
      headers,
      ...(body.length ? { body } : {})
    });
    const result = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json"
    });
    response.end(result);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    setFailing(value) {
      failing = value;
    },
    rearm() {
      triggerMergedUpdate = true;
    },
    mergeRequests: () => mergeRequests,
    close: () => new Promise((done) => server.close(() => done()))
  };
}

function serviceFor({ gateway, backendId, startedAt, root, project }) {
  return createProjectDevelopmentService({
    runtime: { service: async () => gateway },
    backendId,
    startedAt,
    developmentRoot: join(root, "development-workspaces"),
    deliveryRoot: join(root, "delivery-sync"),
    project: async (projectId) =>
      projectId === project.projectId
        ? {
            projectId: project.projectId,
            projectName: project.projectName,
            projectDirectory: project.projectDirectory
          }
        : undefined,
    taskProject: async () => undefined
  });
}

/** The local pending-sync fact for one published merge, or undefined. */
async function outboxEntries(root) {
  let files;
  try {
    files = await readdir(join(root, "delivery-sync"));
  } catch {
    return [];
  }
  const entries = [];
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const parsed = JSON.parse(await readFile(join(root, "delivery-sync", file), "utf8"));
    entries.push(...(parsed.entries ?? []));
  }
  return entries;
}

for (const engine of PROJECT_DATA_ENGINES) {
  test(
    `${engine}: a real merge records delivery in the ledger and pending release on the board`,
    { timeout: 240_000 },
    async (t) => {
      const dashboard = await startProjectDataDashboard(t, engine, { postgres });
      const repository = await makeRepository(join(dashboard.root, "repository"));
      const created = await dashboard.request("/api/projects", {
        projectName: "交付项目",
        projectDirectory: repository
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const project = created.body.project;
      const instance = await readBackendInstance(backendPaths(join(dashboard.root, "home")));
      assert.ok(instance.value?.token && instance.value.backendId);
      const authority = await openAuthority(engine, dashboard);
      t.after(() => authority.close());
      const request = client(dashboard);
      const service = serviceFor({
        gateway: authority.gateway,
        backendId: instance.value.backendId,
        startedAt: "started-main",
        root: dashboard.root,
        project
      });
      const configured = await service.setMergeConfig(project.projectId, {
        repository,
        targetBranch: "main"
      });
      assert.equal(configured.executionBackendId, instance.value.backendId);

      // One demand comes from the shared board and is claimed by a Main; the
      // other is recorded internally and must never create a board item.
      const published = await request(projectPath(project.projectId, "/board"), {
        action: "publish",
        requestId: "publish-delivery-board",
        title: "看板交付需求",
        content: "来自外部渠道，需要关联实际合入。",
        source: { kind: "external", reference: "客户渠道" }
      });
      assert.equal(published.status, 201, JSON.stringify(published.body));
      const boardId = published.body.entry.boardId;
      const boardRequirementId = published.body.entry.requirementId;
      const session = await request(projectPath(project.projectId, "/main-sessions"), {
        action: "create",
        title: "看板交付会话",
        requirementId: boardRequirementId
      });
      assert.equal(session.status, 201, JSON.stringify(session.body));
      const boardTaskId = session.body.session.taskId;
      const claimed = await request(projectPath(project.projectId, "/board"), {
        action: "claim",
        boardId,
        expectedRevision: published.body.entry.revision,
        requestId: "claim-delivery-board",
        handler: {
          backendId: instance.value.backendId,
          projectId: project.projectId,
          taskId: boardTaskId
        }
      });
      assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
      assert.equal(claimed.body.entry.state, "claimed");
      const internal = await request(projectPath(project.projectId, "/ledger"), {
        action: "create",
        title: "内部交付需求",
        content: "内部直接提出，只写台账。"
      });
      assert.equal(internal.status, 201, JSON.stringify(internal.body));
      const internalRequirementId = internal.body.requirement.requirementId;

      const develop = async (requirementId, title) =>
        service.create(project.projectId, {
          requirementId,
          goal: title,
          completionCriteria: ["observable result"],
          route: "quick"
        });
      const boardDevelopment = await develop(boardRequirementId, "看板交付");
      const internalDevelopment = await develop(internalRequirementId, "内部交付");
      assert.equal(boardDevelopment.workspace.state, "ready");
      assert.equal(internalDevelopment.workspace.state, "ready");

      // Before the real merge nothing is delivered: the ledger is open, the
      // board keeps its claim and no delivery row exists.
      assert.equal((await service.deliveries(project.projectId)).length, 0);
      const openLedger = await request(
        projectPath(project.projectId, `/ledger/${encodeURIComponent(boardRequirementId)}`)
      );
      assert.equal(openLedger.body.requirement.status, "open");
      assert.ok(
        !(openLedger.body.requirement.references ?? []).some((reference) => reference.kind === "delivery")
      );

      const merge = async (development, file) => {
        await commitFile(development.workspace.directory, file, `${file}\n`);
        await service.setReviewPlan(project.projectId, {
          developmentId: development.developmentId,
          channel: "self",
          basis: "单文件改动，Main 自查",
          checks: [{ name: "自检", command: `test -f ${file}`, exitCode: 0, output: "" }]
        });
        return service.requestMerge(project.projectId, {
          developmentId: development.developmentId,
          checks: [{ name: "组合检查", command: `test -f ${file}` }]
        });
      };

      // The board demand merges for real and becomes pending release with its
      // original owner and the actual merge commit.
      const boardMerge = await merge(boardDevelopment, "board.txt");
      assert.equal(boardMerge.state, "merged", JSON.stringify(boardMerge));
      assert.ok(boardMerge.receipt);
      const boardEntry = await request(
        projectPath(project.projectId, `/board/${encodeURIComponent(boardId)}`)
      );
      assert.equal(boardEntry.body.entry.state, "pending_release", JSON.stringify(boardEntry.body));
      assert.deepEqual(boardEntry.body.entry.assignment, claimed.body.entry.assignment);
      assert.equal(boardEntry.body.entry.delivery.mergeId, boardMerge.mergeId);
      assert.equal(boardEntry.body.entry.delivery.mergedCommit, boardMerge.mergeCommit);
      assert.ok(
        boardEntry.body.events.some((event) => event.kind === "delivered"),
        "the delivery transition is kept in the board history"
      );
      const boardLedger = await request(
        projectPath(project.projectId, `/ledger/${encodeURIComponent(boardRequirementId)}`)
      );
      assert.equal(boardLedger.body.requirement.status, "delivered");
      assert.ok(
        boardLedger.body.requirement.references.some(
          (reference) => reference.kind === "delivery" && reference.value === boardMerge.mergeCommit
        ),
        "the ledger links the actual merge commit"
      );
      assert.match(boardLedger.body.requirement.revisions.at(-1).note, new RegExp(boardMerge.mergeId));
      const boardDelivery = (await service.deliveries(project.projectId)).find(
        (entry) => entry.developmentId === boardDevelopment.developmentId
      );
      assert.equal(boardDelivery.state, "synced", JSON.stringify(boardDelivery));
      assert.equal(boardDelivery.mergedCommit, boardMerge.mergeCommit);
      assert.equal(boardDelivery.boardId, boardId);
      assert.ok(boardDelivery.syncedAt);
      // A receipt that only resembles a merged operation is refused: the
      // shared merged row, not a caller's claim, is the delivery authority.
      await assert.rejects(
        authority.gateway.syncDelivery(project.projectId, {
          ...boardMerge.receipt,
          mergedCommit: "0".repeat(40)
        }),
        (error) => error.code === "delivery_not_merged"
      );

      // A delivered board need is not released, paused or cancelled: ownership
      // stays with the handling Main and publishing is a later phase.
      const released = await request(projectPath(project.projectId, "/board"), {
        action: "release",
        boardId,
        expectedRevision: boardEntry.body.entry.revision,
        requestId: "release-delivered"
      });
      assert.equal(released.status, 409, JSON.stringify(released.body));
      assert.equal(released.body.code, "board_state_conflict");
      const stillDelivered = await request(
        projectPath(project.projectId, `/board/${encodeURIComponent(boardId)}`)
      );
      assert.equal(stillDelivered.body.entry.state, "pending_release");
      assert.deepEqual(stillDelivered.body.entry.assignment, claimed.body.entry.assignment);

      // The internal demand writes its delivery to the ledger only.
      const internalMerge = await merge(internalDevelopment, "internal.txt");
      assert.equal(internalMerge.state, "merged", JSON.stringify(internalMerge));
      const internalLedger = await request(
        projectPath(project.projectId, `/ledger/${encodeURIComponent(internalRequirementId)}`)
      );
      assert.equal(internalLedger.body.requirement.status, "delivered");
      assert.ok(
        internalLedger.body.requirement.references.some(
          (reference) => reference.kind === "delivery" && reference.value === internalMerge.mergeCommit
        )
      );
      const allBoard = await request(projectPath(project.projectId, "/board"));
      assert.ok(
        !allBoard.body.entries.some((entry) => entry.requirementId === internalRequirementId),
        "an internal need creates no board item"
      );
      assert.equal(
        await readFile(join(repository, "board.txt"), "utf8"),
        "board.txt\n",
        "the delivered candidate is on the real target"
      );

      // Restart and a retried request keep the same receipt, delivery rows and
      // target history: no second development, merge or delivery.
      await dashboard.restart();
      const targetCommits = await git(repository, ["rev-list", "--count", "main"]);
      const retried = await service.requestMerge(project.projectId, {
        developmentId: boardDevelopment.developmentId
      });
      assert.equal(retried.mergeId, boardMerge.mergeId);
      assert.equal(retried.mergeCommit, boardMerge.mergeCommit);
      assert.equal(await git(repository, ["rev-list", "--count", "main"]), targetCommits);
      const afterRestart = await service.deliveries(project.projectId);
      assert.equal(afterRestart.length, 2);
      assert.ok(afterRestart.every((entry) => entry.state === "synced"));

      // The new table and board columns are part of the backup/restore contract.
      const backupPath = join(dashboard.root, "delivery-backup.json");
      const backup = await authority.gateway.backupTo(backupPath);
      assert.equal(backup.counts.project_data_deliveries, 2);
      assert.equal(backup.counts.project_data_board_entries, 1);
      const snapshot = JSON.parse(await readFile(backupPath, "utf8"));
      assert.equal(snapshot.version, 6);
      assert.equal(snapshot.tables.project_data_board_entries[0].delivery_commit, boardMerge.mergeCommit);
      const restored = await authority.gateway.restoreFrom(backupPath);
      assert.equal(restored.counts.project_data_deliveries, 2);
      assert.equal((await authority.gateway.queryDeliveries(project.projectId)).length, 2);
      const restoredBoard = await authority.gateway.boardEntry(project.projectId, boardId);
      assert.equal(restoredBoard.state, "pending_release");
      assert.equal(restoredBoard.delivery.mergedCommit, boardMerge.mergeCommit);
    }
  );

  test(
    `${engine}: a published merge survives an unreachable shared service and syncs after recovery`,
    { timeout: 240_000 },
    async (t) => {
      const dashboard = await startProjectDataDashboard(t, engine, { postgres });
      const repository = await makeRepository(join(dashboard.root, "repository"));
      const created = await dashboard.request("/api/projects", {
        projectName: "中断项目",
        projectDirectory: repository
      });
      const project = created.body.project;
      const instance = await readBackendInstance(backendPaths(join(dashboard.root, "home")));
      const request = client(dashboard);
      const authority = await openAuthority(engine, dashboard);
      t.after(() => authority.close());
      const remote = await RemoteProjectDataService.open({
        url: dashboard.base,
        token: instance.value.token,
        backendId: "backend_delivery",
        source: "p4-delivery-records-test"
      });
      t.after(() => remote.close());

      // A real network partition at the client boundary: while down, every
      // business call behaves as an unreachable shared service.
      let down = false;
      let tripOnMergedUpdate = true;
      let syncFailures = 0;
      const unavailable = () => new ProjectDataUnavailableError("fixture: shared service unreachable");
      const flaky = new Proxy(remote, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (typeof value !== "function") return value;
          if (property === "updateMerge")
            return async (...args) => {
              if (down) throw unavailable();
              const patch = args[2] ?? {};
              if (patch.state === "merged" && tripOnMergedUpdate) {
                tripOnMergedUpdate = false;
                down = true;
                throw unavailable();
              }
              return value.apply(target, args);
            };
          if (property === "syncDelivery")
            return async (...args) => {
              if (down) throw unavailable();
              if (syncFailures > 0) {
                syncFailures -= 1;
                throw new ProjectDataUnavailableError("fixture: ledger write failed");
              }
              return value.apply(target, args);
            };
          return (...args) => (down ? Promise.reject(unavailable()) : value.apply(target, args));
        }
      });
      const execution = serviceFor({
        gateway: flaky,
        backendId: "backend_delivery",
        startedAt: "started-execution",
        root: join(dashboard.root, "execution"),
        project
      });
      const configured = await execution.setMergeConfig(project.projectId, {
        repository,
        targetBranch: "main",
        executionBackendId: "backend_delivery"
      });
      assert.equal(configured.executionBackendId, "backend_delivery");

      const requirement = await request(projectPath(project.projectId, "/ledger"), {
        action: "create",
        title: "中断后补齐",
        content: "合入真实发生，共享记录稍后补齐。"
      });
      const development = await execution.create(project.projectId, {
        requirementId: requirement.body.requirement.requirementId,
        goal: "中断后补齐",
        completionCriteria: ["合入后自动补齐交付"],
        route: "quick"
      });
      await commitFile(development.workspace.directory, "resilient.txt", "resilient\n");
      await execution.setReviewPlan(project.projectId, {
        developmentId: development.developmentId,
        channel: "self",
        basis: "Main 自查",
        checks: [{ name: "自检", command: "test -f resilient.txt", exitCode: 0, output: "" }]
      });

      const baseline = await git(repository, ["rev-parse", "HEAD"]);
      const requested = await execution.requestMerge(project.projectId, {
        developmentId: development.developmentId,
        checks: [{ name: "组合检查", command: "test -f resilient.txt" }]
      });
      // The merge record cannot be written, but the real Git update and the
      // local pending-sync fact survive; the Run is not blocked or repeated.
      assert.equal(requested.state, "applying", JSON.stringify(requested));
      assert.ok(requested.mergeCommit);
      assert.equal(await git(repository, ["rev-parse", "main"]), requested.mergeCommit);
      assert.equal(
        (await authority.gateway.queryDeliveries(project.projectId)).length,
        0,
        "no shared delivery is pretended while the service is unreachable"
      );
      const pending = await outboxEntries(join(dashboard.root, "execution"));
      assert.equal(pending.length, 1);
      assert.equal(pending[0].mergeId, requested.mergeId);
      assert.equal(pending[0].mergedCommit, requested.mergeCommit);
      assert.equal(
        (await authority.gateway.getRequirement(project.projectId, development.requirementId)).status,
        "open"
      );

      // The service comes back; the next apply completes the same merge from
      // the local fact and the real branch, then writes the delivery once.
      down = false;
      const recovered = await execution.applyMerges(project.projectId);
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].state, "merged", JSON.stringify(recovered[0]));
      assert.equal(recovered[0].mergeId, requested.mergeId);
      assert.equal(recovered[0].mergeCommit, requested.mergeCommit);
      assert.equal(
        await git(repository, ["rev-list", "--count", `--first-parent`, `${baseline}..main`]),
        "1"
      );
      const deliveries = await authority.gateway.queryDeliveries(project.projectId);
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].state, "synced");
      assert.equal(deliveries[0].mergedCommit, requested.mergeCommit);
      assert.equal(
        (await authority.gateway.getRequirement(project.projectId, development.requirementId)).status,
        "delivered"
      );
      assert.deepEqual(await outboxEntries(join(dashboard.root, "execution")), []);

      // A restarted process with a new identity finds nothing new to write.
      const restarted = serviceFor({
        gateway: flaky,
        backendId: "backend_delivery",
        startedAt: "started-restarted",
        root: join(dashboard.root, "execution"),
        project
      });
      await restarted.applyMerges(project.projectId);
      assert.equal((await authority.gateway.queryDeliveries(project.projectId)).length, 1);
      assert.equal(
        await git(repository, ["rev-list", "--count", `--first-parent`, `${baseline}..main`]),
        "1"
      );

      // A delivery write that fails after the merged record is visible as a
      // pending local sync with its error, then retried to the same receipt.
      const secondRequirement = await request(projectPath(project.projectId, "/ledger"), {
        action: "create",
        title: "同步失败可见",
        content: "合入已记录，台账写入失败后重试。"
      });
      const second = await restarted.create(project.projectId, {
        requirementId: secondRequirement.body.requirement.requirementId,
        goal: "同步失败可见",
        completionCriteria: ["同步失败可重试"],
        route: "quick"
      });
      await commitFile(second.workspace.directory, "retry.txt", "retry\n");
      await restarted.setReviewPlan(project.projectId, {
        developmentId: second.developmentId,
        channel: "self",
        basis: "Main 自查",
        checks: [{ name: "自检", command: "test -f retry.txt", exitCode: 0, output: "" }]
      });
      syncFailures = 10;
      const secondMerge = await restarted.requestMerge(project.projectId, {
        developmentId: second.developmentId,
        checks: [{ name: "组合检查", command: "test -f retry.txt" }]
      });
      assert.equal(secondMerge.state, "merged", JSON.stringify(secondMerge));
      const pendingView = await restarted.deliveryView(project.projectId, {
        developmentId: second.developmentId
      });
      assert.equal(pendingView.stage, "merged");
      assert.equal(pendingView.delivery, undefined, "the shared delivery row was not created yet");
      assert.equal(pendingView.pendingSync.mergeId, secondMerge.mergeId);
      assert.match(pendingView.pendingSync.error, /ledger write failed/);
      syncFailures = 0;
      const retried = await restarted.retryDevelopmentDelivery(project.projectId, second.developmentId);
      assert.equal(retried.state, "synced");
      assert.equal(retried.mergedCommit, secondMerge.mergeCommit);
      assert.equal(
        (await authority.gateway.getRequirement(project.projectId, second.requirementId)).status,
        "delivered"
      );
      assert.deepEqual(await outboxEntries(join(dashboard.root, "execution")), []);
      assert.equal((await authority.gateway.queryDeliveries(project.projectId)).length, 2);
    }
  );

  test(
    `${engine}: a v6 database keeps its rows when the delivery schema is added`,
    { timeout: 180_000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), `coworkos-delivery-upgrade-${engine}-`));
      t.after(() => rm(directory, { recursive: true, force: true }));
      let database;
      let config;
      if (engine === "sqlite") {
        const path = join(directory, "project-data.sqlite");
        database = await SqliteDatabase.open(path);
        config = { sqlite: { path } };
      } else {
        const name = `coworkos_upgrade_${process.pid}_${Math.random().toString(16).slice(2, 8)}`;
        const admin = new pg.Client({ connectionString: postgres.connectionString });
        await admin.connect();
        await admin.query(`CREATE DATABASE ${name}`);
        await admin.end();
        const url = new URL(postgres.connectionString);
        url.pathname = `/${name}`;
        t.after(async () => {
          const cleanup = new pg.Client({ connectionString: postgres.connectionString });
          await cleanup.connect();
          await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
          await cleanup.end();
        });
        database = new PostgresDatabase({ connectionString: url.toString() });
        config = { engine, postgres: { connectionString: url.toString() } };
      }
      await database.execute(
        "CREATE TABLE project_data_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
      );
      for (const migration of PROJECT_DATA_MIGRATIONS.filter((entry) => entry.version <= 6)) {
        for (const statement of migration.statements) await database.execute(statement);
        await database.execute("INSERT INTO project_data_migrations (version, applied_at) VALUES (?, ?)", [
          migration.version,
          "2026-01-01T00:00:00.000Z"
        ]);
      }
      const timestamp = "2026-01-01T00:00:00.000Z";
      await database.execute(
        "INSERT INTO project_data_projects (project_id, project_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        ["project_legacy", "旧交付项目", timestamp, timestamp]
      );
      await database.execute(
        `INSERT INTO project_data_requirements
           (project_id, requirement_id, title, content, source_kind, source_reference, status, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "project_legacy",
          "requirement_legacy",
          "旧看板需求",
          "v6 数据不能丢。",
          "external",
          "旧渠道",
          "open",
          1,
          timestamp,
          timestamp
        ]
      );
      await database.execute(
        `INSERT INTO project_data_board_entries
           (project_id, board_id, requirement_id, entry_kind, state, revision, backend_id,
            publish_request_id, assignment_kind, assignee_id, handler_backend_id, handler_project_id,
            handler_task_id, assigned_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "project_legacy",
          "board_legacy",
          "requirement_legacy",
          "external",
          "claimed",
          2,
          "backend_legacy",
          "publish_legacy",
          "main",
          "host",
          "backend_legacy",
          "project_legacy",
          "task_legacy",
          timestamp,
          timestamp,
          timestamp
        ]
      );
      await database.close();

      const runtime = new ProjectDataRuntime({
        config,
        configPath: join(directory, "config.json"),
        dataRoot: directory,
        env: {}
      });
      try {
        const service = await runtime.service();
        assert.equal(service.description.schemaVersion, 7);
        assert.deepEqual(
          (await service.queryRequirements("project_legacy")).map((entry) => entry.title),
          ["旧看板需求"]
        );
        const [entry] = await service.boardEntries("project_legacy");
        assert.equal(entry.state, "claimed");
        assert.equal(entry.assignment.handler.taskId, "task_legacy");
        assert.equal(entry.delivery, undefined, "old rows have no delivery until a real merge");
        assert.deepEqual(await service.queryDeliveries("project_legacy"), []);
      } finally {
        await runtime.close();
      }
    }
  );
}

test(
  "a delivery receipt must match the whole merged operation and keeps its merge time",
  { timeout: 180_000 },
  async (t) => {
    const dashboard = await startProjectDataDashboard(t, "sqlite", { postgres });
    const repository = await makeRepository(join(dashboard.root, "repository"));
    const created = await dashboard.request("/api/projects", {
      projectName: "回执一致性项目",
      projectDirectory: repository
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const project = created.body.project;
    const instance = await readBackendInstance(backendPaths(join(dashboard.root, "home")));
    const authority = await openAuthority("sqlite", dashboard);
    t.after(() => authority.close());
    const request = client(dashboard);
    const info = (await request("/api/project-data", undefined, "GET")).body;

    // The merge record is written but the delivery write fails, so a merged
    // row with no delivery is the fixture for every forged receipt below.
    const failing = new Proxy(authority.gateway, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        if (property === "syncDelivery")
          return async () => {
            throw new ProjectDataUnavailableError("fixture: delivery write failed");
          };
        return (...args) => value.apply(target, args);
      }
    });
    const service = serviceFor({
      gateway: failing,
      backendId: instance.value.backendId,
      startedAt: "started-receipt",
      root: dashboard.root,
      project
    });
    await service.setMergeConfig(project.projectId, { repository, targetBranch: "main" });

    const published = await request(projectPath(project.projectId, "/board"), {
      action: "publish",
      requestId: "publish-receipt-board",
      title: "回执一致性看板需求",
      content: "关联合入回执和合入时间。",
      source: { kind: "external", reference: "回执渠道" }
    });
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const boardId = published.body.entry.boardId;
    const boardRequirementId = published.body.entry.requirementId;
    const claimed = await request(projectPath(project.projectId, "/board"), {
      action: "claim",
      boardId,
      expectedRevision: published.body.entry.revision,
      requestId: "claim-receipt-board"
    });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    const internal = await request(projectPath(project.projectId, "/ledger"), {
      action: "create",
      title: "回执一致性内部需求",
      content: "只写台账。"
    });
    const internalRequirementId = internal.body.requirement.requirementId;

    const develop = (requirementId, title) =>
      service.create(project.projectId, {
        requirementId,
        goal: title,
        completionCriteria: ["observable result"],
        route: "quick"
      });
    const boardDevelopment = await develop(boardRequirementId, "回执一致性看板");
    const internalDevelopment = await develop(internalRequirementId, "回执一致性内部");
    const merge = async (development, file) => {
      await commitFile(development.workspace.directory, file, `${file}\n`);
      await service.setReviewPlan(project.projectId, {
        developmentId: development.developmentId,
        channel: "self",
        basis: "Main 自查",
        checks: [{ name: "自检", command: `test -f ${file}`, exitCode: 0, output: "" }]
      });
      return service.requestMerge(project.projectId, {
        developmentId: development.developmentId,
        checks: [{ name: "组合检查", command: `test -f ${file}` }]
      });
    };
    const boardMerge = await merge(boardDevelopment, "receipt.txt");
    const internalMerge = await merge(internalDevelopment, "internal-receipt.txt");
    assert.equal(boardMerge.state, "merged", JSON.stringify(boardMerge));
    assert.equal(internalMerge.state, "merged", JSON.stringify(internalMerge));
    assert.equal((await authority.gateway.queryDeliveries(project.projectId)).length, 0);
    assert.equal(
      (await authority.gateway.getRequirement(project.projectId, boardRequirementId)).status,
      "open"
    );

    // Each field that identifies the accepted version is authoritative; a
    // caller value that differs is refused before any row or record changes.
    const forgedReceipts = [
      ["candidateCommit", { ...boardMerge.receipt, candidateCommit: "0".repeat(40) }],
      ["mergedAt", { ...internalMerge.receipt, mergedAt: "2000-01-01T00:00:00.000Z" }]
    ];
    for (const [field, receipt] of forgedReceipts) {
      await assert.rejects(authority.gateway.syncDelivery(project.projectId, receipt), (error) => {
        assert.equal(error.code, "delivery_not_merged", field);
        return true;
      });
    }
    assert.equal((await authority.gateway.queryDeliveries(project.projectId)).length, 0);
    assert.equal(
      (await authority.gateway.getRequirement(project.projectId, boardRequirementId)).status,
      "open"
    );
    assert.equal(
      (await authority.gateway.getRequirement(project.projectId, internalRequirementId)).status,
      "open"
    );
    assert.equal(
      (await authority.gateway.boardEntry(project.projectId, boardId)).state,
      "claimed",
      "a forged receipt does not move the board"
    );

    // A pending row that no longer matches the merged operation is refused on
    // retry; it must not reach the ledger or the board.
    const timestamp = new Date().toISOString();
    const forged = await SqliteDatabase.open(info.target);
    await forged.execute(
      `INSERT INTO project_data_deliveries
         (project_id, delivery_id, development_id, requirement_id, merge_id, candidate_commit,
          merged_commit, target_branch, merged_at, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      [
        project.projectId,
        "delivery_forged_receipt",
        boardDevelopment.developmentId,
        boardRequirementId,
        boardMerge.mergeId,
        "0".repeat(40),
        boardMerge.mergeCommit,
        "main",
        boardMerge.receipt.mergedAt,
        timestamp,
        timestamp
      ]
    );
    await forged.close();
    const pending = (await authority.gateway.queryDeliveries(project.projectId)).find(
      (entry) => entry.mergeId === boardMerge.mergeId
    );
    assert.equal(pending.state, "pending");
    await assert.rejects(
      authority.gateway.retryDelivery(project.projectId, pending.deliveryId),
      (error) => error.code === "delivery_not_merged"
    );
    assert.equal(
      (await authority.gateway.getRequirement(project.projectId, boardRequirementId)).status,
      "open"
    );
    assert.equal((await authority.gateway.boardEntry(project.projectId, boardId)).state, "claimed");
    const cleanup = await SqliteDatabase.open(info.target);
    await cleanup.execute("DELETE FROM project_data_deliveries WHERE project_id = ? AND delivery_id = ?", [
      project.projectId,
      pending.deliveryId
    ]);
    await cleanup.close();

    // The accepted receipt syncs the real candidate and the authority's own
    // merge time; a later sync keeps the same delivery and revision.
    await delay(20);
    const boardDelivery = await authority.gateway.syncDelivery(project.projectId, boardMerge.receipt);
    assert.equal(boardDelivery.state, "synced");
    assert.equal(boardDelivery.candidateCommit, boardMerge.candidate.commit);
    assert.equal(boardDelivery.mergedCommit, boardMerge.mergeCommit);
    assert.equal(boardDelivery.mergedAt, boardMerge.receipt.mergedAt);
    const internalDelivery = await authority.gateway.syncDelivery(project.projectId, internalMerge.receipt);
    assert.equal(internalDelivery.candidateCommit, internalMerge.candidate.commit);
    assert.equal(internalDelivery.mergedAt, internalMerge.receipt.mergedAt);
    const boardEntry = await authority.gateway.boardEntry(project.projectId, boardId);
    assert.equal(boardEntry.state, "pending_release");
    assert.equal(boardEntry.delivery.mergedAt, boardMerge.receipt.mergedAt);
    assert.notEqual(boardEntry.updatedAt, boardEntry.delivery.mergedAt, "sync time is not merge time");
    const revision = (await authority.gateway.getRequirement(project.projectId, boardRequirementId)).revision;
    const repeated = await authority.gateway.syncDelivery(project.projectId, boardMerge.receipt);
    assert.equal(repeated.deliveryId, boardDelivery.deliveryId);
    assert.equal(
      (await authority.gateway.getRequirement(project.projectId, boardRequirementId)).revision,
      revision,
      "a repeated receipt does not append another delivery revision"
    );
  }
);

test(
  "the execution host completes a pending delivery after the shared service returns without a read",
  { timeout: 180_000 },
  async (t) => {
    const authority = await startDashboard({ defaultProject: false });
    t.after(() => authority.stop());
    const request = client(authority);
    const repository = await makeRepository(join(authority.root, "repository"));
    const created = await request("/api/projects", {
      projectName: "自动补齐项目",
      projectDirectory: repository
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const project = created.body.project;
    const authorityInstance = await servingInstance(authority.root);
    const info = (await request("/api/project-data", undefined, "GET")).body;
    const runtime = new ProjectDataRuntime({
      config: { sqlite: { path: info.target } },
      configPath: join(authority.root, "config.json"),
      dataRoot: authority.root,
      env: {}
    });
    t.after(() => runtime.close());
    const gateway = await runtime.service();
    const proxy = await startPartitionProxy(authority.base);
    const execution = await startDashboard({
      defaultProject: false,
      config: {
        projectData: { authority: { url: proxy.url, token: authorityInstance.token } }
      },
      env: { COWORK_DELIVERY_SYNC_TICK_MS: "50" }
    });
    let stopped = false;
    t.after(async () => {
      if (!stopped) await execution.stop();
      await proxy.close();
    });
    const executionInstance = await servingInstance(execution.root);
    const remote = await RemoteProjectDataService.open({
      url: proxy.url,
      token: authorityInstance.token,
      backendId: executionInstance.backendId,
      source: "p4-delivery-recovery-test"
    });
    t.after(() => remote.close());
    const service = createProjectDevelopmentService({
      runtime: { service: async () => remote },
      backendId: executionInstance.backendId,
      startedAt: "started-recovery",
      developmentRoot: join(execution.root, "development-workspaces"),
      deliveryRoot: join(execution.root, "delivery-sync"),
      project: async (projectId) =>
        projectId === project.projectId
          ? {
              projectId: project.projectId,
              projectName: project.projectName,
              projectDirectory: repository
            }
          : undefined,
      taskProject: async () => undefined
    });
    await service.setMergeConfig(project.projectId, {
      repository,
      targetBranch: "main",
      executionBackendId: executionInstance.backendId
    });
    const requirement = await request(projectPath(project.projectId, "/ledger"), {
      action: "create",
      title: "自动补齐需求",
      content: "共享服务恢复后无需读取即可补齐。"
    });
    const development = await service.create(project.projectId, {
      requirementId: requirement.body.requirement.requirementId,
      goal: "自动补齐需求",
      completionCriteria: ["共享服务恢复后自动补齐"],
      route: "quick"
    });
    await commitFile(development.workspace.directory, "auto.txt", "auto\n");
    await service.setReviewPlan(project.projectId, {
      developmentId: development.developmentId,
      channel: "self",
      basis: "Main 自查",
      checks: [{ name: "自检", command: "test -f auto.txt", exitCode: 0, output: "" }]
    });
    const baseline = await git(repository, ["rev-parse", "HEAD"]);
    const requested = await service.requestMerge(project.projectId, {
      developmentId: development.developmentId,
      checks: [{ name: "组合检查", command: "test -f auto.txt" }]
    });
    assert.equal(requested.state, "applying", JSON.stringify(requested));
    await waitFor(async () => {
      const row = (await gateway.queryMerges(project.projectId))[0];
      return row?.state === "applying" && (await outboxEntries(execution.root)).length === 1;
    }, "the published merge and its local pending fact were not observed");
    // While the service is unreachable, the host must not pretend to complete.
    await delay(300);
    assert.equal(
      (await gateway.queryMerges(project.projectId))[0].state,
      "applying",
      "an unreachable service cannot complete the record"
    );
    assert.equal((await gateway.queryDeliveries(project.projectId)).length, 0);

    // Restore the service; only the production execution host's own retry task
    // runs now. The test reads the authority directly and never calls the
    // execution host, apply, retry or a UI.
    proxy.setFailing(false);
    await waitFor(
      async () => {
        const row = (await gateway.queryMerges(project.projectId))[0];
        const deliveries = await gateway.queryDeliveries(project.projectId);
        return (
          row?.state === "merged" &&
          deliveries.some((delivery) => delivery.mergeId === row.mergeId && delivery.state === "synced")
        );
      },
      "the execution host did not complete the delivery after the service returned",
      20_000
    );
    const merged = (await gateway.queryMerges(project.projectId))[0];
    assert.equal(merged.state, "merged");
    assert.equal(merged.mergeCommit, requested.mergeCommit);
    assert.equal(await git(repository, ["rev-list", "--count", "--first-parent", `${baseline}..main`]), "1");
    assert.equal(
      (await gateway.getRequirement(project.projectId, development.requirementId)).status,
      "delivered"
    );
    assert.deepEqual(await outboxEntries(execution.root), []);

    // Stopping the production execution host ends its retry task; no later
    // merge/delivery requests are issued by it.
    const before = proxy.mergeRequests();
    await execution.stop();
    stopped = true;
    await delay(400);
    assert.equal(proxy.mergeRequests(), before, "the stopped execution host kept retrying");

    // A new execution service instance can also start while the shared service
    // is still unreachable: its startup retry pass keeps the local fact pending
    // and its next tick completes it after recovery without a read or apply.
    proxy.rearm();
    const secondRequirement = await request(projectPath(project.projectId, "/ledger"), {
      action: "create",
      title: "重启后自动补齐",
      content: "启动时仍不可达，恢复后自动完成。"
    });
    const secondDevelopment = await service.create(project.projectId, {
      requirementId: secondRequirement.body.requirement.requirementId,
      goal: "重启后自动补齐",
      completionCriteria: ["重启后自动补齐"],
      route: "quick"
    });
    await commitFile(secondDevelopment.workspace.directory, "restart.txt", "restart\n");
    await service.setReviewPlan(project.projectId, {
      developmentId: secondDevelopment.developmentId,
      channel: "self",
      basis: "Main 自查",
      checks: [{ name: "自检", command: "test -f restart.txt", exitCode: 0, output: "" }]
    });
    const secondRequested = await service.requestMerge(project.projectId, {
      developmentId: secondDevelopment.developmentId,
      checks: [{ name: "组合检查", command: "test -f restart.txt" }]
    });
    assert.equal(secondRequested.state, "applying", JSON.stringify(secondRequested));
    await waitFor(async () => {
      const row = (await gateway.queryMerges(project.projectId)).find(
        (entry) => entry.mergeId === secondRequested.mergeId
      );
      return row?.state === "applying" && (await outboxEntries(execution.root)).length === 1;
    }, "the second published merge and its local pending fact were not observed");
    const restarted = createProjectDevelopmentService({
      runtime: { service: async () => remote },
      backendId: executionInstance.backendId,
      startedAt: "started-restart",
      developmentRoot: join(execution.root, "development-workspaces"),
      deliveryRoot: join(execution.root, "delivery-sync"),
      project: async (projectId) =>
        projectId === project.projectId
          ? {
              projectId: project.projectId,
              projectName: project.projectName,
              projectDirectory: repository
            }
          : undefined,
      taskProject: async () => undefined
    });
    restarted.startDeliveryRecovery(50);
    t.after(() => restarted.stopDeliveryRecovery());
    await delay(300);
    assert.equal(
      (await gateway.queryMerges(project.projectId)).find(
        (entry) => entry.mergeId === secondRequested.mergeId
      ).state,
      "applying",
      "a startup pass during the outage cannot complete the record"
    );
    assert.equal(
      (await gateway.queryDeliveries(project.projectId)).filter(
        (delivery) => delivery.mergeId === secondRequested.mergeId
      ).length,
      0
    );
    proxy.setFailing(false);
    await waitFor(
      async () => {
        const row = (await gateway.queryMerges(project.projectId)).find(
          (entry) => entry.mergeId === secondRequested.mergeId
        );
        const deliveries = await gateway.queryDeliveries(project.projectId);
        return (
          row?.state === "merged" &&
          deliveries.some((delivery) => delivery.mergeId === row.mergeId && delivery.state === "synced")
        );
      },
      "the restarted service did not complete the delivery after the service returned",
      20_000
    );
    assert.equal(await git(repository, ["rev-list", "--count", "--first-parent", `${baseline}..main`]), "2");
    assert.equal(
      (await gateway.getRequirement(project.projectId, secondDevelopment.requirementId)).status,
      "delivered"
    );
    assert.deepEqual(await outboxEntries(execution.root), []);
    await restarted.stopDeliveryRecovery();
  }
);
