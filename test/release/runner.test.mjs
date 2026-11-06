import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseOptions,
  loadPlan,
  stageIds,
  parseTap,
  stepStatus,
  automationOutcome
} from "../../scripts/release-test-plan.mjs";
import { createTestPlan, discoverNodeTests, parseTestOptions } from "../../scripts/test.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("every existing test is assigned once, including deferred native tests", async () => {
  const plan = await loadPlan(root, parseOptions([]), "linux");
  assert.deepEqual(
    plan.groups.map((group) => group.id),
    stageIds
  );
  const existing = [
    ...(await discoverNodeTests(root)),
    ...(await readdir(join(root, "e2e")))
      .filter((name) => name.endsWith(".spec.js"))
      .map((name) => `e2e/${name}`)
  ].sort();
  const assigned = [
    ...plan.groups.flatMap((group) => [...group.node, ...group.browser]),
    ...plan.deferred.map((item) => item.file)
  ].sort();
  assert.deepEqual(assigned, existing);
  assert.equal(new Set(assigned).size, assigned.length);
  assert.ok(plan.requirements.some((item) => item.id === "TXT-05"));
  assert.ok(plan.requirements.some((item) => item.id === "GUI-04/resume-friendly"));
  assert.ok(plan.requirements.every((item) => ["partial_mapping", "planned"].includes(item.coverage)));
  assert.equal(plan.steps.filter((step) => step.id === "check-docs").length, 1);
});

test("release discovery includes ESM, nested and compiled tests exactly once in executable steps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atria-release-discovery-"));
  const put = async (file, content = "") => {
    await mkdir(join(directory, file, ".."), { recursive: true });
    await writeFile(join(directory, file), content);
  };
  try {
    await put("package.json", JSON.stringify({ type: "module" }));
    await put(
      "test/release/catalog.json",
      JSON.stringify({
        stages: stageIds.map((id) => ({ id, name: id })),
        rules: [],
        nativeNode: ["test/computer-native.test.js"],
        nativeBrowserPattern: "-desktop\\.spec\\.js$",
        anchors: [],
        manual: []
      })
    );
    await put("docs/testing-case-catalog.md");
    await put("docs/testing-application-release.md");
    await put("e2e/browser.spec.js");
    await put("test/root.test.js", "import { test } from 'node:test'; test('JS fixture', () => {});");
    await put(
      "test/nested/esm.test.mjs",
      "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('ESM fixture', () => assert.equal(process.env.RELEASE_ESM_EXPECTATION, 'pass'));"
    );
    for (const name of ["p0", "nested/compiled"]) {
      await put(`test/${name}.test.ts`);
      await put(
        `dist/test/${name}.test.js`,
        "import { test } from 'node:test'; test('compiled fixture', () => {});"
      );
    }
    await put("test/computer-native.test.js");
    await put("test/release/runner.test.mjs");
    await put("test/helper.mjs");

    const plan = await loadPlan(directory, parseOptions(["--skip-build"]), "linux");
    const files = plan.groups.flatMap((group) => group.node).sort();
    assert.deepEqual(files, [
      "test/nested/compiled.test.ts",
      "test/nested/esm.test.mjs",
      "test/p0.test.ts",
      "test/root.test.js"
    ]);
    assert.deepEqual(plan.deferred.map((item) => item.file), ["test/computer-native.test.js"]);
    const steps = plan.steps.filter((step) => step.kind === "node" && step.id !== "release-runner");
    const env = { ...process.env, RELEASE_ESM_EXPECTATION: "pass" };
    // Run fixture suites as independent processes rather than recursive node:test children.
    delete env.NODE_TEST_CONTEXT;
    for (const file of files) {
      const executable = file.endsWith(".ts")
        ? file.replace(/^test\//, "dist/test/").replace(/\.ts$/, ".js")
        : file;
      assert.equal(
        steps.flatMap((step) => step.args).filter((arg) => arg === executable).length,
        1
      );
    }
    for (const step of steps) {
      const result = spawnSync(step.command, step.args, {
        cwd: directory,
        encoding: "utf8",
        timeout: 10_000,
        env
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(
        stepStatus(result.status, parseTap(result.stdout)),
        "passed",
        result.stdout + result.stderr
      );
    }
    const esmStep = steps.find((step) => step.args.includes("test/nested/esm.test.mjs"));
    const failure = spawnSync(esmStep.command, esmStep.args, {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...env, RELEASE_ESM_EXPECTATION: "fail" }
    });
    assert.equal(failure.status, 1);
    assert.match(failure.stdout, /ESM fixture/);
    assert.equal(stepStatus(failure.status, parseTap(failure.stdout)), "failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stage selection excludes unrelated commands and keeps shared build", async () => {
  const plan = await loadPlan(root, parseOptions(["--stage", "applications"]));
  assert.equal(plan.steps[0].id, "build");
  assert.ok(plan.steps.slice(1).every((step) => step.stage === "applications"));
  assert.ok(plan.steps.some((step) => step.args.includes("test/application-resource-store.test.js")));
  assert.ok(!plan.steps.some((step) => step.id === "basic-node"));
});

test("native and package work is explicit and Mac-specific", async () => {
  const mac = await loadPlan(root, parseOptions(["--native", "--packages"]), "darwin");
  assert.ok(mac.groups.some((group) => group.node.includes("test/computer-native.test.js")));
  assert.ok(mac.steps.some((step) => step.id === "app-package"));
  assert.ok(
    mac.steps.filter((step) => step.kind === "browser").every((step) => step.args.includes("--workers=1"))
  );
  const linux = await loadPlan(root, parseOptions(["--native", "--packages"]), "linux");
  assert.ok(linux.deferred.some((item) => item.file === "final-mac-package"));
  assert.ok(!linux.steps.some((step) => step.id === "app-package"));
});

test("mixed files retain Web coverage and gate only native variants", async () => {
  const normal = await loadPlan(root, parseOptions([]), "darwin");
  const browser = normal.steps.find((step) => step.id === "app-browser");
  assert.ok(browser.args.includes("e2e/model-profiles.spec.js"));
  assert.ok(browser.args.includes("--grep-invert"));
  assert.ok(browser.args.some((arg) => arg.includes("desktop: saved connections")));
  assert.equal(normal.steps.find((step) => step.id === "app-node").env.ATRIA_NATIVE_DESKTOP_TEST, "0");
  assert.equal(normal.steps.find((step) => step.id === "app-node").env.ATRIA_MANAGED_UPDATE_NATIVE, "0");
  assert.ok(normal.deferredVariants.some((variant) => variant.file === "test/desktop-update-install.test.js"));
  assert.equal(normal.deferredVariants.length, 3);
  const native = await loadPlan(root, parseOptions(["--native"]), "darwin");
  assert.equal(native.steps.find((step) => step.id === "app-node").env.ATRIA_NATIVE_DESKTOP_TEST, "1");
  assert.equal(native.steps.find((step) => step.id === "app-node").env.ATRIA_MANAGED_UPDATE_NATIVE, "1");
  assert.ok(!native.steps.find((step) => step.id === "app-browser").args.includes("--grep-invert"));
  assert.equal(native.deferredVariants.length, 0);
});

test("failed, skipped, empty and retry-pass reports cannot become a clean pass", () => {
  assert.equal(parseTap("no report"), null);
  assert.equal(parseTap("# tests 0\n# pass 0\n"), null);
  const skipped = parseTap("# tests 4\n# pass 3\n# fail 0\n# skipped 1\n");
  assert.equal(stepStatus(0, skipped), "passed_with_skips");
  assert.equal(stepStatus(1, skipped), "failed");
  assert.equal(stepStatus(0, { tests: 4, fail: 1, skipped: 0 }), "failed");
  assert.equal(stepStatus(0, { tests: 4, fail: 0, flaky: 1 }), "failed");
  assert.equal(stepStatus(0, null), "unverified");
  assert.equal(stepStatus(0, skipped, true), "interrupted");
  assert.equal(stepStatus(0, skipped, false, true), "timed_out");
  assert.equal(automationOutcome([{ status: "passed" }], stageIds, ["basic"]), "incomplete");
  assert.equal(automationOutcome([{ status: "passed_with_skips" }], stageIds, stageIds), "passed_with_skips");
});

test("malformed options fail before running a build", () => {
  for (const args of [
    ["--stage"],
    ["--stage", "other"],
    ["--stage", "basic,"],
    ["--timeout-seconds", "0"],
    ["--unknown"]
  ])
    assert.throws(() => parseOptions(args));
});

test("list is read-only and reports planned coverage and manual work", async () => {
  const directory = join(root, ".tmp/release-tests");
  const before = await readdir(directory).catch(() => []);
  const output = execFileSync(process.execPath, ["scripts/test-release.mjs", "--list", "--stage", "cli"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.match(output, /二 CLI 专门功能/);
  assert.match(output, /部分覆盖线索/);
  assert.match(output, /人工待验/);
  assert.doesNotMatch(output, /开始 build/);
  assert.deepEqual(await readdir(directory).catch(() => []), before);
});

test("the local runner is not added to GitHub workflows or ordinary test discovery", async () => {
  for (const file of (await readdir(join(root, ".github/workflows"))).filter((name) => /\.ya?ml$/.test(name)))
    assert.doesNotMatch(
      await readFile(join(root, ".github/workflows", file), "utf8"),
      /test:release|test-release\.mjs|release\/runner\.test/
    );
  const standard = await createTestPlan(root, parseTestOptions([]));
  assert.ok(!standard.selected.some((file) => file.startsWith("test/release/")));
  assert.ok(!standard.commands.flat().some((argument) => /test-release\.mjs|release\/runner\.test/.test(argument)));
});
