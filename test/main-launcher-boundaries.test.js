import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

test("a recovery launch that finds a live Main leaves no polling observer behind", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-main-launch-reuse-"));
  const harnessRoot = join(root, "harness");
  const workspaceRoot = join(root, "workspace");
  const taskId = "reuse-task";
  const runId = "reuse-run";
  await mkdir(join(harnessRoot, "scripts"), { recursive: true });
  const store = new LocalWorkspaceStore(workspaceRoot);
  await store.createTask(taskId);
  await store.createRun(taskId, runId);
  // A live process stands in for the Main a previous supervisor started.
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const { readProcessIdentity } = await import("../dist/src/runtime/process-identity.js");
  const { agentProcessRecordPath } = await import("../dist/src/runtime/agent-process.js");
  const identity = await readProcessIdentity(holder.pid);
  assert.ok(identity);
  const recordPath = agentProcessRecordPath(workspaceRoot, taskId, runId, "main", "main");
  await mkdir(join(recordPath, ".."), { recursive: true });
  await writeFile(
    recordPath,
    JSON.stringify({
      version: 1,
      taskId,
      runId,
      callId: runId,
      agentId: "main",
      role: "main",
      pid: holder.pid,
      host: hostname(),
      startedAt: identity.startedAt,
      token: "reuse",
      launchedAt: new Date().toISOString(),
      workingDirectory: harnessRoot,
      sessionDirectory: join(workspaceRoot, taskId, "sessions", "main", "pi"),
      resultPath: join(recordPath, "..", "process-result.json"),
      stdoutPath: join(recordPath, "..", "agent-output.log"),
      stderrPath: join(recordPath, "..", "agent-stderr.log")
    })
  );
  t.after(async () => {
    try {
      holder.kill("SIGKILL");
    } catch {
      /* the holder already exited */
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // A short-lived host is exactly what the CLI recovery loop is: it decides
  // whether a Main exists and exits. A polling observer it keeps for a process
  // it did not start would hold that process open forever.
  const script = [
    `import { spawnMainProcess } from ${JSON.stringify(
      pathToFileURL(resolve("dist/src/runtime/main-supervisor.js")).href
    )};`,
    `const record = await spawnMainProcess({`,
    `  taskId: ${JSON.stringify(taskId)},`,
    `  runId: ${JSON.stringify(runId)},`,
    `  harnessRoot: ${JSON.stringify(harnessRoot)},`,
    `  workspaceRoot: ${JSON.stringify(workspaceRoot)}`,
    `});`,
    `if (!record || record.pid !== ${holder.pid}) {`,
    `  console.error("expected the live record, got", record && record.pid);`,
    `  process.exit(2);`,
    `}`
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: resolve("."),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  const outcome = await Promise.race([
    once(child, "exit").then(([code]) => code),
    delay(8_000).then(() => "timeout")
  ]);
  if (outcome === "timeout") child.kill("SIGKILL");
  assert.notEqual(outcome, "timeout", `the recovery host stayed alive: ${output}`);
  assert.equal(outcome, 0, output);
});
