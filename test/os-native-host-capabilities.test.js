import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createDashboardApplication } from "../dist/src/dashboard/application.js";
import { WatchProgramStore } from "../dist/src/runtime/watch-program-store.js";
import { WatcherRuntime } from "../dist/src/runtime/watcher.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { businessCommandEnvironment } from "../dist/src/runtime/command-environment.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { killJob, listJobs } from "../dist/src/tools/jobs.js";
import { installComputerUse } from "../web/assets/controllers/computer-use.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const hostToken = "native-host-fixture-token";
const require = createRequire(import.meta.url);
const { createComputerHost } = require("../desktop/computer-host.cjs");
const {
  createComputerPolicyController,
  createComputerPolicyStore
} = require("../desktop/computer-policy.cjs");
const repositoryRoot = resolve(".");
const backendEntry = join(repositoryRoot, "dist/src/cli/backend.js");

async function dashboardFixture(t, options = {}, envOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "cowork-native-host-"));
  const environment = { ...process.env };
  for (const key of Object.keys(process.env))
    if (/^(COWORK_|ATRIA_|PI_|ELECTRON_)/.test(key)) delete process.env[key];
  Object.assign(process.env, {
    ATRIA_HOME: root,
    COWORK_WORKSPACE: join(root, "workspace"),
    COWORK_CONFIG: join(root, "config.json"),
    COWORK_API_TOKEN: hostToken,
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_OFFLINE: "1",
    ...envOverrides
  });
  await writeFile(join(root, "config.json"), "{}\n");
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const identity = { backendId: "native_fixture", pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" };
  const app = createDashboardApplication({
    projectRoot: resolve("."),
    port,
    backendIdentity: identity,
    ...options
  });
  app.server.listen(port, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => {
    await app.stop();
    for (const key of Object.keys(process.env))
      if (/^(COWORK_|ATRIA_|PI_|ELECTRON_)/.test(key)) delete process.env[key];
    Object.assign(process.env, environment);
    await rm(root, { recursive: true, force: true });
  });
  async function request(path, { token = hostToken, body, approval } = {}) {
    const response = await fetch(`${app.dashboardUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-atria-token": token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(approval ? { "x-computer-approval": approval } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  }
  const host = (input, token, approval) =>
    request("/api/host/computer", { token, approval, body: { ...identity, input } });
  return { request, host, identity, root, url: app.dashboardUrl };
}

test("client sessions can inspect and pause but cannot prompt or grant host permissions", async (t) => {
  let prompts = 0;
  let approvals = 0;
  const fixture = await dashboardFixture(t, {
    computerApprovalAuthenticate: async () => (++approvals, true),
    computerDriver: {
      status: async () => ({ available: true, screenRecording: false, accessibility: false, windows: [] }),
      requestPermissions: async () => (++prompts, { requested: true }),
      observe: async () => {
        throw new Error("unexpected observation");
      },
      act: async () => {
        throw new Error("unexpected action");
      }
    }
  });
  const session = await fixture.request("/api/session", {
    body: { clientName: "remote fixture", protocolVersion: "1.0" }
  });
  assert.equal(session.status, 201);
  const token = session.body.session.token;
  assert.equal((await fixture.request("/api/computer/status", { token })).status, 200);
  assert.equal((await fixture.host({ operation: "pause" }, token)).status, 200);
  assert.equal(
    (await fixture.host({ operation: "permissions", permission: "screenRecording" }, token)).status,
    403
  );
  assert.equal(
    (await fixture.request("/api/host/computer/approve", { token, body: fixture.identity })).status,
    403
  );
  assert.equal(prompts, 0);
  assert.equal(approvals, 0);
  assert.equal((await fixture.host({ operation: "permissions", permission: "accessibility" })).status, 200);
  assert.equal(prompts, 1);
  const approved = await fixture.request("/api/host/computer/approve", { body: fixture.identity });
  assert.equal(approved.status, 200);
  const enable = { operation: "policy", enabled: true, mode: "control" };
  assert.equal((await fixture.host(enable, token, approved.body.approval.token)).status, 403);
  assert.equal((await fixture.host(enable, hostToken, approved.body.approval.token)).status, 200);
});

test(
  "Dashboard Watch model commands use the backend business credential across foreground and background tools",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cowork-watch-host-credential-"));
    const workspaceRoot = join(root, "workspace");
    const home = join(root, "home");
    const userHome = join(root, "user");
    for (const directory of [workspaceRoot, home, userHome]) await mkdir(directory, { recursive: true });
    const previous = process.env;
    process.env = {
      ...Object.fromEntries(
        Object.entries(previous).filter(
          ([name]) =>
            !/^(?:COWORK_|ATRIA_|PI_|ELECTRON_|SERPER_|EXA_|(?:HTTP|HTTPS|ALL|NO)_PROXY$)/i.test(name)
        )
      ),
      HOME: userHome,
      ATRIA_HOME: home,
      COWORK_HARNESS_ROOT: repositoryRoot,
      COWORK_CONFIG: join(root, "config.json"),
      COWORK_WORKSPACE: workspaceRoot,
      COWORK_GLOBAL_INDEX: join(home, "runtime", "workspaces.json"),
      COWORK_TABS_INDEX: join(home, "runtime", "tabs.json"),
      COWORK_API_TOKEN: hostToken,
      COWORK_DASHBOARD_URL: "http://127.0.0.1:9",
      COWORK_ALLOWED_MARKER: "preserved-fixture-value",
      COWORK_DISABLE_WATCH_SUPERVISOR: "0",
      COWORK_SUPERVISOR_INTERVAL_MS: "1000",
      COWORK_REASONING_EFFORT: "off",
      COWORK_SUPPORTS_REASONING_EFFORT: "0",
      COWORK_MODEL_API: "openai-completions",
      COWORK_MAIN_MAX_TURNS: "8",
      PI_CODING_AGENT_DIR: join(root, "pi"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0"
    };
    let app, model, jobDirectory;
    let permissionPrompts = 0,
      authenticationCalls = 0,
      turns = 0;
    const modelErrors = [];
    t.after(async () => {
      try {
        if (jobDirectory)
          for (const job of await listJobs({ directory: jobDirectory }))
            if (job.state === "running") await killJob({ directory: jobDirectory, jobId: job.jobId });
      } finally {
        try {
          await app?.stop();
        } finally {
          try {
            await model?.close();
          } finally {
            process.env = previous;
            await rm(root, { recursive: true, force: true });
          }
        }
      }
    });
    await writeFile(join(root, "config.json"), "{}\n");
    const taskId = "watch-credential-task";
    const store = new LocalWorkspaceStore(workspaceRoot);
    await store.createTask(taskId, { goal: "Classify an isolated event" });
    await store.updateTask(taskId, { capabilities: { longRunning: true } });
    await store.createRun(taskId, "watch-main");
    await store.transitionTask(taskId, "waiting", { runId: "watch-main", reason: "fixture" });
    const programs = new WatchProgramStore(workspaceRoot);
    const program = await programs.createProgram({
      taskId,
      programId: "credential-check",
      subject: "fixture",
      objective: "Classify fixture changes"
    });
    const monitor = await programs.createVirtualAgent({
      programId: program.programId,
      task: "Classify the event",
      profileId: "custom",
      cadenceSeconds: 3600,
      wake: "important",
      activate: true
    });
    jobDirectory = join(workspaceRoot, taskId, "agents", "subagents", monitor.monitorId, "logs", "jobs");
    await programs.updateVirtualAgentState(taskId, program.programId, monitor.monitorId, {
      lastCheckedAt: new Date().toISOString()
    });
    const accepted = await new WatcherRuntime({
      workspaceRoot,
      taskId,
      runId: `watch-${program.programId}`,
      programId: program.programId,
      recipientAgentId: monitor.monitorId
    }).ingest({
      watcherId: monitor.monitorId,
      source: "fixture",
      type: "fixture.changed",
      dedupeKey: "credential-event",
      payload: { title: "Fixture event" }
    });
    const inbox = new InboxStore(
      join(
        workspaceRoot,
        taskId,
        "runs",
        `watch-${program.programId}`,
        "agents",
        monitor.monitorId,
        "inbox-store.json"
      )
    );
    const portProbe = createServer();
    portProbe.listen(0, "127.0.0.1");
    await once(portProbe, "listening");
    const port = portProbe.address().port;
    await new Promise((done) => portProbe.close(done));
    const backendUrl = `http://127.0.0.1:${port}`;
    const probePath = join(root, "probe.mjs");
    await writeFile(
      probePath,
      `
import {writeFile} from "node:fs/promises";
const url = ${JSON.stringify(backendUrl)};
const headers = {"x-atria-token":process.env.COWORK_API_TOKEN, "content-type":"application/json"};
const infoResponse = await fetch(url + "/api/backend", {headers});
const info = await infoResponse.json();
const identity = {backendId:info.backendId,pid:info.pid,startedAt:info.startedAt};
const status = await fetch(url + "/api/computer/status", {headers});
const permission = await fetch(url + "/api/host/computer", {method:"POST",headers,body:JSON.stringify({...identity,input:{operation:"permissions",permission:"screenRecording"}})});
const approval = await fetch(url + "/api/host/computer/approve", {method:"POST",headers,body:JSON.stringify(identity)});
await writeFile(process.argv[2], JSON.stringify({
  pid:process.pid, backend:infoResponse.status, status:status.status, permission:permission.status, approval:approval.status,
  hostCredentialInherited:process.env.COWORK_API_TOKEN === ${JSON.stringify(hostToken)},
  backendUrlMatches:process.env.COWORK_DASHBOARD_URL === url,
  marker:process.env.COWORK_ALLOWED_MARKER
}));
`
    );
    const results = [join(root, "foreground.json"), join(root, "tests.json"), join(root, "job.json")];
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    model = await modelProtocolFixture("openai-completions", async (request) => {
      try {
        const step = turns++;
        const name = ["run_command", "run_tests", "start_job"][step];
        if (!name) return { text: "classification: no_change\nFixture classified successfully." };
        assert.ok(
          request.tools.some((tool) => tool.function.name === name),
          `${name} is available`
        );
        return name === "start_job"
          ? {
              name,
              arguments: { command: `${quote(process.execPath)} ${quote(probePath)} ${quote(results[step])}` }
            }
          : { name, arguments: { command: process.execPath, args: [probePath, results[step]] } };
      } catch (error) {
        modelErrors.push(error.message);
        return { text: "classification: uncertain\nFixture failed." };
      }
    });
    Object.assign(process.env, {
      COWORK_API_BASE: model.baseUrl,
      COWORK_API_KEY: "local-fixture",
      COWORK_MODEL: "protocol-fixture"
    });
    app = createDashboardApplication({
      projectRoot: repositoryRoot,
      port,
      backendIdentity: { backendId: "watch_fixture_backend", startedAt: "2026-01-01T00:00:00.000Z" },
      computerDriver: {
        status: async () => ({ available: true, screenRecording: true, accessibility: true, windows: [] }),
        requestPermissions: async () => (++permissionPrompts, { requested: true }),
        observe: async () => {
          throw new Error("unexpected observation");
        },
        act: async () => {
          throw new Error("unexpected action");
        }
      },
      computerApprovalAuthenticate: async () => (++authenticationCalls, true)
    });
    app.server.listen(port, "127.0.0.1");
    await once(app.server, "listening");
    await waitFor(
      async () =>
        (await inbox.list(monitor.monitorId)).some(
          (entry) => entry.eventId === accepted.eventId && entry.state === "consumed"
        ),
      40_000
    );
    await waitFor(
      async () =>
        (
          await Promise.all(
            results.map(async (file) => {
              try {
                await readFile(file, "utf8");
                return true;
              } catch (error) {
                if (error.code === "ENOENT") return false;
                throw error;
              }
            })
          )
        ).every(Boolean),
      10_000
    );
    await waitFor(async () => {
      const jobs = await listJobs({ directory: jobDirectory });
      return jobs.length === 1 && jobs[0].state === "exited" && jobs[0].exitCode === 0;
    }, 10_000);
    assert.deepEqual(modelErrors, []);
    assert.equal(turns, 4);
    for (const file of results) {
      const result = JSON.parse(await readFile(file, "utf8"));
      assert.equal(result.backend, 200, file);
      assert.equal(result.status, 200, file);
      assert.equal(result.permission, 403, file);
      assert.equal(result.approval, 403, file);
      assert.equal(result.hostCredentialInherited, false, file);
      assert.equal(result.backendUrlMatches, true, file);
      assert.equal(result.marker, "preserved-fixture-value", file);
    }
    assert.equal(permissionPrompts, 0);
    assert.equal(authenticationCalls, 0);
    assert.equal(process.env.COWORK_API_TOKEN, hostToken);
    assert.equal(
      (await programs.readVirtualAgentState(taskId, program.programId, monitor.monitorId)).lastClassification,
      "no_change"
    );
  }
);

test(
  "CLI Watch commands preserve an authorized session while rejecting a host credential",
  { timeout: 60_000 },
  async (t) => {
    let permissionPrompts = 0;
    let authenticationCalls = 0;
    const fixture = await dashboardFixture(t, {
      computerDriver: {
        status: async () => ({ available: true, screenRecording: true, accessibility: true, windows: [] }),
        requestPermissions: async () => (++permissionPrompts, { requested: true }),
        observe: async () => {
          throw new Error("unexpected observation");
        },
        act: async () => {
          throw new Error("unexpected action");
        }
      },
      computerApprovalAuthenticate: async () => (++authenticationCalls, true)
    });
    const workspaceRoot = join(fixture.root, "workspace");
    const taskId = "cli-watch-credential";
    const store = new LocalWorkspaceStore(workspaceRoot);
    await store.createTask(taskId, { goal: "Classify isolated events" });
    await store.createRun(taskId, "cli-main");
    await store.transitionTask(taskId, "waiting", { runId: "cli-main", reason: "fixture" });
    const programs = new WatchProgramStore(workspaceRoot);
    const program = await programs.createProgram({
      taskId,
      programId: "cli-topic",
      subject: "fixture",
      objective: "Classify fixture changes"
    });
    const monitor = await programs.createVirtualAgent({
      programId: program.programId,
      task: "Classify the event",
      profileId: "custom",
      cadenceSeconds: 3600,
      wake: "important",
      activate: true
    });
    const session = await fixture.request("/api/session", {
      body: { clientName: "cli fixture", protocolVersion: "1.0" }
    });
    assert.equal(session.status, 201);
    let turn = 0,
      outputFile;
    const probe = `
import {writeFile} from "node:fs/promises";
const token=process.env.COWORK_API_TOKEN;
const headers={"content-type":"application/json",...(token?{"x-atria-token":token}:{})};
const url=process.env.COWORK_DASHBOARD_URL;
const status=await fetch(url+"/api/computer/status",{headers});
const identity=${JSON.stringify(fixture.identity)};
const permission=await fetch(url+"/api/host/computer",{method:"POST",headers,body:JSON.stringify({...identity,input:{operation:"permissions",permission:"screenRecording"}})});
const approval=await fetch(url+"/api/host/computer/approve",{method:"POST",headers,body:JSON.stringify(identity)});
await writeFile(process.argv[2],JSON.stringify({status:status.status,permission:permission.status,approval:approval.status,hostCredentialInherited:token===${JSON.stringify(hostToken)}}));
`;
    const probePath = join(fixture.root, "cli-probe.mjs");
    await writeFile(probePath, probe);
    const model = await modelProtocolFixture("openai-completions", async () =>
      turn++ % 2 === 0
        ? { name: "run_command", arguments: { command: process.execPath, args: [probePath, outputFile] } }
        : { text: "classification: no_change\nCLI fixture completed." }
    );
    t.after(() => model.close());
    for (const [name, token, expectedStatus, command] of [
      ["run-session", session.body.session.token, 200, "watch-run"],
      ["run-host", hostToken, 401, "watch-run"],
      ["supervisor-session", session.body.session.token, 200, "watch-supervisor"],
      ["supervisor-host", hostToken, 401, "watch-supervisor"]
    ]) {
      await new WatcherRuntime({
        workspaceRoot,
        taskId,
        runId: `watch-${program.programId}`,
        programId: program.programId,
        recipientAgentId: monitor.monitorId
      }).ingest({
        watcherId: monitor.monitorId,
        source: "fixture",
        type: "fixture.changed",
        dedupeKey: name,
        payload: { title: name }
      });
      outputFile = join(fixture.root, `${name}.json`);
      turn = 0;
      const args =
        command === "watch-run"
          ? [
              command,
              "--task",
              taskId,
              "--run",
              `watch-${program.programId}`,
              "--program",
              program.programId,
              "--monitor",
              monitor.monitorId
            ]
          : [command, "--task", taskId, "--program", program.programId, "--once"];
      const cli = await runProcess(
        process.execPath,
        [join(repositoryRoot, "dist/src/cli/cowork.js"), ...args, "--timeout", "10000", "--max-turns", "3"],
        {
          ...process.env,
          COWORK_API_TOKEN: token,
          COWORK_DASHBOARD_URL: fixture.url,
          COWORK_API_BASE: model.baseUrl,
          COWORK_API_KEY: "local-fixture",
          COWORK_MODEL: "protocol-fixture",
          COWORK_MODEL_API: "openai-completions",
          COWORK_REASONING_EFFORT: "off",
          COWORK_SUPPORTS_REASONING_EFFORT: "0",
          PI_TELEMETRY: "0"
        }
      );
      assert.equal(cli.code, 0, cli.stderr);
      const outcome = JSON.parse(cli.stdout);
      if (command === "watch-run") assert.equal(outcome.status, "succeeded");
      else {
        assert.equal(outcome.processed, 1);
        assert.deepEqual(outcome.failures, []);
      }
      const observed = JSON.parse(await readFile(outputFile, "utf8"));
      assert.deepEqual(observed, {
        status: expectedStatus,
        permission: 403,
        approval: 403,
        hostCredentialInherited: false
      });
    }
    assert.equal(permissionPrompts, 0);
    assert.equal(authenticationCalls, 0);
  }
);

test("a real Main delegation retains its backend business credential", { timeout: 60_000 }, async (t) => {
  let mainTurns = 0,
    delegateTurns = 0,
    probePath,
    resultPath;
  const errors = [];
  const model = await modelProtocolFixture("openai-completions", async (request) => {
    try {
      const names = request.tools.map((tool) => tool.function.name);
      if (names.includes("call_subagent"))
        return mainTurns++ === 0
          ? { name: "call_subagent", arguments: { task: "Run the isolated credential probe", mode: "sync" } }
          : { text: "Main and delegate completed." };
      assert.ok(names.includes("run_command"));
      return delegateTurns++ === 0
        ? { name: "run_command", arguments: { command: process.execPath, args: [probePath, resultPath] } }
        : { text: "Delegate completed." };
    } catch (error) {
      errors.push(error.message);
      return { text: "fixture failed" };
    }
  });
  const fixture = await dashboardFixture(
    t,
    {},
    {
      COWORK_API_BASE: model.baseUrl,
      COWORK_API_KEY: "local-fixture",
      COWORK_MODEL: "protocol-fixture",
      COWORK_MODEL_API: "openai-completions",
      COWORK_REASONING_EFFORT: "off",
      COWORK_SUPPORTS_REASONING_EFFORT: "0",
      PI_TELEMETRY: "0"
    }
  );
  t.after(() => model.close());
  probePath = join(fixture.root, "delegate-probe.mjs");
  resultPath = join(fixture.root, "delegate-result.json");
  await writeFile(
    probePath,
    `
import {writeFile} from "node:fs/promises";
const token=process.env.COWORK_API_TOKEN;
const headers={"x-atria-token":token};
const response=await fetch(process.env.COWORK_DASHBOARD_URL+"/api/computer/status",{headers});
await writeFile(process.argv[2],JSON.stringify({status:response.status,hostCredentialInherited:token===${JSON.stringify(hostToken)}}));
`
  );
  assert.equal(
    (
      await fixture.request("/api/tasks", {
        body: { taskId: "delegate-task", goal: "Run a delegated fixture" }
      })
    ).status,
    201
  );
  const started = await fixture.request("/api/tasks/delegate-task/run", {
    body: { prompt: "Delegate the credential check." }
  });
  assert.ok(started.status >= 200 && started.status < 300);
  await waitFor(async () => {
    const current = await fixture.request("/api/tasks/delegate-task");
    return !current.body.runtime.active && current.body.task.status === "completed";
  }, 40_000);
  assert.deepEqual(errors, []);
  assert.equal(mainTurns, 2);
  assert.equal(delegateTurns, 2);
  assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), {
    status: 200,
    hostCredentialInherited: false
  });
});

test("cancelling session verification rejects before releasing a credential", async (t) => {
  const started = Promise.withResolvers();
  const server = createHttpServer(() => started.resolve());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const env = {
    COWORK_DASHBOARD_URL: `http://127.0.0.1:${server.address().port}`,
    COWORK_API_TOKEN: "fixture-session"
  };
  const abort = new AbortController();
  const verification = businessCommandEnvironment(env, abort.signal);
  await started.promise;
  abort.abort();
  await assert.rejects(verification, { name: "AbortError" });
  const before = new AbortController();
  before.abort();
  await assert.rejects(businessCommandEnvironment(env, before.signal), { name: "AbortError" });
});

test(
  "concurrent Coordinator commands retain their own runtime context without persisting credentials",
  { timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cowork-command-context-"));
    const previous = process.env.COWORK_API_TOKEN;
    process.env.COWORK_API_TOKEN = hostToken;
    const store = new LocalWorkspaceStore(root);
    const tasks = ["context-a", "context-b", "context-default"];
    for (const taskId of tasks) await store.createTask(taskId, { goal: "Run isolated command" });
    const probe = `
import {writeFile} from "node:fs/promises";
await writeFile(process.argv[2],JSON.stringify({token:process.env.COWORK_API_TOKEN??null, marker:process.env.COMMAND_CONTEXT??null}));
`;
    const probePath = join(root, "context-probe.mjs");
    await writeFile(probePath, probe);
    const model = await modelProtocolFixture("openai-completions", async (request) => {
      if (request.messages.some((message) => message.role === "tool")) return { text: "fixture completed" };
      const user = JSON.stringify(request.messages.find((message) => message.role === "user")?.content);
      const taskId = tasks.find((name) => user.includes(name));
      if (!taskId) throw new Error("missing fixture task identity");
      return {
        name: "run_command",
        arguments: { command: process.execPath, args: [probePath, join(root, `${taskId}.json`)] }
      };
    });
    t.after(async () => {
      await model.close();
      if (previous === undefined) delete process.env.COWORK_API_TOKEN;
      else process.env.COWORK_API_TOKEN = previous;
      await rm(root, { recursive: true, force: true });
    });
    const coordinator = new CoordinatorRuntime();
    const results = await Promise.all(
      tasks.map((taskId, index) =>
        coordinator.dispatch({
          taskId,
          runId: "context-run",
          agentId: `agent-${index}`,
          task: `Execute ${taskId}`,
          mode: "sync",
          workspaceRoot: root,
          baseUrl: model.baseUrl,
          apiKey: "local-fixture",
          model: "protocol-fixture",
          api: "openai-completions",
          thinkingFormat: "openai",
          thinkingLevel: "off",
          supportsReasoningEffort: false,
          maxTurns: 3,
          timeoutMs: 10000,
          ...(index < 2
            ? {
                commandEnv: {
                  COWORK_API_TOKEN: `business-token-${index}`,
                  COMMAND_CONTEXT: `context-${index}`
                }
              }
            : {})
        })
      )
    );
    assert.deepEqual(
      results.map((result) => result.status),
      ["succeeded", "succeeded", "succeeded"]
    );
    for (const [index, taskId] of tasks.entries()) {
      const value = JSON.parse(await readFile(join(root, `${taskId}.json`), "utf8"));
      assert.deepEqual(
        value,
        index < 2
          ? { token: `business-token-${index}`, marker: `context-${index}` }
          : { token: null, marker: null }
      );
      const queue = await readFile(join(root, taskId, "runs", "context-run", "queue.json"), "utf8");
      assert.doesNotMatch(queue, /business-token-|native-host-fixture-token/);
    }
    assert.equal(process.env.COWORK_API_TOKEN, hostToken);
  }
);

test(
  "recovered Coordinator work uses the current business context instead of a persisted credential",
  { timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cowork-recovery-context-"));
    const previous = process.env.COWORK_API_TOKEN;
    process.env.COWORK_API_TOKEN = hostToken;
    const taskId = "recover-context";
    const store = new LocalWorkspaceStore(root);
    await store.createTask(taskId, { goal: "Recover a queued command" });
    const resultFile = join(root, "recovered.json");
    const probePath = join(root, "recover-probe.mjs");
    await writeFile(
      probePath,
      `import {writeFile} from "node:fs/promises"; await writeFile(process.argv[2],JSON.stringify({token:process.env.COWORK_API_TOKEN??null}));`
    );
    const model = await modelProtocolFixture("openai-completions", async (request) =>
      request.messages.some((message) => message.role === "tool")
        ? { text: "recovered fixture completed" }
        : { name: "run_command", arguments: { command: process.execPath, args: [probePath, resultFile] } }
    );
    t.after(async () => {
      await model.close();
      if (previous === undefined) delete process.env.COWORK_API_TOKEN;
      else process.env.COWORK_API_TOKEN = previous;
      await rm(root, { recursive: true, force: true });
    });
    const connection = {
      workspaceRoot: root,
      taskId,
      runId: "recover-run",
      baseUrl: model.baseUrl,
      apiKey: "local-fixture",
      model: "protocol-fixture",
      api: "openai-completions",
      thinkingFormat: "openai",
      thinkingLevel: "off",
      supportsReasoningEffort: false,
      maxTurns: 3,
      timeoutMs: 10000
    };
    const coordinator = new CoordinatorRuntime();
    // The throw interrupts the process after the durable enqueue; dispatch
    // settles the call record and recovery re-drives the queued item.
    const interrupted = await coordinator.dispatch({
      ...connection,
      activateRun: false,
      callId: "recover-call",
      agentId: "recover-agent",
      task: "Run the fixture",
      mode: "async",
      commandEnv: { COWORK_API_TOKEN: "old-business-token" },
      onQueued: () => {
        throw new Error("stop after queue");
      }
    });
    assert.equal(interrupted.status, "failed");
    assert.match(interrupted.error, /stop after queue/);
    const queuePath = join(root, taskId, "runs", "recover-run", "queue.json");
    assert.doesNotMatch(await readFile(queuePath, "utf8"), /old-business-token|native-host-fixture-token/);
    const recovered = await coordinator.recoverRun({
      ...connection,
      commandEnv: { COWORK_API_TOKEN: "new-business-token" }
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, "succeeded");
    assert.deepEqual(JSON.parse(await readFile(resultFile, "utf8")), { token: "new-business-token" });
    assert.doesNotMatch(
      await readFile(queuePath, "utf8"),
      /old-business-token|new-business-token|native-host-fixture-token/
    );
    assert.equal(process.env.COWORK_API_TOKEN, hostToken);
  }
);

test("web settings show execution-host permissions without requesting the client device", async (t) => {
  let status = { available: true, screenRecording: false, accessibility: true, windows: [] };
  let prompts = 0;
  const fixture = await dashboardFixture(t, {
    computerDriver: {
      status: async () => status,
      requestPermissions: async () => (++prompts, { requested: true }),
      observe: async () => {
        throw new Error("unexpected observation");
      },
      act: async () => {
        throw new Error("unexpected action");
      }
    }
  });
  const session = await fixture.request("/api/session", {
    body: { clientName: "web fixture", protocolVersion: "1.0" }
  });
  const token = session.body.session.token;
  const { window, document } = parseHTML(`
    <div id="settings-entry"><div id="profile-settings-tools"></div></div>
    <button id="user-menu-button"></button><main id="conversation"></main>`);
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = window;
  globalThis.document = document;
  t.after(() => {
    window.dispatchEvent(new window.Event("pagehide"));
    globalThis.window = previous.window;
    globalThis.document = previous.document;
  });
  let heldStatus;
  let pendingStatus;
  const controller = installComputerUse({
    api: async (path) => {
      const result = await fixture.request(path, { token });
      assert.equal(result.status, 200);
      if (path === "/api/computer/status" && heldStatus) {
        const held = heldStatus;
        heldStatus = undefined;
        pendingStatus.resolve();
        await held.promise;
      }
      return result.body;
    },
    getSelectedTaskId: () => null,
    getTaskLabel: () => "",
    showToast: () => {}
  });
  const permissions = document.querySelector("[data-computer-permissions]");
  const state = document.querySelector("[data-computer-state]");
  await waitFor(() => permissions.textContent.includes("屏幕录制"));
  assert.match(permissions.textContent, /执行主机/);
  assert.match(permissions.textContent, /屏幕录制：未开启/);
  assert.match(permissions.textContent, /辅助功能：已开启/);
  assert.equal(document.querySelector(".computer-permission-actions").hidden, true);
  assert.equal(prompts, 0);
  status = {
    available: true,
    screenRecording: true,
    accessibility: true,
    controlAvailable: false,
    windows: [],
    reason: "无图形桌面"
  };
  document.querySelector("#user-menu-button").click();
  await waitFor(() => permissions.textContent.includes("无图形桌面"));
  assert.match(state.textContent, /不可用/);
  assert.match(permissions.textContent, /执行主机/);
  // A recorded reason follows the sentence stop the Chinese message always used.
  assert.match(
    permissions.textContent,
    /辅助功能：已开启。无图形桌面。请在执行主机的 Formicand 桌面版处理权限。/
  );
  assert.equal(prompts, 0);
  heldStatus = Promise.withResolvers();
  pendingStatus = Promise.withResolvers();
  const old = heldStatus;
  document.querySelector("#user-menu-button").click();
  await pendingStatus.promise;
  controller.reset();
  status = { available: true, screenRecording: true, accessibility: false, windows: [] };
  await controller.refresh();
  assert.match(permissions.textContent, /辅助功能：未开启/);
  old.resolve();
  await new Promise((done) => setTimeout(done, 20));
  assert.match(permissions.textContent, /辅助功能：未开启/);
  assert.doesNotMatch(permissions.textContent, /无图形桌面/);
});

test("host permission recovery and takeover invalidate old observations and target identities", async (t) => {
  const target = {
    pid: 11,
    windowId: 12,
    bundleId: "fixture.window",
    application: "Fixture",
    title: "Probe"
  };
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  let holdObservation = false;
  let screenRecording = false;
  let permissionPrompts = 0;
  let confirmations = 0;
  const effects = [];
  const fixture = await dashboardFixture(t, {
    computerApprovalAuthenticate: async () => (++confirmations, true),
    computerDriver: {
      status: async () => ({
        available: true,
        screenRecording,
        accessibility: true,
        controlAvailable: true,
        postEventAccess: true,
        windows: [target]
      }),
      requestPermissions: async () => (++permissionPrompts, { requested: true }),
      observe: async () => {
        if (holdObservation) {
          started.resolve();
          await gate.promise;
        }
        return {
          width: 1,
          height: 1,
          image:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          frame: { x: 0, y: 0, width: 1, height: 1 }
        };
      },
      act: async (_target, action) => {
        effects.push(action.type);
      }
    }
  });
  const instance = { ...fixture.identity, url: fixture.url, token: hostToken };
  let inspected = instance;
  const computer = createComputerHost({ expected: instance, inspect: async () => inspected });
  const backend = { computer };
  const store = createComputerPolicyStore(fixture.root);
  await store.load();
  let settingsOpened = 0;
  const controller = createComputerPolicyController({
    store,
    getBackend: () => backend,
    registerTakeover: () => undefined,
    openPermissionSettings: async () => {
      settingsOpened++;
    }
  });
  await controller.initialize(backend);
  const denied = await controller.request({ operation: "permissions", permission: "screenRecording" });
  assert.equal(denied.screenRecording, false);
  assert.equal(permissionPrompts, 1);
  assert.equal(settingsOpened, 1);
  await assert.rejects(
    controller.request({ operation: "policy", enabled: true, mode: "control" }),
    /系统权限/
  );
  assert.equal(confirmations, 0);
  screenRecording = true;
  assert.equal(
    (await controller.request({ operation: "permissions", permission: "screenRecording" })).screenRecording,
    true
  );
  assert.equal(permissionPrompts, 1);
  assert.equal(
    (await controller.request({ operation: "policy", enabled: true, mode: "control" })).enabled,
    true
  );
  assert.equal(confirmations, 1);

  const session = await fixture.request("/api/session", {
    body: { clientName: "task fixture", protocolVersion: "1.0" }
  });
  const token = session.body.session.token;
  assert.equal(
    (await fixture.request("/api/tasks", { token, body: { taskId: "native-task", goal: "probe" } })).status,
    201
  );
  const select = await fixture.request("/api/tasks/native-task/computer/select", {
    token,
    body: { pid: target.pid, windowId: target.windowId, mode: "control" }
  });
  assert.equal(select.status, 200);
  const sessionId = select.body.session.sessionId;
  const observed = await fixture.request("/api/tasks/native-task/computer/observe", {
    token,
    body: { sessionId }
  });
  assert.equal(observed.status, 200);
  const action = { sessionId, observationId: observed.body.observationId, action: { type: "activate" } };
  holdObservation = true;
  const late = fixture.request("/api/tasks/native-task/computer/observe", { token, body: { sessionId } });
  await started.promise;
  const queued = fixture.request("/api/tasks/native-task/computer/act", { token, body: action });
  await controller.request({ operation: "pause" });
  gate.resolve();
  assert.notEqual((await late).status, 200);
  assert.notEqual((await queued).status, 200);
  assert.deepEqual(effects, []);
  await controller.request({ operation: "resume" });
  assert.notEqual(
    (await fixture.request("/api/tasks/native-task/computer/act", { token, body: action })).status,
    200
  );
  holdObservation = false;
  const current = await fixture.request("/api/tasks/native-task/computer", { token });
  assert.notEqual(current.body.session.sessionId, sessionId);
  const fresh = await fixture.request("/api/tasks/native-task/computer/observe", {
    token,
    body: { sessionId: current.body.session.sessionId }
  });
  assert.equal(fresh.status, 200);
  const acted = await fixture.request("/api/tasks/native-task/computer/act", {
    token,
    body: {
      sessionId: current.body.session.sessionId,
      observationId: fresh.body.observationId,
      action: { type: "activate" }
    }
  });
  assert.equal(acted.status, 200);
  assert.deepEqual(effects, ["activate"]);
  inspected = { ...instance, startedAt: "2026-01-02T00:00:00.000Z" };
  await assert.rejects(computer({ operation: "permissions", permission: "screenRecording" }), /身份已改变/);
  assert.equal(permissionPrompts, 1);
  inspected = instance;
  await controller.request({ operation: "policy", enabled: false, mode: "control" });
  assert.notEqual(
    (
      await fixture.request("/api/tasks/native-task/computer/observe", {
        token,
        body: { sessionId: current.body.session.sessionId }
      })
    ).status,
    200
  );
});

test(
  "an independent backend completes a code task after its client exits without a graphical host",
  { timeout: 150_000 },
  async (t) => {
    const base = await mkdtemp(join(tmpdir(), "cowork-headless-host-"));
    const home = join(base, "home");
    const project = join(base, "project");
    const userHome = join(base, "user");
    for (const directory of [home, project, userHome, join(base, "workspace")])
      await mkdir(directory, { recursive: true });
    const config = join(base, "config.json");
    await writeFile(config, "{}\n");
    const executable = join(base, "headless-computer-fixture");
    await writeFile(
      executable,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({available:false,screenRecording:false,accessibility:false,controlAvailable:false,windows:[],reason:"fixture: no graphical desktop"}));\n`,
      { mode: 0o755 }
    );
    const release = Promise.withResolvers();
    const received = Promise.withResolvers();
    const failures = [];
    let step = 0;
    const report = "headless fixture result\n";
    const model = await modelProtocolFixture("openai-completions", async (request) => {
      try {
        if (step === 0) {
          received.resolve();
          await release.promise;
        }
        switch (step++) {
          case 0:
            return {
              name: "bash",
              arguments: { command: `${process.execPath} ${join(project, "check-permission.mjs")}` }
            };
          case 1:
            return { name: "read", arguments: { path: join(project, "input.txt") } };
          case 2:
            assert.match(
              JSON.stringify(request.messages.findLast((message) => message.role === "tool")?.content),
              /fixture input/
            );
            return { name: "write", arguments: { path: join(project, "result.txt"), content: report } };
          default:
            return { text: "完成。" };
        }
      } catch (error) {
        failures.push(error.message);
        return { text: "fixture failed" };
      }
    });
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(COWORK_|ATRIA_|PI_|ELECTRON_|SERPER_|EXA_)/.test(key))
    );
    const env = {
      ...inherited,
      HOME: userHome,
      ATRIA_HOME: home,
      PI_CODING_AGENT_DIR: join(base, "pi"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      COWORK_HARNESS_ROOT: repositoryRoot,
      COWORK_WORKSPACE: join(base, "workspace"),
      COWORK_GLOBAL_INDEX: join(home, "runtime/workspaces.json"),
      COWORK_TABS_INDEX: join(home, "runtime/tabs.json"),
      COWORK_CONFIG: config,
      COWORK_DISABLE_WATCH_SUPERVISOR: "1",
      COWORK_COMPUTER_USE_EXECUTABLE: executable,
      COWORK_API_BASE: model.baseUrl,
      COWORK_API_KEY: "local-fixture",
      COWORK_MODEL: "protocol-fixture",
      COWORK_REASONING_EFFORT: "off",
      COWORK_SUPPORTS_REASONING_EFFORT: "0"
    };
    let instance;
    let backendPid;
    t.after(async () => {
      release.resolve();
      try {
        if (backendPid) {
          const stopped = await runProcess(process.execPath, [backendEntry, "stop"], env);
          if (stopped.code !== 0) {
            try {
              process.kill(backendPid, "SIGKILL");
            } catch (error) {
              if (error.code !== "ESRCH") throw error;
            }
          }
          assert.equal(stopped.code, 0, stopped.stderr);
          assert.equal(JSON.parse(stopped.stdout).state, "stopped");
        }
      } finally {
        await model.close();
        await rm(base, { recursive: true, force: true });
      }
    });
    await writeFile(join(project, "input.txt"), "fixture input\n");
    await writeFile(
      join(project, "check-permission.mjs"),
      `
import { writeFile } from "node:fs/promises";
const url = process.env.COWORK_DASHBOARD_URL;
const headers = {"x-atria-token": process.env.COWORK_API_TOKEN, "content-type": "application/json"};
await writeFile(${JSON.stringify(join(project, "run-credential.txt"))}, process.env.COWORK_API_TOKEN);
const info = await (await fetch(url + "/api/backend", {headers})).json();
const response = await fetch(url + "/api/host/computer", {
  method:"POST", headers,
  body:JSON.stringify({backendId:info.backendId, pid:info.pid, startedAt:info.startedAt,
    input:{operation:"permissions",permission:"screenRecording"}})
});
await writeFile(${JSON.stringify(join(project, "permission-status.txt"))}, String(response.status));
`
    );
    const started = await runProcess(process.execPath, [backendEntry, "start"], env);
    assert.equal(started.code, 0, started.stderr);
    const startedState = JSON.parse(started.stdout);
    assert.equal(startedState.state, "started");
    backendPid = startedState.pid;
    instance = JSON.parse(await readFile(join(home, "runtime/backend-instance.json"), "utf8"));
    assert.equal(instance.pid, startedState.pid);
    const call = async (path) => {
      const response = await fetch(`${instance.url}${path}`, {
        headers: { "x-atria-token": instance.token }
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const status = await call("/api/computer/status");
    assert.equal(status.available, false);
    assert.ok(status.reason);
    if (process.platform === "darwin") assert.equal(status.reason, "fixture: no graphical desktop");
    const client = join(base, "client.mjs");
    await writeFile(
      client,
      `
const [url, token, project] = process.argv.slice(2);
const headers = {"x-atria-token": token, "content-type": "application/json"};
async function post(path, body) {
  const response = await fetch(url + path, {method:"POST", headers, body:JSON.stringify(body)});
  const result = await response.json();
  if (!response.ok) throw new Error(path + " " + JSON.stringify(result));
  return result;
}
const created = await post("/api/projects", {projectName:"Headless", projectDirectory:project});
await post("/api/tasks", {taskId:"headless-task", goal:"write result", projectId:created.project.projectId});
await post("/api/tasks/headless-task/run", {prompt:"Read input.txt and write result.txt."});
process.stdout.write("client exited");
`
    );
    const clientResult = await runProcess(
      process.execPath,
      [client, instance.url, instance.token, project],
      env
    );
    assert.equal(clientResult.code, 0, clientResult.stderr);
    assert.equal(clientResult.stdout, "client exited");
    await received.promise;
    assert.equal((await call("/api/tasks/headless-task")).runtime.active, true);
    release.resolve();
    await waitFor(async () => {
      const task = await call("/api/tasks/headless-task");
      return !task.runtime.active && task.task.status === "completed";
    }, 60_000);
    assert.deepEqual(failures, []);
    assert.equal(await readFile(join(project, "permission-status.txt"), "utf8"), "403");
    assert.equal(await readFile(join(project, "result.txt"), "utf8"), report);
    assert.equal((await call("/api/backend")).pid, instance.pid);
    assert.equal((await call("/api/computer/status")).available, false);
    const runCredential = await readFile(join(project, "run-credential.txt"), "utf8");
    const stopped = await runProcess(process.execPath, [backendEntry, "stop"], env);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(JSON.parse(stopped.stdout).state, "stopped");
    backendPid = undefined;
    const restarted = await runProcess(process.execPath, [backendEntry, "start"], env);
    assert.equal(restarted.code, 0, restarted.stderr);
    const restartedState = JSON.parse(restarted.stdout);
    backendPid = restartedState.pid;
    const priorIdentity = instance.backendId;
    instance = JSON.parse(await readFile(join(home, "runtime/backend-instance.json"), "utf8"));
    assert.equal(instance.backendId, priorIdentity);
    assert.notEqual(instance.pid, startedState.pid);
    assert.equal(
      (await fetch(`${instance.url}/api/computer/status`, { headers: { "x-atria-token": runCredential } }))
        .status,
      401
    );
    assert.equal((await call("/api/computer/access")).policy.enabled, false);
  }
);

async function runProcess(entry, args, env) {
  const child = spawn(entry, args, { cwd: repositoryRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const [code] = await once(child, "close");
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for fixture result");
    await new Promise((done) => setTimeout(done, 10));
  }
}
