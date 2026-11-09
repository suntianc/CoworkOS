import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { RunService } from "../dist/src/runtime/run-service.js";
import { DurableScheduler } from "../dist/src/runtime/scheduler.js";
import {
  configuredReasoningEffort,
  configuredSupportsReasoningEffort,
  normalizeReasoningEffort,
  runtimeSettingsEnv
} from "../dist/src/runtime/runtime-settings.js";

const reasoningEnvNames = ["COWORK_REASONING_EFFORT", "COWORK_SUPPORTS_REASONING_EFFORT"];
const inheritedReasoningEnv = Object.fromEntries(reasoningEnvNames.map((name) => [name, process.env[name]]));
before(() => {
  for (const name of reasoningEnvNames) delete process.env[name];
});
after(() => {
  for (const name of reasoningEnvNames) {
    if (inheritedReasoningEnv[name] === undefined) delete process.env[name];
    else process.env[name] = inheritedReasoningEnv[name];
  }
});

async function modelFixture(t) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      path: request.url,
      body: JSON.parse(Buffer.concat(chunks).toString())
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) =>
      `data: ${JSON.stringify({
        id: `completion-${requests.length}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "glm-5.3",
        choices: [{ index: 0, delta, finish_reason }]
      })}\n\n`;
    response.write(chunk({ role: "assistant", content: "Fixture task complete." }));
    response.write(chunk({}, "stop"));
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "fixture-key" };
}

async function workspaceFixture(t) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "atria-reasoning-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  return {
    workspaceRoot,
    taskId: "reasoning-task",
    runId: "reasoning-run",
    agentId: "researcher",
    queue: new DurableScheduler(join(workspaceRoot, "reasoning-task", "runs", "reasoning-run", "queue.json"))
  };
}

function assertRequest(request, expectedEffort) {
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/v1/chat/completions");
  assert.equal(request.body.stream, true);
  if (expectedEffort === undefined) {
    assert.equal(
      Object.hasOwn(request.body, "reasoning_effort"),
      false,
      "disabled reasoning must omit the provider parameter"
    );
  } else {
    assert.equal(request.body.reasoning_effort, expectedEffort, "reasoning effort must reach the HTTP body");
  }
}

function withReasoningEnv(values, callback) {
  const names = reasoningEnvNames;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) {
      if (values[name] === undefined) delete process.env[name];
      else process.env[name] = values[name];
    }
    return callback();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test("reasoning settings default to high and reject misspelled or unsupported values", () => {
  assert.equal(normalizeReasoningEffort(undefined), "high");
  assert.equal(configuredReasoningEffort({}), "high");
  assert.equal(configuredSupportsReasoningEffort({}), true);
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(normalizeReasoningEffort(level), level);
    assert.equal(configuredReasoningEffort({ COWORK_REASONING_EFFORT: level }), level);
  }
  assert.throws(() => normalizeReasoningEffort("hight"), /high/);
  assert.throws(
    () => configuredReasoningEffort({ COWORK_REASONING_EFFORT: "hight" }),
    /COWORK_REASONING_EFFORT/
  );
  assert.throws(() => configuredReasoningEffort({ COWORK_REASONING_EFFORT: "" }), /COWORK_REASONING_EFFORT/);
  for (const value of ["1", "true"])
    assert.equal(configuredSupportsReasoningEffort({ COWORK_SUPPORTS_REASONING_EFFORT: value }), true);
  for (const value of ["0", "false"])
    assert.equal(configuredSupportsReasoningEffort({ COWORK_SUPPORTS_REASONING_EFFORT: value }), false);
  assert.throws(
    () => configuredSupportsReasoningEffort({ COWORK_SUPPORTS_REASONING_EFFORT: "maybe" }),
    /COWORK_SUPPORTS_REASONING_EFFORT/
  );
});

test("config reasoning settings apply only when the corresponding environment value is absent", () => {
  const config = { reasoningEffort: "low", supportsReasoningEffort: false };
  withReasoningEnv({}, () => {
    const env = runtimeSettingsEnv(config);
    assert.equal(configuredReasoningEffort(env), "low");
    assert.equal(configuredSupportsReasoningEffort(env), false);
  });
  withReasoningEnv({ COWORK_REASONING_EFFORT: "high", COWORK_SUPPORTS_REASONING_EFFORT: "true" }, () => {
    const env = runtimeSettingsEnv(config);
    assert.equal(configuredReasoningEffort(env), "high");
    assert.equal(configuredSupportsReasoningEffort(env), true);
  });
});

test("PiSession sends the selected reasoning effort in real HTTP requests", { timeout: 15000 }, async (t) => {
  for (const { name, options, expected } of [
    { name: "default high", options: {}, expected: "high" },
    { name: "explicit low", options: { thinkingLevel: "low" }, expected: "low" },
    { name: "explicit max", options: { thinkingLevel: "max" }, expected: "max" },
    { name: "off", options: { thinkingLevel: "off" }, expected: undefined },
    {
      name: "provider capability disabled",
      options: { thinkingLevel: "high", supportsReasoningEffort: false },
      expected: undefined
    }
  ]) {
    await t.test(name, async (t) => {
      const model = await modelFixture(t);
      const session = new PiSession({
        ...model,
        ...options,
        tools: new Map(),
        maxErrorRetries: 0,
        timeoutMs: 3000
      });
      assert.equal((await session.run("Complete the fixture task.")).termination, "completed");
      assert.equal(model.requests.length, 1);
      assertRequest(model.requests[0], expected);
    });
  }
});

test("PiSession rejects hight before making any provider request", async (t) => {
  const model = await modelFixture(t);
  assert.throws(() => new PiSession({ ...model, thinkingLevel: "hight", tools: new Map() }), /high/);
  assert.equal(model.requests.length, 0);
});

test("RunService forwards Main reasoning settings to the provider", { timeout: 15000 }, async (t) => {
  for (const { name, options, expected } of [
    { name: "default high", options: {}, expected: "high" },
    { name: "explicit low", options: { thinkingLevel: "low" }, expected: "low" },
    { name: "explicit max", options: { thinkingLevel: "max" }, expected: "max" },
    {
      name: "provider capability disabled",
      options: { thinkingLevel: "high", supportsReasoningEffort: false },
      expected: undefined
    }
  ]) {
    await t.test(name, async (t) => {
      const model = await modelFixture(t);
      const fixture = await workspaceFixture(t);
      const result = await new RunService(fixture.workspaceRoot).runPi({
        taskId: fixture.taskId,
        runId: fixture.runId,
        ...model,
        ...options,
        prompt: "Complete the Main fixture task.",
        tools: () => new Map(),
        timeoutMs: 3000
      });
      assert.equal(result.taskStatus, "completed");
      assert.equal(model.requests.length, 1);
      assertRequest(model.requests[0], expected);
    });
  }
});

test(
  "Coordinator dispatch sends high by default and persists the resolved settings",
  { timeout: 15000 },
  async (t) => {
    const model = await modelFixture(t);
    const fixture = await workspaceFixture(t);
    const result = await new CoordinatorRuntime().dispatch({
      ...fixture,
      ...model,
      callId: "call-default",
      task: "Complete the delegated fixture task.",
      mode: "sync",
      toolFactory: () => new Map(),
      skillRoots: [],
      timeoutMs: 3000
    });
    assert.equal(result.status, "succeeded", result.error);
    assert.equal(model.requests.length, 1);
    assertRequest(model.requests[0], "high");
    const [saved] = await fixture.queue.list();
    assert.equal(saved.payload.thinkingLevel, "high");
    assert.equal(saved.payload.supportsReasoningEffort, true);
  }
);

test(
  "Coordinator recovery preserves queued reasoning settings over changed caller defaults",
  { timeout: 15000 },
  async (t) => {
    for (const supportsReasoningEffort of [true, false]) {
      await t.test(`saved capability ${supportsReasoningEffort}`, async (t) => {
        const model = await modelFixture(t);
        const fixture = await workspaceFixture(t);
        const common = {
          ...fixture,
          ...model,
          toolFactory: () => new Map(),
          skillRoots: [],
          timeoutMs: 3000
        };
        // Simulate a process interruption after the durable enqueue, before the first lease.
        // dispatch owns the failure after the call record exists; the queued
        // item keeps the settings the next recovery reads.
        const interrupted = await new CoordinatorRuntime().dispatch({
          ...common,
          callId: "call-recover",
          task: "Recover the delegated fixture task.",
          mode: "async",
          thinkingLevel: "low",
          supportsReasoningEffort,
          onQueued: () => {
            throw new Error("fixture interruption after enqueue");
          }
        });
        assert.equal(interrupted.status, "failed");
        assert.match(interrupted.error, /fixture interruption after enqueue/);
        assert.equal(model.requests.length, 0);
        const [saved] = await fixture.queue.list();
        assert.equal(saved.status, "queued");
        assert.equal(saved.payload.thinkingLevel, "low");
        assert.equal(saved.payload.supportsReasoningEffort, supportsReasoningEffort);

        const results = await new CoordinatorRuntime().recoverRun({
          ...common,
          thinkingLevel: "high",
          supportsReasoningEffort: !supportsReasoningEffort
        });
        assert.equal(results.length, 1);
        assert.equal(results[0].status, "succeeded", results[0].error);
        assert.equal(model.requests.length, 1);
        assertRequest(model.requests[0], supportsReasoningEffort ? "low" : undefined);
        assert.equal((await fixture.queue.list())[0].status, "completed");
      });
    }
  }
);

test(
  "Coordinator recovery uses caller reasoning settings for legacy queue entries",
  { timeout: 15000 },
  async (t) => {
    const model = await modelFixture(t);
    const fixture = await workspaceFixture(t);
    await fixture.queue.enqueue({
      stepId: "legacy-call",
      taskId: fixture.taskId,
      runId: fixture.runId,
      agentId: fixture.agentId,
      importance: "normal",
      payload: { task: "Recover a legacy fixture task." },
      maxAttempts: 1
    });
    const results = await new CoordinatorRuntime().recoverRun({
      ...fixture,
      ...model,
      thinkingLevel: "low",
      supportsReasoningEffort: true,
      toolFactory: () => new Map(),
      skillRoots: [],
      timeoutMs: 3000
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "succeeded", results[0].error);
    assert.equal(model.requests.length, 1);
    assertRequest(model.requests[0], "low");
  }
);
