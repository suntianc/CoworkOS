import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DurableScheduler, InboxStore } from "../dist/src/runtime/scheduler.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { SubagentDispatchService } from "../dist/src/runtime/subagent-dispatch.js";
import { createSubagentBackend } from "../dist/src/dashboard/subagent-backend.js";
import { claimSubagentOwnership } from "../dist/src/runtime/subagent-owner.js";
import { LocalAccess } from "../dist/src/dashboard/local-access.js";

const harness = resolve(".");

async function waitFor(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(25);
  }
}

/** A pid that is certainly gone, so a forged lock names a dead owner. */
async function deadPid() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  await once(child, "spawn");
  const pid = child.pid;
  child.kill("SIGKILL");
  await once(child, "exit");
  return pid;
}

/**
 * A lock directory exactly as a SIGKILLed holder leaves it: the owner record is
 * published and its process never releases.
 */
async function forgeAbandonedLock(targetPath, pid) {
  const lockPath = `${targetPath}.lock`;
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    join(lockPath, "owner.json"),
    `${JSON.stringify({ token: "killed-holder", pid, host: hostname(), acquiredAt: new Date().toISOString() })}\n`
  );
}

test(
  "a lock left by a killed process is reclaimed at once instead of stalling readers",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p46-lock-recovery-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new LocalWorkspaceStore(root);
    await store.createTask("task");
    await store.createRun("task", "run");
    const queuePath = join(root, "task", "runs", "run", "queue.json");
    const inboxPath = join(root, "task", "runs", "run", "agents", "main", "inbox-store.json");
    const taskPath = join(root, "task", "task.json");
    await new DurableScheduler(queuePath).enqueue({
      stepId: "call-locked",
      taskId: "task",
      runId: "run",
      agentId: "subagent_1",
      importance: "normal",
      payload: { task: "wait" },
      maxAttempts: 1
    });
    await new InboxStore(inboxPath).enqueue({
      messageId: "message-locked",
      recipientAgentId: "main",
      kind: "callback",
      eventId: "event",
      priority: 1,
      state: "ready",
      payload: {},
      createdAt: new Date().toISOString()
    });

    const pid = await deadPid();
    for (const path of [queuePath, inboxPath, taskPath]) await forgeAbandonedLock(path, pid);

    // Each of these takes the lock a killed Main could have been holding when
    // it died. Waiting for the stale TTL here is what stalled a task detail
    // read past the client's ten-second budget.
    const started = Date.now();
    assert.equal((await new DurableScheduler(queuePath).list()).length, 1);
    assert.equal((await new InboxStore(inboxPath).list("main")).length, 1);
    assert.equal((await store.readTask("task")).taskId, "task");
    // A write, not only a read: the transition takes the same lock.
    await store.transitionTask("task", "running", { runId: "run" });
    assert.ok(Date.now() - started < 10_000, `locks were not reclaimed in time (${Date.now() - started}ms)`);
    for (const path of [queuePath, inboxPath, taskPath]) assert.equal(existsSync(`${path}.lock`), false);
  }
);

test(
  "a refused start never fails a work item another owner already leased",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p46-fail-unstarted-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new LocalWorkspaceStore(root);
    await store.createTask("task");
    await store.createRun("task", "run");
    const queuePath = join(root, "task", "runs", "run", "queue.json");
    const scheduler = new DurableScheduler(queuePath);
    await scheduler.enqueue({
      stepId: "call-raced",
      taskId: "task",
      runId: "run",
      agentId: "subagent_1",
      importance: "normal",
      payload: { task: "raced" },
      maxAttempts: 1
    });
    const claimed = await scheduler.claim("backend-owner", 60_000, "call-raced");
    assert.ok(claimed?.lease);

    // The refused attempt reports its reason, but another owner holds the call:
    // the real settlement is still the outcome.
    const refused = await scheduler.failUnstarted("call-raced", "unable to lease subagent call");
    assert.equal(refused.status, "leased", JSON.stringify(refused));
    assert.equal((await scheduler.list()).find((item) => item.stepId === "call-raced").status, "leased");
    await scheduler.complete("call-raced", claimed.lease.token);
    const settled = (await scheduler.list()).find((item) => item.stepId === "call-raced");
    assert.equal(settled.status, "completed");
    assert.equal(settled.error, undefined, "a completed call keeps no failure reason");
  }
);

test(
  "backend maintenance leaves a work item claimed by another owner to that owner",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p46-recovery-race-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new LocalWorkspaceStore(root);
    await store.createTask("task");
    await store.createRun("task", "run");
    const runRoot = join(root, "task", "runs", "run");
    const scheduler = new DurableScheduler(join(runRoot, "queue.json"));
    await scheduler.enqueue({
      stepId: "call-race",
      taskId: "task",
      runId: "run",
      agentId: "subagent_1",
      importance: "normal",
      payload: { task: "raced between list and claim" },
      maxAttempts: 1
    });

    // The exact window the finding names: recovery lists the item as queued,
    // then the backend claims it before recovery's own claim runs.
    const original = DurableScheduler.prototype.claim;
    let raced = false;
    DurableScheduler.prototype.claim = async function claim(workerId, leaseMs, stepId) {
      if (!raced && stepId === "call-race" && workerId.startsWith("subagent-process-")) {
        raced = true;
        await original.call(this, "backend-owner", 60_000, stepId);
        return undefined;
      }
      return original.call(this, workerId, leaseMs, stepId);
    };
    t.after(() => {
      DurableScheduler.prototype.claim = original;
    });

    const service = new SubagentDispatchService({ workspaceRoot: root, harnessRoot: harness });
    await service.maintain({ taskId: "task", runId: "run" });
    service.close();
    const item = (await scheduler.list()).find((entry) => entry.stepId === "call-race");
    assert.equal(item.status, "leased", "the other owner keeps its lease");
    const events = await readFile(join(runRoot, "run_events.jsonl"), "utf8")
      .then((text) =>
        text
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      )
      .catch(() => []);
    assert.equal(
      events.some((event) => event.type === "run.failed" && event.callId === "call-race"),
      false,
      "no failure is recorded for work another owner is running"
    );
    assert.equal(
      await readFile(join(runRoot, "agents", "main", "inbox-store.json"), "utf8")
        .then((text) => JSON.parse(text).some((message) => message.callId === "call-race"))
        .catch(() => false),
      false,
      "no failure callback is written for it"
    );
  }
);

test(
  "a backend refused by a live owner takes the root once that owner is gone",
  { timeout: 90_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p46-owner-reclaim-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    // A separate process owns the root, as another backend would.
    const owner = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { claimSubagentOwnership } from ${JSON.stringify(join(harness, "dist/src/runtime/subagent-owner.js"))};
         await claimSubagentOwnership(process.argv[1], "dashboard");
         console.log("claimed");
         setInterval(() => {}, 1_000);`,
        root
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    t.after(() => owner.kill("SIGKILL"));
    await once(owner, "spawn");
    await waitFor(
      async () =>
        (await readFile(`${root}/.runtime/subagent-owner.json`, "utf8").catch(() => "")).includes(
          "dashboard"
        ),
      "the other owner's claim"
    );

    const backend = createSubagentBackend({
      projectRoot: harness,
      dashboardUrl: "http://127.0.0.1:1",
      locateTask: async () => {
        throw new Error("not used");
      },
      workspaceRoots: async () => [root],
      config: () => ({}),
      resolveMainModel: () => {
        throw new Error("not used");
      },
      development: async () => undefined,
      frozenCandidate: async () => undefined,
      grants: async () => [],
      refusalRecheckMs: 100
    });
    t.after(() => backend.stop());
    await backend.start();
    assert.equal(backend.ownership(root)?.owned, false, "a live owner is respected");

    owner.kill("SIGKILL");
    await once(owner, "exit");
    await waitFor(() => backend.ownership(root)?.owned === true, "the dead owner's root to be re-claimed");
  }
);

test(
  "the run credential is one atomic 0600 record that survives a restart",
  { timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p46-run-credential-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const first = new LocalAccess(root, () => undefined);
    const credential = first.runCredential();
    assert.match(credential, /^run_[a-f0-9]{64}$/);
    const path = join(root, "run-credential");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await readFile(path, "utf8")).trim(), credential);
    // A later backend process of the same data root presents the same
    // credential, which is what keeps an adopted Main authorized.
    assert.equal(new LocalAccess(root, () => undefined).runCredential(), credential);
    const leftovers = (await readFile(join(root, "run-credential"), "utf8")).length;
    assert.ok(leftovers > 0);
  }
);
