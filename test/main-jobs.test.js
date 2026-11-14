import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";

const extensionPath = resolve(".pi/extensions/cowork.ts");
const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const TASK = "jobs-task";
const RUN = "main-jobs";

function fakePi() {
  const tools = new Map();
  const handlers = new Map();
  const sent = [];
  return {
    tools,
    sent,
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerProvider() {},
    registerCommand() {},
    getActiveTools() {
      return [...tools.keys()];
    },
    setActiveTools() {},
    sendMessage(message, options) {
      sent.push({ ...message, options });
    },
    handlers
  };
}

async function loadExtension() {
  const { createJiti } = await import(requirePi.resolve("jiti"));
  const jiti = createJiti(pathToFileURL(extensionPath).href, { interopDefault: true });
  const module = await jiti.import(extensionPath, { default: true });
  return module.default ?? module;
}

const keys = [
  "COWORK_CONFIG",
  "COWORK_WORKSPACE",
  "COWORK_PROJECT_DIR",
  "COWORK_TASK_ID",
  "COWORK_RUN_ID",
  "COWORK_API_BASE",
  "COWORK_API_KEY"
];

/** The extension's runtime-state writes are fire-and-forget; let them land. */
async function removeAfterAsyncWrites(path) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "ENOTEMPTY" && error?.code !== "EBUSY") throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  await rm(path, { recursive: true, force: true });
}

/** Build a Task whose capabilities are whatever this test needs. */
async function harness(t, capabilities) {
  const root = await mkdtemp(join(tmpdir(), "atria-main-jobs-"));
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    COWORK_CONFIG: join(root, "config.json"),
    COWORK_WORKSPACE: root,
    COWORK_PROJECT_DIR: root,
    COWORK_TASK_ID: TASK,
    COWORK_RUN_ID: RUN
  });
  await writeFile(process.env.COWORK_CONFIG, "{}\n");
  delete process.env.COWORK_API_BASE;
  delete process.env.COWORK_API_KEY;
  const store = new LocalWorkspaceStore(root);
  await store.createTask(TASK, { goal: "run long work" });
  await store.createRun(TASK, RUN);
  if (capabilities) await store.updateTask(TASK, { capabilities });
  const pi = fakePi();
  (await loadExtension())(pi);
  t.after(async () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await removeAfterAsyncWrites(root);
  });
  const ctx = {
    sessionManager: {
      getSessionId: () => "jobs-session",
      getSessionFile: () => undefined,
      getEntries: () => []
    },
    isProjectTrusted: () => false,
    ui: { notify() {}, setStatus() {} },
    signal: new AbortController().signal,
    hasPendingMessages: () => false,
    isIdle: () => true
  };
  const call = (name, args = {}) => pi.tools.get(name).execute(name, args, undefined, undefined, ctx);
  const details = async (name, args) => (await call(name, args)).details;
  /**
   * Poll until the job is gone AND its outcome is recorded.
   *
   * Liveness comes from the pid, but the exit code is written by the spawning
   * process's exit handler, so a job can read as exited a tick before its code
   * lands. Tests that assert on the code have to wait for the record, not just
   * the process.
   *
   * The budget is generous because these are real subprocesses: on a loaded
   * machine the first spawn after a cold build can take seconds, and a timeout
   * here would read as a product bug rather than a busy CI box.
   */
  async function settled(jobId) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const status = await details("check_job", { jobId });
      if (status.state === "exited" && (status.exitCode !== undefined || status.signal !== undefined))
        return status;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    }
    throw new Error("job did not exit");
  }
  return { root, store, pi, ctx, call, details, settled };
}

test("job tools are registered for Main and refuse work until long work is granted", async (t) => {
  const h = await harness(t);
  for (const name of ["start_job", "check_job", "kill_job"]) {
    assert.ok(h.pi.tools.has(name), `${name} must be registered for Main`);
  }
  const refused = await h.call("start_job", { command: "echo hello" });
  assert.equal(refused.isError, true);
  assert.equal(refused.details.reason, "capability_required");
  assert.match(refused.details.note, /grant_capabilities/);

  // The grant has to work on the next call, not the next process: the tools
  // read capabilities per call for the same reason the write guard does.
  await h.store.updateTask(TASK, {
    capabilities: { longRunning: true, grantedBy: "user", grantedAt: new Date().toISOString() }
  });
  const started = await h.details("start_job", { command: "echo granted" });
  assert.ok(started.jobId, "a granted Task must be able to start a job");
  assert.equal((await h.settled(started.jobId)).exitCode, 0);
});

test("a Main job records its output and reports quiet time while it runs", async (t) => {
  const h = await harness(t, { longRunning: true, grantedBy: "user", grantedAt: new Date().toISOString() });
  const started = await h.details("start_job", { command: "echo first; sleep 0.6; echo second" });
  const running = await h.details("check_job", { jobId: started.jobId });
  assert.equal(running.state, "running");
  assert.equal(typeof running.quietMs, "number", "quiet time is the evidence a fixed timeout cannot provide");

  const listed = await h.details("check_job");
  assert.equal(listed.jobs.length, 1);
  assert.equal(listed.jobs[0].jobId, started.jobId);

  const done = await h.settled(started.jobId);
  assert.equal(done.exitCode, 0);
  assert.match(await readFile(done.logPath, "utf8"), /second/);
  // Main's jobs stay under its own Run rather than in the Subagent tree.
  assert.match(done.logPath, /agents[/\\]main[/\\]jobs/);
});

test("Main can recover from a job startup error without leaving a completion blocker", async (t) => {
  const h = await harness(t, { longRunning: true, grantedBy: "user", grantedAt: new Date().toISOString() });
  await assert.rejects(
    () => h.call("start_job", { command: "echo unused", cwd: join(h.root, "missing") }),
    /Failed to start job job-1.*ENOENT/
  );
  const failed = await h.details("check_job", { jobId: "job-1" });
  assert.equal(failed.state, "exited");
  assert.match(failed.spawnError, /ENOENT/);
  const next = await h.details("start_job", { command: "echo recovered" });
  assert.equal(next.jobId, "job-2");
  assert.equal((await h.settled(next.jobId)).exitCode, 0);
  assert.equal((await h.details("finish_task", {})).completed, true);
});

test("an unfinished job blocks completion and its exit wakes Main through the Inbox", async (t) => {
  const h = await harness(t, { longRunning: true, grantedBy: "user", grantedAt: new Date().toISOString() });
  const started = await h.details("start_job", { command: "sleep 0.5; echo done" });

  const early = await h.details("finish_task", {});
  assert.equal(early.completed, false);
  assert.equal(early.reason, "pending_jobs", "a running job is outstanding work, not a finished Task");

  await h.settled(started.jobId);
  // finish_task polls jobs, which is also where a finished job is queued.
  const completed = await h.details("finish_task", {});
  assert.equal(completed.completed, true);

  const queued = await new InboxStore(
    join(h.root, TASK, "runs", RUN, "agents", "main", "inbox-store.json")
  ).list("main");
  const wake = queued.filter((message) => message.payload?.type === "job.finished");
  assert.equal(wake.length, 1, "a finished job must wake Main exactly once");
  assert.equal(wake[0].messageId, `job-finished-${started.jobId}`);
  assert.equal(wake[0].payload.exitCode, 0);
  assert.match(wake[0].payload.tail, /done/);
});

test("killing a Main job stops it and releases the completion gate", async (t) => {
  const h = await harness(t, { longRunning: true, grantedBy: "user", grantedAt: new Date().toISOString() });
  const started = await h.details("start_job", { command: "sleep 30" });
  assert.equal((await h.details("finish_task", {})).reason, "pending_jobs");

  const killed = await h.details("kill_job", { jobId: started.jobId });
  assert.equal(killed.state, "exited");
  assert.equal((await h.details("finish_task", {})).completed, true);
});

test("Main stays alive while a job runs and settles once it exits", async (t) => {
  const h = await harness(t, { longRunning: true, grantedBy: "user", grantedAt: new Date().toISOString() });
  await h.details("start_job", { command: "sleep 0.6" });
  let ended = false;
  const ending = h.pi.handlers
    .get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop", content: "waiting" }] }, h.ctx)
    .then(() => {
      ended = true;
    });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  assert.equal(ended, false, "Main must not settle while its own job is still running");
  await ending;
  assert.equal(ended, true);
});
