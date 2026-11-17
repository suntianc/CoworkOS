import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createWebSearchSettings } from "../dist/src/dashboard/web-search-settings.js";
const require = createRequire(import.meta.url);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-search-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const saved = process.env.COWORK_CONFIG;
  process.env.COWORK_CONFIG = join(root, "config.json");
  const keys = ["COWORK_WEB_TOOLS", "COWORK_EXA_API_KEY", "EXA_API_KEY", "COWORK_EXA_MCP_ENDPOINT"];
  const env = keys.map((key) => [key, process.env[key]]);
  for (const key of keys) delete process.env[key];
  t.after(() => {
    if (saved === undefined) delete process.env.COWORK_CONFIG;
    else process.env.COWORK_CONFIG = saved;
    for (const [key, value] of env) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return { root, paths: { configPath: join(root, "config.json") } };
}
test("Web search settings persist choices privately without changing the model connection", async (t) => {
  const { root, paths } = await fixture(t);
  const config = { model: "fixture-model", apiKey: "model-secret" };
  await writeFile(paths.configPath, JSON.stringify(config));
  let active = false;
  const settings = createWebSearchSettings(root, config, () => active);
  assert.equal(settings.status().provider, "exa");
  assert.equal(settings.status().authenticated, false, "no configuration means anonymous Exa");
  await settings.save({ provider: "exa", exaApiKey: "exa-secret" });
  assert.equal(settings.status().authenticated, true);
  assert.doesNotMatch(JSON.stringify(settings.status()), /exa-secret|model-secret/);
  const saved = JSON.parse(await readFile(paths.configPath, "utf8"));
  assert.equal(saved.model, "fixture-model");
  assert.deepEqual(saved.webSearch, { provider: "exa" });
  assert.equal((await stat(paths.configPath)).mode & 0o777, 0o600);
  active = true;
  await assert.rejects(settings.save({ provider: "off" }), /停止运行/);
  active = false;
  await settings.save({ provider: "off" });
  assert.equal(settings.status().enabled, false);
  await settings.save({ provider: "exa", clearExaApiKey: true });
  assert.equal(settings.status().authenticated, false);
  process.env.COWORK_WEB_TOOLS = "0";
  await assert.rejects(settings.save({ provider: "exa" }), /启动环境/);
});
test("Web search settings create a missing config and reject invalid input", async (t) => {
  const { root } = await fixture(t);
  const settings = createWebSearchSettings(root, {}, () => false);
  await assert.rejects(settings.save({ provider: "bad" }), /搜索服务/);
  await settings.save({ provider: "off" });
  assert.equal(settings.status().provider, "off");
});
