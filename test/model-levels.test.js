import test from "node:test";
import assert from "node:assert/strict";
import { availableModels } from "../dist/src/runtime/model-catalog.js";
import { endpointLevels, isOfficialAddress, modelLevels } from "../dist/src/runtime/model-levels.js";
import { parseConnectionProfile, parseReasoningLevels } from "../dist/src/runtime/model-profile.js";

/**
 * Each model's reasoning levels (#27): what the provider's `/models` entry
 * says first, then Pi's table for a known provider address, then the
 * connection's own choice. Only levels Pi can send survive.
 */

test("a /models entry names its levels in either shape, and Pi's unknown names are ignored", () => {
  // The shape a custom provider returned, trimmed to the reasoning fields.
  const entry = {
    id: "auto/gpt-6.1-terra",
    reasoning: true,
    reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }]
  };
  assert.deepEqual(endpointLevels(entry), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(endpointLevels({ supported_reasoning_levels: [{ effort: "max" }, { effort: "off" }] }), [
    "off",
    "max"
  ]);
  assert.deepEqual(endpointLevels({ reasoning: false }), ["off"]);
  assert.equal(endpointLevels({ reasoning: true }), undefined, "saying it reasons names no levels");
  assert.equal(endpointLevels({ reasoning_levels: ["ultra"] }), undefined);
  assert.equal(endpointLevels(null), undefined);
});

test("levels come from the endpoint, then Pi's table for an official address, then the connection", async () => {
  const endpoint = await modelLevels({
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    endpoint: ["low", "high"]
  });
  assert.deepEqual(endpoint, { levels: ["low", "high"], source: "endpoint" });

  const official = await modelLevels({ baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-pro" });
  assert.equal(official.source, "official");
  assert.deepEqual(official.levels, ["off", "high", "max"]);
  assert.equal(await isOfficialAddress("https://open.bigmodel.cn/api/paas/v4"), true);
  assert.equal(await isOfficialAddress("https://relay.example/v1"), false);

  // An unknown address uses the connection's choice, or every level.
  assert.deepEqual(
    await modelLevels({
      baseUrl: "https://relay.example/v1",
      model: "deepseek-v4-pro",
      manual: ["off", "high"]
    }),
    { levels: ["off", "high"], source: "manual" }
  );
  assert.deepEqual((await modelLevels({ baseUrl: "https://relay.example/v1", model: "anything" })).levels, [
    "off",
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ]);
});

test("the catalog carries each model's endpoint levels", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      data: [
        { id: "selected", reasoning_levels: ["low", "high", "ultra"] },
        { id: "plain" },
        { id: "fixed", reasoning: false }
      ]
    })
  );
  assert.deepEqual(
    await availableModels({
      model: "selected",
      baseUrl: "https://relay.example",
      apiKey: "fake-catalog-key"
    }),
    [{ id: "selected", levels: ["low", "high"] }, { id: "plain" }, { id: "fixed", levels: ["off"] }]
  );
});

test("a connection's chosen levels are known, not empty, and include its default", () => {
  assert.deepEqual(parseReasoningLevels(["max", "off", "high", "high"]), ["off", "high", "max"]);
  assert.throws(() => parseReasoningLevels([]), /至少选择一项/);
  assert.throws(() => parseReasoningLevels(["ultra"]), /已知档位/);
  const fallback = {
    api: "openai-responses",
    reasoningEffort: "off",
    supportsReasoningEffort: false,
    supportsPromptCacheKey: false,
    mainMaxTokens: 8192,
    subagentMaxTokens: 8192,
    contextWindow: 256000
  };
  assert.deepEqual(parseConnectionProfile({ reasoningLevels: ["off", "high"] }, fallback).reasoningLevels, [
    "off",
    "high"
  ]);
  assert.throws(
    () => parseConnectionProfile({ reasoningLevels: ["low", "high"] }, fallback),
    /默认的推理强度须是支持的档位之一/
  );
  assert.equal(
    "reasoningLevels" in
      parseConnectionProfile({ reasoningLevels: null }, { ...fallback, reasoningLevels: ["off"] }),
    false,
    "null clears a narrowed choice"
  );
});
