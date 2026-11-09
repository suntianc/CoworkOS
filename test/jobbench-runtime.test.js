import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { DurableScheduler } from "../dist/src/runtime/scheduler.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

test("zero maxTurns disables the local turn limit and completes multiple actual tool rounds", async (t) => {
  const model = await modelProtocolFixture("openai-completions", (_body, requests) =>
    requests.length <= 2 ? { name: "verify", arguments: {} } : { text: "All verified." }
  );
  t.after(() => model.close());
  let calls = 0;
  const result = await new PiSession({
    baseUrl: model.baseUrl,
    apiKey: "fixture-key",
    maxTurns: 0,
    timeoutMs: 5000,
    tools: new Map([
      [
        "verify",
        {
          parameters: { type: "object", properties: {} },
          execute: async () => {
            calls++;
            return "verified";
          }
        }
      ]
    ])
  }).run("Verify twice.");
  assert.equal(result.termination, "completed");
  assert.equal(calls, 2);
  assert.equal(model.requests.length, 3);
});

test("delegated model settings are durable and restored through the actual SDK", async (t) => {
  const model = await modelProtocolFixture("openai-completions", (_body, requests) => ({
    text: "Child verified.",
    finishReason: requests.length === 1 ? "length" : "stop"
  }));
  t.after(() => model.close());
  const root = await mkdtemp(join(tmpdir(), "atria-child-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const common = {
    taskId: "task",
    runId: "run",
    agentId: "subagent_1",
    callId: "call",
    task: "Verify child.",
    workspaceRoot: root,
    baseUrl: model.baseUrl,
    apiKey: "fixture-key",
    toolFactory: () => new Map(),
    skillRoots: [],
    thinkingLevel: "off",
    timeoutMs: 5000
  };
  const runtime = new CoordinatorRuntime();
  // An interruption after the durable enqueue settles the call record; the
  // queued item keeps the delegated settings for the next recovery.
  const interrupted = await runtime.dispatch({
    ...common,
    mode: "async",
    maxTurns: 0,
    maxTokens: 512,
    contextWindow: 50000,
    maxLengthContinuations: 1,
    sampling: { temperature: 0.4, topP: 0.8 },
    maxToolResponseChars: 100,
    compaction: { enabled: false },
    onQueued() {
      throw new Error("Fixture interruption");
    }
  });
  assert.equal(interrupted.status, "failed");
  assert.match(interrupted.error, /Fixture interruption/);
  const queue = await new DurableScheduler(join(root, "task", "runs", "run", "queue.json")).list();
  assert.equal(queue[0].payload.maxTurns, 0);
  assert.equal(queue[0].payload.contextWindow, 50000);
  const recovered = await runtime.recoverRun({
    ...common,
    maxTurns: 1,
    maxTokens: 32,
    contextWindow: 1000,
    maxLengthContinuations: 0,
    sampling: { temperature: 1.7 }
  });
  assert.equal(recovered[0].status, "succeeded", recovered[0].error);
  assert.equal(model.requests.length, 2);
  for (const { body } of model.requests) {
    assert.equal(body.max_completion_tokens, 512);
    assert.equal(body.temperature, 0.4);
    assert.equal(body.top_p, 0.8);
  }
  const saved = JSON.parse(await readFile(join(root, "task", recovered[0].diagnostics.resultPath), "utf8"));
  assert.equal(saved.stopReason, "stop");
  assert.deepEqual(saved.continuations, { providerErrors: 0, outputLimits: 1 });
});
