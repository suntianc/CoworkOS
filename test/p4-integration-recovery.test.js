import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { startDashboard } from "./dashboard-fixture.mjs";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";
import { createProjectDevelopmentService } from "../dist/src/dashboard/project-development-service.js";
import { createProjectDevelopmentController } from "../web/assets/controllers/project-development.js";

const run = promisify(execFile);
const git = (cwd, args) =>
  run("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((result) => result.stdout.trim());

const waitFor = async (check, message, timeout = 30_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(message);
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function servingInstance(root) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const instance = await readBackendInstance(backendPaths(join(root, "home")));
    if (instance.value?.token && instance.value.backendId) return instance.value;
    await delay(25);
  }
  assert.fail("the backend did not publish its local credential");
}

const client = (dashboard) => async (path, body, method) => {
  const response = await fetch(`${dashboard.base}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
};

/** A repository with a committed baseline plus the user's own dirty work. */
async function makeDirtyRepository(directory) {
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.email", "fixture@example.test"]);
  await git(directory, ["config", "user.name", "Fixture"]);
  await writeFile(join(directory, "baseline.txt"), "baseline\n");
  await writeFile(join(directory, "shared.txt"), "base\n");
  await writeFile(join(directory, "tracked.txt"), "committed\n");
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "baseline"]);
  // The user's reserved work: a modified tracked file, a staged new file and
  // an untracked file. None of it may be overwritten by a merge or a recovery.
  await writeFile(join(directory, "tracked.txt"), "committed\nlocal edit\n");
  await writeFile(join(directory, "reserved.txt"), "reserved for the next change\n");
  await git(directory, ["add", "reserved.txt"]);
  await writeFile(join(directory, "untracked.txt"), "never committed\n");
  return directory;
}

async function dirtyState(repository) {
  return {
    tracked: await readFile(join(repository, "tracked.txt"), "utf8"),
    reserved: await readFile(join(repository, "reserved.txt"), "utf8"),
    untracked: await readFile(join(repository, "untracked.txt"), "utf8"),
    status: await git(repository, ["status", "--porcelain=v1"])
  };
}

async function makeRepositoryCommit(directory, name, content) {
  await writeFile(join(directory, name), content);
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", content]);
  return git(directory, ["rev-parse", "HEAD"]);
}

/**
 * A crashed merge, a real same-file conflict, a failed combined check and a
 * waiting request all keep locatable shared facts, and recovery completes the
 * missing record without merging twice.
 *
 * The execution location is a real secondary Dashboard process. The crash is a
 * real SIGKILL between its target update and its record write; after restart it
 * reads the persisted operation identity and the actual branch, then completes
 * the same merge. The user's dirty files, prior merges and unmerged branches
 * stay intact, and the production controller distinguishes every state.
 */
test(
  "a crashed, conflicted and check-failed merge leaves reconcilable facts",
  { timeout: 300_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-p4-recovery-"));
    const repository = await makeDirtyRepository(join(root, "repository"));
    const baseline = await git(repository, ["rev-parse", "HEAD"]);
    const before = await dirtyState(repository);
    const authority = await startDashboard({ defaultProject: false });
    t.after(async () => {
      await authority.stop();
      await rm(root, { recursive: true, force: true });
    });
    const request = client(authority);
    const project = (
      await request("/api/projects", { projectName: "恢复项目", projectDirectory: repository })
    ).body.project;
    const authorityInstance = await servingInstance(authority.root);
    // The shared project identity exists before a secondary backend reads it.
    const runtime = new ProjectDataRuntime({
      config: { sqlite: { path: (await request("/api/project-data", undefined, "GET")).body.target } },
      configPath: join(authority.root, "config.json"),
      dataRoot: authority.root,
      env: {}
    });
    t.after(() => runtime.close());
    const gateway = await runtime.service();
    await gateway.ensureProject({
      projectId: project.projectId,
      projectName: project.projectName,
      projectDirectory: repository,
      backendId: authorityInstance.backendId
    });

    // The execution location is its own backend process with its own data root.
    const execution = await startDashboard({
      defaultProject: false,
      config: { projectData: { authority: { url: authority.base, token: authorityInstance.token } } },
      env: { COWORK_MERGE_FAULT_INJECT: "crash:*@after-apply" }
    });
    t.after(() => execution.stop());
    const executionInstance = await servingInstance(execution.root);
    const configured = await client(execution)(
      `/api/projects/${encodeURIComponent(project.projectId)}/merge-config`,
      { repository, targetBranch: "main" }
    );
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    assert.equal(configured.body.mergeConfig.executionBackendId, executionInstance.backendId);

    // The requesting Main works in its own checkout under the authority's root.
    const main = createProjectDevelopmentService({
      runtime: { service: async () => gateway },
      backendId: authorityInstance.backendId,
      startedAt: "started-main",
      developmentRoot: join(authority.root, "development-workspaces"),
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
    const development = async (title) => {
      const requirement = (
        await request(`/api/projects/${encodeURIComponent(project.projectId)}/ledger`, {
          action: "create",
          title,
          content: `${title}的内容`
        })
      ).body.requirement;
      const record = await main.create(project.projectId, {
        requirementId: requirement.requirementId,
        goal: title,
        completionCriteria: ["observable result"],
        route: "quick"
      });
      assert.equal(record.workspace.state, "ready", JSON.stringify(record.workspace));
      return record;
    };
    const selfPlan = (record, command) =>
      main.setReviewPlan(project.projectId, {
        developmentId: record.developmentId,
        channel: "self",
        basis: "Main 在本版本自查",
        checks: [{ name: "自检", command, exitCode: 0, output: "" }]
      });
    const mergeRequest = (record, checks) =>
      client(authority)(`/api/projects/${encodeURIComponent(project.projectId)}/merges`, {
        action: "request",
        developmentId: record.developmentId,
        checks
      });
    const apply = () =>
      client(execution)(`/api/projects/${encodeURIComponent(project.projectId)}/merges`, {
        action: "apply"
      });
    const operations = async (record) =>
      (
        await client(authority)(`/api/projects/${encodeURIComponent(project.projectId)}/merges`, {
          action: "query",
          ...(record ? { developmentId: record.developmentId } : {})
        })
      ).body.merges;

    // --- the crash window -----------------------------------------------------
    const crash = await development("崩溃窗口");
    await makeRepositoryCommit(crash.workspace.directory, "crash.txt", "crashed but applied\n");
    await selfPlan(crash, "test -f crash.txt");
    const crashRequest = await mergeRequest(crash, [{ name: "组合检查", command: "test -f crash.txt" }]);
    assert.equal(crashRequest.status, 200, JSON.stringify(crashRequest.body));
    assert.equal(crashRequest.body.merge.state, "waiting");

    // The execution process is killed after the target moved and before its
    // record was written; the HTTP call therefore never receives a body.
    const crashed = await apply().catch(() => undefined);
    assert.equal(crashed, undefined, "the killed backend cannot answer");
    await waitFor(() => !alive(executionInstance.pid), "the execution backend was not killed");
    await assert.rejects(
      fetch(`${execution.base}/api/tasks`, { signal: AbortSignal.timeout(3_000) }),
      "the dead backend no longer serves"
    );

    const applying = (await operations(crash))[0];
    assert.equal(applying.state, "applying", JSON.stringify(applying));
    assert.ok(applying.mergeCommit, "the operation recorded the commit it published");
    assert.equal(applying.expectedTarget, baseline);
    assert.equal(applying.receipt, undefined, "the record is not complete yet");
    assert.equal(await git(repository, ["rev-parse", "main"]), applying.mergeCommit);
    assert.deepEqual(await dirtyState(repository), before, "the user's reserved work survived the crash");

    // The controller shows the committed-but-unrecorded window as pending sync.
    const previousGlobals = { window: globalThis.window, document: globalThis.document, CSS: globalThis.CSS };
    t.after(() => {
      for (const [key, value] of Object.entries(previousGlobals)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    });
    const { window, document } = parseHTML(readFileSync("web/index.html", "utf8"));
    globalThis.window = window;
    globalThis.document = document;
    globalThis.CSS = { escape: (value) => value };
    window.HTMLElement.prototype.getClientRects ??= () => [];
    const api = (requestPath, options) =>
      fetch(`${authority.base}${requestPath}`, {
        method: options?.method ?? (options?.body === undefined ? "GET" : "POST"),
        headers: options?.headers ?? { "content-type": "application/json" },
        ...(options?.body === undefined ? {} : { body: options.body })
      }).then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw Object.assign(new Error(body.error ?? "请求失败"), { status: response.status });
        return body;
      });
    const state = {
      projects: [{ ...project, tasks: [] }],
      selectedProjectId: project.projectId,
      selected: undefined
    };
    const controller = createProjectDevelopmentController({ api, state });
    controller.open(project.projectId);
    await waitFor(
      () => document.querySelectorAll("[data-list] button").length > 0,
      "developments did not load"
    );
    const detail = () => document.querySelector("[data-detail]");
    await controller.selectDevelopment(crash.developmentId);
    await waitFor(
      () => /待同步/.test(detail().textContent),
      "the applying operation was not shown as pending sync"
    );

    // Restarting the execution backend with a new process identity reconciles
    // the same merge instead of creating a second one.
    delete execution.env.COWORK_MERGE_FAULT_INJECT;
    await execution.restart();
    let restartedInstance;
    await waitFor(async () => {
      const found = await readBackendInstance(backendPaths(join(execution.root, "home")));
      if (!found.value || found.value.pid === executionInstance.pid) return false;
      restartedInstance = found.value;
      return true;
    }, "the restarted execution backend did not publish a new process identity");
    assert.notEqual(restartedInstance.pid, executionInstance.pid);
    const recovered = await apply();
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    const recoveredCrash = (await operations(crash))[0];
    assert.equal(recoveredCrash.state, "merged", JSON.stringify(recoveredCrash));
    assert.equal(recoveredCrash.mergeCommit, applying.mergeCommit);
    assert.equal(recoveredCrash.receipt.mergedCommit, applying.mergeCommit);
    assert.equal(await git(repository, ["rev-list", "--count", "--first-parent", `${baseline}..main`]), "1");
    assert.deepEqual(await dirtyState(repository), before);

    const retried = await mergeRequest(crash, [{ name: "组合检查", command: "test -f crash.txt" }]);
    assert.equal(retried.body.merge.mergeId, recoveredCrash.mergeId);
    assert.equal(retried.body.merge.mergeCommit, recoveredCrash.mergeCommit);
    assert.equal(await git(repository, ["rev-list", "--count", "--first-parent", `${baseline}..main`]), "1");

    // --- a real same-file conflict -------------------------------------------
    // Both requirements branch from the same tip before either merges, so their
    // edits to shared.txt are a real same-file conflict at merge time.
    const first = await development("先合入的改动");
    const conflicting = await development("冲突的改动");
    assert.equal(first.baseline.commit, conflicting.baseline.commit);
    await makeRepositoryCommit(first.workspace.directory, "shared.txt", "first\n");
    await selfPlan(first, "test -f shared.txt");
    await makeRepositoryCommit(conflicting.workspace.directory, "shared.txt", "second\n");
    await selfPlan(conflicting, "test -f shared.txt");
    const firstRequest = await mergeRequest(first, [{ name: "组合检查", command: "test -f shared.txt" }]);
    assert.equal(firstRequest.status, 200, JSON.stringify(firstRequest.body));
    const firstApplied = await apply();
    assert.equal(firstApplied.status, 200, JSON.stringify(firstApplied.body));
    const firstMerged = (await operations(first))[0];
    assert.equal(firstMerged.state, "merged", JSON.stringify(firstMerged));
    assert.equal(await readFile(join(repository, "shared.txt"), "utf8"), "first\n");
    const tipAfterFirst = await git(repository, ["rev-parse", "main"]);

    const conflictingRequest = await mergeRequest(conflicting, [
      { name: "组合检查", command: "test -f shared.txt" }
    ]);
    assert.equal(conflictingRequest.status, 200, JSON.stringify(conflictingRequest.body));
    const conflictingApplied = await apply();
    assert.equal(conflictingApplied.status, 200, JSON.stringify(conflictingApplied.body));
    const conflict = (await operations(conflicting))[0];
    assert.equal(conflict.state, "conflict", JSON.stringify(conflict));
    assert.match(conflict.detail, /shared\.txt/);
    assert.equal(
      await git(repository, ["rev-parse", "main"]),
      tipAfterFirst,
      "a conflict does not move the target"
    );
    assert.equal(await readFile(join(repository, "shared.txt"), "utf8"), "first\n");
    assert.equal(await readFile(join(conflicting.workspace.directory, "shared.txt"), "utf8"), "second\n");
    assert.deepEqual(await dirtyState(repository), before);

    // --- a failed combined check ---------------------------------------------
    const failing = await development("检查失败");
    await makeRepositoryCommit(failing.workspace.directory, "check.txt", "checked\n");
    await selfPlan(failing, "test -f check.txt");
    const failingRequest = await mergeRequest(failing, [
      { name: "组合检查", command: "printf 'combined check failed\\n' >&2; exit 2" }
    ]);
    assert.equal(failingRequest.status, 200, JSON.stringify(failingRequest.body));
    const failingApplied = await apply();
    assert.equal(failingApplied.status, 200, JSON.stringify(failingApplied.body));
    const checkFailed = (await operations(failing))[0];
    assert.equal(checkFailed.state, "check_failed", JSON.stringify(checkFailed));
    assert.match(checkFailed.detail, /组合检查/);
    assert.equal(checkFailed.checks[0].exitCode, 2);
    assert.match(checkFailed.checks[0].output, /combined check failed/);
    assert.equal(await git(repository, ["rev-parse", "main"]), tipAfterFirst);
    assert.equal(await readFile(join(failing.workspace.directory, "check.txt"), "utf8"), "checked\n");
    assert.deepEqual(await dirtyState(repository), before);

    // --- a queued request and the other requirement's site --------------------
    const waiting = await development("等待中的改动");
    await makeRepositoryCommit(waiting.workspace.directory, "waiting.txt", "queued\n");
    await selfPlan(waiting, "test -f waiting.txt");
    const waitingRequest = await mergeRequest(waiting, [
      { name: "组合检查", command: "test -f waiting.txt" }
    ]);
    assert.equal(waitingRequest.body.merge.state, "waiting");

    // The production controller separates merged, conflict, check failure,
    // pending sync and waiting, and the conflicted requirement's own site can
    // still be continued after its merge failed.
    const labels = [
      [crash, /已合入/],
      [conflicting, /合入冲突/],
      [failing, /检查未通过/],
      [waiting, /等待合入/]
    ];
    for (const [record, expected] of labels) {
      await controller.selectDevelopment(record.developmentId);
      await waitFor(
        () => expected.test(detail().textContent),
        `${record.developmentId} did not render ${expected}`
      );
      assert.match(detail().textContent, expected);
    }
    await controller.selectDevelopment(conflicting.developmentId);
    await waitFor(() => /合入冲突/.test(detail().textContent), "the conflict did not render");
    detail().querySelector("[data-continue]").click();
    await waitFor(
      () => /现场就绪/.test(detail().textContent),
      "the conflicted requirement's site was not continued"
    );
    assert.equal(await readFile(join(conflicting.workspace.directory, "shared.txt"), "utf8"), "second\n");
    assert.equal((await operations(waiting))[0].state, "waiting", "an unrelated request is still queued");
    assert.deepEqual(await dirtyState(repository), before);

    // The reconciled receipt is idempotent for the delivery ticket: one
    // operation per development, the same merge commit, no duplicate target
    // commit and a readable reason for every refused attempt.
    const all = await operations();
    assert.equal(new Set(all.map((entry) => entry.mergeId)).size, all.length);
    const merged = all.filter((entry) => entry.state === "merged");
    assert.equal(merged.length, 2, "only the crash and the first independent change merged");
    for (const entry of merged) assert.equal(entry.receipt.mergedCommit, entry.mergeCommit);
  }
);
