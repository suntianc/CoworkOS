import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { WatchProgramStore } from "../dist/src/runtime/watch-program-store.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";

const execute = promisify(execFile);
const entry = resolve(process.env.ATRIA_TEST_CLI_ENTRY || "scripts/atria.mjs");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-cli-command-"));
  const project = join(root, "project"),
    workspace = join(root, "workspace");
  await mkdir(project);
  const config = join(root, "fixture-config.json");
  await writeFile(
    config,
    JSON.stringify({ baseUrl: "http://127.0.0.1:9", model: "fixture", apiKey: "cli-command-fixture-key" })
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_|NODE_OPTIONS$)/.test(name))
  );
  Object.assign(env, {
    ATRIA_HOME: join(root, "user"),
    COWORK_CONFIG: config,
    COWORK_WORKSPACE: workspace,
    PI_CODING_AGENT_DIR: join(root, "pi"),
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_OFFLINE: "1"
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = (args, extra = {}) =>
    execute(process.execPath, [entry, ...args], {
      cwd: project,
      env: { ...env, ...extra },
      timeout: 15000,
      maxBuffer: 1024 * 1024
    });
  return { root, project, workspace, config, env, run };
}

test("public CLI command help is discoverable and works without configuration or writes", async (t) => {
  const f = await fixture(t);
  const missing = { COWORK_CONFIG: join(f.root, "missing.json") };
  for (const args of [
    ["task", "--help"],
    ["task", "create", "-h"],
    ["human", "reply", "--help"],
    ["watch", "--help"],
    ["watch", "add", "--help"],
    ["single", "--help"],
    ["worker", "-h"],
    ["watch-file", "--help"],
    ["watch-research", "--help"],
    ["watch-run", "--help"],
    ["watch-supervisor", "-h"],
    ["main-supervisor", "--help"],
    ["main-worker", "--help"],
    ["init", "-h"],
    ["doctor", "-h"],
    ["data", "-h"],
    ["help", "task", "create"]
  ]) {
    const result = await f.run(args, missing);
    assert.match(result.stdout, /Usage: coworkos/);
    assert.equal(result.stderr, "");
  }
  const top = await f.run(["--help"], missing);
  for (const command of ["create", "complete", "single", "watch", "main-supervisor"])
    assert.ok(top.stdout.includes(command), `${command} must be discoverable`);
  for (const path of [f.workspace, f.env.ATRIA_HOME, f.env.PI_CODING_AGENT_DIR])
    await assert.rejects(stat(path), { code: "ENOENT" }, "help must not create user data");
});

test("invalid CLI flags, missing values, numeric limits and operands are rejected before writes", async (t) => {
  const f = await fixture(t);
  const invalid = [
    ["task", "create", "sample", "--typo", "value"],
    ["task", "create", "sample", "--workspace"],
    ["task", "list", "--goal", "unused"],
    ["task", "status", "sample", "extra"],
    ["task", "create", ".."],
    ["watch-file", "--task", "sample", "--path", "file", "--interval", "NaN"],
    ["watch-file", "--task", "sample", "--path", "file", "--interval", "0"],
    ["watch-file", "--task", "sample", "--path", "file", "--interval", "1.5"],
    ["watch-file", "--task", "sample", "--path", "file", "--interval", "2147483648"],
    [
      "watch-run",
      "--task",
      "sample",
      "--run",
      "run",
      "--program",
      "program",
      "--monitor",
      "monitor",
      "--timeout",
      "-1"
    ],
    ["single", "fixture prompt", "--max-tokens", "65537"],
    ["single", "fixture prompt", "--max-turns", "nope"],
    ["worker", "--task", "sample", "--run", "run", "--once=maybe"],
    ["main-worker", "--task", "sample", "--poll-ms", "bad"],
    ["main-worker", "--task", "sample", "--unknown"],
    ["data", "paths", "--unknown"],
    ["data", "import", "--from", f.project, "--kind", "bad"],
    ["init", "--max-tokens", "0"],
    ["init", "--thinking", "invalid"]
  ];
  for (const args of invalid) {
    await assert.rejects(f.run(args), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /^CoworkOS: /);
      assert.doesNotMatch(error.stderr, /\bat .*\(|file:\/\/|Node\.js v/);
      return true;
    });
    await assert.rejects(
      stat(f.workspace),
      { code: "ENOENT" },
      `${args.join(" ")} must not create a workspace`
    );
  }
});

test("unknown cancel options preserve the Task, and expected failures have concise CoworkOS errors", async (t) => {
  const f = await fixture(t);
  await f.run(["task", "create", "sample", "--goal", "Retain this task"]);
  const path = join(f.workspace, "sample", "task.json");
  const before = await readFile(path, "utf8");
  await assert.rejects(
    f.run(["task", "cancel", "sample", "--workspcae", join(f.root, "other")]),
    /Unknown option/
  );
  assert.equal(await readFile(path, "utf8"), before);
  await assert.rejects(f.run(["task", "status", "missing"]), (error) => {
    assert.match(error.stderr, /^CoworkOS: unknown task: missing\s*$/);
    assert.doesNotMatch(error.stderr, /cowork:|file:\/\/|Node\.js|\bat /);
    return true;
  });
  const listed = await f.run(["task", "list", "--workspace=" + f.workspace]);
  assert.match(listed.stdout, /sample/);
});

async function watchFixture(t) {
  const f = await fixture(t);
  const taskId = "watch-task",
    runId = "watch-run";
  const taskStore = new LocalWorkspaceStore(f.workspace);
  await taskStore.createTask(taskId);
  await taskStore.createRun(taskId, runId);
  const watchStore = new WatchProgramStore(f.workspace);
  const program = await watchStore.createProgram({
    taskId,
    programId: "watch-program",
    subject: "fixture",
    objective: "Retain failed input",
    watchRunId: runId
  });
  const monitor = await watchStore.createVirtualAgent({
    programId: program.programId,
    task: "Analyze fixture",
    activate: true
  });
  await watchStore.updateVirtualAgentState(taskId, program.programId, monitor.monitorId, {
    consecutiveFailures: 3,
    lastEventId: "previous-success",
    cursor: "retain-cursor"
  });
  const inbox = new InboxStore(
    join(f.workspace, taskId, "runs", runId, "agents", monitor.monitorId, "inbox-store.json")
  );
  await inbox.enqueue({
    messageId: "fixture-message",
    recipientAgentId: monitor.monitorId,
    kind: "watcher_event",
    eventId: "fixture-event",
    priority: 1,
    state: "ready",
    payload: { type: "fixture" },
    createdAt: new Date().toISOString()
  });
  const preload = join(f.root, "dispatch-fixture.mjs");
  await writeFile(
    preload,
    `
import { CoordinatorRuntime } from ${JSON.stringify(pathToFileURL(resolve(dirname(entry), "../dist/src/runtime/coordinator-runtime.js")).href)};
CoordinatorRuntime.prototype.dispatch = async function(input) {
  const status = process.env.ATRIA_TEST_DISPATCH_OUTCOME;
  if (status === 'throw') throw new Error('Provider failed with cli-command-fixture-key');
  return { taskId: input.taskId, runId: input.runId, callId: input.callId, agentId: input.agentId,
    status, response: 'classification: no_change; fixture summary', artifacts: [], outputFiles: [],
    error: status === 'succeeded' ? undefined : 'Fixture ' + status,
    diagnostics: {tracePath: 'sessions/fixture.jsonl', resultPath: 'runs/fixture/result.json'} };
};
`
  );
  const args = [
    "watch-run",
    "--task",
    taskId,
    "--run",
    runId,
    "--program",
    program.programId,
    "--monitor",
    monitor.monitorId,
    "--timeout",
    "0"
  ];
  return {
    ...f,
    watchStore,
    inbox,
    taskId,
    programId: program.programId,
    monitorId: monitor.monitorId,
    attempt: (outcome) =>
      f.run(args, {
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        ATRIA_TEST_DISPATCH_OUTCOME: outcome
      })
  };
}

for (const outcome of ["failed", "timed_out", "cancelled", "throw"]) {
  test(`watch-run releases ${outcome} input and records failure, then a successful retry acknowledges it`, async (t) => {
    const f = await watchFixture(t);
    await assert.rejects(f.attempt(outcome), (error) => {
      assert.equal(error.code, 1);
      if (outcome === "throw") {
        assert.match(error.stderr, /CoworkOS: Provider failed with \[REDACTED\]/);
        assert.doesNotMatch(error.stderr, /cli-command-fixture-key|file:\/\/|\bat /);
      } else assert.equal(JSON.parse(error.stdout).status, outcome);
      return true;
    });
    const [message] = await f.inbox.list();
    assert.equal(message.state, "ready");
    assert.equal(message.lease, undefined);
    const failed = await f.watchStore.readVirtualAgentState(f.taskId, f.programId, f.monitorId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.consecutiveFailures, 4);
    assert.equal(failed.lastEventId, "previous-success");
    assert.equal(failed.cursor, "retain-cursor");
    assert.ok(failed.lastSummary.includes(outcome === "throw" ? "Provider failed" : outcome));
    const retried = await f.attempt("succeeded");
    assert.equal(JSON.parse(retried.stdout).status, "succeeded");
    assert.equal((await f.inbox.list())[0].state, "consumed");
    const succeeded = await f.watchStore.readVirtualAgentState(f.taskId, f.programId, f.monitorId);
    assert.equal(succeeded.status, "active");
    assert.equal(succeeded.consecutiveFailures, 0);
    assert.equal(succeeded.lastEventId, "fixture-event");
    assert.equal(succeeded.cursor, "retain-cursor");
    assert.equal(JSON.parse((await f.attempt("succeeded")).stdout).reason, "no_pending_event");
  });
}

test(
  "real CLI/Pi watch failure retains its input, then a real successful retry consumes it",
  { timeout: 30000 },
  async (t) => {
    const f = await watchFixture(t);
    let healthy = false;
    const requests = [];
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request.setEncoding("utf8")) raw += chunk;
      requests.push(JSON.parse(raw));
      if (!healthy) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "Fixture authentication failure", type: "authentication_error" }
          })
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        response.write(
          `data: ${JSON.stringify({ id: "cli-watch-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        );
      send({
        role: "assistant",
        content: "classification: no_change\nThe fixture event was successfully analyzed."
      });
      send({}, "stop");
      response.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    });
    await writeFile(
      f.config,
      JSON.stringify({
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        model: "fixture",
        apiKey: "cli-command-fixture-key",
        reasoningEffort: "off",
        supportsReasoningEffort: false,
        mainMaxTokens: 8192,
        subagentMaxTokens: 8192
      })
    );
    const args = [
      "watch-run",
      "--task",
      f.taskId,
      "--run",
      "watch-run",
      "--program",
      f.programId,
      "--monitor",
      f.monitorId,
      "--timeout",
      "5000"
    ];
    await assert.rejects(f.run(args), (error) => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).status, "failed");
      return true;
    });
    const failed = await f.watchStore.readVirtualAgentState(f.taskId, f.programId, f.monitorId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.consecutiveFailures, 4);
    assert.equal(failed.lastEventId, "previous-success");
    assert.equal((await f.inbox.list())[0].state, "ready");
    const failedRequests = requests.length;
    assert.ok(failedRequests >= 1, "the real Pi provider must reach the failing fixture service");
    healthy = true;
    const result = JSON.parse((await f.run(args)).stdout);
    assert.equal(result.status, "succeeded");
    assert.match(result.response, /fixture event was successfully analyzed/);
    assert.equal((await f.inbox.list())[0].state, "consumed");
    const successful = await f.watchStore.readVirtualAgentState(f.taskId, f.programId, f.monitorId);
    assert.equal(successful.status, "active");
    assert.equal(successful.consecutiveFailures, 0);
    assert.equal(successful.lastEventId, "fixture-event");
    assert.equal(JSON.parse((await f.run(args)).stdout).reason, "no_pending_event");
    assert.equal(
      requests.length,
      failedRequests + 1,
      "the explicit retry succeeds once, and a consumed event does not call the model again"
    );
    assert.ok(requests.every((request) => request.stream === true));
  }
);
