import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

// These files name the removed ids to assert they are absent everywhere else;
// the retrospective records the removal itself as history.
const assertionFiles = new Set([
  "test/p45-no-starfield.test.js",
  "e2e/p45-no-starfield.spec.js",
  "docs/p4.5-retrospective.md"
]);
const sourceRoots = ["web", "desktop", "src", "test", "e2e", "scripts", "docs", ".pi"];
const rootFiles = ["AGENTS.md", "CLAUDE.md", "README.md", "package.json"];
const sourceFile = /\.(?:js|mjs|cjs|ts|html|css|md|json)$/;
const generated =
  /(?:^|\/)(?:node_modules|dist|build|\.git|\.tmp|\.cowork|applications|workspace|task-[^/]+)(?:\/|$)/;
const removed = /starfield|night-sky|atria\.(?:background|galaxy)\.motion|星空|流星/i;

async function sourceFiles(directory) {
  const found = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (generated.test(path)) continue;
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (sourceFile.test(entry.name) && !assertionFiles.has(path)) found.push(path);
  }
  return found;
}

test("the starfield script and its stylesheet are deleted", async () => {
  for (const file of ["web/assets/starfield.js", "web/assets/starfield.css"]) {
    await assert.rejects(access(join(root, file)), { code: "ENOENT" }, `${file} is deleted`);
  }
});

test("no source, test or document still names the starfield canvas or motion switch", async () => {
  const files = [
    ...rootFiles,
    ...(await Promise.all(sourceRoots.map((directory) => sourceFiles(directory)))).flat()
  ];
  const mentions = [];
  for (const file of files) {
    const text = await readFile(join(root, file), "utf8");
    text.split("\n").forEach((line, index) => {
      if (removed.test(line)) mentions.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(mentions, [], "the starfield canvas, script and motion switch are gone");
});
