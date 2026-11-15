import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";

/**
 * Every Node and browser test must be loadable.
 *
 * A test that still imports a module this branch deleted fails before it can
 * run, and only the file's own command notices. This scans the static import
 * and export specifiers of every test file and resolves each local target, so a
 * removed file cannot survive behind a green focused run elsewhere.
 */

const roots = ["test", "e2e"];
const extensions = new Set([".js", ".ts", ".mjs"]);
/** Removed modules, matched on the resolved suffix so a package named the same is not flagged. */
const removedModules = [
  "/runtime/pi-session.js",
  "/runtime/agent-checkpoint.js",
  "/runtime/context-compaction.js",
  "/runtime/subagent-recovery-summary.js",
  "/runtime/command-output-feedback.js",
  "/runtime/run-service.js",
  "/runtime/worker.js",
  "/storage/trace-recorder.js",
  "/tools/builtin.js",
  "/tools/foreground-command.js",
  "/tools/foreground-command-output.js",
  "/tools/foreground-command-host.js",
  "/tools/command-receipt.js",
  "/tools/process-group.js",
  "/tools/remote-tools.js",
  "/cli/coding-smoke.js",
  "/cli/multi-subagent-smoke.js"
];

async function testFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await testFiles(path)));
    else if (extensions.has(path.slice(path.lastIndexOf(".")))) files.push(path);
  }
  return files;
}

function importSpecifiers(source) {
  // Generated package code lives in template literals; its imports belong to
  // the installed package, not to this repository.
  const text = source.replace(/`[\s\S]*?`/g, "");
  const specifiers = [];
  for (const [, specifier] of text.matchAll(
    /^\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm
  ))
    specifiers.push(specifier);
  for (const [, specifier] of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) specifiers.push(specifier);
  return specifiers;
}

function resolves(base, specifier) {
  const withoutQuery = specifier.replace(/[?#].*$/, "");
  const target = resolve(dirname(base), withoutQuery);
  for (const candidate of [
    target,
    `${target}.js`,
    `${target}.ts`,
    `${target}.mjs`,
    target.replace(/\.js$/, ".ts"),
    join(target, "index.js"),
    join(target, "index.ts"),
    join(target, "index.mjs")
  ])
    if (existsSync(candidate)) return true;
  return false;
}

test("every test and e2e import resolves to a file that exists", async () => {
  const problems = [];
  for (const root of roots) {
    for (const file of await testFiles(root)) {
      const text = await readFile(file, "utf8");
      for (const specifier of importSpecifiers(text)) {
        // Only relative imports are repository files; bare names are packages
        // and a leading slash is a URL served to a browser.
        if (!specifier.startsWith(".")) continue;
        const path = specifier.replace(/[?#].*$/, "");
        if (removedModules.some((suffix) => path.endsWith(suffix))) {
          problems.push(`${relative(".", file)} imports the removed module ${specifier}`);
          continue;
        }
        if (!resolves(file, specifier)) problems.push(`${relative(".", file)} imports missing ${specifier}`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});
