import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelSettings } from "../dist/src/dashboard/model-settings.js";
import { readCoworkConfig } from "../dist/src/runtime/config.js";

test("Web settings preserve other fields, never return keys, validate inputs and block active runs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-model-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const saved = Object.fromEntries(
    [
      "COWORK_CONFIG",
      "COWORK_API_BASE",
      "COWORK_API_KEY",
      "COWORK_MODEL",
      "COWORK_SUPPORTS_IMAGES",
      "COWORK_MODEL_API"
    ].map((k) => [k, process.env[k]])
  );
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  for (const key of Object.keys(saved)) delete process.env[key];
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({ workspaceRoot: "/preserve", supportsImages: false }));
  const config = {};
  let active = false;
  const settings = createModelSettings(root, config, () => active);
  assert.equal(settings.status().api, "openai-responses");
  assert.equal(settings.status().reasoningEffort, "off");
  assert.equal(settings.status().mainMaxTokens, 8192);
  assert.equal(settings.status().contextWindow, 256000);
  const body = {
    baseUrl: "http://127.0.0.1:1/v1",
    model: "fixture",
    apiKey: "private-test-key",
    supportsImages: true
  };
  const result = await settings.save(body);
  assert.equal(result.api, "openai-responses");
  assert.equal(result.configured, true);
  assert.ok(!JSON.stringify(result).includes("private-test-key"));
  assert.equal(JSON.parse(await readFile(path, "utf8")).workspaceRoot, "/preserve");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await settings.save({ ...body, apiKey: "" });
  assert.equal(config.apiKey, "private-test-key");
  await settings.save({ baseUrl: body.baseUrl, model: body.model });
  assert.equal(config.supportsImages, true, "updating a connection must preserve omitted image capability");
  await settings.save({
    ...body,
    api: "openai-responses",
    reasoningEffort: "low",
    supportsReasoningEffort: true,
    mainMaxTokens: 4096,
    contextWindow: 64000,
    subagentMaxTokens: 2048
  });
  await settings.save({ ...body });
  assert.equal(settings.status().api, "openai-responses");
  assert.equal(settings.status().reasoningEffort, "low");
  assert.equal(settings.status().mainMaxTokens, 4096);
  assert.equal(settings.status().subagentMaxTokens, 2048);
  assert.equal(settings.status().contextWindow, 64000, "omitted values preserve the saved window");
  const beforeInvalid = await readFile(path, "utf8");
  await assert.rejects(settings.save({ ...body, api: "invalid" }), /消息格式/);
  await assert.rejects(settings.save({ ...body, mainMaxTokens: 0 }), /输出上限/);
  for (const contextWindow of [0, -1, 1.5, NaN, Infinity, 2 ** 53, "32000", null])
    await assert.rejects(settings.save({ ...body, contextWindow }), /上下文窗口/);
  assert.equal(await readFile(path, "utf8"), beforeInvalid);
  await assert.rejects(settings.test({ supportsImages: "yes" }), /布尔/);
  active = true;
  await assert.rejects(settings.save(body), /停止/);
  active = false;
  await assert.rejects(settings.save({ ...body, baseUrl: "file:///private" }), /HTTP/);
  await assert.rejects(settings.save({ ...body, model: "bad model" }), /模型 ID/);
  await writeFile(path, '{"apiKey":"secret invalid');
  await assert.rejects(
    settings.save(body),
    (error) => !error.message.includes("secret") && /配置/.test(error.message)
  );
  assert.equal(await readFile(path, "utf8"), '{"apiKey":"secret invalid');
  process.env.COWORK_API_KEY = "environment-key";
  process.env.COWORK_SUPPORTS_IMAGES = "1";
  assert.equal(settings.status().supportsImages, true);
  await assert.rejects(settings.save(body), /启动环境/);
});

test("testing stored Web settings retains image capability when the request omits it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-model-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const saved = Object.fromEntries(
    ["COWORK_API_BASE", "COWORK_API_KEY", "COWORK_MODEL", "COWORK_SUPPORTS_IMAGES", "COWORK_MODEL_API"].map(
      (key) => [key, process.env[key]]
    )
  );
  for (const key of Object.keys(saved)) delete process.env[key];
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const settings = createModelSettings(
    root,
    { baseUrl: "https://example.com/v1", model: "fixture", apiKey: "private-test-key", supportsImages: true },
    () => false
  );
  let request;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response("{}", { status: 401 });
  });
  await assert.rejects(settings.test({}), /认证/);
  assert.equal(request.messages.find((message) => message.role === "user").content[1].type, "image_url");
  process.env.COWORK_MODEL_API = "openai-responses";
  assert.equal(settings.status().api, "openai-responses");
  assert.equal(settings.status().managedByEnvironment, true);
  await assert.rejects(settings.test({ api: "openai-completions" }), /认证/);
  assert.equal(request.messages, undefined);
  assert.equal(request.input.find((message) => message.role === "user").content[1].type, "input_image");
});

test("profiles migrate legacy settings and keep credentials, activation and restart isolated", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-model-profiles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "config.json");
  const previousConfigPath = process.env.COWORK_CONFIG;
  process.env.COWORK_CONFIG = path;
  t.after(() => {
    if (previousConfigPath === undefined) delete process.env.COWORK_CONFIG;
    else process.env.COWORK_CONFIG = previousConfigPath;
  });
  const legacy = {
    baseUrl: "https://first.example/v1",
    model: "first-model",
    apiKey: "first-secret",
    workspaceRoot: "/keep"
  };
  await writeFile(path, JSON.stringify(legacy));
  const config = { ...legacy };
  const settings = createModelSettings(root, config, () => false);
  const original = settings.status().activeProfileId;
  assert.equal(settings.status().api, "openai-completions", "legacy connections retain their wire format");
  await assert.rejects(
    settings.save({ profileId: "", baseUrl: "https://second.example/v1", model: "second-model" }),
    /API Key/
  );
  const result = await settings.save({
    profileId: "",
    profileName: "第二组",
    baseUrl: "https://second.example/v1",
    model: "second-model",
    apiKey: "second-secret",
    api: "openai-responses",
    supportsImages: true,
    contextWindow: 128000,
    activate: false
  });
  assert.equal(result.activeProfileId, original);
  assert.equal(result.contextWindow, 256000);
  assert.equal(config.apiKey, "first-secret");
  assert.equal(result.profiles.length, 2);
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.deepEqual(JSON.parse(await readFile(`${path}.before-model-profiles`, "utf8")), legacy);
  const second = result.profiles.find((p) => p.name === "第二组");
  const originalContext = config.modelConnections.profiles.find((p) => p.id === second.id).contextId;
  let authorization;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    authorization = new Headers(options.headers).get("authorization");
    return new Response("{}", { status: 401 });
  });
  await assert.rejects(settings.test({ profileId: second.id }), /认证/);
  assert.equal(authorization, "Bearer second-secret");
  await settings.save({ ...second, profileId: second.id, apiKey: "", activate: true });
  assert.equal(config.apiKey, "second-secret");
  assert.equal(config.api, "openai-responses");
  assert.equal(config.supportsImages, true);
  assert.equal(config.contextWindow, 128000);
  assert.equal(config.modelConnections.profiles.find((p) => p.id === second.id).contextId, originalContext);
  await settings.save({ ...second, profileId: second.id, apiKey: "replacement-secret", activate: true });
  assert.notEqual(
    config.modelConnections.profiles.find((p) => p.id === second.id).contextId,
    originalContext
  );
  const restartedConfig = JSON.parse(await readFile(path, "utf8"));
  const restarted = createModelSettings(root, restartedConfig, () => false);
  assert.equal(restarted.status().activeProfileId, second.id);
  assert.equal(restarted.status().contextWindow, 128000);
  assert.equal(
    restarted.status().profiles.find((profile) => profile.id === second.id).configured,
    true,
    "host credentials survive a restart without living in the public config"
  );
  const first = restarted.status().profiles.find((p) => p.id === original);
  await restarted.save({ ...first, profileId: original, activate: true });
  assert.equal(restartedConfig.apiKey, "first-secret");
  assert.equal(restartedConfig.model, "first-model");
  assert.equal(restarted.status().contextWindow, 256000);
  assert.equal(restartedConfig.workspaceRoot, "/keep");
  await assert.rejects(restarted.save({ ...first, profileId: "unknown" }), /不存在/);
  await writeFile(
    path,
    JSON.stringify({ ...restartedConfig, modelConnections: { version: 2, profiles: [] } })
  );
  await assert.rejects(restarted.save({ ...first, profileId: original }), /不兼容/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).modelConnections.version, 2);
});

test("native image settings reject cleared connection fields without corrupting restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-native-image-settings-"));
  const path = join(root, "config.json");
  const savedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.startsWith("COWORK_"))
  );
  for (const name of Object.keys(savedEnv)) delete process.env[name];
  process.env.COWORK_CONFIG = path;
  t.after(async () => {
    for (const name of Object.keys(process.env)) if (name.startsWith("COWORK_")) delete process.env[name];
    Object.assign(process.env, savedEnv);
    await rm(root, { recursive: true, force: true });
  });
  const config = {
    baseUrl: "https://vision.example/v1",
    model: "vision-fixture",
    apiKey: "local-settings-secret",
    supportsImages: true
  };
  await writeFile(path, JSON.stringify(config));
  const settings = createModelSettings(root, config, () => false);
  const saved = await settings.save({
    baseUrl: config.baseUrl,
    model: config.model,
    supportsImages: true,
    vision: true
  });
  const profileId = saved.visionProfileId;
  const before = await readFile(path, "utf8");
  await assert.rejects(
    settings.save({ profileId, baseUrl: "", model: "", apiKey: "", supportsImages: true, vision: false }),
    /HTTP/
  );
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(readCoworkConfig(root).modelConnections.visionId, profileId);
  await settings.save({
    profileId,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: "",
    supportsImages: true,
    vision: false
  });
  const restarted = readCoworkConfig(root);
  assert.equal(restarted.supportsImages, true);
  assert.equal(restarted.modelConnections.visionId, undefined);
  const { HostCredentialStore } = await import("../dist/src/security/host-credentials.js");
  const stored = new HostCredentialStore(join(root, "credentials.json"));
  assert.equal(stored.value.modelConnections[profileId], "local-settings-secret");
});
