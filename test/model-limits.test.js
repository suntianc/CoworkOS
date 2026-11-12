import test from "node:test";
import assert from "node:assert/strict";
import { availableModels } from "../dist/src/runtime/model-catalog.js";
import {
  applyEndpointLimits,
  autoLimitFields,
  endpointLimits,
  outputLimit
} from "../dist/src/runtime/model-limits.js";
import { parseConnectionProfile } from "../dist/src/runtime/model-profile.js";

/**
 * A model's context window, largest output and image input from its `/models`
 * entry are its defaults (#27); a value filled in by hand on the connection wins.
 */

const profile = (fields = {}) => ({
  api: "openai-completions",
  reasoningEffort: "off",
  supportsReasoningEffort: false,
  supportsPromptCacheKey: false,
  mainMaxTokens: 8192,
  subagentMaxTokens: 8192,
  contextWindow: 256000,
  ...fields
});

test("a /models entry names its limits in the common shapes", () => {
  // The shape a custom provider returned, trimmed to the limit fields.
  assert.deepEqual(
    endpointLimits({
      id: "auto/gpt-6.1-terra",
      context_window: 922000,
      max_output_tokens: 128000,
      modalities: { input: ["text", "image"], output: ["text"] }
    }),
    { contextWindow: 922000, maxOutputTokens: 128000, images: true }
  );
  assert.deepEqual(endpointLimits({ context_length: 64000, modalities: { input: ["text"] } }), {
    contextWindow: 64000,
    images: false
  });
  assert.equal(endpointLimits({ id: "plain" }), undefined);
  assert.equal(endpointLimits({ context_window: -1, max_output_tokens: "many" }), undefined);
});

test("untouched defaults follow the endpoint, a hand-filled value wins, and output keeps room for input", () => {
  const limits = { contextWindow: 922000, maxOutputTokens: 128000, images: true };
  const fresh = applyEndpointLimits({ profile: profile(), supportsImages: false }, limits);
  assert.equal(fresh.profile.contextWindow, 922000);
  assert.equal(fresh.profile.mainMaxTokens, 65536, "within the form's range");
  assert.equal(fresh.profile.subagentMaxTokens, 65536);
  assert.equal(fresh.supportsImages, true);

  // A connection saved before the choice existed: changed values count as filled by hand.
  const edited = profile({ contextWindow: 128000, mainMaxTokens: 4096 });
  assert.deepEqual(autoLimitFields(edited, true), []);
  const kept = applyEndpointLimits({ profile: edited, supportsImages: true }, limits);
  assert.equal(kept.profile.contextWindow, 128000);
  assert.equal(kept.profile.mainMaxTokens, 4096);
  assert.equal(kept.supportsImages, true);

  // An explicit choice is read as saved.
  const chosen = applyEndpointLimits(
    { profile: profile({ autoLimits: ["contextWindow"] }), supportsImages: false },
    limits
  );
  assert.equal(chosen.profile.contextWindow, 922000);
  assert.equal(chosen.profile.mainMaxTokens, 8192);
  assert.equal(chosen.supportsImages, false);

  assert.equal(outputLimit(128000, 64000), 32000, "half the window stays for input");
  const unlisted = { profile: profile(), supportsImages: false };
  assert.equal(applyEndpointLimits(unlisted, undefined), unlisted);
});

test("a connection saves which fields follow the endpoint", () => {
  assert.deepEqual(
    parseConnectionProfile({ autoLimits: ["images", "contextWindow"] }, profile()).autoLimits,
    ["contextWindow", "images"]
  );
  assert.throws(() => parseConnectionProfile({ autoLimits: ["temperature"] }, profile()), /autoLimits/);
  assert.equal(
    "autoLimits" in parseConnectionProfile({ autoLimits: null }, profile({ autoLimits: ["images"] })),
    false
  );
});

test("the catalog carries each model's limits", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      data: [
        { id: "wide", context_window: 922000, modalities: { input: ["text", "image"] } },
        { id: "plain" }
      ]
    })
  );
  assert.deepEqual(
    await availableModels({ model: "plain", baseUrl: "https://relay.example", apiKey: "fake-catalog-key" }),
    [{ id: "plain" }, { id: "wide", limits: { contextWindow: 922000, images: true } }]
  );
});
