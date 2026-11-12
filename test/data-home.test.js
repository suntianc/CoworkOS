import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atriaHome, atriaDataPaths } from "../scripts/data-home.cjs";
import { configuredWorkspaceRoot } from "../dist/src/runtime/runtime-settings.js";
import { readCoworkConfig, coworkConfigPath } from "../dist/src/runtime/config.js";
import { createRequire } from "node:module";
const { desktopPaths } = createRequire(import.meta.url)("../desktop/paths.cjs");

test("App, CLI and direct runtime use the same default paths with explicit overrides", () => {
  const env = { ATRIA_HOME: "/private-fixture/atria" };
  const shared = atriaDataPaths(env, {}, "/project");
  assert.equal(atriaHome({}, "/test-user"), "/test-user/.atria");
  assert.equal(shared.workspaceRoot, "/private-fixture/atria/workspace");
  assert.equal(shared.piAgentDir, "/private-fixture/atria/pi");
  const desktop = desktopPaths("/install", shared.home, env);
  for (const key of ["workspaceRoot", "piAgentDir", "globalIndex", "logs"])
    assert.equal(desktop[key], shared[key]);
  assert.equal(configuredWorkspaceRoot({}, env, "/project"), shared.workspaceRoot);
  assert.equal(
    atriaDataPaths(env, { workspaceRoot: "old-data" }, "/project").workspaceRoot,
    "/project/old-data"
  );
  const explicit = atriaDataPaths({
    ...env,
    COWORK_WORKSPACE: "/workspace",
    PI_CODING_AGENT_DIR: "/pi",
    COWORK_GLOBAL_INDEX: "/indexes/catalog.json"
  });
  assert.equal(explicit.workspaceRoot, "/workspace");
  assert.equal(explicit.piAgentDir, "/pi");
  assert.equal(explicit.globalIndex, "/indexes/catalog.json");
});

test("all source entrypoints honor user config fallback and existing explicit/project config", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-data-home-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"),
    project = join(root, "project");
  await mkdir(home);
  await mkdir(project);
  const env = { ATRIA_HOME: home };
  await writeFile(join(home, "config.json"), JSON.stringify({ model: "home-fixture" }));
  assert.equal(readCoworkConfig(project, env).model, "home-fixture");
  assert.equal(coworkConfigPath(project, env), join(home, "config.json"));
  await writeFile(join(project, "config.json"), JSON.stringify({ model: "project-fixture" }));
  assert.equal(readCoworkConfig(project, env).model, "project-fixture");
  const explicit = join(root, "explicit.json");
  await writeFile(explicit, JSON.stringify({ model: "explicit-fixture" }));
  assert.equal(readCoworkConfig(project, { ...env, COWORK_CONFIG: explicit }).model, "explicit-fixture");
  assert.equal(await readFile(join(home, "config.json"), "utf8"), '{"model":"home-fixture"}');
});
