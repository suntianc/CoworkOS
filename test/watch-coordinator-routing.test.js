import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { MainSupervisor } from "../dist/src/runtime/main-supervisor.js";
import { DurableScheduler, InboxStore } from "../dist/src/runtime/scheduler.js";
import { WatchProgramStore } from "../dist/src/runtime/watch-program-store.js";
import { WatchSupervisor } from "../dist/src/runtime/watch-supervisor.js";
import { WatcherRuntime } from "../dist/src/runtime/watcher.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const TASK = "routing-task";
const MAIN_RUN = `main-${TASK}`;
const CHANGE = "classification: relevant_change\nEvidence: an important fixture change";
const execute = promisify(execFile);
const cliEntry = resolve("scripts/atria.mjs");

// Keep the real Coordinator/Pi loop; only the provider and external event source
// are fixtures. Inherited user runtime settings must not select another API,
// proxy, workspace, model or credential for these sessions.
async function fixture(t, { classification = CHANGE, onRequest } = {}) {
  const inherited = process.env;
  process.env = Object.fromEntries(
    Object.entries(inherited).filter(
      ([name]) => !/^(?:COWORK_|ATRIA_|PI_|SERPER_|(?:HTTP|HTTPS|ALL|NO)_PROXY$)/i.test(name)
    )
  );
  t.after(() => {
    process.env = inherited;
  });
  const root = await mkdtemp(join(tmpdir(), "atria-watch-coordinator-routing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalWorkspaceStore(root);
  await store.createTask(TASK, { goal: "follow a fixture topic" });
  await store.createRun(TASK, MAIN_RUN);
  await store.transitionTask(TASK, "waiting", {
    runId: MAIN_RUN,
    reason: "parked_for_wake",
    completion: { signal: "natural_stop" }
  });
  const programs = new WatchProgramStore(root);
  const program = await programs.createProgram({
    taskId: TASK,
    programId: "topic",
    subject: "fixture",
    objective: "find important changes"
  });
  const monitor = await programs.createVirtualAgent({
    programId: program.programId,
    task: "classify the fixture event",
    profileId: "custom",
    cadenceSeconds: 3600,
    wake: "important",
    activate: true
  });
  // Accepted events and controls are enough to drive the real executor. Do not
  // add a polling source that could create unrelated work during recovery.
  await programs.updateVirtualAgentState(TASK, program.programId, monitor.monitorId, {
    lastCheckedAt: new Date().toISOString()
  });
  const model = await modelProtocolFixture("openai-completions", async () => {
    await onRequest?.({ root, store, programs, program, monitor });
    return { text: classification };
  });
  t.after(() => model.close());
  const connection = {
    baseUrl: model.baseUrl,
    apiKey: "isolated-local-fixture",
    model: "protocol-fixture",
    api: "openai-completions",
    thinkingFormat: "openai",
    thinkingLevel: "off",
    supportsReasoningEffort: false,
    supportsImages: false,
    maxTurns: 2,
    maxTokens: 256,
    timeoutMs: 5000
  };
  const supervisor = () => new WatchSupervisor({ workspaceRoot: root, ...connection });
  const mainPath = join(root, TASK, "runs", MAIN_RUN, "agents", "main", "inbox-store.json");
  const mainInbox = new InboxStore(mainPath);
  const sourceInbox = new InboxStore(
    join(root, TASK, "runs", "watch-topic", "agents", monitor.monitorId, "inbox-store.json")
  );
  const ingest = () =>
    new WatcherRuntime({
      workspaceRoot: root,
      taskId: TASK,
      runId: "watch-topic",
      programId: program.programId,
      recipientAgentId: monitor.monitorId
    }).ingest({
      watcherId: monitor.monitorId,
      source: "fixture",
      type: "fixture.changed",
      dedupeKey: "important-change",
      payload: { title: "Important change" }
    });
  return {
    root,
    store,
    programs,
    program,
    monitor,
    model,
    connection,
    supervisor,
    mainPath,
    mainInbox,
    sourceInbox,
    ingest
  };
}

test(
  "real Watch analysis preserves Main's Task and wakes the offline Main Run",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await f.ingest();
    const before = await f.store.readTask(TASK);
    const cycle = await f.supervisor().runCycle({ taskId: TASK });

    assert.deepEqual(cycle.failures, []);
    assert.equal(cycle.processed, 1);
    assert.equal(cycle.wakeRequests, 1);
    assert.equal(f.model.requests.length, 1, "the default executor must reach the real Pi/model loop");
    assert.deepEqual(
      await f.store.readTask(TASK),
      before,
      "monitor analysis must not claim the Task lifecycle"
    );
    const [wake] = await f.mainInbox.list("main");
    assert.match(wake.payload.summary, /important fixture change/);
    const state = await f.programs.readVirtualAgentState(TASK, "topic", f.monitor.monitorId);
    assert.notEqual(state.lastRunId, MAIN_RUN);
    const analysisRun = JSON.parse(
      await readFile(join(f.root, TASK, "runs", state.lastRunId, "run.json"), "utf8")
    );
    assert.equal(analysisRun.runId, state.lastRunId, "keep the separate monitor Run and its durable records");
    const launches = [];
    const main = new MainSupervisor({
      workspaceRoot: f.root,
      launch: (input) => {
        launches.push(input);
      }
    });
    assert.equal((await main.runCycle({ taskId: TASK })).resumed, 1);
    assert.deepEqual(launches, [{ taskId: TASK, runId: MAIN_RUN }]);
  }
);

test(
  "completed Tasks do not restart Watch analysis or erase their completion",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, { classification: "classification: no_change\nNo important change" });
    await f.store.transitionTask(TASK, "completed", {
      runId: MAIN_RUN,
      reason: "fixture_finished",
      completion: { signal: "finish_task", verifiedAt: new Date().toISOString() }
    });
    await f.ingest();
    const before = await f.store.readTask(TASK);

    const cycle = await f.supervisor().runCycle({ taskId: TASK });
    assert.deepEqual(cycle.failures, []);
    assert.equal(cycle.processed, 0);
    assert.equal(cycle.wakeRequests, 0);
    assert.equal(f.model.requests.length, 0);
    assert.deepEqual(await f.store.readTask(TASK), before);
    assert.deepEqual(await f.mainInbox.list("main"), []);
  }
);

test(
  "real monitor control analysis preserves Main's Run and survives a supervisor restart",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await f.programs.enqueueControl(TASK, f.monitor.monitorId, "narrow the monitor scope");
    const before = await f.store.readTask(TASK);

    const first = await f.supervisor().runCycle({ taskId: TASK });
    assert.deepEqual(first.failures, []);
    assert.equal(first.wakeRequests, 1);
    assert.deepEqual(await f.store.readTask(TASK), before);
    assert.equal(f.model.requests.length, 1);
    assert.match(JSON.stringify(f.model.requests[0].body.messages), /narrow the monitor scope/);
    assert.deepEqual(await f.programs.listControls(TASK, "topic", f.monitor.monitorId), []);
    const runs = await readdir(join(f.root, TASK, "runs"));
    assert.ok(runs.some((runId) => runId.startsWith(`control-topic-${f.monitor.monitorId}-`)));

    const restarted = await f.supervisor().runCycle({ taskId: TASK });
    assert.deepEqual(restarted.failures, []);
    assert.equal(f.model.requests.length, 1, "a consumed control must not run again");
    assert.equal((await f.mainInbox.list("main")).length, 1);
    assert.deepEqual(await f.store.readTask(TASK), before);
  }
);

test(
  "a real Watch result retries failed delivery without repeating analysis or claiming Task state",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, {
      onRequest: ({ root }) => mkdir(join(root, TASK, "runs", MAIN_RUN, "agents", "main", "inbox-store.json"))
    });
    await f.ingest();
    const before = await f.store.readTask(TASK);
    const failed = await f.supervisor().runCycle({ taskId: TASK });
    assert.equal(failed.failures.length, 1);
    assert.match(failed.failures[0].error, /EISDIR/);
    assert.equal(f.model.requests.length, 1);
    assert.deepEqual(await f.store.readTask(TASK), before);
    const pending = await f.programs.readVirtualAgentState(TASK, "topic", f.monitor.monitorId);
    assert.equal(pending.pendingWake.runId, MAIN_RUN);
    assert.equal((await f.sourceInbox.list(f.monitor.monitorId))[0].state, "ready");
    await rm(f.mainPath, { recursive: true });

    const recovered = await f.supervisor().runCycle({ taskId: TASK });
    assert.deepEqual(recovered.failures, []);
    assert.equal(recovered.wakeRequests, 1);
    assert.equal(f.model.requests.length, 1, "recovery must reuse the durable result");
    assert.deepEqual(await f.store.readTask(TASK), before);
    assert.equal((await f.mainInbox.list("main")).length, 1);
    assert.equal((await f.sourceInbox.list(f.monitor.monitorId))[0].state, "consumed");
  }
);

test(
  "finishing real Watch analysis does not restore stale Task state over a newer Main Run",
  { timeout: 15000 },
  async (t) => {
    let newer;
    const f = await fixture(t, {
      onRequest: async ({ store }) => {
        await store.createRun(TASK, "newer-main-run");
        await store.transitionTask(TASK, "waiting", {
          runId: "newer-main-run",
          reason: "newer_main_parked",
          completion: { signal: "interrupted" }
        });
        newer = await store.readTask(TASK);
      }
    });
    await f.ingest();
    assert.deepEqual((await f.supervisor().runCycle({ taskId: TASK })).failures, []);
    assert.deepEqual(await f.store.readTask(TASK), newer);
  }
);

test(
  "Coordinator recovery retains a background Run's lifecycle ownership and tool restriction from the durable queue",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const before = await f.store.readTask(TASK);
    const runId = "monitor-recovery";
    const input = {
      ...f.connection,
      workspaceRoot: f.root,
      taskId: TASK,
      runId,
      agentId: f.monitor.monitorId,
      callId: "queued-analysis",
      task: "classify the fixture",
      mode: "sync",
      activateRun: false,
      disableTools: true,
      skillRoots: [],
      toolFactory: () => new Map(),
      questionTimeoutMs: 0,
      onQueued: () => {
        throw new Error("fixture stopped after durable enqueue");
      }
    };
    const interrupted = await new CoordinatorRuntime().dispatch(input);
    assert.equal(interrupted.status, "failed");
    assert.match(interrupted.error, /stopped after durable enqueue/);
    assert.deepEqual(await f.store.readTask(TASK), before);
    assert.equal(f.model.requests.length, 0);
    const scheduler = new DurableScheduler(join(f.root, TASK, "runs", runId, "queue.json"));
    assert.equal((await scheduler.list())[0].payload.activateRun, false);
    assert.equal((await scheduler.list())[0].payload.disableTools, true);

    const recovered = await new CoordinatorRuntime().recoverRun({
      ...f.connection,
      workspaceRoot: f.root,
      taskId: TASK,
      runId,
      skillRoots: [],
      toolFactory: () => new Map(),
      questionTimeoutMs: 0
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, "succeeded");
    assert.equal(f.model.requests.length, 1);
    assert.equal(f.model.requests[0].body.tools?.length ?? 0, 0);
    assert.deepEqual(await f.store.readTask(TASK), before);
    assert.equal((await scheduler.list())[0].status, "completed");
  }
);

test(
  "ordinary Coordinator delegation keeps its existing Task activation semantics",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const result = await new CoordinatorRuntime().dispatch({
      ...f.connection,
      workspaceRoot: f.root,
      taskId: TASK,
      runId: MAIN_RUN,
      agentId: "ordinary-subagent",
      task: "summarize the fixture",
      mode: "sync",
      skillRoots: [],
      toolFactory: () => new Map()
    });
    assert.equal(result.status, "succeeded");
    const task = await f.store.readTask(TASK);
    assert.equal(task.activeRunId, MAIN_RUN);
    assert.equal(task.status, "running");
    assert.equal(task.completion.signal, "none");
    assert.equal(f.model.requests.length, 1);
  }
);

test(
  "real CLI watch-run preserves Main's Task ownership and acknowledges the event",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await f.ingest();
    const before = await f.store.readTask(TASK);
    const configPath = join(f.root, "fixture-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        baseUrl: f.connection.baseUrl,
        apiKey: f.connection.apiKey,
        model: f.connection.model,
        api: f.connection.api,
        thinkingFormat: f.connection.thinkingFormat,
        reasoningEffort: "off",
        supportsReasoningEffort: false,
        supportsImages: false,
        webTools: false
      })
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^(?:COWORK_|ATRIA_|PI_|SERPER_|NODE_OPTIONS$|(?:HTTP|HTTPS|ALL|NO)_PROXY$)/i.test(name)
      )
    );
    const { stdout, stderr } = await execute(
      process.execPath,
      [
        cliEntry,
        "watch-run",
        "--task",
        TASK,
        "--run",
        "watch-topic",
        "--program",
        "topic",
        "--monitor",
        f.monitor.monitorId,
        "--timeout",
        "5000",
        "--max-turns",
        "2",
        "--max-tokens",
        "256"
      ],
      {
        cwd: f.root,
        env: {
          ...env,
          ATRIA_HOME: join(f.root, "user"),
          COWORK_CONFIG: configPath,
          COWORK_WORKSPACE: f.root,
          PI_CODING_AGENT_DIR: join(f.root, "pi"),
          COWORK_DISABLE_WATCH_SUPERVISOR: "1",
          PI_OFFLINE: "1"
        },
        timeout: 10000,
        maxBuffer: 1024 * 1024
      }
    );
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.status, "succeeded");
    assert.equal(result.processed, true);
    assert.notEqual(result.monitorRunId, MAIN_RUN);
    assert.equal(f.model.requests.length, 1, "CLI analysis must use the real Coordinator/Pi loop");
    assert.deepEqual(await f.store.readTask(TASK), before);
    assert.equal((await f.sourceInbox.list(f.monitor.monitorId))[0].state, "consumed");
    const analysis = await f.programs.readVirtualAgentState(TASK, "topic", f.monitor.monitorId);
    assert.equal(analysis.lastRunId, result.monitorRunId);
    assert.match(analysis.lastSummary, /important fixture change/);
  }
);
