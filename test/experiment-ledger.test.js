import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { ExperimentProgramStore } from "../dist/src/runtime/experiment-program-store.js";
import { readRunMetrics, METRICS_FILENAME } from "../dist/src/runtime/experiment-metrics.js";
import { experimentDigest } from "../dist/src/runtime/experiment-digest.js";
import { metricSeries } from "../dist/src/domain/experiment.js";
import {
  configuredExperimentMaxRuns,
  configuredMaxAttempts,
  DEFAULT_MAX_ATTEMPTS
} from "../dist/src/runtime/runtime-settings.js";

const extensionPath = resolve(".pi/extensions/cowork.ts");
const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));

function fakePi() {
  const tools = new Map();
  const handlers = new Map();
  return {
    tools,
    handlers,
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerProvider() {},
    registerCommand() {},
    getActiveTools() {
      return [...tools.keys()];
    },
    setActiveTools() {},
    sendMessage: async () => {}
  };
}

async function loadExtension() {
  const { createJiti } = await import(requirePi.resolve("jiti"));
  const jiti = createJiti(pathToFileURL(extensionPath).href, { interopDefault: true });
  const module = await jiti.import(extensionPath, { default: true });
  return module.default ?? module;
}

const ctx = { ui: { setStatus() {}, notify() {} } };

async function extensionFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-ledger-"));
  const taskId = "ledger-task";
  await new LocalWorkspaceStore(root).createTask(taskId, { goal: "iterate" });

  await writeFile(join(root, "config.json"), "{}\n");
  const env = {
    COWORK_API_BASE: "http://127.0.0.1:1",
    COWORK_API_KEY: "test-key",
    COWORK_CONFIG: join(root, "config.json"),
    COWORK_WORKSPACE: root,
    COWORK_TASK_ID: taskId,
    COWORK_RUN_ID: "run-1"
  };
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  const dispatches = [];
  const originalDispatch = CoordinatorRuntime.prototype.dispatch;
  CoordinatorRuntime.prototype.dispatch = function (input) {
    dispatches.push(input);
    input.onQueued?.();
    return Promise.resolve({
      callId: input.callId,
      taskId: input.taskId,
      runId: input.runId,
      agentId: input.agentId,
      status: "succeeded",
      response: `completed: ${input.task}`,
      workingDirectory: join(root, "wd"),
      artifacts: []
    });
  };

  t.after(async () => {
    CoordinatorRuntime.prototype.dispatch = originalDispatch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const pi = fakePi();
  await (
    await loadExtension()
  )(pi);
  return { pi, root, taskId, dispatches, store: new ExperimentProgramStore(root) };
}

test("the ledger adds no tools for Main to operate", async (t) => {
  const { pi } = await extensionFixture(t);
  // Bookkeeping is Runtime's job. Exposing it as tools would hand the
  // decision-maker a subsystem to maintain.
  for (const name of pi.tools.keys()) {
    assert.ok(!name.startsWith("experiment_"), `${name} must not exist: the ledger is not Main's to operate`);
  }
  assert.deepEqual(pi.tools.get("call_subagent").parameters.required, ["task", "mode"]);
  assert.deepEqual(Object.keys(pi.tools.get("call_subagent").parameters.properties), [
    "task",
    "attachments",
    "resources",
    "mode",
    "role",
    "dependsOn",
    "developmentId",
    "continueCallId",
    "reviewId",
    "profileId",
    "model"
  ]);
  assert.equal(pi.tools.get("call_subagent").parameters.additionalProperties, false);
});

test("delegations are recorded without Main declaring anything, and lineage is inferred", async (t) => {
  const { pi, dispatches, store, taskId } = await extensionFixture(t);
  for (const task of ["train on v1", "evaluate v1", "train on v2"]) {
    await pi.tools.get("call_subagent").execute("c", { task, mode: "sync" }, undefined, undefined, ctx);
  }
  const programs = await store.listPrograms(taskId);
  assert.equal(programs.length, 1, "one ledger per Task, created by Runtime on first use");

  const runs = await store.listRuns(taskId, programs[0].experimentId);
  assert.equal(runs.length, 3);
  assert.deepEqual(
    runs.map((run) => run.objective),
    ["train on v1", "evaluate v1", "train on v2"]
  );
  // These rows never settled (the fixture stubs dispatch), so none of them has
  // a result a later round could have built on. Lineage stays empty rather
  // than inventing a chain out of start order; the parallel test covers the
  // same rule, and the settled case is covered below.
  assert.ok(runs.every((run) => run.variant?.parentRunId === undefined));
  assert.ok(dispatches.every((call) => call.experimentRef?.experimentRunId));
});

test("ledger ids reach both the callback and the crash-durable queue payload", async (t) => {
  const { pi, dispatches } = await extensionFixture(t);
  await pi.tools
    .get("call_subagent")
    .execute("c1", { task: "train", mode: "sync" }, undefined, undefined, ctx);
  assert.deepEqual(dispatches[0].callbackMetadata, dispatches[0].experimentRef);
});

test("a ledger failure never fails the delegation", async (t) => {
  const { pi, store, taskId, dispatches } = await extensionFixture(t);
  const original = ExperimentProgramStore.prototype.openRun;
  ExperimentProgramStore.prototype.openRun = async () => {
    throw new Error("disk full");
  };
  t.after(() => {
    ExperimentProgramStore.prototype.openRun = original;
  });

  const result = await pi.tools
    .get("call_subagent")
    .execute("c1", { task: "train", mode: "sync" }, undefined, undefined, ctx);
  assert.equal(result.details.status, "succeeded");
  assert.equal(dispatches[0].experimentRef, undefined);
});

test("the recording cap bounds bookkeeping without blocking work", async (t) => {
  const { pi, store, taskId, dispatches } = await extensionFixture(t);
  process.env.COWORK_EXPERIMENT_MAX_RUNS = "2";
  t.after(() => {
    delete process.env.COWORK_EXPERIMENT_MAX_RUNS;
  });

  for (const task of ["one", "two", "three"]) {
    const out = await pi.tools
      .get("call_subagent")
      .execute("c", { task, mode: "sync" }, undefined, undefined, ctx);
    assert.equal(out.details.status, "succeeded", "work continues past the recording cap");
  }
  const programs = await store.listPrograms(taskId);
  assert.equal((await store.listRuns(taskId, programs[0].experimentId)).length, 2);
  assert.equal(dispatches[2].experimentRef, undefined);
});

test("get_task_status reports a compact index, not the series", async (t) => {
  const { pi, store, taskId } = await extensionFixture(t);
  await pi.tools
    .get("call_subagent")
    .execute("c1", { task: "evaluate", mode: "sync" }, undefined, undefined, ctx);
  const programs = await store.listPrograms(taskId);
  const runs = await store.listRuns(taskId, programs[0].experimentId);
  await store.completeRun({
    taskId,
    experimentId: programs[0].experimentId,
    runId: runs[0].runId,
    status: "succeeded",
    metrics: { eval_score: 58.1 }
  });

  const status = await pi.tools.get("get_task_status").execute();
  assert.equal(status.details.experiments.length, 1);
  assert.deepEqual(status.details.experiments[0].metrics, ["eval_score"]);
  assert.equal(status.details.experiments[0].runs, undefined, "the per-run series must not ride along");
});

test("the digest states what was measured and never says what to do next", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-digest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskId = "digest-task";
  await new LocalWorkspaceStore(root).createTask(taskId, { goal: "raise eval" });
  const store = new ExperimentProgramStore(root);

  // One measurement is not a series: the conversation still holds it.
  const program = await store.ensureLedger(taskId, "raise eval");
  const first = await store.startRun({
    taskId,
    experimentId: program.experimentId,
    callId: "call-1",
    agentId: "subagent_1",
    objective: "evaluate v1"
  });
  await store.completeRun({
    taskId,
    experimentId: program.experimentId,
    runId: first.runId,
    status: "succeeded",
    metrics: { eval_score: 58.1 },
    variantRef: "data-v1"
  });
  assert.equal(await experimentDigest(root, taskId), undefined);

  let parent = first.runId;
  for (const [index, score] of [61.2, 63.5].entries()) {
    const run = await store.startRun({
      taskId,
      experimentId: program.experimentId,
      callId: `call-${index + 2}`,
      agentId: `subagent_${index + 2}`,
      objective: `evaluate v${index + 2}`,
      variant: { subject: "other", ref: "", parentRunId: parent }
    });
    await store.completeRun({
      taskId,
      experimentId: program.experimentId,
      runId: run.runId,
      status: "succeeded",
      metrics: { eval_score: score },
      variantRef: `data-v${index + 2}`
    });
    parent = run.runId;
  }

  const digest = await experimentDigest(root, taskId);
  assert.match(digest, /Recorded rounds \(3 measured/);
  assert.match(digest, /data-v1/);
  assert.match(digest, /eval_score: 58\.1 → 61\.2 → 63\.5/, "the series is presented as reported");
  assert.match(digest, /from #2/, "lineage is shown by round number");
  // The Runtime must not read the trend for Main.
  for (const word of ["should", "best", "improved", "recommend", "next iteration", "try"]) {
    assert.ok(!digest.toLowerCase().includes(word), `digest must not advise: found "${word}"`);
  }
});

test("the digest keeps the baseline when truncating a long series", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-digest-long-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskId = "long-task";
  await new LocalWorkspaceStore(root).createTask(taskId, { goal: "iterate" });
  const store = new ExperimentProgramStore(root);
  const program = await store.ensureLedger(taskId, "iterate");
  for (let index = 0; index < 12; index += 1) {
    const run = await store.startRun({
      taskId,
      experimentId: program.experimentId,
      callId: `call-${index}`,
      agentId: `subagent_${index}`,
      objective: `round ${index}`
    });
    await store.completeRun({
      taskId,
      experimentId: program.experimentId,
      runId: run.runId,
      status: "succeeded",
      metrics: { score: index },
      variantRef: `v${index}`
    });
  }
  const digest = await experimentDigest(root, taskId, { maxRows: 4 });
  assert.match(digest, /v0/, "the baseline every later round is judged against stays readable");
  assert.match(digest, /earlier rounds omitted/);
  assert.match(digest, /v11/);
});

test("metric series are inferred from what runs reported, with no declaration", () => {
  const runs = [
    { runId: "r1", metrics: { eval_score: 58.1, loss: 0.9 } },
    { runId: "r2", metrics: { eval_score: 61.2, loss: 0.83 } },
    { runId: "r3", metrics: { eval_score: 63.5, wall_clock_s: 400 } }
  ];
  const series = metricSeries(runs);
  assert.deepEqual(series[0], {
    name: "eval_score",
    points: [
      { runId: "r1", value: 58.1 },
      { runId: "r2", value: 61.2 },
      { runId: "r3", value: 63.5 }
    ]
  });
  assert.equal(series[1].name, "loss");
  // A value seen once is a reading, not yet a trend, so it sorts last.
  assert.equal(series.at(-1).name, "wall_clock_s");
  assert.deepEqual(metricSeries([{ runId: "r1", metrics: { note: "not a number" } }]), []);
});

test("metrics come from the run's own file; a bad file is reported, not ignored", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-metrics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workingDirectory = join(root, "agent");
  await mkdir(join(workingDirectory, "deliverables"), { recursive: true });

  assert.deepEqual(
    await readRunMetrics({ workingDirectory, taskDirectory: root }),
    {},
    "no metrics file is normal"
  );

  await writeFile(
    join(workingDirectory, METRICS_FILENAME),
    JSON.stringify({ eval_score: 61.2, variant: "data-v2" })
  );
  const found = await readRunMetrics({ workingDirectory, taskDirectory: root });
  assert.deepEqual(found.metrics, { eval_score: 61.2 }, "a variant label is not a metric");
  assert.equal(found.ref, "data-v2", "Runtime observes the label instead of asking Main for it");
  assert.equal(found.source, join("agent", METRICS_FILENAME));

  await writeFile(join(workingDirectory, METRICS_FILENAME), "{ not json");
  assert.match((await readRunMetrics({ workingDirectory, taskDirectory: root })).problem, /not valid JSON/);

  await writeFile(join(workingDirectory, METRICS_FILENAME), JSON.stringify([1, 2]));
  assert.match((await readRunMetrics({ workingDirectory, taskDirectory: root })).problem, /JSON object/);
});

test("the ledger records and does not advise", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ExperimentProgramStore(root);
  const taskId = "store-task";
  const program = await store.ensureLedger(taskId, "iterate");
  const run = await store.startRun({
    taskId,
    experimentId: program.experimentId,
    callId: "call-1",
    agentId: "subagent_1",
    objective: "evaluate"
  });

  await store.completeRun({
    taskId,
    experimentId: program.experimentId,
    runId: run.runId,
    status: "succeeded",
    metrics: { eval_score: 58 },
    metricsOrigin: "file"
  });
  // A duplicate callback must not rewrite a settled row.
  const replayed = await store.completeRun({
    taskId,
    experimentId: program.experimentId,
    runId: run.runId,
    status: "failed",
    metrics: { eval_score: 0 }
  });
  assert.equal(replayed.status, "succeeded");
  assert.deepEqual(replayed.metrics, { eval_score: 58 });

  const parked = await store.readProgram(taskId, program.experimentId);
  assert.equal(parked.decisionOwner, "main");
  assert.equal(parked.nextAction, undefined, "the Runtime must not tell the decision-maker what to do");
});

test("ensureLedger is idempotent across processes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-store-idem-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskId = "idem-task";
  const [a, b] = await Promise.all([
    new ExperimentProgramStore(root).ensureLedger(taskId, "iterate"),
    new ExperimentProgramStore(root).ensureLedger(taskId, "iterate")
  ]);
  assert.equal(a.experimentId, b.experimentId);
  assert.equal((await new ExperimentProgramStore(root).listPrograms(taskId)).length, 1);
});

test("operator-side bounds are read from the environment, not asked of Main", () => {
  assert.equal(configuredExperimentMaxRuns({}), 0, "unlimited by default");
  assert.equal(configuredExperimentMaxRuns({ COWORK_EXPERIMENT_MAX_RUNS: "50" }), 50);
  assert.equal(configuredMaxAttempts({}), DEFAULT_MAX_ATTEMPTS);
  assert.equal(configuredMaxAttempts({ COWORK_MAX_ATTEMPTS: "1" }), 1);
  assert.equal(
    configuredMaxAttempts({ COWORK_MAX_ATTEMPTS: "0" }),
    DEFAULT_MAX_ATTEMPTS,
    "zero attempts would never run"
  );
});

/** A stub model endpoint, so a real dispatch can run without a provider. */
async function modelFixture(t, { fail = false } = {}) {
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    if (fail) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "fixture failure" }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) =>
      `data: ${JSON.stringify({
        id: "completion-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "glm-5.3",
        choices: [{ index: 0, delta, finish_reason }]
      })}\n\n`;
    response.write(chunk({ role: "assistant", content: "Evaluation finished." }));
    response.write(chunk({}, "stop"));
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "fixture-key" };
}

test("a real dispatch settles its row from the file the run wrote", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "atria-settle-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const taskId = "settle-task";
  const runId = "settle-run";
  const workspace = new LocalWorkspaceStore(workspaceRoot);
  await workspace.createTask(taskId, { goal: "raise eval" });
  const store = new ExperimentProgramStore(workspaceRoot);
  const program = await store.ensureLedger(taskId, "raise eval");
  const ledgerRun = await store.startRun({
    taskId,
    experimentId: program.experimentId,
    callId: "call-settle",
    agentId: "subagent_1",
    objective: "evaluate"
  });

  const workDir = await workspace.prepareAgentWorkDir(taskId, runId, "subagent_1");
  await writeFile(
    join(workDir, METRICS_FILENAME),
    JSON.stringify({ eval_score: 63.5, loss: 0.81, variant: "data-v3" })
  );

  const model = await modelFixture(t);
  const result = await new CoordinatorRuntime().dispatch({
    taskId,
    runId,
    callId: "call-settle",
    agentId: "subagent_1",
    task: "evaluate data-v3",
    mode: "sync",
    workspaceRoot,
    baseUrl: model.baseUrl,
    apiKey: model.apiKey,
    model: "glm-5.3",
    maxTurns: 2,
    timeoutMs: 20_000,
    experimentRef: { experimentId: program.experimentId, experimentRunId: ledgerRun.runId }
  });
  assert.equal(result.status, "succeeded");

  const settled = await store.readRun(taskId, program.experimentId, ledgerRun.runId);
  assert.deepEqual(settled.metrics, { eval_score: 63.5, loss: 0.81 });
  assert.equal(settled.metricsOrigin, "file");
  assert.equal(settled.variant.ref, "data-v3", "the label the run reported is recorded");
  assert.ok(settled.metricsSource?.includes(METRICS_FILENAME));
});

test("a failure still being retried leaves its row open", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "atria-retry-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const taskId = "retry-task";
  const runId = "retry-run";
  await new LocalWorkspaceStore(workspaceRoot).createTask(taskId, { goal: "iterate" });
  const store = new ExperimentProgramStore(workspaceRoot);
  const program = await store.ensureLedger(taskId, "iterate");
  const ledgerRun = await store.startRun({
    taskId,
    experimentId: program.experimentId,
    callId: "call-retry",
    agentId: "subagent_1",
    objective: "train"
  });

  const model = await modelFixture(t, { fail: true });
  const dispatchInput = {
    taskId,
    runId,
    callId: "call-retry",
    agentId: "subagent_1",
    task: "train",
    mode: "sync",
    workspaceRoot,
    baseUrl: model.baseUrl,
    apiKey: model.apiKey,
    model: "glm-5.3",
    maxTurns: 2,
    timeoutMs: 20_000,
    maxAttempts: 2,
    experimentRef: { experimentId: program.experimentId, experimentRunId: ledgerRun.runId }
  };
  await new CoordinatorRuntime().dispatch(dispatchInput).catch(() => {});
  const stillOpen = await store.readRun(taskId, program.experimentId, ledgerRun.runId);
  assert.equal(stillOpen.status, "running", "a retryable failure is not yet an outcome");
  assert.equal(stillOpen.finishedAt, undefined);

  await new CoordinatorRuntime().dispatch(dispatchInput).catch(() => {});
  const settled = await store.readRun(taskId, program.experimentId, ledgerRun.runId);
  assert.equal(settled.status, "failed");
  assert.ok(settled.error);
});

test("parallel delegations are siblings, not a fabricated chain", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-parallel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskId = "par-task";
  await new LocalWorkspaceStore(root).createTask(taskId, { goal: "iterate" });
  const store = new ExperimentProgramStore(root);

  // A settled round, then three delegations issued in one turn. The three
  // build on the settled result, not on each other: none of them could have
  // seen another's outcome.
  const first = await store.openRun({ taskId, callId: "call-0", agentId: "sub_0", objective: "baseline" });
  await store.completeRun({
    taskId,
    ...first,
    runId: first.experimentRunId,
    status: "succeeded",
    metrics: { score: 1 }
  });

  const refs = await Promise.all(
    [1, 2, 3].map((index) =>
      store.openRun({
        taskId,
        callId: `call-${index}`,
        agentId: `sub_${index}`,
        objective: `branch ${index}`
      })
    )
  );
  const runs = await store.listRuns(taskId, "ledger");
  const parents = refs.map(
    (ref) => runs.find((run) => run.runId === ref.experimentRunId).variant?.parentRunId
  );
  assert.deepEqual(
    parents,
    [first.experimentRunId, first.experimentRunId, first.experimentRunId],
    "an in-flight row has no result to build on, so it cannot be a parent"
  );
});

test("a delegation with no metrics and no outputs leaves no row behind", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-prune-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskId = "prune-task";
  await new LocalWorkspaceStore(root).createTask(taskId, { goal: "iterate" });
  const store = new ExperimentProgramStore(root);

  const ordinary = await store.openRun({
    taskId,
    callId: "call-1",
    agentId: "sub_1",
    objective: "read a file"
  });
  await store.discardRun(taskId, ordinary.experimentId, ordinary.experimentRunId);
  assert.deepEqual(
    await store.listRuns(taskId, "ledger"),
    [],
    "ordinary work must not bury the rounds that matter"
  );

  // The budget still counted it: a discarded row consumed a delegation.
  assert.equal((await store.readProgram(taskId, "ledger")).runCount, 1);
});

test("a row later rounds descend from is never discarded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-prune-keep-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskId = "keep-task";
  await new LocalWorkspaceStore(root).createTask(taskId, { goal: "iterate" });
  const store = new ExperimentProgramStore(root);

  const parent = await store.openRun({ taskId, callId: "call-1", agentId: "sub_1", objective: "round 1" });
  await store.completeRun({
    taskId,
    ...parent,
    runId: parent.experimentRunId,
    status: "succeeded",
    metrics: { score: 5 }
  });
  const child = await store.openRun({ taskId, callId: "call-2", agentId: "sub_2", objective: "round 2" });
  assert.equal(
    (await store.readRun(taskId, "ledger", child.experimentRunId)).variant.parentRunId,
    parent.experimentRunId
  );

  // Removing it would break the lineage the child records.
  await store.discardRun(taskId, parent.experimentId, parent.experimentRunId);
  assert.ok(
    await store.readRun(taskId, "ledger", parent.experimentRunId),
    "lineage must not be broken by pruning"
  );
});
