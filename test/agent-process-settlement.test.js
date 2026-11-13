import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AgentProcessHost, agentProcessRecordPath } from "../dist/src/runtime/agent-process.js";
import { readProcessIdentity } from "../dist/src/runtime/process-identity.js";

/**
 * A process that ends while its own launch is still being written down.
 *
 * The launch records identity and the durable record after spawning, so a
 * child that exits in that window has already emitted its one `close` event
 * before the caller could subscribe. Missing it left the record unsettled
 * forever: the queue lease was renewed for a process nobody would ever hear
 * from again, and a `--once` worker waited on it until it was killed.
 */

async function waitFor(check, label, timeout = 10_000) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= until) throw new Error(`timed out waiting for ${label}`);
    await delay(20);
  }
}

test("a process that exits during launch settles exactly once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-agent-settlement-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  // Exits before the backend finishes reading the pid and writing the record.
  await writeFile(join(root, "scripts", "start-pi.mjs"), "process.exit(0);\n");
  const workspaceRoot = join(root, "workspace");
  const exits = [];
  const host = new AgentProcessHost({
    workspaceRoot,
    harnessRoot: root,
    pollMs: 100,
    graceMs: 500,
    onExit: (record) => {
      exits.push(record);
    }
  });
  t.after(async () => {
    host.close();
    for (const record of exits) {
      try {
        process.kill(-record.pid, "SIGKILL");
      } catch {
        /* the process already exited */
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  for (const callId of ["call-1", "call-2", "call-3"]) {
    exits.length = 0;
    const directory = join(workspaceRoot, "task", "runs", "run", "agents", "subagents", callId);
    const record = await host.launch({
      taskId: "task",
      runId: "run",
      callId,
      agentId: callId,
      role: "executor",
      workingDirectory: root,
      prompt: "this prompt never reaches a process",
      sessionDirectory: join(directory, "sessions"),
      resultPath: join(directory, "result.json"),
      env: {}
    });
    await waitFor(() => exits.length === 1, `${callId} to settle`);
    // A second settlement would project the same call twice.
    await delay(250);
    assert.equal(exits.length, 1, `${callId} settled exactly once`);
    assert.equal(exits[0].pid, record.pid, `${callId} settled the process it started`);
  }
});

test("an exit whose record now describes a newer process is not projected onto it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-agent-replaced-"));
  const workspaceRoot = join(root, "workspace");
  const exits = [];
  const host = new AgentProcessHost({
    workspaceRoot,
    harnessRoot: root,
    pollMs: 100,
    graceMs: 500,
    onExit: (record) => {
      exits.push(record);
    }
  });
  // A live process stands in for the Main a relaunch started for the same Run.
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(async () => {
    host.close();
    try {
      holder.kill("SIGKILL");
    } catch {
      /* the holder already exited */
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const identity = await readProcessIdentity(holder.pid);
  assert.ok(identity);
  const path = agentProcessRecordPath(workspaceRoot, "task", "run", "main", "main");
  await mkdir(join(path, ".."), { recursive: true });
  const common = {
    version: 1,
    taskId: "task",
    runId: "run",
    callId: "run",
    agentId: "main",
    role: "main",
    host: hostname(),
    launchedAt: new Date().toISOString(),
    workingDirectory: root,
    sessionDirectory: join(root, "sessions"),
    resultPath: join(root, "result.json"),
    stdoutPath: join(path, "..", "agent-output.log"),
    stderrPath: join(path, "..", "agent-stderr.log")
  };
  const replaced = { ...common, pid: 2 ** 31 - 1, startedAt: "gone", token: "old" };
  await writeFile(path, JSON.stringify(replaced));
  const newer = { ...common, pid: holder.pid, startedAt: identity.startedAt, token: "new" };
  await writeFile(path, JSON.stringify(newer));

  // The stale record's observer notices it died. Its record path now belongs to
  // the live process, which still owns the Run: projecting the old exit would
  // write a failure for work that is still running.
  await host.stop(replaced);
  await delay(200);
  assert.equal(exits.length, 0, "the replaced process is not projected");
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.equal(stored.pid, holder.pid);
  assert.equal(stored.settledAt, undefined, "the live process's record stays unsettled");
});
