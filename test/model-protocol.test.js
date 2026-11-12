import { test } from "node:test";
import assert from "node:assert/strict";
import { testModelConnection } from "../dist/src/runtime/model-connection.js";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { configuredModelApi, normalizeModelApi } from "../dist/src/runtime/runtime-settings.js";
import { RunService } from "../dist/src/runtime/run-service.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelProtocolFixture, protocolStream } from "./model-protocol-fixture.mjs";

for (const api of ["openai-completions", "openai-responses"]) {
  test(`${api}: formal runs forward sampling and bounded output recovery to real Pi`, async (t) => {
    const provider = await modelProtocolFixture(api, (_body, requests) => ({
      text: requests.length === 1 ? "Partial receipt check" : "Receipt check complete",
      finishReason: requests.length === 1 ? "length" : "stop"
    }));
    t.after(() => provider.close());
    const root = await mkdtemp(join(tmpdir(), "atria-profile-run-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const result = await new RunService(root).runPi({
      api,
      baseUrl: provider.baseUrl,
      apiKey: "local-test",
      model: "protocol-fixture",
      thinkingLevel: "off",
      supportsReasoningEffort: false,
      taskId: "profile-task",
      runId: "profile-run",
      prompt: "Verify the receipt.",
      maxLengthContinuations: 1,
      contextWindow: 16000,
      sampling: { temperature: 0.5, topP: 0.9 },
      compaction: { enabled: false },
      tools: () => new Map()
    });
    assert.equal(result.taskStatus, "completed");
    assert.equal(result.lastStopReason, "stop");
    assert.deepEqual(result.continuations, { providerErrors: 0, outputLimits: 1 });
    assert.equal(provider.requests.length, 2);
    for (const { body } of provider.requests) {
      assert.equal(body.temperature, 0.5);
      assert.equal(body.top_p, 0.9);
      assert.equal(body.contextWindow, undefined);
      assert.equal(body.enable_thinking, undefined);
      assert.equal(body.clear_thinking, undefined);
    }
    const saved = JSON.parse(
      await readFile(join(root, "profile-task", result.diagnostics.resultPath), "utf8")
    );
    assert.equal(saved.stopReason, "stop");
    assert.deepEqual(saved.continuations, result.continuations);
    assert.equal(
      saved.messages.filter((message) => message.role === "assistant" && message.stopReason === "length")
        .length,
      1
    );
  });

  test(`${api}: omitted sampling retains the provider defaults`, async (t) => {
    const provider = await modelProtocolFixture(api);
    t.after(() => provider.close());
    const input = { api, baseUrl: provider.baseUrl, apiKey: "local-test", tools: new Map() };
    await new PiSession(input).run("Verify.");
    assert.equal(provider.requests[0].body.temperature, undefined);
    assert.equal(provider.requests[0].body.top_p, undefined);
    for (const sampling of [{ temperature: NaN }, { temperature: 3 }, { topP: 0 }, { topP: 1.1 }]) {
      assert.throws(() => new PiSession({ ...input, sampling }), /sampling/);
    }
    for (const contextWindow of [0, 0.5, Infinity]) {
      assert.throws(() => new PiSession({ ...input, contextWindow }), /contextWindow/);
    }
    assert.equal(provider.requests.length, 1);
  });

  test(`${api}: probe and real agent tool round trip share the selected protocol`, async (t) => {
    const provider = await modelProtocolFixture(api, (_body, requests) =>
      requests.length === 2
        ? { name: "verify_protocol", arguments: { value: "round-trip" } }
        : { text: "协议验证完成" }
    );
    t.after(() => provider.close());
    const options = {
      api,
      baseUrl: provider.baseUrl,
      apiKey: "local-test",
      model: "protocol-fixture",
      supportsReasoningEffort: true,
      reasoningEffort: "low",
      mainMaxTokens: 1024
    };
    assert.equal((await testModelConnection(options)).ok, true);
    let executed = 0;
    const session = new PiSession({
      ...options,
      thinkingLevel: "low",
      maxTokens: 1024,
      maxTurns: 3,
      tools: new Map([
        [
          "verify_protocol",
          {
            parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
            execute: async ({ value }) => {
              assert.equal(value, "round-trip");
              executed++;
              return { receipt: "verified" };
            }
          }
        ]
      ])
    });
    const result = await session.run("验证一次工具调用");
    assert.equal(result.termination, "completed");
    assert.equal(executed, 1);
    assert.equal(provider.requests.length, 3);
    const body = provider.requests[2].body;
    assert.ok(JSON.stringify(body).includes("verified"));
    for (const { body } of provider.requests) {
      assert.equal(api === "openai-responses" ? body.reasoning?.effort : body.reasoning_effort, "low");
      assert.equal(api === "openai-responses" ? body.max_output_tokens : body.max_completion_tokens, 1024);
      assert.equal(api === "openai-responses" ? body.messages : body.input, undefined);
    }
  });
}

test("Responses respects disabled reasoning and off, transmits images, and sanitizes failures", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(
      protocolStream("openai-responses", {
        name: "atria_connection_check",
        arguments: { status: "connected", color: "blue", code: "123456" }
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
  });
  const input = {
    api: "openai-responses",
    baseUrl: "https://fixture.example/v1",
    model: "fixture",
    apiKey: "private-test-secret",
    supportsImages: true
  };
  for (const profile of [
    { reasoningEffort: "off", supportsReasoningEffort: true },
    { reasoningEffort: "high", supportsReasoningEffort: false }
  ]) {
    await testModelConnection(
      { ...input, ...profile },
      { imageFixture: () => ({ imageUrl: "data:image/png;base64,fixture", code: "123456" }) }
    );
  }
  for (const body of requests) {
    assert.equal(body.reasoning, undefined);
    assert.equal(body.input.find((message) => message.role === "user").content[1].type, "input_image");
  }
  globalThis.fetch.mock.mockImplementation(async () => new Response(input.apiKey, { status: 400 }));
  await assert.rejects(
    testModelConnection(input),
    (error) => /HTTP 400/.test(error.message) && !error.message.includes(input.apiKey)
  );
  await assert.rejects(testModelConnection({ ...input, api: "invalid" }), /消息格式/);
  assert.equal(configuredModelApi({}), "openai-completions");
  assert.equal(configuredModelApi({ COWORK_MODEL_API: "openai-responses" }), "openai-responses");
  assert.throws(() => normalizeModelApi(null), /消息格式/);
});
