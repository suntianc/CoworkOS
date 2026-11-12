import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { test } from "node:test";

/**
 * P4.6 #04: leftovers from the first removal round stay gone.
 *
 * These assertions are about names and duplication, not user-observable
 * behaviour: every item below was dead code, a duplicate implementation or a
 * misleading name. The kept paths keep their own behaviour tests — atomic
 * writes are exercised through the stores, the artifact index race through
 * artifact-store.test.js and the image tool arguments through
 * image-tools.test.js.
 */

const scannedExtensions = new Set([".ts", ".js", ".mjs", ".cjs", ".html", ".json", ".md"]);
const skippedDirectories = new Set(["node_modules", "dist", ".git"]);
const self = join("test", "p46-tidy-leftovers.test.js");

async function* sourceFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (skippedDirectories.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (entry.isFile() && scannedExtensions.has(extname(entry.name))) yield path;
  }
}

test("one atomic state write serves every runtime store", async () => {
  const definitions = [];
  for await (const path of sourceFiles("src")) {
    if ((await readFile(path, "utf8")).includes("function atomicWrite")) definitions.push(path);
  }
  assert.deepEqual(definitions, [join("src", "storage", "atomic-file.ts")]);
});

test("the Dashboard run service and the watcher keep no dead port or poller", async () => {
  const runService = await readFile(join("src", "dashboard", "run-service.ts"), "utf8");
  assert.doesNotMatch(runService, /onRunStarting/);
  assert.doesNotMatch(runService, /launchMainRunWithActivity/);
  const watcher = await readFile(join("src", "runtime", "watcher.ts"), "utf8");
  assert.doesNotMatch(watcher, /WatcherPoller|WatcherPollResult|appendWatcherFailure/);
  assert.doesNotMatch(watcher, /\bpoll\s*\(/);
});

test("the icon sprite carries no symbol the page never uses", async () => {
  for await (const path of sourceFiles("web")) {
    assert.doesNotMatch(await readFile(path, "utf8"), /i-monitor/, `${path} still names the retired icon`);
  }
});

test("the artifact page reuses the shared HTML escape", async () => {
  const artifacts = await readFile(join("web", "assets", "artifacts.js"), "utf8");
  assert.doesNotMatch(artifacts, /const esc\s*=/, "a private escape copy is back");
  assert.match(artifacts, /import \{ escapeHtml \} from "\.\/ui\/html\.js";/);
});

test("retired fixture names and the misleading action name stay gone", async () => {
  const retired = [
    "openProjectExperience",
    "getWorkbench",
    "hasResources",
    "apply_resource_operation",
    "editAction"
  ];
  // The round-1 removal regression names the retired identifier on purpose.
  const namesRemovedIdentifiers = new Set([join("test", "p46-applications-removed.test.js")]);
  for (const root of ["src", "web", ".pi", "test", "e2e"]) {
    for await (const path of sourceFiles(root)) {
      if (path === self) continue;
      const text = await readFile(path, "utf8");
      for (const term of retired) {
        if (term === "apply_resource_operation" && namesRemovedIdentifiers.has(path)) continue;
        assert.equal(text.includes(term), false, `${path} still names ${term}`);
      }
    }
  }
});

test("image tests are named for image input, not the removed vision role", async () => {
  const retiredWording = [
    "visionApi",
    "visionCalls",
    "vision-capable",
    "vision blocks",
    "vision probe",
    "vision settings",
    "vision to text"
  ];
  for (const root of ["test", "e2e"]) {
    for await (const path of sourceFiles(root)) {
      if (path === self) continue;
      // The removal regression keeps the removed role's own name.
      if (/p46-.*removed/.test(basename(path))) continue;
      assert.doesNotMatch(basename(path), /vision/i, `${path} is still named after the removed role`);
      const text = await readFile(path, "utf8");
      for (const term of retiredWording)
        assert.equal(text.includes(term), false, `${path} still says ${term}`);
    }
  }
});
