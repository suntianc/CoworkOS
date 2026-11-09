import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { startDashboard } from "./dashboard-fixture.mjs";
import { createProjectCloneService } from "../dist/src/dashboard/project-clone-service.js";

const run = promisify(execFile);
const git = (cwd, args) =>
  run("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((result) => result.stdout.trim());

async function request(dashboard, path, { method = "GET", body } = {}) {
  const response = await fetch(`${dashboard.base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}

async function projects(dashboard) {
  return (await request(dashboard, "/api/tasks")).body.projects ?? [];
}

async function waitForClone(dashboard, cloneId, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let clone;
  for (;;) {
    const result = await request(dashboard, `/api/project-clones/${encodeURIComponent(cloneId)}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    clone = result.body.clone;
    if (predicate(clone)) return clone;
    if (Date.now() > deadline)
      throw new Error(`clone did not reach the expected state: ${JSON.stringify(clone)}`);
    await delay(50);
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** One real repository with `main` and a `release` branch, plus a bare copy. */
async function seedRepository(root) {
  const work = join(root, "seed");
  await mkdir(work, { recursive: true });
  await git(work, ["init", "-b", "main"]);
  await git(work, ["config", "user.email", "fixture@example.test"]);
  await git(work, ["config", "user.name", "Fixture"]);
  await writeFile(join(work, "README.md"), "克隆夹具\n");
  await git(work, ["add", "."]);
  await git(work, ["commit", "-m", "initial"]);
  await git(work, ["checkout", "-b", "release"]);
  await writeFile(join(work, "release.txt"), "release branch\n");
  await git(work, ["add", "."]);
  await git(work, ["commit", "-m", "release"]);
  await git(work, ["checkout", "main"]);
  const bare = join(root, "remote.git");
  await run("git", ["clone", "--bare", work, bare], { maxBuffer: 8 * 1024 * 1024 });
  return bare;
}

/** A Git stand-in for the paths a real repository cannot hold for long enough. */
async function fakeGit(root) {
  const directory = join(root, "bin");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "git");
  await writeFile(
    path,
    `#!/bin/sh\ntrap 'echo term > "$GIT_TERM_MARKER"; exit 1' TERM INT\nfor arg in "$@"; do\n  case "$arg" in\n    *denied*)\n      echo "git@example.test: Permission denied (publickey)." >&2\n      exit 128;;\n    *slow*)\n      echo "Cloning into 'website'..." >&2\n      sleep 0.2\n      echo "Receiving objects:  42% (42/100)" >&2\n      sleep 60\n      exit 0;;\n    *cred*)\n      echo "fatal: unable to access '$arg': repository not found" >&2\n      exit 128;;\n  esac\ndone\nexit 1\n`
  );
  await run("chmod", ["755", path]);
  return { directory, path };
}

test("clones a branch from a file URL, reports progress and registers the project", async (t) => {
  const dashboard = await startDashboard({ defaultProject: false });
  t.after(() => dashboard.stop());
  const bare = await seedRepository(dashboard.root);
  const destination = join(dashboard.root, "website");
  const started = await request(dashboard, "/api/project-clones", {
    method: "POST",
    body: { remoteUrl: `file://${bare}`, destination, branch: "release" }
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal(started.body.clone.state, "cloning");
  assert.equal(started.body.clone.progress, 0);

  const done = await waitForClone(
    dashboard,
    started.body.clone.cloneId,
    (clone) => clone.state === "completed"
  );
  assert.equal(done.progress, 100);
  assert.equal(done.project.projectDirectory, destination);
  assert.equal(done.project.projectName, "website");
  assert.match(done.project.projectId, /^project_[a-f0-9-]{36}$/);
  assert.equal(await readFile(join(destination, "release.txt"), "utf8"), "release branch\n");
  assert.deepEqual(
    (await projects(dashboard)).map((project) => project.projectId),
    [done.project.projectId]
  );
});

test("clones a local path with the default branch", async (t) => {
  const dashboard = await startDashboard({ defaultProject: false });
  t.after(() => dashboard.stop());
  const bare = await seedRepository(dashboard.root);
  const destination = join(dashboard.root, "local-clone");
  const started = await request(dashboard, "/api/project-clones", {
    method: "POST",
    body: { remoteUrl: bare, destination }
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const done = await waitForClone(
    dashboard,
    started.body.clone.cloneId,
    (clone) => clone.state === "completed"
  );
  assert.equal(await readFile(join(destination, "README.md"), "utf8"), "克隆夹具\n");
  assert.equal(await exists(join(destination, ".git")), true);
  assert.equal(done.project.projectName, "local-clone");
  assert.equal((await projects(dashboard)).length, 1);
});

test("refuses an existing target and registers nothing", async (t) => {
  const dashboard = await startDashboard({ defaultProject: false });
  t.after(() => dashboard.stop());
  const destination = join(dashboard.root, "taken");
  await mkdir(destination);
  const result = await request(dashboard, "/api/project-clones", {
    method: "POST",
    body: { remoteUrl: join(dashboard.root, "remote.git"), destination }
  });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.match(result.body.error, /已存在/);
  assert.deepEqual(await projects(dashboard), []);
});

test("an address that is not a repository fails readably and leaves no folder or project", async (t) => {
  const dashboard = await startDashboard({ defaultProject: false });
  t.after(() => dashboard.stop());
  const destination = join(dashboard.root, "missing-clone");
  const started = await request(dashboard, "/api/project-clones", {
    method: "POST",
    body: { remoteUrl: join(dashboard.root, "missing.git"), destination }
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const failed = await waitForClone(
    dashboard,
    started.body.clone.cloneId,
    (clone) => clone.state === "failed"
  );
  assert.match(failed.error, /does not exist|not a git repository|不存在|not found/i);
  assert.equal(await exists(destination), false);
  assert.deepEqual(await projects(dashboard), []);
});

test("an authentication failure is reported without registering a project", async (t) => {
  const root = await mkdtempForTest();
  const ssh = join(root, "fake-ssh");
  await writeFile(ssh, `#!/bin/sh\necho "Permission denied (publickey)." >&2\nexit 255\n`);
  await run("chmod", ["755", ssh]);
  const dashboard = await startDashboard({
    defaultProject: false,
    env: { GIT_SSH_COMMAND: ssh }
  });
  t.after(() => dashboard.stop());
  const destination = join(dashboard.root, "private-clone");
  const started = await request(dashboard, "/api/project-clones", {
    method: "POST",
    body: { remoteUrl: "ssh://git@example.test/acme/website.git", destination }
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const failed = await waitForClone(
    dashboard,
    started.body.clone.cloneId,
    (clone) => clone.state === "failed"
  );
  assert.match(failed.error, /Permission denied \(publickey\)/);
  assert.equal(await exists(destination), false);
  assert.deepEqual(await projects(dashboard), []);
});

test("reports clone progress and cancelling stops git and removes the incomplete folder", async (t) => {
  const root = await mkdtempForTest();
  const fake = await fakeGit(root);
  const dashboard = await startDashboard({
    defaultProject: false,
    env: {
      PATH: `${fake.directory}:${process.env.PATH}`,
      GIT_TERM_MARKER: join(root, "terminated.marker")
    }
  });
  t.after(() => dashboard.stop());
  const destination = join(dashboard.root, "slow-clone");
  const started = await request(dashboard, "/api/project-clones", {
    method: "POST",
    body: { remoteUrl: "https://example.test/slow.git", destination }
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const cloneId = started.body.clone.cloneId;
  const progressed = await waitForClone(dashboard, cloneId, (clone) => clone.progress >= 42);
  assert.equal(progressed.state, "cloning");
  assert.equal(await exists(destination), true);

  const cancelled = await request(dashboard, `/api/project-clones/${cloneId}/cancel`, { method: "POST" });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.clone.state, "cancelled");
  assert.equal(await exists(destination), false);
  assert.equal(await readFile(join(root, "terminated.marker"), "utf8"), "term\n");
  assert.deepEqual(await projects(dashboard), []);
});

test("one operation id returns its clone and refuses different content", async (t) => {
  const root = await mkdtempForTest();
  const fake = await fakeGit(root);
  const dashboard = await startDashboard({
    defaultProject: false,
    env: { PATH: `${fake.directory}:${process.env.PATH}` }
  });
  const destination = join(dashboard.root, "operation-clone");
  const body = {
    remoteUrl: "https://example.test/slow.git",
    destination,
    operationId: "clone-operation-1"
  };
  try {
    const first = await request(dashboard, "/api/project-clones", { method: "POST", body });
    const again = await request(dashboard, "/api/project-clones", { method: "POST", body });
    assert.equal(first.status, 202);
    assert.equal(again.body.clone.cloneId, first.body.clone.cloneId);
    const conflict = await request(dashboard, "/api/project-clones", {
      method: "POST",
      body: { ...body, destination: join(dashboard.root, "other-clone") }
    });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.match(conflict.body.error, /操作标识/);
    await request(dashboard, `/api/project-clones/${first.body.clone.cloneId}/cancel`, { method: "POST" });
  } finally {
    await dashboard.stop();
  }
});

test("recovery fails an interrupted clone, removes its folder and registers nothing", async (t) => {
  const root = await mkdtempForTest();
  const fake = await fakeGit(root);
  const dataRoot = join(root, "project-clones");
  const destination = join(root, "crash-clone");
  const created = [];
  const first = createProjectCloneService({
    dataRoot,
    gitCommand: fake.path,
    createProject: async (input) => {
      created.push(input);
      return { projectId: "project_crash", ...input };
    }
  });
  t.after(() => first.stop());
  const started = await first.start({ remoteUrl: "https://example.test/slow.git", destination });
  assert.equal(started.state, "cloning");
  assert.equal(await exists(destination), true);

  // A new process reads the same durable record; no live process owns it there.
  const second = createProjectCloneService({
    dataRoot,
    gitCommand: fake.path,
    createProject: async (input) => {
      created.push(input);
      return { projectId: "project_crash", ...input };
    }
  });
  await second.ready;
  const recovered = await second.status(started.cloneId);
  assert.equal(recovered.state, "failed");
  assert.match(recovered.error, /中断/);
  assert.equal(await exists(destination), false);
  assert.deepEqual(created, []);
  await second.stop();
});

test("a credential embedded in the remote URL never reaches a response or the clone record", async (t) => {
  const root = await mkdtempForTest();
  const fake = await fakeGit(root);
  const dashboard = await startDashboard({
    defaultProject: false,
    env: { PATH: `${fake.directory}:${process.env.PATH}` }
  });
  t.after(() => dashboard.stop());
  const destination = join(dashboard.root, "private-address");
  const started = await request(dashboard, "/api/project-clones", {
    method: "POST",
    body: { remoteUrl: "https://user:secret-token@example.test/acme/cred.git", destination }
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const failed = await waitForClone(
    dashboard,
    started.body.clone.cloneId,
    (clone) => clone.state === "failed"
  );
  assert.doesNotMatch(JSON.stringify(failed), /secret-token/);
  assert.match(failed.error, /example\.test/);
  const records = await readdir(join(dashboard.root, "project-clones"));
  for (const name of records) {
    const content = await readFile(join(dashboard.root, "project-clones", name), "utf8");
    assert.doesNotMatch(content, /secret-token/);
    assert.doesNotMatch(content, /user:/);
  }
});

function mkdtempForTest() {
  return mkdtemp(join(tmpdir(), "project-clone-test-"));
}
