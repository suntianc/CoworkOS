import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelSettings } from "../dist/src/dashboard/model-settings.js";
import { readCoworkConfig } from "../dist/src/runtime/config.js";
import { resolveModelRole } from "../dist/src/runtime/role-models.js";

const ENV = [
  "COWORK_CONFIG",
  "COWORK_API_BASE",
  "COWORK_API_KEY",
  "COWORK_MODEL",
  "COWORK_SUPPORTS_IMAGES",
  "COWORK_MODEL_API",
  "COWORK_CREDENTIALS"
];

async function fixture(t, initial = { workspaceRoot: "/preserve" }) {
  const root = await mkdtemp(join(tmpdir(), "atria-model-providers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  for (const key of ENV) delete process.env[key];
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify(initial));
  const state = { active: false };
  const config = {};
  const settings = createModelSettings(root, config, () => state.active);
  const reopen = () =>
    createModelSettings(root, readCoworkConfig(root, { COWORK_CONFIG: path }), () => false);
  return { root, path, config, settings, state, reopen, credentials: join(root, "credentials.json") };
}

const providerNamed = (status, name) => status.providers.find((entry) => entry.name === name);

test("providers keep keys on the host, validate input and refuse changes during a run", async (t) => {
  const f = await fixture(t);
  const key = "private-provider-key";
  const created = await f.settings.saveProvider({
    name: "服务 A",
    preset: "deepseek",
    baseUrl: "https://a.example.test",
    api: "openai-completions",
    apiKey: key
  });
  const provider = providerNamed(created, "服务 A");
  assert.equal(provider.configured, true);
  assert.equal(provider.preset, "deepseek");
  assert.equal(provider.enabled, true);
  assert.deepEqual(provider.models, []);
  assert.equal(JSON.stringify(created).includes(key), false, "the status never carries a key");
  const file = await readFile(f.path, "utf8");
  assert.equal(file.includes(key), false);
  assert.equal(JSON.parse(file).workspaceRoot, "/preserve", "other settings survive");
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(f.credentials, "utf8")).modelProviders[provider.id], key);

  // An empty key keeps the saved one; other fields change.
  await f.settings.saveProvider({ id: provider.id, apiKey: "", name: "服务 A2" });
  assert.equal(JSON.parse(await readFile(f.credentials, "utf8")).modelProviders[provider.id], key);
  assert.equal(f.settings.status().providers[0].name, "服务 A2");

  const before = await readFile(f.path, "utf8");
  await assert.rejects(
    f.settings.saveProvider({ name: "无 Key", baseUrl: "https://b.example.test" }),
    /API Key/
  );
  await assert.rejects(f.settings.saveProvider({ id: provider.id, api: "invalid" }), /接口格式/);
  await assert.rejects(f.settings.saveProvider({ id: provider.id, baseUrl: "file:///private" }), /HTTP/);
  await assert.rejects(
    f.settings.saveProvider({ id: provider.id, baseUrl: "https://user:pass@a.example.test" }),
    /凭据/
  );
  await assert.rejects(f.settings.saveProvider({ id: "missing", apiKey: key }), /不存在/);
  assert.equal(await readFile(f.path, "utf8"), before, "a rejected change writes nothing");

  f.state.active = true;
  await assert.rejects(f.settings.saveProvider({ id: provider.id, name: "运行中" }), /停止/);
  f.state.active = false;

  // Anthropic has no prompt cache key; the flag never sticks.
  const anthropic = providerNamed(
    await f.settings.saveProvider({
      name: "Claude",
      baseUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
      supportsPromptCacheKey: true,
      apiKey: "anthropic-key"
    }),
    "Claude"
  );
  assert.equal(anthropic.api, "anthropic-messages");
  assert.equal(anthropic.supportsPromptCacheKey, false);

  // A restart reads the same providers with their keys applied in memory only.
  const restarted = f.reopen();
  assert.deepEqual(
    restarted.status().providers.map((entry) => [entry.name, entry.configured]),
    [
      ["服务 A2", true],
      ["Claude", true]
    ]
  );

  process.env.COWORK_API_KEY = "environment-key";
  assert.equal(f.settings.status().managedByEnvironment, true);
  await assert.rejects(f.settings.saveProvider({ id: provider.id, name: "环境" }), /启动环境/);
});

test("models keep their own settings, and what a role uses cannot disappear", async (t) => {
  const f = await fixture(t);
  const created = await f.settings.saveProvider({
    name: "服务",
    baseUrl: "https://models.example.test/v1",
    apiKey: "models-key"
  });
  const id = created.providers[0].id;
  const added = await f.settings.saveModels({
    providerId: id,
    models: [
      { id: "fast", name: "Fast", contextWindow: 64000, mainMaxTokens: 4096, supportsImages: true },
      { id: "deep", reasoningEffort: "high", supportsReasoningEffort: true, reasoningLevels: ["off", "high"] }
    ]
  });
  const [fast, deep] = added.providers[0].models;
  assert.equal(fast.profileId, `${id}#fast`);
  assert.equal(fast.name, "Fast");
  assert.equal(fast.contextWindow, 64000);
  assert.equal(fast.mainMaxTokens, 4096);
  assert.equal(fast.supportsImages, true);
  assert.equal(deep.reasoningEffort, "high");
  assert.deepEqual(deep.reasoningLevels, ["off", "high"]);

  // Updating one field keeps the others.
  await f.settings.saveModels({ providerId: id, models: [{ id: "fast", reasoningEffort: "low" }] });
  const updated = f.settings.status().providers[0].models.find((model) => model.id === "fast");
  assert.equal(updated.contextWindow, 64000);
  assert.equal(updated.supportsImages, true);
  assert.equal(updated.reasoningEffort, "low");

  const before = await readFile(f.path, "utf8");
  for (const contextWindow of [0, -1, 1.5, 2 ** 53, "32000", null])
    await assert.rejects(
      f.settings.saveModels({ providerId: id, models: [{ id: "fast", contextWindow }] }),
      /上下文窗口/
    );
  await assert.rejects(
    f.settings.saveModels({ providerId: id, models: [{ id: "fast", mainMaxTokens: 0 }] }),
    /输出上限/
  );
  await assert.rejects(f.settings.saveModels({ providerId: id, models: [{ id: "bad model" }] }), /模型 ID/);
  await assert.rejects(
    f.settings.saveModels({ providerId: id, models: [{ id: "deep", reasoningEffort: "low" }] }),
    /推理强度/
  );
  assert.equal(await readFile(f.path, "utf8"), before);

  // Without a binding Main uses the first model; the single-connection fields follow.
  assert.equal(f.config.model, "fast");
  assert.equal(f.config.baseUrl, "https://models.example.test/v1");
  assert.equal(f.settings.status().activeProfileId, `${id}#fast`);
  const bound = await f.settings.saveRole({ role: "main", profileId: `${id}#deep` });
  assert.equal(bound.activeProfileId, `${id}#deep`);
  assert.equal(f.config.model, "deep");
  assert.equal(resolveModelRole(f.config).thinkingLevel, "high");

  await assert.rejects(f.settings.saveModels({ providerId: id, remove: ["deep"] }), /角色使用/);
  await assert.rejects(f.settings.deleteProvider({ id }), /角色使用/);
  await assert.rejects(f.settings.saveProvider({ id, enabled: false }), /角色使用/);
  await f.settings.saveModels({ providerId: id, remove: ["fast"] });
  assert.deepEqual(
    f.settings.status().providers[0].models.map((model) => model.id),
    ["deep"]
  );

  await f.settings.saveRole({ role: "main", profileId: "" });
  await f.settings.deleteProvider({ id });
  assert.deepEqual(f.settings.status().providers, []);
  assert.equal(f.config.baseUrl, undefined, "no provider leaves no default connection");
  assert.deepEqual(
    JSON.parse(await readFile(f.credentials, "utf8")).modelProviders,
    {},
    "a deleted provider's key leaves the store"
  );
});

test("a probe uses the provider's wire format and the saved model's image setting", async (t) => {
  const f = await fixture(t);
  const created = await f.settings.saveProvider({
    name: "探测",
    baseUrl: "https://probe.example.test/v1",
    apiKey: "probe-key"
  });
  const id = created.providers[0].id;
  await f.settings.saveModels({ providerId: id, models: [{ id: "vision", supportsImages: true }] });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({
      url: String(url),
      headers: new Headers(options.headers),
      body: JSON.parse(options.body)
    });
    return new Response("{}", { status: 401 });
  });
  await assert.rejects(f.settings.test({ id, model: "vision" }), /认证/);
  assert.equal(requests[0].url, "https://probe.example.test/v1/chat/completions");
  assert.equal(
    requests[0].body.messages.find((message) => message.role === "user").content[1].type,
    "image_url"
  );
  await assert.rejects(f.settings.test({ id, model: "vision", api: "openai-responses" }), /认证/);
  assert.equal(requests[1].url, "https://probe.example.test/v1/responses");
  await assert.rejects(
    f.settings.test({
      id,
      model: "claude",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.test"
    }),
    /认证/
  );
  assert.equal(new URL(requests[2].url).pathname, "/v1/messages");
  assert.equal(new URL(requests[2].url).host, "api.anthropic.test");
  assert.equal(requests[2].headers.get("x-api-key"), "probe-key");
});

test("listing models asks each format's endpoint and marks what is already added", async (t) => {
  const f = await fixture(t);
  const openai = (
    await f.settings.saveProvider({
      name: "列表",
      baseUrl: "https://list.example.test/v1",
      apiKey: "list-key"
    })
  ).providers[0].id;
  await f.settings.saveModels({ providerId: openai, models: [{ id: "kept" }] });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const headers = new Headers(options?.headers);
    requests.push({ url: String(url), headers });
    return Response.json({
      data: String(url).includes("anthropic")
        ? [{ id: "claude-x", display_name: "Claude X" }]
        : [{ id: "kept" }, { id: "fresh", context_length: 32000 }]
    });
  });
  const listed = await f.settings.listModels({ id: openai });
  assert.equal(requests[0].url, "https://list.example.test/v1/models");
  assert.equal(requests[0].headers.get("authorization"), "Bearer list-key");
  assert.deepEqual(
    listed.models.map((model) => [model.id, model.added]),
    [
      ["kept", true],
      ["fresh", false]
    ]
  );
  const anthropic = await f.settings.listModels({
    baseUrl: "https://api.anthropic.test",
    api: "anthropic-messages",
    apiKey: "draft-key"
  });
  assert.equal(requests[1].url, "https://api.anthropic.test/v1/models");
  assert.equal(requests[1].headers.get("x-api-key"), "draft-key");
  assert.deepEqual(anthropic.models, [{ id: "claude-x", name: "Claude X", added: false }]);
  await assert.rejects(f.settings.listModels({ baseUrl: "https://no-key.example.test/v1" }), /API Key/);
});
