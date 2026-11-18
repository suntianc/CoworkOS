import assert from "node:assert/strict";
import { test } from "node:test";
import { modelFamily, providerLogo } from "../web/assets/controllers/model-providers.js";

test("a custom provider's mark follows the model it serves, with a plain mark for an unknown one", () => {
  assert.equal(modelFamily("gpt-5.1")?.id, "openai");
  assert.equal(modelFamily("openai/o4-mini")?.id, "openai");
  assert.equal(modelFamily("deepseek-chat")?.id, "deepseek");
  assert.equal(modelFamily("claude-sonnet-5")?.id, "anthropic");
  assert.equal(modelFamily("qwen3-coder")?.id, "bailian");
  assert.equal(modelFamily("my-local-model"), undefined);
  const custom = { name: "公司网关" };
  assert.match(providerLogo(custom, 18, "gpt-5.1"), /data-logo="openai"/);
  assert.match(providerLogo(custom, 18, "deepseek-chat"), /data-logo="deepseek"/);
  assert.match(providerLogo(custom, 18, "my-local-model"), /data-logo="generic"/);
  // A provider made from a preset keeps its own mark whatever the model.
  assert.match(providerLogo({ preset: "openrouter", name: "OpenRouter" }, 18, "deepseek-chat"), /data-logo="openrouter"/);
});
