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
  "a real Main edits the requirement checkout directly and runs dependent role work items",
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
    const requests = { main: 0, a: 0, b: 0, reviewer: 0 };
    const calls = {};
    let devDirectory = "";
    let developmentRecordId = "";
    // Both Executors are in flight before the dependent Reviewer can start.
    const arrived = new Set();
    const finished = new Set();
    let release;
    const gate = new Promise((done) => {
      release = done;
    });
    const identity = (body) => {
      const system = body.messages
        .filter((message) => ["system", "developer"].includes(message.role))
        .map(messageText)
        .join("\n");
      if (!system.includes("You are a CoworkOS Subagent")) return "main";
      const task = userText(body);
      if (task.includes("审查者工作项")) return "reviewer";
      return task.includes("工作项 B") ? "b" : "a";
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
            devDirectory = development.workspace.directory;
            developmentRecordId = development.developmentId;
            assert.ok(
              !devDirectory.startsWith(`${repository}/`),
              "the requirement checkout is outside the user's working tree"
            );
            assert.equal((await stat(devDirectory)).isDirectory(), true);
            return {
              name: "write",
              arguments: { path: join(devDirectory, "feature.txt"), content: "main edit\n" }
            };
          }
          if (step === 2)
            return {
              name: "bash",
              arguments: {
                command: `cd "${devDirectory}" && test "$(cat feature.txt)" = "main edit" && echo CHECK_OK`
              }
            };
          if (step === 3) {
            assert.match(lastToolText(body), /CHECK_OK/, "Main verified its own edit in the checkout");
            return {
              name: "call_subagent",
              arguments: {
                task: "执行者工作项 A：在需求现场新增 export-a.txt 并返回证据。",
                mode: "async",
                role: "executor",
                developmentId: developmentRecordId
              }
            };
          }
          if (step === 4) {
            calls.a = toolJson(body);
            assert.equal(calls.a.accepted, true);
            assert.equal(calls.a.role, "executor");
            assert.equal(calls.a.workspace, devDirectory, "the work item runs in the requirement checkout");
            return {
              name: "call_subagent",
              arguments: {
                task: "执行者工作项 B：在需求现场新增 export-b.txt 并返回证据。",
                mode: "async",
                role: "executor",
                developmentId: developmentRecordId
              }
            };
          }
          if (step === 5) {
            calls.b = toolJson(body);
            assert.notEqual(calls.b.callId, calls.a.callId);
            return {
              name: "call_subagent",
              arguments: {
                task: "审查者工作项 C：核对 A 与 B 的产物并返回结论。",
                mode: "async",
                role: "reviewer",
                developmentId: developmentRecordId,
                dependsOn: [calls.a.callId, calls.b.callId]
              }
            };
          }
          if (step === 6) {
            calls.c = toolJson(body);
            assert.equal(calls.c.role, "reviewer");
            assert.deepEqual(calls.c.dependsOn, [calls.a.callId, calls.b.callId]);
            return { name: "get_subagent_status", arguments: {} };
          }
          if (step === 7) {
            const status = toolJson(body);
            const byCall = new Map(status.agents.map((agent) => [agent.callId, agent]));
            const waiting = byCall.get(calls.c.callId);
            assert.equal(waiting.role, "reviewer");
            assert.equal(waiting.blocked, true, "a work item with unfinished prerequisites is blocked");
            assert.deepEqual(waiting.dependsOn, [calls.a.callId, calls.b.callId]);
            assert.equal(waiting.workspace, devDirectory);
            assert.equal(waiting.status, "queued");
            assert.equal(requests.reviewer, 0, "the Reviewer sent no model request before its prerequisites");
            await waitFor(
              () => arrived.size === 2,
              "both independent Executors never reached the model together"
            );
            release();
            return {
              name: "wait_for_subagents",
              arguments: { callIds: [calls.c.callId], timeoutMs: 60_000 }
            };
          }
          if (step === 8) {
            const waited = toolJson(body);
            assert.deepEqual(waited.pending, []);
            assert.equal(waited.timedOut, false);
            assert.equal(waited.calls.find((call) => call.callId === calls.c.callId).status, "completed");
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
          finished.add("A");
          return { text: "A 完成：已写入 export-a.txt。" };
        }
        if (role === "b") {
          if (step === 0) {
            assert.ok(arrived.has("A"), "A was already running when B started");
            arrived.add("B");
            return { name: "write_file", arguments: { path: "export-b.txt", content: "executor b\n" } };
          }
          finished.add("B");
          return { text: "B 完成：已写入 export-b.txt。" };
        }
        // Reviewer C: it cannot start before both Executors responded.
        assert.deepEqual([...finished].sort(), ["A", "B"], "the Reviewer started only after both Executors");
        assert.equal(await readFile(join(devDirectory, "export-a.txt"), "utf8"), "executor a\n");
        assert.equal(await readFile(join(devDirectory, "export-b.txt"), "utf8"), "executor b\n");
        return { text: "C 完成：A、B 产物均已在同一现场核对。" };
      } catch (error) {
        failures.push(error.stack ?? error.message);
        release();
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
    await settle(request, taskId);
    assert.deepEqual(failures, [], failures.join("\n"));

    // The requirement checkout holds Main's edit and both Executor files; the
    // user's working tree is untouched apart from the worktree registry.
    assert.equal(await readFile(join(devDirectory, "feature.txt"), "utf8"), "main edit\n");
    assert.equal(await readFile(join(devDirectory, "tracked.txt"), "utf8"), "committed\n");
    assert.equal(await readFile(join(devDirectory, "export-a.txt"), "utf8"), "executor a\n");
    assert.equal(await readFile(join(devDirectory, "export-b.txt"), "utf8"), "executor b\n");
    await assert.rejects(readFile(join(repository, "feature.txt"), "utf8"));
    await assert.rejects(readFile(join(repository, "export-a.txt"), "utf8"));
    assert.equal(await readFile(join(repository, "tracked.txt"), "utf8"), "committed\n");
    assert.equal(await git(repository, ["rev-parse", "HEAD"]), baselineHead);

    // Identity, site and progress are readable through the production service...
    const detail = await request(`/api/tasks/${taskId}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    const agents = detail.body.progress.agents;
    assert.equal(agents.length, 3);
    assert.deepEqual(
      agents.map((agent) => agent.callId).sort(),
      [calls.a.callId, calls.b.callId, calls.c.callId].sort()
    );
    for (const agent of agents) {
      assert.equal(agent.workspace, devDirectory, "every work item names its working site");
      assert.equal(agent.status, "succeeded");
    }
    assert.deepEqual(
      agents.filter((agent) => agent.role === "reviewer").map((agent) => agent.callId),
      [calls.c.callId]
    );
    assert.deepEqual(agents.find((agent) => agent.callId === calls.c.callId).dependsOn, [
      calls.a.callId,
      calls.b.callId
    ]);
    assert.equal(new Set(agents.map((agent) => agent.agentId)).size, 3, "each work item keeps its identity");

    // ...and through the shared presentation controller the UI renders from.
    const members = teamMembers(detail.body);
    assert.equal(members[0].agentId, "main");
    for (const callId of [calls.a.callId, calls.b.callId, calls.c.callId]) {
      const member = members.find((entry) => entry.callId === callId);
      assert.ok(member, `the controller shows ${callId}`);
      assert.equal(member.workspace, devDirectory);
    }
    assert.equal(members.filter((entry) => entry.role === "reviewer").length, 1);

    // An internal requirement stays ledger-only: no board item appears.
    assert.deepEqual(
      (await request(`/api/projects/${encodeURIComponent(project.projectId)}/board`)).body.entries,
      []
    );
  }
);
