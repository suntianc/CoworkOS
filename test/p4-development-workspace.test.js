import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, test } from "node:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import {
  PROJECT_DATA_ENGINES,
  startPostgresProjectDatabase,
  startProjectDataDashboard
} from "./p3-storage-fixture.mjs";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";
import { SqliteDatabase } from "../dist/src/storage/project-data/sqlite-database.js";
import { PostgresDatabase } from "../dist/src/storage/project-data/postgres-database.js";
import { PROJECT_DATA_MIGRATIONS } from "../dist/src/storage/project-data/migrations.js";

const run = promisify(execFile);

/**
 * Development records on a real Git repository, through the same unified
 * gateway on both engines.
 *
 * Nothing here substitutes a directory for a repository or an in-memory map for
 * the database: the workspaces are real `git worktree` checkouts, a restart
 * reads the record back from the engine that committed it, and the user's own
 * working tree must be byte-identical afterwards.
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

const git = (cwd, args) =>
  run("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((result) => result.stdout.trim());

/** A committed baseline, a staged reservation, a modified file and an untracked file. */
async function makeRepository(directory) {
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.email", "fixture@example.test"]);
  await git(directory, ["config", "user.name", "Fixture"]);
  await writeFile(join(directory, "tracked.txt"), "committed\n");
  await writeFile(join(directory, "README.md"), "# fixture\n");
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "baseline"]);
  await writeFile(join(directory, "tracked.txt"), "committed\nlocal edit\n");
  await writeFile(join(directory, "reserved.txt"), "reserved for the next change\n");
  await git(directory, ["add", "reserved.txt"]);
  await writeFile(join(directory, "untracked.txt"), "never committed\n");
  return directory;
}

/** The user's working tree as observed: HEAD, status and every file's bytes. */
async function repositoryState(repository) {
  return {
    head: await git(repository, ["rev-parse", "HEAD"]),
    status: await git(repository, ["status", "--porcelain=v1"]),
    tracked: await readFile(join(repository, "tracked.txt"), "utf8"),
    reserved: await readFile(join(repository, "reserved.txt"), "utf8"),
    untracked: await readFile(join(repository, "untracked.txt"), "utf8"),
    readme: await readFile(join(repository, "README.md"), "utf8")
  };
}

const client =
  (fixture) =>
  async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${fixture.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };

async function createProject(fixture, request, name, projectDirectory) {
  const directory = projectDirectory ?? join(fixture.root, `project-${name}`);
  if (!projectDirectory) await mkdir(directory, { recursive: true });
  const response = await request("/api/projects", {
    projectName: `项目 ${name}`,
    projectDirectory: directory
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.project;
}

async function createRequirement(request, projectId, title) {
  const response = await request(`/api/projects/${encodeURIComponent(projectId)}/ledger`, {
    action: "create",
    title,
    content: `${title}的内容`
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.requirement;
}

const developmentPath = (projectId) => `/api/projects/${encodeURIComponent(projectId)}/developments`;

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
  test(`${engine}: two requirements get independent isolated workspaces that survive restart`, async (t) => {
    const f = await startProjectDataDashboard(t, engine, { postgres });
    const request = client(f);
    const repository = await makeRepository(join(f.root, "repository"));
    const project = await createProject(f, request, "workspace", repository);
    const first = await createRequirement(request, project.projectId, "登录记住设备");
    const second = await createRequirement(request, project.projectId, "导出月度报表");
    const base = await repositoryState(repository);

    // No merge configuration is a locatable refusal, not a guess.
    const missing = await request(developmentPath(project.projectId), {
      action: "create",
      requirementId: first.requirementId,
      goal: "同一设备 30 天内免验证",
      completionCriteria: ["同一设备第二次登录不再要求验证码"],
      route: "direct"
    });
    assert.equal(missing.status, 409, JSON.stringify(missing.body));
    assert.equal(missing.body.code, "project_git_missing");
    assert.match(missing.body.error, /repository/);
    assert.match(missing.body.error, /targetBranch/);

    const configured = await request(`/api/projects/${encodeURIComponent(project.projectId)}/merge-config`, {
      repository,
      targetBranch: "main"
    });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    assert.equal(configured.body.mergeConfig.repository, repository);
    assert.equal(configured.body.mergeConfig.targetBranch, "main");
    assert.ok(configured.body.mergeConfig.executionBackendId, "the serving backend owns the merge entry");
    const readConfig = await request(`/api/projects/${encodeURIComponent(project.projectId)}/merge-config`);
    assert.equal(readConfig.status, 200, JSON.stringify(readConfig.body));
    assert.equal(readConfig.body.mergeConfig.repository, repository);
    assert.equal(readConfig.body.mergeConfig.targetBranch, "main");
    assert.equal(
      readConfig.body.mergeConfig.executionBackendId,
      configured.body.mergeConfig.executionBackendId
    );

    // An inapplicable repository or branch is refused where it is named.
    const other = await createProject(f, request, "invalid");
    const badRepository = await request(`/api/projects/${encodeURIComponent(other.projectId)}/merge-config`, {
      repository: join(f.root, "not-a-repository"),
      targetBranch: "main"
    });
    assert.equal(badRepository.status, 400, JSON.stringify(badRepository.body));
    assert.equal(badRepository.body.code, "project_git_invalid");
    assert.match(badRepository.body.error, /not-a-repository/);
    const badBranch = await request(`/api/projects/${encodeURIComponent(other.projectId)}/merge-config`, {
      repository,
      targetBranch: "missing-branch"
    });
    assert.equal(badBranch.status, 400, JSON.stringify(badBranch.body));
    assert.equal(badBranch.body.code, "project_git_invalid");
    assert.match(badBranch.body.error, /missing-branch/);

    const createdFirst = await request(developmentPath(project.projectId), {
      action: "create",
      requirementId: first.requirementId,
      goal: "同一设备 30 天内免验证",
      completionCriteria: ["同一设备第二次登录不再要求验证码", "敏感操作仍需验证"],
      route: "full"
    });
    assert.equal(createdFirst.status, 201, JSON.stringify(createdFirst.body));
    const one = createdFirst.body.development;
    assert.equal(one.requirementId, first.requirementId);
    assert.equal(one.requirementTitle, "登录记住设备");
    assert.equal(one.revision, 1);
    assert.equal(one.status, "active");
    assert.equal(one.route, "full");
    assert.deepEqual(one.completionCriteria, ["同一设备第二次登录不再要求验证码", "敏感操作仍需验证"]);
    assert.equal(one.baseline.branch, "main");
    assert.equal(one.baseline.commit, base.head);
    assert.equal(one.workspace.state, "ready", JSON.stringify(one.workspace));
    assert.equal(one.workspace.backendId, configured.body.mergeConfig.executionBackendId);
    assert.ok(
      !one.workspace.directory.startsWith(`${repository}/`),
      "the workspace lives outside the user's tree"
    );
    assert.equal((await stat(one.workspace.directory)).isDirectory(), true);

    const createdSecond = await request(developmentPath(project.projectId), {
      action: "create",
      requirementId: second.requirementId,
      goal: "管理员按月导出",
      completionCriteria: ["导出当前月份的完整数据"],
      route: "quick"
    });
    assert.equal(createdSecond.status, 201, JSON.stringify(createdSecond.body));
    const two = createdSecond.body.development;
    assert.notEqual(two.developmentId, one.developmentId);
    assert.notEqual(two.workspace.directory, one.workspace.directory);
    assert.notEqual(two.workspace.branch, one.workspace.branch);
    assert.equal(two.baseline.commit, base.head);
    // Each workspace is a real checkout of the recorded baseline, and the
    // uncommitted reservation is not carried into either of them.
    for (const workspace of [one.workspace, two.workspace]) {
      assert.equal(await git(workspace.directory, ["rev-parse", "HEAD"]), base.head);
      assert.equal(await git(workspace.directory, ["rev-parse", "--abbrev-ref", "HEAD"]), workspace.branch);
      assert.equal(await readFile(join(workspace.directory, "tracked.txt"), "utf8"), "committed\n");
      await assert.rejects(readFile(join(workspace.directory, "untracked.txt"), "utf8"));
    }
    const worktrees = await git(repository, ["worktree", "list", "--porcelain"]);
    assert.match(worktrees, new RegExp(one.workspace.directory.replaceAll("/", "\\/")));
    assert.match(worktrees, new RegExp(two.workspace.directory.replaceAll("/", "\\/")));

    // The user's directory keeps its committed content, reservation, edit and
    // untracked file; only the worktree registry under .git changed.
    assert.deepEqual(await repositoryState(repository), base);

    // One record per requirement; a second create names the existing record.
    const duplicate = await request(developmentPath(project.projectId), {
      action: "create",
      requirementId: first.requirementId,
      goal: "另一份目标",
      completionCriteria: ["另一份标准"],
      route: "direct"
    });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.code, "development_exists");
    assert.equal(duplicate.body.developmentId, one.developmentId);

    // Internal requirements stay ledger-only: no board item appears.
    assert.deepEqual(
      (await request(`/api/projects/${encodeURIComponent(project.projectId)}/board`)).body.entries,
      []
    );

    // An update carries the revision it read; a stale page cannot overwrite it.
    const updated = await request(developmentPath(project.projectId), {
      action: "update",
      developmentId: one.developmentId,
      expectedRevision: 1,
      goal: "同一设备 30 天内免验证，公共设备除外",
      completionCriteria: ["同一设备第二次登录不再要求验证码", "敏感操作仍需验证", "公共设备每次验证"]
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.development.revision, 2);
    assert.equal(updated.body.development.workspace.directory, one.workspace.directory);
    const stale = await request(developmentPath(project.projectId), {
      action: "update",
      developmentId: one.developmentId,
      expectedRevision: 1,
      goal: "过期页面写入"
    });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.code, "revision_conflict");
    assert.equal(stale.body.currentRevision, 2);

    // Backup includes the new shared records; restoring removes the later one.
    const service = await openService(f, engine, (await request("/api/project-data")).body);
    t.after(() => service.close());
    const backupPath = join(f.root, `development-backup-${engine}.json`);
    const backup = await service.service.backupTo(backupPath);
    assert.equal(backup.counts.project_data_developments, 2);
    assert.equal(backup.counts.project_data_development_workspaces, 2);
    assert.equal(backup.counts.project_data_merge_configs, 1);
    const third = await createRequirement(request, project.projectId, "备份后的需求");
    const createdThird = await request(developmentPath(project.projectId), {
      action: "create",
      requirementId: third.requirementId,
      goal: "备份之后新增",
      completionCriteria: ["恢复后不应存在"],
      route: "direct"
    });
    assert.equal(createdThird.status, 201, JSON.stringify(createdThird.body));
    assert.equal((await service.service.queryDevelopments(project.projectId)).length, 3);
    const restored = await service.service.restoreFrom(backupPath);
    assert.equal(restored.counts.project_data_developments, backup.counts.project_data_developments);
    assert.equal((await service.service.queryDevelopments(project.projectId)).length, 2);

    // A restart finds the same identity, baseline, workspace and latest goal.
    await f.restart();
    const afterRestart = await request(
      `${developmentPath(project.projectId)}/${encodeURIComponent(one.developmentId)}`
    );
    assert.equal(afterRestart.status, 200, JSON.stringify(afterRestart.body));
    assert.equal(afterRestart.body.development.developmentId, one.developmentId);
    assert.equal(afterRestart.body.development.goal, "同一设备 30 天内免验证，公共设备除外");
    assert.equal(afterRestart.body.development.revision, 2);
    assert.deepEqual(afterRestart.body.development.baseline, one.baseline);
    assert.equal(afterRestart.body.development.workspace.directory, one.workspace.directory);
    assert.equal(afterRestart.body.development.workspace.branch, one.workspace.branch);
    assert.equal(afterRestart.body.development.workspace.state, "ready");
    assert.equal((await request(developmentPath(project.projectId))).body.developments.length, 2);
    const configAfterRestart = await request(
      `/api/projects/${encodeURIComponent(project.projectId)}/merge-config`
    );
    assert.equal(configAfterRestart.body.mergeConfig.targetBranch, "main");
    assert.deepEqual(await repositoryState(repository), base);

    // Another project never sees or reads this project's record.
    const crossProject = await request(
      `${developmentPath(other.projectId)}/${encodeURIComponent(one.developmentId)}`
    );
    assert.equal(crossProject.status, 404, JSON.stringify(crossProject.body));
  });

  test(`${engine}: a v3 database upgrades to v4 and keeps its records usable`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), `coworkos-p4-upgrade-${engine}-`));
    const moved = await migrateDirectory(t, directory, engine);
    const repository = await makeRepository(join(directory, "repository"));
    const runtime = new ProjectDataRuntime({
      config: moved.config,
      configPath: join(directory, "config.json"),
      dataRoot: directory,
      backendId: "backend_upgrade"
    });
    try {
      const service = await runtime.service();
      assert.equal(service.description.schemaVersion, 4);
      assert.deepEqual(
        (await service.queryRequirements("project_legacy")).map((requirement) => requirement.title),
        ["旧需求"]
      );
      const config = await service.setMergeConfig(
        "project_legacy",
        { repository, targetBranch: "main" },
        "backend_upgrade"
      );
      assert.equal(config.targetBranch, "main");
      const record = await service.createDevelopment("project_legacy", {
        requirementId: "requirement_legacy",
        goal: "升级后记录目标",
        completionCriteria: ["升级后仍可创建"],
        route: "direct",
        baseline: { branch: "main", commit: await git(repository, ["rev-parse", "HEAD"]) }
      });
      assert.equal(record.developmentId.startsWith("development_"), true);
      assert.equal((await service.queryDevelopments("project_legacy")).length, 1);
      const workspace = await service.getDevelopment(
        "project_legacy",
        record.developmentId,
        "backend_upgrade"
      );
      assert.equal(workspace.workspace, undefined, "no workspace was bound yet");
    } finally {
      await runtime.close();
      await moved.cleanup();
    }
  });
}

/**
 * A database that only knows v1..v3, on either engine.
 *
 * It reproduces the shipped versions by applying their statements in order, so
 * the upgrade is observed rather than constructed from the current schema.
 */
async function migrateDirectory(t, directory, engine) {
  if (engine === "sqlite") {
    const path = join(directory, "legacy.sqlite");
    const database = await SqliteDatabase.open(path);
    await seedLegacy(database);
    await database.close();
    return { config: { sqlite: { path } }, cleanup: async () => {} };
  }
  const suffix = randomBytes(4).toString("hex");
  const name = `p4_upgrade_${suffix}`;
  const admin = new pg.Client({ connectionString: postgres.connectionString });
  await admin.connect();
  t.after(() => admin.end().catch(() => undefined));
  await admin.query(`CREATE DATABASE ${name}`);
  const cleanup = async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
  };
  const url = new URL(postgres.connectionString);
  url.pathname = `/${name}`;
  const database = new PostgresDatabase({ connectionString: url.toString() });
  await seedLegacy(database);
  await database.close();
  return { config: { engine, postgres: { connectionString: url.toString() } }, cleanup };
}

async function seedLegacy(database) {
  await database.execute(
    "CREATE TABLE project_data_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  for (const version of [1, 2, 3]) {
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
      "v3 数据不能丢。",
      "internal",
      null,
      "open",
      1,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    ]
  );
}
