import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelSettings as webSettings } from "../dist/src/dashboard/model-settings.js";
import { visionModelConfig, visionModelEnv } from "../dist/src/runtime/vision-config.js";
import { readHostCoworkConfig } from "../dist/src/runtime/config.js";

const require = createRequire(import.meta.url);
const { createModelSettings: desktopSettings } = require("../desktop/model-settings.cjs");
const { desktopPaths } = require("../desktop/paths.cjs");
for (const native of [false, true])
  test(`${native ? "desktop encrypted" : "Web private"} vision role survives restart without switching chat or exposing secrets`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-vision-settings-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const configPath = join(root, "config.json"),
      config = {};
    const previous = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => /^COWORK_(CONFIG|API|MODEL|SUPPORTS)/.test(key))
    );
    for (const key of Object.keys(previous)) delete process.env[key];
    process.env.COWORK_CONFIG = configPath;
    t.after(() => {
      for (const key of Object.keys(process.env))
        if (/^COWORK_(CONFIG|API|MODEL|SUPPORTS)/.test(key)) delete process.env[key];
      Object.assign(process.env, previous);
    });
    const secure = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`encrypted:${value}`),
      decryptString: (value) => String(value).slice(10)
    };
    const paths = desktopPaths("/test/install", root, {});
    const settings = native ? desktopSettings(paths, secure) : webSettings(root, config, () => false);
    const first = await settings.save({
      baseUrl: "https://chat.example/v1",
      model: "chat",
      apiKey: "chat-fixture-secret"
    });
    const result = await settings.save({
      profileId: "",
      profileName: "Vision",
      baseUrl: "https://vision.example/v1",
      model: "vision",
      apiKey: "vision-fixture-secret",
      api: "openai-responses",
      thinkingFormat: "zai",
      supportsImages: true,
      vision: true,
      activate: false
    });
    const selected = result.profiles.find((p) => p.name === "Vision");
    assert.equal(result.activeProfileId, first.activeProfileId);
    assert.equal(result.visionProfileId, selected.id);
    assert.equal(result.model, "chat");
    assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
    const persisted = await readFile(native ? paths.configPath : configPath, "utf8");
    if (native) assert.equal(persisted.includes("fixture-secret"), false);
    const restoredConfig = native
      ? await desktopSettings(paths, secure).read()
      : readHostCoworkConfig(root, { COWORK_CONFIG: configPath });
    const vision = visionModelConfig(restoredConfig, {});
    assert.equal(vision.apiKey, "vision-fixture-secret");
    assert.equal(vision.api, "openai-responses");
    assert.equal(vision.thinkingFormat, "zai");
    const childEnv = visionModelEnv(restoredConfig, {});
    assert.equal(visionModelConfig({}, childEnv).apiKey, vision.apiKey);
    assert.equal(visionModelConfig({}, childEnv).api, vision.api);
    assert.equal(visionModelConfig({}, childEnv).thinkingFormat, "zai");
    const reloaded = native ? desktopSettings(paths, secure) : webSettings(root, restoredConfig, () => false);
    await assert.rejects(
      reloaded.save({ ...selected, profileId: selected.id, supportsImages: false }),
      /图片分析/
    );
    await assert.rejects(reloaded.save({ ...selected, profileId: selected.id, vision: "true" }), /布尔/);
    await reloaded.save({ ...selected, profileId: selected.id, vision: false, activate: false });
    assert.equal((native ? await reloaded.status() : reloaded.status()).visionProfileId, "");
    assert.equal(
      (native ? await reloaded.status() : reloaded.status()).activeProfileId,
      first.activeProfileId
    );
  });

test("vision environment refuses partial connections and invalid capabilities", () => {
  assert.equal(visionModelConfig({}, {}), undefined);
  assert.throws(() => visionModelConfig({}, { COWORK_VISION_MODEL: "fixture" }), /requires/);
  const env = {
    COWORK_VISION_API_BASE: "https://vision.example/v1",
    COWORK_VISION_API_KEY: "fixture",
    COWORK_VISION_MODEL: "fixture"
  };
  assert.throws(() => visionModelConfig({}, { ...env, COWORK_VISION_MAX_TOKENS: "0" }), /limit/);
  assert.throws(
    () => visionModelConfig({}, { ...env, COWORK_VISION_SUPPORTS_REASONING_EFFORT: "yes" }),
    /boolean/
  );
});
