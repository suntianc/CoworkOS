import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { createSettingsTargetGuard } = require("../desktop/settings-target.cjs");
const { createBackendAuthorization } = require("../desktop/backend-authorization.cjs");
const repo = resolve(new URL("..", import.meta.url).pathname);
const exec = promisify(execFile);
const cli = join(repo, "dist/src/cli/backend.js");

async function setup() {
  const base = await mkdtemp(join(tmpdir(), "desktop-settings-target-"));
  const data = join(base, "data");
  const workspace = join(base, "workspace");
  const home = join(base, "home");
  await Promise.all([mkdir(data), mkdir(workspace), mkdir(home)]);
  const config = join(data, "model-config.json");
  await writeFile(config, JSON.stringify({ model: "fixture-before", baseUrl: "https://fixture.invalid" }));
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(COWORK_|ATRIA_|PI_|ELECTRON_)/.test(key))
  );
  const env = {
    ...inherited,
    HOME: home,
    ATRIA_HOME: data,
    COWORK_HARNESS_ROOT: repo,
    COWORK_WORKSPACE: workspace,
    COWORK_CONFIG: config,
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0"
  };
  await exec(process.execPath, [cli, "start"], { cwd: repo, env, timeout: 60000 });
  const instance = JSON.parse(await readFile(join(data, "runtime/backend-instance.json"), "utf8"));
  return { base, data, config, env, instance };
}

async function isServing(record) {
  const response = await fetch(`${record.url}/api/backend`, {
    headers: { "x-atria-token": record.token },
    signal: AbortSignal.timeout(5000)
  });
  const identity = await response.json();
  return response.ok && identity.backendId === record.backendId && identity.pid === record.pid;
}

test(
  "selecting an isolated second backend leaves default model and search settings untouched",
  { timeout: 120000 },
  async (t) => {
    const roots = [];
    t.after(async () => {
      for (const root of roots) {
        await exec(process.execPath, [cli, "stop"], { cwd: repo, env: root.env, timeout: 60000 });
        await rm(root.base, { recursive: true, force: true });
      }
    });
    const a = await setup();
    roots.push(a);
    const b = await setup();
    roots.push(b);
    assert.notEqual(a.instance.backendId, b.instance.backendId);
    assert.notEqual(a.instance.token, b.instance.token);
    const before = await readFile(a.config, "utf8");
    const auth = createBackendAuthorization({ appRoot: repo });
    let selected = await auth.select(b.data);
    const guard = createSettingsTargetGuard({
      getOwner: () => a.instance,
      getSelected: () => selected,
      verifySelected: (expected) => auth.verifySelected(expected)
    });
    let writes = 0;
    for (const action of ["model-status", "search-status", "model-save", "search-save"]) {
      await assert.rejects(
        guard.settings(async () => {
          writes++;
          await writeFile(a.config, action);
        }),
        /后端/
      );
    }
    assert.equal(writes, 0);
    assert.equal(await readFile(a.config, "utf8"), before);
    assert.equal(await isServing(a.instance), true);
    assert.equal(await isServing(b.instance), true);
    selected = await guard.select(() => auth.select(a.data));
    assert.equal(await guard.settings(() => readFile(a.config, "utf8")), before);
    await guard.settings(() => writeFile(a.config, JSON.stringify({ model: "fixture-after" })));
    assert.deepEqual(JSON.parse(await readFile(a.config, "utf8")), { model: "fixture-after" });
    assert.equal(await isServing(a.instance), true);
  }
);
