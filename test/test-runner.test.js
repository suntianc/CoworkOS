import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "./dashboard-fixture.mjs";
import {
  createTestPlan,
  discoverNodeTests,
  parseTestOptions,
  repositoryRoot,
  runCommand
} from "../scripts/test.mjs";

async function fixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "atria-test-runner-"));
  const put = async (file, text = "") => {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), text);
  };
  try {
    await put(
      "test/release/catalog.json",
      JSON.stringify({
        nativeNode: ["test/native.test.js"],
        nativeVariants: [
          {
            kind: "node",
            file: "test/desktop.test.js",
            pattern: "native variant",
            enableEnv: "NATIVE_VARIANT"
          }
        ]
      })
    );
    for (const file of [
      "test/p0.test.ts",
      "test/runtime.test.js",
      "test/desktop.test.js",
      "test/native.test.js",
      "test/nested/new.test.mjs",
      "test/release/runner.test.mjs",
      "test/fixtures/not-a-test.js"
    ])
      await put(file);
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("discovery includes nested and compiled tests, explicitly defers native work, and reserves release runner", async () => {
  await fixture(async (root) => {
    const files = await discoverNodeTests(root);
    assert.ok(files.includes("test/nested/new.test.mjs"));
    assert.ok(files.includes("test/p0.test.ts"));
    assert.ok(!files.some((file) => file.includes("release/") || file.includes("fixtures/")));
    const plan = await createTestPlan(root, parseTestOptions([]));
    assert.equal(plan.selected.length, 4);
    assert.deepEqual(plan.deferred, ["test/native.test.js"]);
    assert.equal(plan.deferredVariants.length, 1);
    assert.equal(plan.env.NATIVE_VARIANT, "0");
    assert.deepEqual(plan.commands[0], ["dist/test/p0.test.js"]);
    assert.ok(plan.commands[1].includes("--test-concurrency=4"));
  });
});

test("focused exact paths and substring selection fail closed on typos and native-only matches", async () => {
  await fixture(async (root) => {
    const exact = await createTestPlan(
      root,
      parseTestOptions(["--file", "./test/runtime.test.js", "--file", "test/runtime.test.js"])
    );
    assert.deepEqual(exact.selected, ["test/runtime.test.js"]);
    const nested = await createTestPlan(root, parseTestOptions(["--match", "nested/", "--concurrency", "1"]));
    assert.deepEqual(nested.selected, ["test/nested/new.test.mjs"]);
    assert.ok(nested.commands[0].includes("--test-concurrency=1"));
    for (const args of [
      ["--file", "test/typo.test.js"],
      ["--match", "typo"],
      ["--file", "test/native.test.js"],
      ["--match", "native"]
    ])
      await assert.rejects(() => createTestPlan(root, parseTestOptions(args)));
  });
});

test("malformed focus/options cannot silently fall back to the full suite", () => {
  for (const args of [
    ["--unknown"],
    ["--file"],
    ["--match"],
    ["--match", ""],
    ["--match", "a", "--match", "b"],
    ["--file", "a", "--match", "b"],
    ["--concurrency", "0"],
    ["--concurrency", "1.5"]
  ])
    assert.throws(() => parseTestOptions(args));
  assert.equal(parseTestOptions(["--build", "--skip-build"]).skipBuild, true);
});

test("test list is read-only and missing focused files return a failure before build", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/test.mjs", "--build", "--list", "--match", "test-runner"],
    { cwd: repositoryRoot, encoding: "utf8" }
  );
  assert.match(output, /focused run/);
  assert.match(output, /test\/test-runner\.test\.js/);
  assert.doesNotMatch(output, /Using existing build|Node suite passed|build-cad/);
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        ["scripts/test.mjs", "--build", "--file", "test/does-not-exist.test.js"],
        { cwd: repositoryRoot, stdio: "pipe" }
      ),
    (error) => error.status === 1 && /Unknown source test file/.test(error.stderr.toString())
  );
});

test("child test failures propagate their actual exit code", async () => {
  assert.equal(await runCommand(process.execPath, ["-e", "process.exit(7)"]), 7);
});

test("the shared Dashboard fixture keeps the Main guardian off unless a test opts in", async (t) => {
  const off = await startDashboard({ defaultProject: false });
  t.after(() => off.stop());
  assert.equal(off.env.COWORK_DISABLE_MAIN_GUARDIAN, "1");

  const on = await startDashboard({ defaultProject: false, mainGuardian: true });
  t.after(() => on.stop());
  assert.equal(on.env.COWORK_DISABLE_MAIN_GUARDIAN, "0");
});
