import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, cp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyCliInformation, scanCliArguments, isInteractiveCli } from "../scripts/cli-information.mjs";

const exec = promisify(execFile);

test("information scanning preserves SDK values, boundaries and extension execution flags", () => {
  for (const args of [
    ["--system-prompt", "--version"],
    ["--model", "--help"],
    ["--", "--version"],
    ["--plan", "value"]
  ])
    assert.equal(classifyCliInformation(args), undefined);
  for (const args of [["--version"], ["-v"]]) assert.equal(classifyCliInformation(args), "version");
  for (const args of [
    ["--version", "--help"],
    ["-h", "-v"]
  ])
    assert.equal(classifyCliInformation(args), "help");
  for (const args of [
    ["--version", "extra"],
    ["--plan", "--version"],
    ["--version", "--model"]
  ])
    assert.throws(() => classifyCliInformation(args), /版本查询不接受执行参数/);
  assert.equal(scanCliArguments(["--model", "--version", "-p"]).get("--model").value, "--version");
  assert.equal(isInteractiveCli(["--system-prompt", "--print"], true, true), true);
  assert.equal(isInteractiveCli(["--", "--mode", "rpc"], true, true), true);
  for (const args of [["--mode", "rpc"], ["--mode", "json"], ["--print"], ["-p"]])
    assert.equal(isInteractiveCli(args, true, true), false);
  assert.equal(isInteractiveCli([], false, true), false);
  for (const args of [
    ["--mode", "rpc", "--mode", "invalid"],
    ["--mode", "rpc", "--mode", "--extension", "fixture"],
    ["--mode", "invalid", "--mode", "text"],
    ["--mode"]
  ])
    assert.equal(isInteractiveCli(args, true, true), false);
  assert.equal(scanCliArguments(["--mode", "rpc", "--mode", "invalid"]).get("--mode").effectiveValue, "rpc");
  assert.equal(isInteractiveCli(["--mode", "rpc", "--mode", "text"], true, true), true);
  assert.equal(isInteractiveCli(["--mode", "text", "--mode", "rpc"], true, true), false);
});

test("public root, start, npm and thin version queries work without SDK/dist/config or writable profile", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-info-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  for (const file of [
    "atria.mjs",
    "cli-information.mjs",
    "cli-startup-error.mjs",
    "data-home.cjs",
    "start-pi.mjs"
  ])
    await cp(resolve("scripts", file), join(root, "scripts", file));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "atria-fixture",
      type: "module",
      version: "0.1.2-test",
      scripts: { start: "node scripts/atria.mjs start" }
    })
  );
  const config = join(root, "config.json");
  await writeFile(config, "invalid configuration containing fixture-private-key");
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(COWORK_|PI_|ATRIA_|NODE_OPTIONS)/.test(key))
    ),
    HOME: join(root, "home"),
    ATRIA_HOME: join(root, "uncreated-home"),
    COWORK_CONFIG: config,
    COWORK_HARNESS_ROOT: root,
    COWORK_API_KEY: "fixture-private-key"
  };
  const run = (entry, args) =>
    exec(process.execPath, [join(root, "scripts", entry), ...args], { cwd: root, env, timeout: 10000 });
  for (const args of [["--version"], ["-v"], ["start", "--version"], ["start", "-v"]])
    assert.equal((await run("atria.mjs", args)).stdout.trim(), "CoworkOS 0.1.2-test");
  for (const args of [["--version"], ["-v"]])
    assert.equal((await run("start-pi.mjs", args)).stdout.trim(), "CoworkOS 0.1.2-test");
  for (const args of [
    ["--version", "--help"],
    ["-v", "extra"]
  ])
    await assert.rejects(
      run("atria.mjs", args),
      (error) => error.code === 1 && /does not accept options/.test(error.stderr)
    );
  for (const args of [
    ["start", "--version", "--help"],
    ["start", "--help", "--version"],
    ["--help", "--version"]
  ])
    assert.match((await run("atria.mjs", args)).stdout, /CoworkOS — local/);
  // The in-process single-agent entry no longer exists, so help must not list it.
  assert.doesNotMatch((await run("atria.mjs", ["--help"])).stdout, /coworkos single/);
  assert.deepEqual((await readdir(root)).sort(), ["config.json", "package.json", "scripts"]);
  const npm = await exec(process.platform === "win32" ? "npm.cmd" : "npm", ["start", "--", "--version"], {
    cwd: root,
    env: { ...env, npm_config_cache: join(root, "npm-cache"), npm_config_update_notifier: "false" },
    timeout: 15000
  });
  assert.match(npm.stdout, /CoworkOS 0\.1\.2-test/);
  assert.equal(await readFile(config, "utf8"), "invalid configuration containing fixture-private-key");
  // npm may create its own cache; the CoworkOS profile must still be untouched.
  await assert.rejects(readdir(env.ATRIA_HOME), { code: "ENOENT" });
});
