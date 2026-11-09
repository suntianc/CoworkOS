import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { DurableScheduler } from "../dist/src/runtime/scheduler.js";
import {
  createCoworkModel,
  connectionProfile,
  parseConnectionProfile
} from "../dist/src/runtime/model-profile.js";
import { configuredThinkingFormat, runtimeSettingsEnv } from "../dist/src/runtime/runtime-settings.js";
import { testModelConnection } from "../dist/src/runtime/model-connection.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const exec = promisify(execFile);

test("thinking format is explicit, validated and leaves legacy SDK detection intact", () => {
  assert.equal(configuredThinkingFormat({}), "auto");
  assert.equal(configuredThinkingFormat({ COWORK_THINKING_FORMAT: "zai" }), "zai");
  assert.throws(() => configuredThinkingFormat({ COWORK_THINKING_FORMAT: "unknown" }), /thinkingFormat/);
  const options = { baseUrl: "https://gateway.example/v1", supportsReasoningEffort: true };
  assert.equal(createCoworkModel(options).compat.thinkingFormat, undefined);
  assert.equal(createCoworkModel({ ...options, thinkingFormat: "zai" }).compat.thinkingFormat, "zai");
  assert.equal(
    createCoworkModel({ ...options, api: "openai-responses", thinkingFormat: "zai" }).compat.thinkingFormat,
    undefined
  );
  assert.throws(
    () => parseConnectionProfile({ thinkingFormat: null }, connectionProfile({})),
    /thinkingFormat/
  );
  const previous = process.env.COWORK_THINKING_FORMAT;
  try {
    delete process.env.COWORK_THINKING_FORMAT;
    assert.equal(runtimeSettingsEnv({ thinkingFormat: "zai" }).COWORK_THINKING_FORMAT, "zai");
    process.env.COWORK_THINKING_FORMAT = "openai";
    assert.equal(runtimeSettingsEnv({ thinkingFormat: "zai" }).COWORK_THINKING_FORMAT, "openai");
  } finally {
    if (previous === undefined) delete process.env.COWORK_THINKING_FORMAT;
    else process.env.COWORK_THINKING_FORMAT = previous;
  }
});

test("connection probe and real Pi sessions use the selected GLM format without affecting other formats", async (t) => {
  const fixture = await modelProtocolFixture("openai-completions");
  t.after(() => fixture.close());
  const options = {
    baseUrl: fixture.baseUrl,
    apiKey: "local-fixture",
    model: "glm-fixture",
    supportsReasoningEffort: true,
    thinkingFormat: "zai",
    reasoningEffort: "max"
  };
  assert.equal((await testModelConnection(options)).ok, true);
  for (const [thinkingFormat, thinkingLevel, expected] of [
    ["zai", "max", { type: "enabled", clear_thinking: false }],
    ["zai", "off", { type: "disabled" }],
    ["openai", "max", undefined],
    ["auto", "max", undefined]
  ]) {
    const session = new PiSession({
      ...options,
      thinkingFormat,
      thinkingLevel,
      tools: new Map(),
      maxTurns: 1,
      maxErrorRetries: 0
    });
    assert.equal((await session.run("Check the fixture")).termination, "completed");
    const body = fixture.requests.at(-1).body;
    assert.deepEqual(body.thinking, expected);
    assert.equal(body.reasoning_effort, thinkingLevel === "off" ? undefined : "max");
  }
  assert.deepEqual(fixture.requests[0].body.thinking, { type: "enabled", clear_thinking: false });
  assert.equal(fixture.requests[0].body.reasoning_effort, "max");
});

test("queued GLM format survives recovery with different caller settings", async (t) => {
  const fixture = await modelProtocolFixture("openai-completions");
  t.after(() => fixture.close());
  const workspaceRoot = await mkdtemp(join(tmpdir(), "atria-thinking-recovery-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const common = {
    workspaceRoot,
    taskId: "format-task",
    runId: "format-run",
    baseUrl: fixture.baseUrl,
    apiKey: "local-fixture",
    model: "glm-fixture",
    toolFactory: () => new Map(),
    skillRoots: [],
    supportsReasoningEffort: true,
    thinkingLevel: "max",
    timeoutMs: 5000
  };
  // The throw stands in for a process interruption after the durable enqueue:
  // dispatch settles the call record and leaves the queued item for recovery.
  const interrupted = await new CoordinatorRuntime().dispatch({
    ...common,
    agentId: "reviewer",
    callId: "call-format",
    task: "Check recovery",
    mode: "async",
    thinkingFormat: "zai",
    onQueued() {
      throw new Error("fixture interruption");
    }
  });
  assert.equal(interrupted.status, "failed");
  assert.match(interrupted.error, /fixture interruption/);
  const queue = new DurableScheduler(join(workspaceRoot, common.taskId, "runs", common.runId, "queue.json"));
  assert.equal((await queue.list())[0].payload.thinkingFormat, "zai");
  const result = await new CoordinatorRuntime().recoverRun({ ...common, thinkingFormat: "openai" });
  assert.equal(result[0].status, "succeeded", result[0].error);
  assert.deepEqual(fixture.requests[0].body.thinking, { type: "enabled", clear_thinking: false });
});

test("real Main launcher sends the connection's GLM format", { timeout: 45000 }, async (t) => {
  const fixture = await modelProtocolFixture("openai-completions", () => ({ text: "GLM format confirmed." }));
  t.after(() => fixture.close());
  const root = await mkdtemp(join(tmpdir(), "atria-thinking-main-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(project);
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      baseUrl: fixture.baseUrl,
      apiKey: "local-fixture",
      model: "glm-fixture",
      thinkingFormat: "zai",
      reasoningEffort: "max",
      supportsReasoningEffort: true
    })
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(COWORK_|PI_|ATRIA_|SERPER_)/.test(name))
  );
  const pending = exec(
    process.execPath,
    ["scripts/start-pi.mjs", "--print", "--mode", "json", "Confirm the fixture"],
    {
      cwd: resolve("."),
      timeout: 35000,
      maxBuffer: 4000000,
      env: {
        ...env,
        COWORK_CONFIG: configPath,
        COWORK_PROJECT_DIR: project,
        COWORK_WORKSPACE: join(root, "workspace"),
        COWORK_TASK_ID: "format-task",
        COWORK_RUN_ID: "format-run",
        PI_CODING_AGENT_DIR: join(root, "pi"),
        COWORK_DISABLE_WATCH_SUPERVISOR: "1",
        PI_OFFLINE: "1"
      }
    }
  );
  pending.child.stdin.end();
  const { stdout, stderr } = await pending;
  assert.ok(stdout.includes("GLM format confirmed."), stderr);
  assert.deepEqual(fixture.requests[0].body.thinking, { type: "enabled", clear_thinking: false });
  assert.equal(fixture.requests[0].body.reasoning_effort, "max");
});
