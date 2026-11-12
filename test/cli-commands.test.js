import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

const execute = promisify(execFile);
const entry = resolve(process.env.ATRIA_TEST_CLI_ENTRY || "scripts/atria.mjs");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-cli-command-"));
  const project = join(root, "project"),
    workspace = join(root, "workspace");
  await mkdir(project);
  const config = join(root, "fixture-config.json");
  await writeFile(
    config,
    JSON.stringify({ baseUrl: "http://127.0.0.1:9", model: "fixture", apiKey: "cli-command-fixture-key" })
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_|NODE_OPTIONS$)/.test(name))
  );
  Object.assign(env, {
    ATRIA_HOME: join(root, "user"),
    COWORK_CONFIG: config,
    COWORK_WORKSPACE: workspace,
    PI_CODING_AGENT_DIR: join(root, "pi"),
    COWORK_DISABLE_MAIN_GUARDIAN: "1",
    PI_OFFLINE: "1"
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = (args, extra = {}) =>
    execute(process.execPath, [entry, ...args], {
      cwd: project,
      env: { ...env, ...extra },
      timeout: 15000,
      maxBuffer: 1024 * 1024
    });
  return { root, project, workspace, config, env, run };
}

test("public CLI command help is discoverable and works without configuration or writes", async (t) => {
  const f = await fixture(t);
  const missing = { COWORK_CONFIG: join(f.root, "missing.json") };
  for (const args of [
    ["task", "--help"],
    ["task", "create", "-h"],
    ["human", "reply", "--help"],
    ["single", "--help"],
    ["worker", "-h"],
    ["main-supervisor", "--help"],
    ["main-worker", "--help"],
    ["init", "-h"],
    ["doctor", "-h"],
    ["data", "-h"],
    ["help", "task", "create"]
  ]) {
    const result = await f.run(args, missing);
    assert.match(result.stdout, /Usage: coworkos/);
    assert.equal(result.stderr, "");
  }
  const top = await f.run(["--help"], missing);
  for (const command of ["create", "complete", "single", "main-supervisor"])
    assert.ok(top.stdout.includes(command), `${command} must be discoverable`);
  for (const path of [f.workspace, f.env.ATRIA_HOME, f.env.PI_CODING_AGENT_DIR])
    await assert.rejects(stat(path), { code: "ENOENT" }, "help must not create user data");
});

test("invalid CLI flags, missing values, numeric limits and operands are rejected before writes", async (t) => {
  const f = await fixture(t);
  const invalid = [
    ["task", "create", "sample", "--typo", "value"],
    ["task", "create", "sample", "--workspace"],
    ["task", "list", "--goal", "unused"],
    ["task", "status", "sample", "extra"],
    ["task", "create", ".."],
    ["single", "fixture prompt", "--max-tokens", "65537"],
    ["single", "fixture prompt", "--max-turns", "nope"],
    ["worker", "--task", "sample", "--run", "run", "--once=maybe"],
    ["main-worker", "--task", "sample", "--poll-ms", "bad"],
    ["main-worker", "--task", "sample", "--unknown"],
    ["data", "paths", "--unknown"],
    ["data", "import", "--from", f.project, "--kind", "bad"],
    ["init", "--max-tokens", "0"],
    ["init", "--thinking", "invalid"]
  ];
  for (const args of invalid) {
    await assert.rejects(f.run(args), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /^CoworkOS: /);
      assert.doesNotMatch(error.stderr, /\bat .*\(|file:\/\/|Node\.js v/);
      return true;
    });
    await assert.rejects(
      stat(f.workspace),
      { code: "ENOENT" },
      `${args.join(" ")} must not create a workspace`
    );
  }
});

test("unknown cancel options preserve the Task, and expected failures have concise CoworkOS errors", async (t) => {
  const f = await fixture(t);
  await f.run(["task", "create", "sample", "--goal", "Retain this task"]);
  const path = join(f.workspace, "sample", "task.json");
  const before = await readFile(path, "utf8");
  await assert.rejects(
    f.run(["task", "cancel", "sample", "--workspcae", join(f.root, "other")]),
    /Unknown option/
  );
  assert.equal(await readFile(path, "utf8"), before);
  await assert.rejects(f.run(["task", "status", "missing"]), (error) => {
    assert.match(error.stderr, /^CoworkOS: unknown task: missing\s*$/);
    assert.doesNotMatch(error.stderr, /cowork:|file:\/\/|Node\.js|\bat /);
    return true;
  });
  const listed = await f.run(["task", "list", "--workspace=" + f.workspace]);
  assert.match(listed.stdout, /sample/);
});
