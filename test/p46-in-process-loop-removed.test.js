import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";

/**
 * The in-process execution loop is gone.
 *
 * Subagents run as their own Pi processes and Main owns its own session, so the
 * repository must not keep a second loop: the modules that ran one, the tools
 * and compaction that only served it, and the CLI paths that drove it. This
 * scans the source tree for every name that belonged to that implementation.
 */

const removedModules = [
  "src/runtime/pi-session.ts",
  "src/runtime/agent-checkpoint.ts",
  "src/runtime/context-compaction.ts",
  "src/runtime/subagent-recovery-summary.ts",
  "src/runtime/run-service.ts",
  "src/runtime/worker.ts",
  "src/runtime/command-output-feedback.ts",
  "src/storage/trace-recorder.ts",
  "src/tools/builtin.ts",
  "src/tools/foreground-command.ts",
  "src/tools/foreground-command-output.ts",
  "src/tools/foreground-command-host.ts",
  "src/tools/command-receipt.ts",
  "src/tools/process-group.ts",
  "src/tools/remote-tools.ts",
  "src/cli/coding-smoke.ts",
  "src/cli/multi-subagent-smoke.ts"
];

/** Everything that exists only to run a delegated session inside Main's process. */
const removedNames = [
  "PiSession",
  "CoordinatorWorker",
  "createBuiltinTools",
  "toolFactory",
  "readAgentCheckpoint",
  "emptyCompaction",
  "PersistedAgentState",
  "ContextCompactor",
  "subagentRecoverySummary",
  "runPi",
  "createSubagentStatusTool",
  "takeOverLegacyRuntime"
];

/**
 * Import basenames that only the removed modules had.
 *
 * `run-service` is excluded on purpose: the Dashboard's own run service keeps
 * that name, and the deleted runtime file is covered by the existence check.
 */
const removedImportNames = new Set([
  "pi-session",
  "agent-checkpoint",
  "context-compaction",
  "subagent-recovery-summary",
  "command-output-feedback",
  "trace-recorder",
  "builtin",
  "coding-smoke",
  "multi-subagent-smoke"
]);

/** The pi-agent-core loop itself: a new Agent, and the session fields it drove. */
const agentLoopPatterns = [
  [/\bnew Agent\s*[<(]/, "a new pi-agent-core Agent loop"],
  [/\.agent\.(?:run|abort|steer)\s*\(/, "a call into the in-process agent loop"],
  [/\.agent\.state\.isStreaming\b/, "in-process streaming state"],
  [/agentTools\s*[:=]/, "model-visible agent tools"]
];

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("the in-process execution modules and CLI smokes no longer exist", () => {
  assert.deepEqual(
    removedModules.filter((path) => existsSync(path)),
    [],
    "these files implemented the in-process loop and its tools"
  );
});

test("src/ has no in-process loop, checkpoint, delegated tools or delegated compaction", async () => {
  const files = await sourceFiles("src");
  const offenders = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const name of removedNames) {
      const match = new RegExp(`\\b${name}\\b`).exec(text);
      if (match) offenders.push(`${relative(".", file)}: ${name}`);
    }
    for (const [pattern, label] of agentLoopPatterns) {
      if (pattern.test(text)) offenders.push(`${relative(".", file)}: ${label}`);
    }
    for (const [, specifier] of text.matchAll(/from\s+"([^"]+)"/g)) {
      const name = specifier.split("/").at(-1).replace(/\.js$/, "");
      if (removedImportNames.has(name)) offenders.push(`${relative(".", file)}: imports ${specifier}`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("no CLI entry still advertises the smoke scripts of the in-process loop", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const scripts = Object.keys(pkg.scripts ?? {}).filter(
    (name) => name === "smoke:coding" || name === "smoke:multi-subagent"
  );
  assert.deepEqual(scripts, [], "both smokes drove the in-process loop and were removed");
});
