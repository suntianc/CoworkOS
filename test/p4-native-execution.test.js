import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { teamMembers } from "../web/assets/agent-room.js";
import { prepareDevelopmentWorkspace } from "../dist/src/workspace/development-workspace.js";
import { prepareWorkItemSite } from "../dist/src/workspace/work-item-workspace.js";

const run = promisify(execFile);
const messageText = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("");
const lastToolText = (body) => messageText(body.messages.findLast((message) => message.role === "tool"));
const toolJson = (body) =>
  JSON.parse(messageText(body.messages.findLast((message) => message.role === "tool")));
const userText = (body) =>
  body.messages
    .filter((message) => message.role === "user")
    .map(messageText)
    .join("\n");

const git = (cwd, args) =>
  run("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((result) => result.stdout.trim());

const client = (dashboard) => async (path, body, method) => {
  const response = await fetch(`${dashboard.base}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
};

const waitFor = async (check, message, timeout = 30_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(message);
};

const settle = async (request, taskId, timeout = 90_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const detail = await request(`/api/tasks/${taskId}`);
    if (detail.status === 200 && !detail.body.runtime.active && detail.body.task.status === "completed")
      return detail.body;
    await delay(50);
  }
  assert.fail(`Main ${taskId} did not settle`);
};

async function makeRepository(directory) {
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.email", "fixture@example.test"]);
  await git(directory, ["config", "user.name", "Fixture"]);
  await writeFile(join(directory, "tracked.txt"), "committed\n");
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "baseline"]);
  return directory;
}

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false
  );

/**
 * Main, Executor and Reviewer work items on the real path.
 *
 * The model is a scripted local provider, but everything around it is
 * production: a spawned Main process, the real `project_development` and
 * `call_subagent` tools, the real Coordinator with its durable queue and
 * callbacks, real `git worktree`s, the Dashboard API and the web controller the
 * UI renders work items from.
 */
test(
  "a real Main edits the requirement checkout directly and runs isolated role work items",
  { timeout: 240_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-p4-native-"));
    const repository = await makeRepository(join(root, "repository"));
    const baselineHead = await git(repository, ["rev-parse", "HEAD"]);
    const dashboard = await startDashboard({
      defaultProject: false,
      env: { COWORK_PROJECT_WRITE: "1", COWORK_DISABLE_WATCH_SUPERVISOR: "1" }
    });
    t.after(async () => {
      await dashboard.stop();
      await rm(root, { recursive: true, force: true });
    });
    const request = client(dashboard);
    const created = await request("/api/projects", {
      projectName: "原生执行项目",
      projectDirectory: repository
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const project = created.body.project;
    const requirement = await request(`/api/projects/${encodeURIComponent(project.projectId)}/ledger`, {
      action: "create",
      title: "报表页加导出按钮",
      content: "用户希望导出当前报表。"
    });
    assert.equal(requirement.status, 201, JSON.stringify(requirement.body));
    const merge = await request(`/api/projects/${encodeURIComponent(project.projectId)}/merge-config`, {
      repository,
      targetBranch: "main"
    });
    assert.equal(merge.status, 200, JSON.stringify(merge.body));
    const taskId = "native-execution";
    const task = await request("/api/tasks", {
      taskId,
      goal: "完成报表导出需求",
      projectId: project.projectId
    });
    assert.equal(task.status, 201, JSON.stringify(task.body));

    const failures = [];
    const requests = { main: 0, a: 0, b: 0, c: 0, d: 0 };
    const calls = {};
    let integration = "";
    let developmentId = "";
    // Both parallel Executors are in flight before the dependent one can start.
    const arrived = new Set();
    let release;
    const gate = new Promise((done) => {
      release = done;
    });
    let failTest;
    const scriptFailure = new Promise((_, reject) => {
      failTest = reject;
    });
    const identity = (body) => {
      const system = body.messages
        .filter((message) => ["system", "developer"].includes(message.role))
        .map(messageText)
        .join("\n");
      if (!system.includes("You are a CoworkOS Subagent")) return "main";
      const text = userText(body);
      const match = text.match(/工作项 ([A-D])/);
      return match ? match[1].toLowerCase() : "unknown";
    };
    const provider = await modelProtocolFixture("openai-completions", async (body) => {
      try {
        const role = identity(body);
        const step = requests[role]++;
        if (role === "main") {
          if (step === 0) {
            assert.ok(body.tools.some((tool) => tool.function.name === "project_development"));
            assert.ok(body.tools.some((tool) => tool.function.name === "call_subagent"));
            return {
              name: "project_development",
              arguments: {
                action: "create",
                requirementId: requirement.body.requirement.requirementId,
                goal: "报表页提供导出当前报表的入口",
                completionCriteria: ["点击导出得到当前报表文件"],
                route: "direct"
              }
            };
          }
          if (step === 1) {
            const development = toolJson(body).development;
            assert.equal(development.workspace.state, "ready");
            integration = development.workspace.directory;
            developmentId = development.developmentId;
            assert.ok(
              !integration.startsWith(`${repository}/`),
              "the requirement checkout is outside the user's working tree"
            );
            return {
              name: "write",
              arguments: { path: join(integration, "feature.txt"), content: "main edit\n" }
            };
          }
          if (step === 2)
            return {
              name: "bash",
              arguments: {
                command: `cd "${integration}" && test "$(cat feature.txt)" = "main edit" && echo CHECK_OK`
              }
            };
          if (step === 3) {
            assert.match(
              lastToolText(body),
              /CHECK_OK/,
              "Main verified its own edit in the integration site"
            );
            return {
              name: "call_subagent",
              arguments: {
                task: "执行者工作项 A：在需求现场新增 export-a.txt 与 shared.txt 并返回证据。",
                mode: "async",
                role: "executor",
                developmentId
              }
            };
          }
          if (step === 4) {
            calls.a = toolJson(body);
            assert.equal(calls.a.accepted, true);
            assert.equal(calls.a.role, "executor");
            assert.notEqual(calls.a.workspace, integration, "a work item does not get the integration site");
            return {
              name: "call_subagent",
              arguments: {
                task: "执行者工作项 B：在需求现场新增 export-b.txt 与 shared.txt 并返回证据。",
                mode: "async",
                role: "executor",
                developmentId
              }
            };
          }
          if (step === 5) {
            calls.b = toolJson(body);
            assert.notEqual(calls.b.workspace, calls.a.workspace, "parallel items get their own checkouts");
            return {
              name: "call_subagent",
              arguments: {
                task: "执行者工作项 D：在 A 完成后新增 export-d.txt 并返回证据。",
                mode: "async",
                role: "executor",
                developmentId,
                dependsOn: [calls.a.callId]
              }
            };
          }
          if (step === 6) {
            calls.d = toolJson(body);
            assert.deepEqual(calls.d.dependsOn, [calls.a.callId]);
            return { name: "get_subagent_status", arguments: {} };
          }
          if (step === 7) {
            const status = toolJson(body);
            const byCall = new Map(status.agents.map((agent) => [agent.callId, agent]));
            const waiting = byCall.get(calls.d.callId);
            assert.equal(waiting.role, "executor");
            assert.equal(waiting.blocked, true, "a work item with unfinished prerequisites is blocked");
            assert.deepEqual(waiting.dependsOn, [calls.a.callId]);
            assert.equal(waiting.status, "queued");
            assert.equal(waiting.workspace, calls.d.workspace);
            const held = byCall.get(calls.a.callId);
            assert.equal(held.status, "running", "the first Executor is held at its model request");
            const free = byCall.get(calls.b.callId);
            assert.ok(["running", "succeeded"].includes(free.status), free.status);
            for (const call of [calls.a, calls.b]) {
              const running = byCall.get(call.callId);
              assert.equal(running.blocked, undefined);
              assert.notEqual(running.workspace, integration);
            }
            assert.notEqual(byCall.get(calls.a.callId).workspace, byCall.get(calls.b.callId).workspace);
            // Both parallel Executors are working before either may answer.
            await waitFor(
              () => arrived.size === 2,
              "both independent Executors never reached the model together"
            );
            release();
            return {
              name: "wait_for_subagents",
              arguments: { callIds: [calls.a.callId, calls.b.callId], timeoutMs: 60_000 }
            };
          }
          if (step === 8) {
            const waited = toolJson(body);
            assert.deepEqual(waited.pending, []);
            assert.equal(waited.timedOut, false);
            for (const call of [calls.a, calls.b])
              assert.equal(waited.calls.find((entry) => entry.callId === call.callId).status, "completed");
            return {
              name: "bash",
              arguments: {
                command: [
                  "set -e",
                  `cd "${integration}"`,
                  `cp "${calls.a.workspace}/export-a.txt" .`,
                  `cp "${calls.b.workspace}/export-b.txt" .`,
                  `cp "${calls.a.workspace}/shared.txt" shared-a.txt`,
                  `cp "${calls.b.workspace}/shared.txt" shared-b.txt`,
                  "git add -A",
                  'git commit -m "collect A and B" >/dev/null',
                  "echo COLLECTED"
                ].join(" && ")
              }
            };
          }
          if (step === 9) {
            assert.match(lastToolText(body), /COLLECTED/);
            return { name: "get_subagent_status", arguments: {} };
          }
          if (step === 10) {
            const status = toolJson(body);
            const dependent = status.agents.find((agent) => agent.callId === calls.d.callId);
            assert.equal(dependent.blocked, undefined, "a finished prerequisite unblocks the dependent item");
            assert.ok(["running", "succeeded"].includes(dependent.status), dependent.status);
            return {
              name: "wait_for_subagents",
              arguments: { callIds: [calls.d.callId], timeoutMs: 60_000 }
            };
          }
          if (step === 11) {
            const waited = toolJson(body);
            assert.equal(waited.calls.find((entry) => entry.callId === calls.d.callId).status, "completed");
            return {
              name: "bash",
              arguments: {
                command: [
                  "set -e",
                  `cd "${integration}"`,
                  `cp "${calls.d.workspace}/export-d.txt" .`,
                  "git add -A",
                  'git commit -m "collect D" >/dev/null',
                  "echo COLLECTED_D"
                ].join(" && ")
              }
            };
          }
          if (step === 12) {
            assert.match(lastToolText(body), /COLLECTED_D/);
            return {
              name: "call_subagent",
              arguments: {
                task: "审查者工作项 C：核对汇总现场中的导出产物并返回结论。",
                mode: "async",
                role: "reviewer",
                developmentId
              }
            };
          }
          if (step === 13) {
            calls.c = toolJson(body);
            assert.equal(calls.c.role, "reviewer");
            assert.notEqual(calls.c.workspace, integration);
            return {
              name: "wait_for_subagents",
              arguments: { callIds: [calls.c.callId], timeoutMs: 60_000 }
            };
          }
          if (step === 14) {
            const waited = toolJson(body);
            assert.equal(waited.calls.find((entry) => entry.callId === calls.c.callId).status, "completed");
            // Reread this async call's stored result through the documented path.
            return { name: "get_task_status", arguments: { resultCallIds: [calls.c.callId] } };
          }
          if (step === 15) {
            const status = toolJson(body);
            const reviewer = status.coordination.calls.find((entry) => entry.callId === calls.c.callId);
            assert.equal(reviewer.status, "completed", JSON.stringify(status).slice(0, 800));
            assert.match(reviewer.response, /export-a\.txt/);
            assert.match(reviewer.response, /export-b\.txt/);
            assert.match(reviewer.response, /export-d\.txt/);
            return { text: "需求已实现并通过检查。" };
          }
          return { text: "需求已实现并通过检查。" };
        }
        if (role === "a") {
          if (step === 0) {
            arrived.add("A");
            await gate;
            return { name: "write_file", arguments: { path: "export-a.txt", content: "executor a\n" } };
          }
          if (step === 1) return { name: "write_file", arguments: { path: "shared.txt", content: "a\n" } };
          return { text: "A 完成：已写入 export-a.txt 与 shared.txt。" };
        }
        if (role === "b") {
          if (step === 0) {
            assert.ok(arrived.has("A"), "A was already running when B started");
            arrived.add("B");
            return { name: "write_file", arguments: { path: "export-b.txt", content: "executor b\n" } };
          }
          if (step === 1) return { name: "write_file", arguments: { path: "shared.txt", content: "b\n" } };
          return { text: "B 完成：已写入 export-b.txt 与 shared.txt。" };
        }
        if (role === "d") {
          if (step === 0) {
            assert.ok(
              calls.a?.callId,
              "the dependent item starts only after the item it waits for was dispatched"
            );
            return { name: "write_file", arguments: { path: "export-d.txt", content: "executor d\n" } };
          }
          return { text: "D 完成：已写入 export-d.txt。" };
        }
        // Reviewer C works in its own checkout forked from the collected site.
        await waitFor(() => Boolean(calls.c?.workspace), "the Reviewer's checkout was never recorded");
        const files = {};
        for (const name of ["feature.txt", "export-a.txt", "export-b.txt", "export-d.txt"])
          files[name] = await readFile(join(calls.c.workspace, name), "utf8");
        assert.equal(files["feature.txt"], "main edit\n");
        assert.equal(files["export-a.txt"], "executor a\n");
        assert.equal(files["export-b.txt"], "executor b\n");
        assert.equal(files["export-d.txt"], "executor d\n");
        return {
          text: `C 完成：汇总现场包含 feature.txt、export-a.txt、export-b.txt、export-d.txt，内容一致。`
        };
      } catch (error) {
        failures.push(error.stack ?? error.message);
        release();
        failTest(error);
        return { text: "原生执行夹具失败。" };
      }
    });
    t.after(async () => {
      release();
      await provider.close();
    });
    const saved = await request("/api/model-settings", {
      profileName: "本地夹具",
      baseUrl: provider.baseUrl,
      model: "protocol-fixture",
      api: "openai-completions",
      supportsReasoningEffort: false,
      supportsImages: false,
      apiKey: "native-execution-local-key"
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const started = await request(`/api/tasks/${taskId}/run`, {
      prompt: "完成报表导出需求，先在自己的需求现场完成小改动，再按依赖组织子任务。"
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await Promise.race([settle(request, taskId), scriptFailure]);
    assert.deepEqual(failures, [], failures.join("\n"));

    // The integration site keeps Main's direct edit and the collected results.
    assert.equal(await readFile(join(integration, "feature.txt"), "utf8"), "main edit\n");
    assert.equal(await readFile(join(integration, "tracked.txt"), "utf8"), "committed\n");
    assert.equal(await readFile(join(integration, "export-a.txt"), "utf8"), "executor a\n");
    assert.equal(await readFile(join(integration, "export-b.txt"), "utf8"), "executor b\n");
    assert.equal(await readFile(join(integration, "export-d.txt"), "utf8"), "executor d\n");
    // Each parallel writer kept its own copy, untouched by the other.
    assert.equal(await readFile(join(calls.a.workspace, "shared.txt"), "utf8"), "a\n");
    assert.equal(await readFile(join(calls.b.workspace, "shared.txt"), "utf8"), "b\n");
    assert.equal(await readFile(join(calls.a.workspace, "export-a.txt"), "utf8"), "executor a\n");
    assert.equal(await exists(join(calls.a.workspace, "export-b.txt")), false);
    assert.equal(await exists(join(calls.b.workspace, "export-a.txt")), false);
    assert.equal(await exists(join(calls.d.workspace, "export-a.txt")), false);
    // Work items never saw the integration checkout's uncommitted change.
    assert.equal(await exists(join(calls.a.workspace, "feature.txt")), false);

    // The user's own working tree is untouched.
    await assert.rejects(readFile(join(repository, "feature.txt"), "utf8"));
    await assert.rejects(readFile(join(repository, "export-a.txt"), "utf8"));
    assert.equal(await readFile(join(repository, "tracked.txt"), "utf8"), "committed\n");
    assert.equal(await git(repository, ["rev-parse", "HEAD"]), baselineHead);

    // Identity, role, site and progress are readable through the service and
    // through the shared controller the UI renders work items from.
    const detail = await request(`/api/tasks/${taskId}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    const agents = detail.body.progress.agents;
    assert.deepEqual(
      agents.map((agent) => agent.callId).sort(),
      [calls.a.callId, calls.b.callId, calls.c.callId, calls.d.callId].sort()
    );
    for (const agent of agents) assert.equal(agent.status, "succeeded");
    assert.equal(new Set(agents.map((agent) => agent.agentId)).size, 4);
    assert.deepEqual(
      agents.filter((agent) => agent.role === "reviewer").map((agent) => agent.callId),
      [calls.c.callId]
    );
    assert.deepEqual(agents.find((agent) => agent.callId === calls.d.callId).dependsOn, [calls.a.callId]);
    for (const call of [calls.a, calls.b, calls.c, calls.d]) {
      const recorded = agents.find((agent) => agent.callId === call.callId);
      assert.equal(recorded.workspace, call.workspace, "the recorded site is the one the item ran in");
      assert.notEqual(recorded.workspace, integration);
      assert.equal(recorded.developmentId, developmentId);
    }
    assert.equal(
      new Set(agents.map((agent) => agent.workspace)).size,
      4,
      "each work item names its own checkout"
    );
    const members = teamMembers(detail.body);
    assert.equal(members[0].agentId, "main");
    assert.deepEqual(
      members
        .filter((member) => member.callId)
        .map((member) => member.workspace)
        .sort(),
      agents.map((agent) => agent.workspace).sort()
    );

    // An internal requirement stays ledger-only: no board item appears.
    assert.deepEqual(
      (await request(`/api/projects/${encodeURIComponent(project.projectId)}/board`)).body.entries,
      []
    );
  }
);

/**
 * A work item's checkout is its identity, not a per-attempt copy.
 *
 * The same directory and branch are reused on every start, so a retry, a resume
 * after a restart or a rework keeps the files and commits it already made; an
 * unrelated directory is preserved and reported rather than deleted.
 */
test("a work item's own checkout is reused instead of reset, and never placed inside the integration site", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-p4-site-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await makeRepository(join(root, "repository"));
  const baseline = await git(repository, ["rev-parse", "HEAD"]);
  const integration = join(root, "development");
  await prepareDevelopmentWorkspace({
    repository,
    branch: "coworkos/development/fixture",
    commit: baseline,
    directory: integration
  });
  const site = {
    developmentDirectory: integration,
    directory: join(root, "work-items", "call-1"),
    branch: "coworkos/work/call-1"
  };
  await prepareWorkItemSite(site);
  assert.equal(await git(site.directory, ["rev-parse", "--abbrev-ref", "HEAD"]), site.branch);
  assert.equal(await git(site.directory, ["rev-parse", "HEAD"]), baseline);

  // The item commits its own work; the integration site does not see it.
  await writeFile(join(site.directory, "work.txt"), "item work\n");
  await git(site.directory, ["add", "work.txt"]);
  await git(site.directory, ["commit", "-m", "item change"]);
  const itemHead = await git(site.directory, ["rev-parse", "HEAD"]);
  assert.equal(await exists(join(integration, "work.txt")), false);

  // A later start reuses the checkout: same directory, same branch, same commit,
  // no second worktree and no reset to the integration site.
  const worktreesBefore = (await git(repository, ["worktree", "list", "--porcelain"]))
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;
  await prepareWorkItemSite(site);
  assert.equal(await readFile(join(site.directory, "work.txt"), "utf8"), "item work\n");
  assert.equal(await git(site.directory, ["rev-parse", "HEAD"]), itemHead);
  const worktreesAfter = (await git(repository, ["worktree", "list", "--porcelain"]))
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;
  assert.equal(worktreesAfter, worktreesBefore, "reuse creates no second checkout");

  // A checkout may not live inside the integration site.
  await assert.rejects(
    prepareWorkItemSite({
      developmentDirectory: integration,
      directory: join(integration, "inside"),
      branch: "coworkos/work/inside"
    }),
    /不能放在需求集成现场内/
  );
  // Somebody else's non-empty directory is preserved and reported.
  const foreign = join(root, "work-items", "call-foreign");
  await mkdir(foreign, { recursive: true });
  await writeFile(join(foreign, "user.txt"), "keep me\n");
  await assert.rejects(
    prepareWorkItemSite({
      developmentDirectory: integration,
      directory: foreign,
      branch: "coworkos/work/call-foreign"
    }),
    /已有内容/
  );
  assert.equal(await readFile(join(foreign, "user.txt"), "utf8"), "keep me\n");
});
