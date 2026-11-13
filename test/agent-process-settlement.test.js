import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AgentProcessHost } from "../dist/src/runtime/agent-process.js";

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
