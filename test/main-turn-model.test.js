import assert from "node:assert/strict";
import { test } from "node:test";
import { MAIN_MODEL_FROM_CONFIG, resolveMainTurnModel } from "../dist/src/runtime/main-turn-model.js";

/**
 * Which connection a resident Main's next turn should use.
 *
 * The launch copied a resolved connection into `COWORK_API_*`; these values
 * outrank the host file in ordinary role resolution. A turn boundary must read
 * the saved configuration instead, and must never do that for a connection the
 * environment pinned.
 */

const connection = (id, overrides = {}) => ({
  id,
  contextId: `ctx-${id}`,
  name: `连接 ${id.toUpperCase()}`,
  baseUrl: `https://${id}.example.test/v1`,
  model: `model-${id}`,
  api: "openai-completions",
  apiKey: `key-${id}`,
  supportsImages: false,
  supportsReasoningEffort: true,
  supportsPromptCacheKey: false,
  reasoningEffort: "low",
  mainMaxTokens: 8192,
  subagentMaxTokens: 8192,
  contextWindow: 256000,
  ...overrides
});

const config = {
  modelConnections: {
    version: 1,
    activeId: "a",
    profiles: [
      connection("a"),
      connection("b", { api: "openai-responses", model: "model-b", reasoningEffort: "max" })
    ]
  },
  roleModels: {
    version: 1,
    host: { main: { profileId: "b" } },
    projects: { projectA: { main: { profileId: "a" } } }
  }
};

const launch = {
  [MAIN_MODEL_FROM_CONFIG]: "1",
  COWORK_API_BASE: "https://launch.example/v1",
  COWORK_API_KEY: "launch-key",
  COWORK_MODEL: "launch-model"
};

test("an environment-pinned launch keeps the connection it was started with", () => {
  assert.equal(
    resolveMainTurnModel(config, { projectId: "projectA" }, { COWORK_API_BASE: "https://launch.example/v1" }),
    undefined
  );
});

test("a Dashboard-resolved launch reads the saved connection, not the values copied into the environment", () => {
  const turn = resolveMainTurnModel(config, {}, launch);
  assert.equal(turn.baseUrl, "https://b.example.test/v1");
  assert.equal(turn.apiKey, "key-b");
  assert.equal(turn.model, "model-b");
  assert.equal(turn.profile.api, "openai-responses");
  assert.equal(turn.thinkingLevel, "max");
});

test("the project override and the message's explicit level win for that turn", () => {
  const hosted = resolveMainTurnModel(
    { ...config, roleModels: { version: 1, host: { main: { profileId: "b" } } } },
    {},
    launch
  );
  assert.equal(hosted.connectionId, "ctx-b");
  const project = resolveMainTurnModel(config, { projectId: "projectA" }, launch);
  assert.equal(project.connectionId, "ctx-a");
  assert.equal(project.thinkingLevel, "low");
  assert.equal(
    resolveMainTurnModel(config, { projectId: "projectA", thinkingLevel: "high" }, launch).thinkingLevel,
    "high"
  );
});

test("a saved configuration with no usable connection leaves the running connection alone", () => {
  assert.equal(
    resolveMainTurnModel({ modelConnections: { version: 1, profiles: [] } }, {}, launch),
    undefined
  );
});
