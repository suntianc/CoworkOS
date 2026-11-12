import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startDashboard } from "./dashboard-fixture.mjs";
import { RETIRED_GUARDIAN_SWITCH as RETIRED_SWITCH } from "./retired-guardian-switch.mjs";

/**
 * Tests, e2e specs and helper scripts start real backends. Those backends must
 * not run the Main guardian unless a case is about the guardian itself, or a
 * parked Task can be relaunched in the middle of a timing-sensitive assertion.
 */
const SCOPES = ["test", "e2e", "scripts"];
const GUARDIAN_SWITCH = "COWORK_DISABLE_MAIN_GUARDIAN";
const SOURCE_FILE = /\.(?:js|mjs|cjs|ts|tsx|json|md)$/;

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

test("test, e2e and script sources no longer name the retired supervisor switch", async () => {
  const files = (await Promise.all(SCOPES.map(walk))).flat().filter((path) => SOURCE_FILE.test(path));
  const offenders = [];
  for (const path of files) if ((await readFile(path, "utf8")).includes(RETIRED_SWITCH)) offenders.push(path);
  assert.deepEqual(offenders, []);
});

test("every file that pinned the retired switch on main disables the Main guardian", async () => {
  const listing = execFileSync("git", ["grep", "-l", "-F", RETIRED_SWITCH, "2166837", "--", ...SCOPES], {
    encoding: "utf8"
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf(":") + 1));
  assert.ok(listing.length > 0, "main 2166837 lists the files that pinned the retired switch");

  const enabledOnMain = new RegExp(`${RETIRED_SWITCH}\\s*[:=][^\\n]*["']1["']`);
  const checked = [];
  for (const path of listing) {
    const original = execFileSync("git", ["show", `2166837:${path}`], { encoding: "utf8" });
    if (!enabledOnMain.test(original)) continue;
    try {
      await stat(path);
    } catch {
      continue;
    }
    checked.push(path);
    const current = await readFile(path, "utf8");
    assert.ok(
      current.includes(GUARDIAN_SWITCH),
      `${path} disables the Main guardian instead of the retired switch`
    );
  }
  assert.ok(checked.length > 0, "the still-present files that pinned the retired switch were checked");
});

test("the shared Dashboard fixture keeps the Main guardian off unless a test opts in", async (t) => {
  const off = await startDashboard({ defaultProject: false });
  t.after(() => off.stop());
  assert.equal(off.env.COWORK_DISABLE_MAIN_GUARDIAN, "1");

  const on = await startDashboard({ defaultProject: false, mainGuardian: true });
  t.after(() => on.stop());
  assert.equal(on.env.COWORK_DISABLE_MAIN_GUARDIAN, "0");
});
