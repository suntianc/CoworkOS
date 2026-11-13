import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { spawnMainProcess } from "../dist/src/runtime/main-supervisor.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";

const exec = promisify(execFile);
const worker = resolve("scripts/main-worker.mjs");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-main-launch-boundary-"));
  const harnessRoot = join(root, "harness"),
    workspaceRoot = join(root, "workspace"),
    evidence = join(root, "child.json");
  await mkdir(join(harnessRoot, "scripts"), { recursive: true });
  await writeFile(
    join(harnessRoot, "scripts/start-pi.mjs"),
    `import {writeFile} from 'node:fs/promises'; await writeFile(${JSON.stringify(evidence)},JSON.stringify({marker:process.env.COWORK_CLI_SESSION,taskId:process.env.COWORK_TASK_ID,runId:process.env.COWORK_RUN_ID}));`
  );
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const readChild = async () => {
    for (let count = 0; count < 100; count++) {
      try {
        return JSON.parse(await readFile(evidence, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
      await delay(10);
    }
    assert.fail("The isolated Main subprocess did not report its environment");
  };
  return { harnessRoot, workspaceRoot, readChild };
}

test("Main Supervisor wakes a fixed Task without inheriting the CLI recovery marker", async (t) => {
  const f = await fixture(t);
  spawnMainProcess({
    taskId: "fixed-task",
    runId: "fixed-run",
    harnessRoot: f.harnessRoot,
    workspaceRoot: f.workspaceRoot,
    env: { COWORK_CLI_SESSION: "1" }
  });
  assert.deepEqual(await f.readChild(), { marker: "0", taskId: "fixed-task", runId: "fixed-run" });
});

test("the independent Main worker clears a parent CLI marker before resuming its fixed Task", async (t) => {
  const f = await fixture(t);
  const store = new LocalWorkspaceStore(f.workspaceRoot);
  await store.createTask("fixed-task");
  await store.createRun("fixed-task", "fixed-run");
  await store.updateTask("fixed-task", { activeRunId: "fixed-run" });
  await new InboxStore(
    join(f.workspaceRoot, "fixed-task", "runs/fixed-run/agents/main/inbox-store.json")
  ).enqueue({
    messageId: "wake",
    recipientAgentId: "main",
    kind: "callback",
    callId: "wake",
    eventId: "wake",
    priority: 1,
    state: "ready",
    payload: { status: "succeeded", response: "resume" },
    createdAt: new Date().toISOString()
  });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_)/.test(name))
  );
  await exec(
    process.execPath,
    [worker, "--workspace", f.workspaceRoot, "--task", "fixed-task", "--once", "true"],
    { cwd: f.harnessRoot, env: { ...env, COWORK_CLI_SESSION: "1" }, timeout: 10000 }
  );
  assert.deepEqual(await f.readChild(), { marker: "0", taskId: "fixed-task", runId: "fixed-run" });
});
