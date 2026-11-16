import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const require = createRequire(import.meta.url);
const { desktopPaths, prepareDesktopData } = require("../desktop/paths.cjs");
const { createModelSettings } = require("../desktop/model-settings.cjs");

test("desktop upgrades preserve data outside installation, and future data versions refuse downgrade", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-desktop-data-"));
  try {
    const paths = desktopPaths("/immutable/install", root, {});
    await prepareDesktopData(paths, "0.1.0");
    const file = join(paths.workspaceRoot, "document.txt");
    await writeFile(file, "持久内容\n");
    await prepareDesktopData(desktopPaths("/new/install", root, {}), "0.2.0");
    assert.equal(await readFile(file, "utf8"), "持久内容\n");
    assert.deepEqual(JSON.parse(await readFile(join(root, "data-version.json"), "utf8")), {
      formatVersion: 1,
      createdWith: "0.1.0",
      lastOpenedWith: "0.2.0"
    });
    await writeFile(join(root, "data-version.json"), '{"formatVersion":2}');
    await assert.rejects(prepareDesktopData(paths, "0.1.0"), /不兼容/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model settings expose status without credentials and fail closed without OS encryption", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-model-settings-"));
  try {
    const paths = desktopPaths("/install", root, {});
    // Test double proves the persistence contract; native smoke exercises real safeStorage.
    const secure = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`encrypted:${value}`),
      decryptString: (value) => String(value).slice(10)
    };
    const settings = createModelSettings(paths, secure);
    assert.equal((await settings.status()).api, "openai-responses");
    assert.equal((await settings.status()).configured, false);
    assert.equal((await settings.status()).mainMaxTokens, 8192);
    assert.equal((await settings.status()).contextWindow, 256000);
    assert.equal((await settings.status()).supportsReasoningEffort, false);
    const status = await settings.save({
      baseUrl: "https://example.com/v1",
      model: "model",
      apiKey: "unit-secret"
    });
    assert.equal(status.configured, true);
    assert.equal(status.api, "openai-responses");
    assert.equal(status.supportsImages, false);
    await settings.save({ baseUrl: "https://example.com/v1", model: "model", supportsImages: true });
    assert.equal((await settings.status()).supportsImages, true);
    await settings.save({
      baseUrl: "https://example.com/v1",
      model: "model",
      api: "openai-responses",
      mainMaxTokens: 4096,
      contextWindow: 64000,
      subagentMaxTokens: 2048,
      reasoningEffort: "low",
      supportsReasoningEffort: true
    });
    assert.equal("apiKey" in status, false);
    assert.equal((await readFile(paths.configPath, "utf8")).includes("unit-secret"), false);
    assert.equal((await stat(paths.configPath)).mode & 0o777, 0o600);
    await settings.save({ baseUrl: "https://other.example.com/v1", model: "model-2", apiKey: "" });
    assert.equal((await settings.read()).apiKey, "unit-secret");
    assert.equal((await settings.status()).supportsImages, true);
    assert.equal((await settings.status()).api, "openai-responses");
    const originalConfig = await readFile(paths.configPath, "utf8");
    const originalSecret = (await settings.read()).apiKey;
    await assert.rejects(
      settings.save({
        baseUrl: "https://example.com/v1",
        model: "model",
        api: "invalid",
        apiKey: "replacement"
      }),
      /消息格式/
    );
    assert.equal(await readFile(paths.configPath, "utf8"), originalConfig);
    assert.equal((await settings.read()).apiKey, originalSecret);
    assert.equal((await settings.status()).mainMaxTokens, 4096);
    assert.equal((await settings.status()).contextWindow, 64000);
    await assert.rejects(
      settings.save({ baseUrl: "https://example.com", model: "model", contextWindow: 0 }),
      /上下文窗口/
    );
    assert.equal(await readFile(paths.configPath, "utf8"), originalConfig);
    assert.equal((await settings.status()).reasoningEffort, "low");
    await assert.rejects(
      settings.save({ baseUrl: "https://example.com", model: "model", supportsImages: "yes" }),
      /布尔/
    );
    await assert.rejects(settings.save({ baseUrl: "file:///secret", model: "model" }), /HTTP/);
    await assert.rejects(settings.save({ baseUrl: "invalid", model: "model" }), /请填写有效.*API 地址/);
    await assert.rejects(
      createModelSettings(desktopPaths("/install", join(root, "new"), {}), {
        isEncryptionAvailable: () => false
      }).save({ baseUrl: "https://example.com", model: "model", apiKey: "secret" }),
      /密钥存储访问失败/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a replacement key recovers a desktop connection whose saved key cannot be decrypted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-secret-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = desktopPaths("/install", root, {});
  const connection = {
    id: "fixture",
    name: "fixture",
    baseUrl: "https://example.com/v1",
    model: "fixture",
    api: "openai-responses",
    encryptedApiKey: Buffer.from("unreadable-old-secret").toString("base64")
  };
  await writeFile(
    paths.configPath,
    JSON.stringify({ modelConnections: { version: 1, activeId: "fixture", profiles: [connection] } })
  );
  const settings = createModelSettings(paths, {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => {
      if (!String(value).startsWith("encrypted:")) throw new Error("decrypt failed");
      return String(value).slice(10);
    }
  });
  assert.equal((await settings.status()).configured, false);
  await assert.rejects(settings.read(), /无法解密/);
  await assert.rejects(
    settings.save({ profileId: "fixture", baseUrl: "https://example.com/v1", model: "fixture" }),
    /无法解密/
  );
  const restored = await settings.save({
    profileId: "fixture",
    baseUrl: "https://example.com/v1",
    model: "fixture",
    apiKey: "replacement-key"
  });
  assert.equal(restored.configured, true);
  assert.ok(!JSON.stringify(restored).includes("replacement-key"));
  assert.equal((await settings.read()).apiKey, "replacement-key");
});

test("renderer shutdown waits for saved documents and refuses a timeout or wrong acknowledgement", async () => {
  const { createRendererFlush } = require("../desktop/renderer-flush.cjs");
  const messages = [];
  const documents = createRendererFlush(
    () => ({
      webContents: {
        isDestroyed: () => false,
        getURL: () => "http://127.0.0.1:3880",
        send: (...args) => messages.push(args)
      }
    }),
    25
  );
  const saved = documents.request();
  documents.acknowledge("wrong-request", true);
  let settled = false;
  saved.then(() => {
    settled = true;
  });
  await new Promise((done) => setImmediate(done));
  assert.equal(settled, false);
  documents.acknowledge(messages[0][1], true);
  assert.equal(await saved, true);
  assert.equal(await documents.request(), false);
  const failed = documents.request();
  documents.acknowledge(messages[2][1], false);
  assert.equal(await failed, false);
});

test("desktop profiles encrypt every key and restore independent keys", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-desktop-profiles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = desktopPaths("/install", root, {});
  const secure = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`encrypted:${s}`),
    decryptString: (s) => String(s).slice(10)
  };
  const seeded = {
    id: "first",
    name: "第一组",
    baseUrl: "https://first.example/v1",
    model: "first-model",
    api: "openai-completions",
    supportsImages: false,
    contextWindow: 256000,
    encryptedApiKey: secure.encryptString("first-private-key").toString("base64")
  };
  await writeFile(
    paths.configPath,
    JSON.stringify({ modelConnections: { version: 1, activeId: "first", profiles: [seeded] } })
  );
  const settings = createModelSettings(paths, secure);
  const firstId = (await settings.status()).activeProfileId;
  const saved = await settings.save({
    profileId: "",
    profileName: "第二组",
    contextWindow: 128000,
    baseUrl: "https://second.example/v1",
    model: "second-model",
    apiKey: "second-private-key",
    api: "openai-responses",
    activate: false
  });
  assert.equal(saved.activeProfileId, firstId);
  assert.equal(saved.contextWindow, 256000);
  assert.equal((await settings.read()).apiKey, "first-private-key");
  const raw = await readFile(paths.configPath, "utf8");
  assert.ok(!raw.includes("private-key"));
  assert.ok(!JSON.stringify(saved).includes("encryptedApiKey"));
  assert.ok(!JSON.stringify(saved).includes("apiKey"));
  const second = saved.profiles.find((p) => p.name === "第二组");
  await settings.save({ ...second, profileId: second.id, activate: true });
  const restarted = createModelSettings(paths, secure);
  assert.equal((await restarted.read()).apiKey, "second-private-key");
  assert.equal((await restarted.status()).api, "openai-responses");
  assert.equal((await restarted.status()).contextWindow, 128000);
  const firstProfile = saved.profiles.find((p) => p.id === firstId);
  await restarted.save({ ...firstProfile, profileId: firstId, activate: true });
  assert.equal((await restarted.read()).apiKey, "first-private-key");
  assert.equal((await restarted.status()).contextWindow, 256000);
  const before = await readFile(paths.configPath, "utf8");
  const broken = createModelSettings(paths, {
    ...secure,
    encryptString: () => {
      throw new Error("encryption unavailable");
    }
  });
  await assert.rejects(broken.save({ ...firstProfile, profileId: firstId, apiKey: "replacement" }));
  assert.equal(await readFile(paths.configPath, "utf8"), before);
  await writeFile(paths.configPath, JSON.stringify({ modelConnections: { version: 2 } }));
  await assert.rejects(restarted.status(), /不兼容/);
});
