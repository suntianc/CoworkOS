import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCoworkConfig } from "../dist/src/runtime/config.js";
import { modelConnections, saveProvider, saveProviderModels } from "../dist/src/runtime/model-providers.js";
import { configuredContextWindow, runtimeSettingsEnv } from "../dist/src/runtime/runtime-settings.js";

test("context capacity resolves config and environment independently of output limits", (t) => {
  const previous = process.env.COWORK_CONTEXT_WINDOW;
  t.after(() => {
    if (previous === undefined) delete process.env.COWORK_CONTEXT_WINDOW;
    else process.env.COWORK_CONTEXT_WINDOW = previous;
  });
  delete process.env.COWORK_CONTEXT_WINDOW;
  assert.equal(configuredContextWindow({}), 256000);
  assert.equal(
    configuredContextWindow(runtimeSettingsEnv({ contextWindow: 128000, mainMaxTokens: 8192 })),
    128000
  );
  process.env.COWORK_CONTEXT_WINDOW = "32000";
  assert.equal(configuredContextWindow(runtimeSettingsEnv({ contextWindow: 128000 })), 32000);
  for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "", "invalid"])
    assert.throws(() => configuredContextWindow({ COWORK_CONTEXT_WINDOW: value }), /上下文窗口/);
});

test("a stored connection capacity is readable and an invalid one is rejected without rewriting the file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-context-window-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "config.json");
  const created = saveProvider({}, { name: "fixture", baseUrl: "https://example.com/v1", apiKey: "local-fixture" });
  const config = saveProviderModels(created, {
    providerId: created.modelProviders.providers[0].id,
    models: [{ id: "fixture", contextWindow: 64000 }]
  });
  await writeFile(path, JSON.stringify(config));
  const loaded = readCoworkConfig(root, { COWORK_CONFIG: path });
  assert.equal(modelConnections(loaded).profiles[0].contextWindow, 64000);
  let rejected;
  for (const contextWindow of [0, -1, 1.5, "64000", null, 2 ** 53]) {
    rejected = JSON.stringify({ ...config, contextWindow });
    await writeFile(path, rejected);
    assert.throws(() => readCoworkConfig(root, { COWORK_CONFIG: path }), /上下文窗口/);
    const invalid = structuredClone(config);
    invalid.modelProviders.providers[0].models[0].contextWindow = contextWindow;
    rejected = JSON.stringify(invalid);
    await writeFile(path, rejected);
    assert.throws(() => readCoworkConfig(root, { COWORK_CONFIG: path }), /上下文窗口/);
  }
  assert.equal(await readFile(path, "utf8"), rejected, "a rejected file is not rewritten");
});
