import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ESLint } from "eslint";
import { piDependencyBoundary } from "../eslint.config.mjs";

const RULE = "cowork/pi-import-boundary";
const eslint = new ESLint();

async function boundaryReports(filePath, source) {
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages.filter((message) => message.ruleId === RULE);
}

test("Pi runtime imports are rejected outside the allowed areas", async () => {
  const cases = [
    [
      "src/runtime/coordinator-runtime.ts",
      'import { SessionManager } from "@earendil-works/pi-coding-agent";'
    ],
    ["src/runtime/coordinator-runtime.ts", 'import "@earendil-works/pi-ai";'],
    ["src/runtime/coordinator-runtime.ts", 'const pi = await import("@earendil-works/pi-ai");'],
    [
      "src/runtime/coordinator-runtime.ts",
      'const { SessionManager } = require("@earendil-works/pi-coding-agent");'
    ],
    ["src/storage/atomic-file.ts", 'export { createModels } from "@earendil-works/pi-ai";'],
    [
      "web/assets/controllers/composer-session.js",
      'import { SessionManager } from "@earendil-works/pi-coding-agent";'
    ]
  ];
  for (const [file, source] of cases) {
    const reports = await boundaryReports(file, source);
    assert.equal(reports.length, 1, `${file}: ${source}`);
    assert.match(reports[0].message, /^Pi runtime imports are only allowed in/);
  }
});

test("type-only imports of Pi packages are unrestricted", async () => {
  const sources = [
    'import type { SessionEntry } from "@earendil-works/pi-coding-agent";',
    'import { type SessionEntry } from "@earendil-works/pi-coding-agent";',
    'import type { Context, Model } from "@earendil-works/pi-ai";',
    'import type { ProviderStreams } from "@earendil-works/pi-ai/api/openai-completions.lazy";',
    'export type { SessionEntry } from "@earendil-works/pi-coding-agent";',
    "let entry: import('@earendil-works/pi-coding-agent').SessionEntry | undefined;"
  ];
  for (const source of sources) {
    assert.deepEqual(await boundaryReports("src/runtime/coordinator-runtime.ts", source), [], source);
  }
});

test("Pi package subpaths are rejected outside model configuration", async () => {
  const allowed = await boundaryReports(
    "src/runtime/model-provider.ts",
    'import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";'
  );
  assert.deepEqual(allowed, []);

  const rejected = [
    [
      "src/runtime/coordinator-runtime.ts",
      'import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";'
    ],
    [
      ".pi/runtime/tools/browser-use.ts",
      'import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";'
    ],
    ["scripts/cli-session.mjs", 'import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";']
  ];
  for (const [file, source] of rejected) {
    const reports = await boundaryReports(file, source);
    assert.equal(reports.length, 1, file);
    assert.match(reports[0].message, /^Pi package subpaths may only be imported by model configuration/);
  }
});

test("Pi runtime imports stay allowed in the boundary areas", async () => {
  const areas = [
    ".pi/runtime/tools/demo.ts",
    "scripts/demo.mjs",
    ...Object.values(piDependencyBoundary.runtimeModules).flat()
  ];
  for (const file of areas) {
    const reports = await boundaryReports(
      file,
      'import { SessionManager } from "@earendil-works/pi-coding-agent";'
    );
    assert.deepEqual(reports, [], file);
  }
});

test("the allowlist matches the architecture documentation", async () => {
  const documents = ["docs/architecture.md", "docs/en/architecture.md"];
  for (const document of documents) {
    const text = await readFile(document, "utf8");
    for (const directory of piDependencyBoundary.runtimeDirectories) {
      assert.ok(text.includes(directory), `${document} does not mention ${directory}`);
    }
    for (const file of Object.values(piDependencyBoundary.runtimeModules).flat()) {
      assert.ok(existsSync(file), `allowlist points at a missing file: ${file}`);
      assert.ok(text.includes(file), `${document} does not mention ${file}`);
    }
  }
});
