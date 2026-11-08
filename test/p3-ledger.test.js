import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { startDashboard } from "./dashboard-fixture.mjs";
import {
  PROJECT_DATA_ENGINES,
  projectDataConfig,
  startPostgresProjectDatabase,
  startProjectDataDashboard
} from "./p3-storage-fixture.mjs";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";

/**
 * One contract, two real engines.
 *
 * The same scenarios run against the default SQLite file and a disposable
 * PostgreSQL 18 server, through the real Dashboard HTTP surface. Nothing here
 * substitutes an in-memory store for a database: a restart has to read the fact
 * back from the engine that committed it.
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

const ledgerFixture = (t, engine, options) => startProjectDataDashboard(t, engine, { postgres, ...options });

async function createProject(fixture, name) {
  const directory = join(fixture.root, `project-${name}`);
  await mkdir(directory, { recursive: true });
  const response = await fixture.request("/api/projects", {
    projectName: `项目 ${name}`,
    projectDirectory: directory
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.project;
}

async function openService(fixture, engine, info) {
  // The default SQLite run names no engine in configuration; the reported target
  // is the file it actually opened, so a second connection reads the same data.
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

/** An HTTP port with nothing listening on it, for the unreachable-database case. */
async function closedPort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

for (const engine of PROJECT_DATA_ENGINES) {
  test(`${engine}: ledger contract survives restart, conflicts, rollback and restore`, async (t) => {
    const f = await ledgerFixture(t, engine);
    const a = await createProject(f, "a");
    const b = await createProject(f, "b");
    const ledger = (projectId) => `/api/projects/${encodeURIComponent(projectId)}/ledger`;

    // Engine choice and versioned schema are observable, and the report carries
    // no credential material.
    const info = await f.request("/api/project-data", undefined, "GET");
    assert.equal(info.status, 200);
    assert.equal(info.body.engine, engine);
    // v1 and v2 stayed intact; v3 adds project Main sessions and v4 adds
    // development records. Migrations are applied one version at a time, so a
    // later version does not hide an unapplied one.
    assert.equal(info.body.schemaVersion, 4);
    assert.ok(info.body.serverVersion, "the engine version is reported");
    assert.doesNotMatch(JSON.stringify(info.body), /password/i);
    if (engine === "sqlite")
      assert.equal(info.body.target, join(f.root, "project-data.sqlite"), "the default SQLite file");

    const created = await f.request(ledger(a.projectId), {
      action: "create",
      title: "登录需要记住设备",
      content: "用户每天在同一台设备登录，不应反复输入验证码。",
      source: { kind: "internal", reference: "会话 a" },
      references: [{ kind: "session", value: "session-a" }]
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const requirement = created.body.requirement;
    assert.equal(requirement.revision, 1);
    assert.equal(requirement.source.kind, "internal");
    assert.equal(requirement.decisions.length, 0);
    assert.equal(requirement.revisions.length, 1);
    assert.equal(requirement.references[0].value, "session-a");
    // An internal requirement is ledger-only: this ticket adds no board projection.
    assert.ok(!("boardEntry" in requirement));
    const emptyBoard = await f.request(
      `/api/projects/${encodeURIComponent(a.projectId)}/board`,
      undefined,
      "GET"
    );
    assert.equal(emptyBoard.status, 200);
    assert.deepEqual(emptyBoard.body.entries, [], "an internal need creates no board item");

    const revised = await f.request(ledger(a.projectId), {
      action: "update",
      requirementId: requirement.requirementId,
      expectedRevision: 1,
      content: "用户每天在同一台设备登录，记住 30 天，敏感操作仍需验证。",
      note: "补充有效期与敏感操作"
    });
    assert.equal(revised.status, 200, JSON.stringify(revised.body));
    assert.equal(revised.body.requirement.revision, 2);
    assert.deepEqual(
      revised.body.requirement.revisions.map((revision) => revision.revision),
      [1, 2]
    );
    assert.equal(revised.body.requirement.revisions[1].note, "补充有效期与敏感操作");

    const decided = await f.request(ledger(a.projectId), {
      action: "decide",
      requirementId: requirement.requirementId,
      expectedRevision: 2,
      text: "使用本机设备令牌，30 天后重新验证。"
    });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    const decision = decided.body.requirement.decisions[0];
    assert.equal(decision.effective, true);
    const retracted = await f.request(ledger(a.projectId), {
      action: "set_decision_effective",
      requirementId: requirement.requirementId,
      decisionId: decision.decisionId,
      expectedRevision: 2,
      effective: false
    });
    assert.equal(retracted.status, 200, JSON.stringify(retracted.body));
    assert.equal(retracted.body.requirement.decisions[0].effective, false);

    // Text query returns the source and validity, both as a page read and as the
    // tool-shaped POST the Main bridge uses.
    const byText = await f.request(
      `${ledger(a.projectId)}?q=${encodeURIComponent("设备")}`,
      undefined,
      "GET"
    );
    assert.equal(byText.status, 200);
    assert.equal(byText.body.requirements.length, 1);
    assert.equal(byText.body.requirements[0].source.kind, "internal");
    assert.equal(byText.body.requirements[0].decisions[0].effective, false);
    assert.equal(byText.body.requirements[0].source.reference, "会话 a");
    const byDelivered = await f.request(`${ledger(a.projectId)}?status=delivered`, undefined, "GET");
    assert.deepEqual(byDelivered.body.requirements, []);
    const isolation = await f.request(ledger(b.projectId), { action: "query" });
    assert.equal(isolation.status, 200);
    assert.deepEqual(isolation.body.requirements, []);

    // A stale page cannot overwrite the newer revision.
    const stale = await f.request(ledger(a.projectId), {
      action: "update",
      requirementId: requirement.requirementId,
      expectedRevision: 1,
      title: "过期页面写入"
    });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.code, "revision_conflict");
    assert.equal(stale.body.currentRevision, 2);

    const before = await openService(f, engine, info.body);
    t.after(() => before.close());
    const history = await before.service.getRequirement(a.projectId, requirement.requirementId);
    assert.equal(history.revisions.length, 2);

    // A failure inside a transaction leaves no requirement and no revision behind.
    await assert.rejects(
      before.service.transaction(async (repository) => {
        await repository.createRequirement(a.projectId, { title: "临时", content: "不应保存" });
        throw new Error("fixture rollback");
      }),
      /fixture rollback/
    );
    assert.equal((await before.service.queryRequirements(a.projectId)).length, 1);

    // Two writers from revision 2: exactly one wins and every accepted revision stays.
    const race = await Promise.allSettled([
      before.service.updateRequirement(a.projectId, requirement.requirementId, {
        expectedRevision: 2,
        title: "并发写入一"
      }),
      before.service.updateRequirement(a.projectId, requirement.requirementId, {
        expectedRevision: 2,
        title: "并发写入二"
      })
    ]);
    assert.equal(race.filter((result) => result.status === "fulfilled").length, 1, JSON.stringify(race));
    const rejected = race.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.status, 409);
    assert.equal(rejected.reason.code, "revision_conflict");
    const afterRace = await before.service.getRequirement(a.projectId, requirement.requirementId);
    assert.equal(afterRace.revisions.length, 3);
    assert.deepEqual(
      afterRace.revisions.map((revision) => revision.revision),
      [1, 2, 3]
    );

    // Backup, mutate, restore: the snapshot is the observable source of truth.
    const backupPath = join(f.root, `ledger-backup-${engine}.json`);
    const backup = await before.service.backupTo(backupPath);
    assert.equal(backup.engine, engine);
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    await f.request(ledger(a.projectId), {
      action: "create",
      title: "备份后新增",
      content: "这一条不应在恢复后出现。"
    });
    assert.equal((await before.service.queryRequirements(a.projectId)).length, 2);
    const restored = await before.service.restoreFrom(backupPath);
    assert.equal(restored.counts.project_data_requirements, backup.counts.project_data_requirements);
    assert.equal((await before.service.queryRequirements(a.projectId)).length, 1);

    // A snapshot cannot shape the restore statement, and a rejected file changes nothing.
    const tampered = JSON.parse(await readFile(backupPath, "utf8"));
    tampered.tables.project_data_requirements[0]["project_id; DROP TABLE project_data_projects"] = "x";
    const tamperedPath = join(f.root, `ledger-backup-tampered-${engine}.json`);
    await writeFile(tamperedPath, JSON.stringify(tampered));
    await assert.rejects(before.service.restoreFrom(tamperedPath), /不是已知字段/);
    assert.equal((await before.service.queryRequirements(a.projectId)).length, 1);

    // Restart reads the restored fact back from the engine, not from memory.
    await f.restart();
    const reopened = await f.request(
      `${ledger(a.projectId)}?q=${encodeURIComponent("设备")}`,
      undefined,
      "GET"
    );
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.requirements.length, 1);
    const detail = await f.request(
      `${ledger(a.projectId)}/${encodeURIComponent(requirement.requirementId)}`,
      undefined,
      "GET"
    );
    assert.equal(detail.body.requirement.revision, 3);
    assert.equal(detail.body.requirement.revisions.length, 3);
    assert.equal(detail.body.requirement.decisions[0].effective, false);
    const infoAfterRestart = await f.request("/api/project-data", undefined, "GET");
    assert.equal(infoAfterRestart.body.schemaVersion, 4);
  });

  test(`${engine}: existing project and task history keep their identity and files`, async (t) => {
    const f = await ledgerFixture(t, engine);
    const taskRoot = join(f.workspaceRoot, "legacy-task");
    await mkdir(taskRoot, { recursive: true });
    await writeFile(
      join(taskRoot, "task.json"),
      JSON.stringify({ taskId: "legacy-task", goal: "历史任务", createdAt: "2026-01-01T00:00:00.000Z" })
    );
    const listed = await f.request("/api/tasks", undefined, "GET");
    const legacyProject = listed.body.projects.find((project) =>
      project.tasks.some((task) => task.taskId === "legacy-task")
    );
    assert.ok(legacyProject, "the old task still groups under a project");
    assert.equal(legacyProject.projectId, f.workspaceRoot, "the legacy directory id is preserved");

    const catalogPath = join(f.root, "projects.json");
    const catalogBefore = await readFile(catalogPath, "utf8");
    const taskBefore = await readFile(join(taskRoot, "task.json"), "utf8");

    const created = await f.request(`/api/projects/${encodeURIComponent(legacyProject.projectId)}/ledger`, {
      action: "create",
      title: "旧项目需求",
      content: "历史项目继续记录需求。"
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.requirement.projectId, legacyProject.projectId);
    // Ledger writes never touch the catalog or the task snapshot.
    assert.equal(await readFile(catalogPath, "utf8"), catalogBefore);
    assert.equal(await readFile(join(taskRoot, "task.json"), "utf8"), taskBefore);

    await f.restart();
    const history = await f.request("/api/tasks", undefined, "GET");
    assert.ok(
      history.body.projects
        .find((project) => project.projectId === legacyProject.projectId)
        ?.tasks.some((task) => task.taskId === "legacy-task")
    );
    const ledger = await f.request(`/api/projects/${encodeURIComponent(legacyProject.projectId)}/ledger`, {
      action: "query"
    });
    assert.equal(ledger.body.requirements.length, 1);
    assert.equal(ledger.body.requirements[0].title, "旧项目需求");
  });
}

test("an invalid engine is refused with a locatable error and no fallback database", async (t) => {
  await assert.rejects(
    startDashboard({ defaultProject: false, config: { projectData: { engine: "mysql" } } }),
    (error) => {
      assert.match(error.message, /projectData/);
      assert.match(error.message, /engine 须为 sqlite \/ postgres/);
      return true;
    }
  );
  t.diagnostic("invalid engine refused at startup");
});

test("a malformed PostgreSQL URL refuses startup with a locatable configuration error", async (t) => {
  const password = "fixture-password";
  const raw = `postgresql://coworkos_test:${encodeURIComponent(password)}@127.0.0.1:not-a-port/ledger`;
  const fallback = join("/tmp", `coworkos-p3-malformed-fallback-${process.pid}-${Date.now()}.sqlite`);
  await assert.rejects(
    startDashboard({
      defaultProject: false,
      config: { projectData: { engine: "postgres", postgres: { connectionString: raw } } },
      env: { COWORK_PROJECT_DATA_SQLITE: fallback }
    }),
    (error) => {
      assert.match(error.message, /PostgreSQL/);
      assert.match(error.message, /postgres\.connectionString/);
      assert.ok(!error.message.includes(password), "the password is not echoed");
      assert.ok(!error.message.includes("not-a-port"), "the raw address is not echoed");
      return true;
    }
  );
  await assert.rejects(stat(fallback), "no SQLite database was opened as a fallback");
  t.diagnostic("malformed postgresql:// URL refused at the configuration boundary");
});

test("an unreachable PostgreSQL refuses to start instead of writing SQLite", async (t) => {
  const port = await closedPort();
  const password = "fixture-password";
  const fallback = join("/tmp", `coworkos-p3-fallback-${process.pid}-${Date.now()}.sqlite`);
  await assert.rejects(
    startDashboard({
      defaultProject: false,
      config: {
        projectData: {
          engine: "postgres",
          postgres: {
            connectionString: `postgresql://coworkos_test:${encodeURIComponent(password)}@127.0.0.1:${port}/unreachable`
          }
        }
      },
      env: { COWORK_PROJECT_DATA_SQLITE: fallback }
    }),
    (error) => {
      assert.match(error.message, /PostgreSQL/);
      assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${port}`));
      assert.ok(!error.message.includes(password), error.message);
      return true;
    }
  );
  await assert.rejects(stat(fallback), "no SQLite database was opened as a fallback");
  t.diagnostic(`refused postgres target 127.0.0.1:${port}`);
});
