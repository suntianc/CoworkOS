import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverNodeTests } from "../scripts/test.mjs";
import { verificationScripts } from "../scripts/verify.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("daily verification runs the release-runner regression that discovery defers", async () => {
  // The runner self-test lives outside Node discovery on purpose; without this
  // gate a release-plan regression reaches review instead of failing a check.
  assert.ok(!(await discoverNodeTests(root)).includes("test/release/runner.test.mjs"));
  assert.ok(verificationScripts.includes("test:release:runner"));
  const listed = execFileSync(process.execPath, ["scripts/verify.mjs", "--list"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.match(listed, /npm run test:release:runner/);
});

test("the gated script executes the release-runner self-test", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["test:release:runner"], "node --test test/release/runner.test.mjs");
});
