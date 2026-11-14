import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import * as humanModule from "../dist/src/runtime/human.js";
import { HumanRequestStore } from "../dist/src/runtime/human.js";
import { MainRequestStore } from "../dist/src/storage/main-request-store.js";
import { readSleep } from "../dist/src/runtime/main-sleep.js";
import { subagentCallStatuses } from "../dist/src/runtime/subagent-call-status.js";

/**
 * Nothing is released yet, so no data written before a capability changed
 * exists. Branches that only recognised such data are gone: the retired goal
 * tool's request ids, the retired system-prompt sections, the pre-1.5.2 SDK
 * identity templates, the old retry slot, and the missing-Pi-version replay
 * path. Data that is incomplete is damaged data, and it follows one path.
 */

const removedModules = [
  "src/runtime/retired-system-sections.ts",
  "src/runtime/model-request-retry.ts",
  "scripts/data-migration.cjs"
];

/** Names that existed only to recognise pre-release data. */
const removedNames = [
  "RETIRED_SYSTEM_SECTIONS",
  "withoutRetiredSections",
  "retiredSectionsWithText",
  "retiredSectionReplayRefusal",
  "isRetiredGoalDecision",
  "listBlockingPending",
  "pi_version_missing",
  "legacyPending",
  "readModelRequestRetry",
  "model-request-retry",
  "retry-request.json",
  "human-goal_",
  "cowork-completion-check",
  "data-migration",
  "importLegacyData",
  "migrateLegacyDesktopData",
  "showLegacyDataNotice",
  "canMigrateLegacy",
  "legacyUserData",
  "data import"
];

/** Text only a pre-release SDK release line produced. */
const removedTemplates = [
  "You are an expert coding assistant operating inside pi",
  "Pi documentation (read only when the user asks about pi itself",
  "You are Atria Main, the agent responsible for completing the user's tasks in Atria Cowork."
];

/** Maintained documents describing the current product, not its history. */
const maintainedDocs = [
  "docs/code-map.md",
  "docs/en/code-map.md",
  "docs/runtime-reference.md",
  "docs/en/runtime-reference.md",
  "docs/task-workspace-layout.md",
  "docs/testing-case-catalog.md",
  "docs/computer-use.md"
];

const scanRoots = ["src", ".pi", "web", "desktop", "scripts"];
/** The removed in-process trace path, which nothing writes any more. */
const removedTracePath = /sessions\/\$\{[^`]*\}\.jsonl/;
const scannedExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"]);

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      files.push(...(await sourceFiles(path)));
    } else if (scannedExtensions.has(entry.name.slice(entry.name.lastIndexOf(".")))) files.push(path);
  }
  return files;
}

test("the compatibility-only modules no longer exist", () => {
  assert.deepEqual(
    removedModules.filter((path) => existsSync(path)),
    [],
    "these modules only kept pre-release data readable"
  );
});

test("product sources no longer name a pre-release compatibility branch", async () => {
  const offenders = [];
  for (const root of scanRoots) {
    for (const file of await sourceFiles(root)) {
      const text = await readFile(file, "utf8");
      for (const name of [...removedNames, ...removedTemplates])
        if (text.includes(name)) offenders.push(`${relative(".", file)}: ${name}`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("product sources never name the removed in-process trace path", async () => {
  const offenders = [];
  for (const root of scanRoots) {
    for (const file of await sourceFiles(root)) {
      const text = await readFile(file, "utf8");
      if (removedTracePath.test(text)) offenders.push(relative(".", file));
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("the stores no longer expose a compatibility read", () => {
  assert.equal(Object.hasOwn(humanModule, "isRetiredGoalDecision"), false);
  assert.equal(
    Object.getOwnPropertyNames(HumanRequestStore.prototype).includes("listBlockingPending"),
    false
  );
  assert.equal(Object.getOwnPropertyNames(MainRequestStore.prototype).includes("legacyPending"), false);
});

test("maintained documents no longer describe a pre-release compatibility branch", async () => {
  const offenders = [];
  for (const file of maintainedDocs) {
    const text = await readFile(file, "utf8");
    for (const name of [...removedNames, "退役段落", "旧快照没有 `piVersion`"])
      if (text.includes(name)) offenders.push(`${file}: ${name}`);
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("a request snapshot without a Pi version is damaged data, not an unversioned replay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cowork-snapshot-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MainRequestStore(join(root, "request-retry.json"), "task");
  const model = {
    id: "fixture",
    provider: "fixture",
    api: "openai-completions",
    baseUrl: "http://fixture.test",
    reasoning: false,
    input: ["text"],
    contextWindow: 10000,
    maxTokens: 64
  };
  const body = JSON.stringify({ model: "fixture", messages: [] });
  await store.begin({
    runId: "run",
    requestId: "request",
    model,
    context: { messages: [] },
    environment: { projectDirectory: root },
    executionScope: {
      version: 1,
      taskStorageRoot: root,
      projectDirectory: root,
      application: null
    },
    endpoint: "http://fixture.test/v1/chat/completions",
    piVersion: "1.5.2",
    body
  });
  assert.equal((await store.read()).requestId, "request");

  // Drop the version the way an archive from before versions were recorded would.
  const snapshot = JSON.parse(await readFile(store.filePath, "utf8"));
  delete snapshot.piVersion;
  delete snapshot.checksum;
  const checksum = createHash("sha256")
    .update(JSON.stringify(Object.fromEntries(Object.entries(snapshot))))
    .digest("hex");
  await writeFile(store.filePath, JSON.stringify({ ...snapshot, checksum }));
  await assert.rejects(store.read(), /原请求快照损坏/);
});

test("the removed data import command is no longer accepted", async () => {
  const child = spawn(process.execPath, ["scripts/atria.mjs", "data", "import", "--from", "/tmp/legacy"], {
    cwd: resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          !/^(COWORK_|ATRIA_|PI_|OPENAI_|ANTHROPIC_|SERPER_|EXA_)/.test(name) && name !== "NODE_OPTIONS"
      )
    )
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const [code] = await once(child, "exit");
  assert.equal(code, 1, output);
  assert.match(output, /data paths\|backup/);
});

test("subagent diagnostics name the process log that the delegated process writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cowork-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = join(root, "task", "runs", "run", "agents", "subagents", "subagent_1", "agent-output.log");
  await mkdir(join(root, "task", "runs", "run", "agents", "subagents", "subagent_1"), { recursive: true });
  await writeFile(log, "");
  const [status] = await subagentCallStatuses(
    { workspaceRoot: root, taskId: "task", runId: "run" },
    [{ stepId: "call-1", agentId: "subagent_1", status: "completed" }],
    []
  );
  assert.equal(status.diagnostics.tracePath, "runs/run/agents/subagents/subagent_1/agent-output.log");
  assert.equal(await readFile(join(root, "task", status.diagnostics.tracePath), "utf8"), "");
});

test("a park record without a wake time is damaged data, not an old park", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cowork-park-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "task", "agents", "main"), { recursive: true });
  await writeFile(
    join(root, "task", "agents", "main", "sleep.json"),
    JSON.stringify({ runId: "run", reason: "old monitor", parkedAt: new Date().toISOString() })
  );
  await assert.rejects(readSleep(root, "task"), /停泊记录损坏/);
});
