import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DurableScheduler } from "../dist/src/runtime/scheduler.js";
import { SubagentProcessService } from "../dist/src/runtime/subagent-processes.js";
import { isolatedPiEnvironment, startLocalProvider } from "./fixtures/pi-process-fixture.mjs";

const harness = resolve(".");
const TASK_ID = "p46-subagent-task";
const RUN_ID = "p46-subagent-run";

/** Wait for an observable condition instead of guessing a fixed delay. */
async function waitFor(check, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(25);
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** A fresh Task/Run workspace and a work site the subagent must actually enter. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "p46-subagent-process-"));
  const workspace = join(root, "workspace");
  const site = join(root, "work-item-site");
  await mkdir(workspace, { recursive: true });
  await mkdir(site, { recursive: true });
  await writeFile(join(site, "SITE_MARKER.txt"), "the delegated site\n");
  const runRoot = join(workspace, TASK_ID, "runs", RUN_ID);
  const processes = [];
  t.after(async () => {
    for (const child of processes) await stopProcess(child);
    for (const record of await recordedProcesses(workspace)) {
      if (!groupAlive(record.pid) || !(await sameProcess(record.pid, record.startedAt))) continue;
      try {
        process.kill(-record.pid, "SIGKILL");
      } catch {
        /* the group already exited */
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspace, site, runRoot, processes };
}

async function recordedProcesses(workspace) {
  const records = [];
  for (const entry of await readdir(join(workspace, TASK_ID, "runs", RUN_ID, "agents", "subagents"), {
    withFileTypes: true
  }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const record = await readJson(
      join(workspace, TASK_ID, "runs", RUN_ID, "agents", "subagents", entry.name, "process.json"),
      undefined
    );
    if (record?.pid) records.push(record);
  }
  return records;
}

/** Never signal a pid another program has taken over since the record was written. */
async function sameProcess(pid, startedAt) {
  const child = spawn("ps", ["-p", String(pid), "-o", "lstart="], {
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, LC_ALL: "C", LANG: "C" }
  });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (out += chunk));
  await once(child, "close");
  return out.trim() === startedAt;
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "close");
  child.kill("SIGTERM");
  const timeout = new AbortController();
  try {
    await Promise.race([exited, delay(5_000, undefined, { signal: timeout.signal })]);
  } finally {
    timeout.abort();
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await exited;
}

/** Start the real backend: the worker command owns delegated process execution. */
function startBackend(f, provider) {
  const env = isolatedPiEnvironment({
    HOME: f.root,
    TMPDIR: f.root,
    ATRIA_HOME: join(f.root, "home"),
    COWORK_CONFIG: join(f.root, "config.json"),
    COWORK_CONFIG_ROOT: f.root,
    COWORK_HARNESS_ROOT: harness,
    COWORK_WORKSPACE: f.workspace,
    COWORK_DISABLE_MAIN_GUARDIAN: "1",
    COWORK_API_BASE: provider.baseUrl,
    COWORK_API_KEY: "fixture-key",
    COWORK_MODEL: "p46-subagent-model",
    COWORK_MODEL_API: "openai-completions",
    COWORK_REASONING_EFFORT: "off",
    PI_CODING_AGENT_DIR: join(f.root, "pi"),
    PI_OFFLINE: "1"
  });
  const child = spawn(
    process.execPath,
    [
      join(harness, "dist", "src", "cli", "cowork.js"),
      "worker",
      "--task",
      TASK_ID,
      "--run",
      RUN_ID,
      "--poll-ms",
      "100",
      "--lease-ms",
      "5000"
    ],
    { cwd: f.root, env, stdio: ["ignore", "pipe", "pipe"] }
  );
  let output = "";
  const record = (chunk) => {
    output = `${output}${chunk}`.slice(-4_000);
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  f.processes.push(child);
  return { child, getOutput: () => output };
}

async function queueCall(f, { callId, agentId, task, site }) {
  const scheduler = new DurableScheduler(join(f.runRoot, "queue.json"));
  await scheduler.enqueue({
    stepId: callId,
    taskId: TASK_ID,
    runId: RUN_ID,
    agentId,
    importance: "normal",
    payload: {
      task,
      projectDirectory: site,
      delegation: { role: "executor" }
    },
    maxAttempts: 1
  });
  return scheduler;
}

function recordPath(f, agentId) {
  return join(f.runRoot, "agents", "subagents", agentId, "process.json");
}

async function waitForRecord(f, agentId) {
  return waitFor(async () => {
    const record = await readJson(recordPath(f, agentId), undefined);
    return record?.pid ? record : undefined;
  }, `${agentId} process record`);
}

async function callbacks(f, callId) {
  const messages = await readJson(join(f.runRoot, "agents", "main", "inbox-store.json"), []);
  return messages.filter((message) => message.callId === callId && message.kind === "callback");
}

async function waitForCallback(f, callId) {
  return waitFor(async () => {
    const found = await callbacks(f, callId);
    return found.length > 0 ? found : undefined;
  }, `${callId} callback`);
}

async function queueItems(f) {
  return readJson(join(f.runRoot, "queue.json"), []);
}

/** A gate the test releases when the model turn should continue. */
function gate() {
  let release;
  const opened = new Promise((resolveGate) => {
    release = resolveGate;
  });
  return { opened, release: () => release() };
}

test(
  "the backend runs a delegated call as a real Pi process in its work site and reports one callback",
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t);
    const turn = gate();
    const provider = await startLocalProvider({
      model: "p46-subagent-model",
      handle: async (_body, requests) => {
        if (requests.length === 1) {
          await turn.opened;
          return { name: "bash", arguments: { command: "pwd" } };
        }
        return { text: "P46_SUBAGENT_DONE" };
      }
    });
    t.after(() => provider.close());
    await writeFile(
      join(f.root, "config.json"),
      JSON.stringify({
        api: "openai-completions",
        baseUrl: provider.baseUrl,
        apiKey: "fixture-key",
        model: "p46-subagent-model"
      })
    );
    const callId = "call-p46-real-process";
    await queueCall(f, { callId, agentId: "subagent_1", task: "报告当前工作目录", site: f.site });
    const backend = startBackend(f, provider);

    await waitFor(() => provider.requests.length === 1, "the delegated model request");
    const record = await waitForRecord(f, "subagent_1");
    assert.equal(alive(record.pid), true, "the delegated process is running");
    assert.notEqual(record.pid, backend.child.pid, "the work runs in its own process, not the backend");
    const command = await readFile(`/proc/${record.pid}/cmdline`, "utf8").catch(() => "");
    const listed = command.split("\0").join(" ");
    assert.match(
      listed || (await psCommand(record.pid)),
      /start-pi\.mjs/,
      "the delegated process is the shared Pi launcher"
    );
    turn.release();

    const [callback] = await waitForCallback(f, callId);
    await waitFor(async () => (await callbacks(f, callId)).length === 1, "exactly one callback", 5_000);
    assert.equal(callback.payload.status, "succeeded", JSON.stringify(callback.payload));
    assert.match(callback.payload.response, /P46_SUBAGENT_DONE/);
    assert.equal((await callbacks(f, callId)).length, 1, "Main receives one callback for one delegated call");

    const toolResult = provider.requests[1].messages.findLast((message) => message.role === "tool");
    assert.match(
      String(toolResult?.content ?? ""),
      new RegExp(escapeRegExp(f.site)),
      "the process ran its turn inside the work site"
    );

    const result = JSON.parse(
      await readFile(join(f.runRoot, "agents", "subagents", "subagent_1", "result.json"), "utf8")
    );
    assert.equal(result.termination, "completed");
    assert.equal(result.response, "P46_SUBAGENT_DONE");
    assert.deepEqual(result.diagnostics, {
      tracePath: `sessions/subagent_1/pi/${callId}`,
      resultPath: `runs/${RUN_ID}/agents/subagents/subagent_1/result.json`
    });
    const sessions = await readdir(join(f.workspace, TASK_ID, "sessions", "subagent_1", "pi", callId), {
      recursive: true
    });
    assert.ok(
      sessions.some((entry) => entry.endsWith(".jsonl")),
      "the call's transcript is stored by callId"
    );
    assert.equal((await queueItems(f)).find((item) => item.stepId === callId).status, "completed");
  }
);

async function psCommand(pid) {
  const child = spawn("ps", ["-p", String(pid), "-o", "command="], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (out += chunk));
  await once(child, "close");
  return out;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test(
  "restarting the backend adopts the running subagent and still delivers exactly one callback",
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t);
    const turn = gate();
    const provider = await startLocalProvider({
      model: "p46-subagent-model",
      handle: async (_body, requests) => {
        if (requests.length === 1) {
          await turn.opened;
          return { text: "P46_RESTART_DONE" };
        }
        return { text: "P46_RESTART_DONE" };
      }
    });
    t.after(() => provider.close());
    await writeFile(
      join(f.root, "config.json"),
      JSON.stringify({
        api: "openai-completions",
        baseUrl: provider.baseUrl,
        apiKey: "fixture-key",
        model: "p46-subagent-model"
      })
    );
    const callId = "call-p46-restart";
    await queueCall(f, { callId, agentId: "subagent_2", task: "等待后端重启", site: f.site });
    const first = startBackend(f, provider);
    await waitFor(() => provider.requests.length === 1, "the first delegated request");
    const record = await waitForRecord(f, "subagent_2");
    const pid = record.pid;

    await stopProcess(first.child);
    assert.equal(alive(pid), true, "the subagent outlives the backend that started it");

    startBackend(f, provider);
    await waitFor(async () => {
      const current = await readJson(recordPath(f, "subagent_2"), undefined);
      return current?.pid === pid && current.launchedAt === record.launchedAt;
    }, "the restarted backend adopts the same process");
    assert.equal(alive(pid), true, "adoption did not restart the subagent");
    turn.release();

    const [callback] = await waitForCallback(f, callId);
    await waitFor(async () => {
      const items = await queueItems(f);
      return items.find((item) => item.stepId === callId)?.status === "completed";
    }, "the adopted call to settle");
    assert.equal(callback.payload.status, "succeeded", JSON.stringify(callback.payload));
    assert.match(callback.payload.response, /P46_RESTART_DONE/);
    assert.equal((await callbacks(f, callId)).length, 1, "restart must not add a second callback");
    const settled = await waitFor(async () => {
      const current = await readJson(recordPath(f, "subagent_2"), undefined);
      return current?.settledAt ? current : undefined;
    }, "the adopted record to settle");
    assert.equal(settled.pid, pid, "the pre-restart identity is the one that was adopted");
  }
);

test(
  "a subagent that ends while the backend is down is notified once on restart",
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t);
    const turn = gate();
    const provider = await startLocalProvider({
      model: "p46-subagent-model",
      handle: async (_body, requests) => {
        if (requests.length === 1) {
          await turn.opened;
          return { text: "P46_OFFLINE_DONE" };
        }
        return { text: "P46_OFFLINE_DONE" };
      }
    });
    t.after(() => provider.close());
    await writeFile(
      join(f.root, "config.json"),
      JSON.stringify({
        api: "openai-completions",
        baseUrl: provider.baseUrl,
        apiKey: "fixture-key",
        model: "p46-subagent-model"
      })
    );
    const callId = "call-p46-offline";
    await queueCall(f, { callId, agentId: "subagent_3", task: "后端停机期间完成", site: f.site });
    const first = startBackend(f, provider);
    await waitFor(() => provider.requests.length === 1, "the delegated request");
    const record = await waitForRecord(f, "subagent_3");
    await stopProcess(first.child);
    turn.release();
    await waitFor(() => !alive(record.pid), "the subagent to finish while no backend watches");
    await waitFor(
      async () =>
        (await readJson(join(f.runRoot, "agents", "subagents", "subagent_3", "result.json"), undefined))
          ?.termination === "completed",
      "the subagent result record"
    );
    assert.equal((await callbacks(f, callId)).length, 0, "no backend was running to write a callback");

    startBackend(f, provider);
    const [callback] = await waitForCallback(f, callId);
    assert.equal(callback.payload.status, "succeeded", JSON.stringify(callback.payload));
    await waitFor(async () => {
      const items = await queueItems(f);
      return items.find((item) => item.stepId === callId)?.status === "completed";
    }, "the missed call to settle on restart");
    assert.equal(
      (await callbacks(f, callId)).length,
      1,
      "the downtime callback is delivered once, not repeatedly"
    );
  }
);

test(
  "an exit without a result record is a failure and a reused pid is not mistaken for the subagent",
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t);
    const turn = gate();
    const provider = await startLocalProvider({
      model: "p46-subagent-model",
      handle: async (_body, requests) => {
        if (requests.length === 1) {
          await turn.opened;
          return { text: "never reached" };
        }
        return { text: "never reached" };
      }
    });
    t.after(() => provider.close());
    await writeFile(
      join(f.root, "config.json"),
      JSON.stringify({
        api: "openai-completions",
        baseUrl: provider.baseUrl,
        apiKey: "fixture-key",
        model: "p46-subagent-model"
      })
    );

    // A; an abnormal exit before the extension writes a result record.
    const abnormal = "call-p46-abnormal";
    await queueCall(f, { callId: abnormal, agentId: "subagent_4", task: "异常退出", site: f.site });
    startBackend(f, provider);
    await waitFor(() => provider.requests.length === 1, "the abnormal call request");
    const running = await waitForRecord(f, "subagent_4");
    try {
      process.kill(-running.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    const [abnormalCallback] = await waitForCallback(f, abnormal);
    assert.equal(abnormalCallback.payload.status, "failed");
    assert.match(abnormalCallback.payload.error, /result record/i);
    assert.equal(
      (await queueItems(f)).find((item) => item.stepId === abnormal).status,
      "failed",
      "an abnormal exit is a terminal failure, not a silent retry"
    );
    turn.release();

    // B; a live pid that is not the recorded process must not be adopted.
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      detached: true,
      stdio: "ignore"
    });
    f.processes.push(sleeper);
    const lease = "call-p46-reused-pid";
    const scheduler = await queueCall(f, {
      callId: lease,
      agentId: "subagent_5",
      task: "PID 复用",
      site: f.site
    });
    const claimed = await scheduler.claim("fixture", 60_000, lease);
    const stale = {
      version: 1,
      taskId: TASK_ID,
      runId: RUN_ID,
      callId: lease,
      agentId: "subagent_5",
      role: "executor",
      pid: sleeper.pid,
      host: hostname(),
      startedAt: "Mon Jan  1 00:00:00 2001",
      token: "stale-token",
      launchedAt: new Date(0).toISOString(),
      workingDirectory: f.site,
      sessionDirectory: join(f.workspace, TASK_ID, "sessions", "subagent_5", "pi", lease),
      resultPath: join(f.runRoot, "agents", "subagents", "subagent_5", "result.json"),
      stdoutPath: join(f.runRoot, "agents", "subagents", "subagent_5", "agent-output.log"),
      stderrPath: join(f.runRoot, "agents", "subagents", "subagent_5", "agent-stderr.log"),
      leaseToken: claimed.lease.token
    };
    await mkdir(join(f.runRoot, "agents", "subagents", "subagent_5"), { recursive: true });
    await writeFile(recordPath(f, "subagent_5"), JSON.stringify(stale));

    // The running backend's next adoption pass must settle it, not trust the pid.
    const service = new SubagentProcessService({
      workspaceRoot: f.workspace,
      harnessRoot: harness,
      env: {},
      pollMs: 50
    });
    try {
      await service.adopt({ taskId: TASK_ID, runId: RUN_ID });
      await service.maintain({ taskId: TASK_ID, runId: RUN_ID });
    } finally {
      service.close();
    }
    const [reusedCallback] = await waitForCallback(f, lease);
    assert.equal(reusedCallback.payload.status, "failed");
    assert.equal(alive(sleeper.pid), true, "an unrelated process with the same pid is left alone");
    assert.ok(
      (await readJson(recordPath(f, "subagent_5"), undefined)).settledAt,
      "the stale record is settled rather than adopted"
    );
  }
);

test(
  "stopping a subagent ends its whole process group and records a cancelled callback",
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t);
    const turn = gate();
    const provider = await startLocalProvider({
      model: "p46-subagent-model",
      handle: async (_body, requests) => {
        if (requests.length === 1) {
          await turn.opened;
          return { text: "never reached" };
        }
        return { text: "never reached" };
      }
    });
    t.after(() => provider.close());
    await writeFile(
      join(f.root, "config.json"),
      JSON.stringify({
        api: "openai-completions",
        baseUrl: provider.baseUrl,
        apiKey: "fixture-key",
        model: "p46-subagent-model"
      })
    );
    const callId = "call-p46-cancel";
    await queueCall(f, { callId, agentId: "subagent_6", task: "取消", site: f.site });
    startBackend(f, provider);
    await waitFor(() => provider.requests.length === 1, "the cancelled call request");
    const record = await waitForRecord(f, "subagent_6");
    const pid = record.pid;
    assert.equal(groupAlive(pid), true, "the delegated process group is running");

    // The stop is a backend action; the test issues it through the same service API.
    const service = new SubagentProcessService({
      workspaceRoot: f.workspace,
      harnessRoot: harness,
      env: {},
      pollMs: 50
    });
    try {
      await service.stop({ taskId: TASK_ID, runId: RUN_ID, callId });
    } finally {
      service.close();
    }
    turn.release();

    await waitFor(() => !alive(pid), "the stopped process to exit");
    assert.equal(groupAlive(pid), false, "the whole process group exited, not just the launcher");
    const [callback] = await waitForCallback(f, callId);
    assert.equal(callback.payload.status, "cancelled", JSON.stringify(callback.payload));
    await waitFor(async () => {
      const items = await queueItems(f);
      return items.find((item) => item.stepId === callId)?.status === "cancelled";
    }, "the cancelled call to settle");
    assert.equal((await callbacks(f, callId)).length, 1, "cancellation reports one callback");
  }
);

/** Spawn a live detached process-group leader the fixture never launched. */
function unrelatedGroup(f) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  f.processes.push(child);
  return child;
}

/** Write the durable record a previous backend would have left behind. */
async function writeStaleRecord(f, { callId, agentId, pid, host, startedAt, leaseToken }) {
  const directory = join(f.runRoot, "agents", "subagents", agentId);
  const sessionDirectory = join(f.workspace, TASK_ID, "sessions", agentId, "pi", callId);
  await mkdir(directory, { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    join(directory, "process.json"),
    JSON.stringify({
      version: 1,
      taskId: TASK_ID,
      runId: RUN_ID,
      callId,
      agentId,
      role: "executor",
      pid,
      host,
      startedAt,
      token: `stale-${callId}`,
      launchedAt: new Date(0).toISOString(),
      workingDirectory: f.site,
      sessionDirectory,
      resultPath: join(directory, "result.json"),
      stdoutPath: join(directory, "agent-output.log"),
      stderrPath: join(directory, "agent-stderr.log"),
      leaseToken
    })
  );
}

test(
  "stopping a record whose identity no longer matches never signals the pid's new owner",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const reusedPid = unrelatedGroup(f);
    const foreignHost = unrelatedGroup(f);
    await waitFor(
      () => reusedPid.pid && groupAlive(reusedPid.pid) && foreignHost.pid && groupAlive(foreignHost.pid),
      "the unrelated process groups"
    );
    const cases = [
      {
        callId: "call-p46-stale-identity",
        agentId: "subagent_7",
        child: reusedPid,
        host: hostname(),
        startedAt: "Thu Jan  1 00:00:01 1970"
      },
      {
        callId: "call-p46-stale-host",
        agentId: "subagent_8",
        child: foreignHost,
        host: "a-different-host",
        startedAt: "Thu Jan  1 00:00:01 1970"
      }
    ];
    for (const entry of cases) {
      const scheduler = await queueCall(f, {
        callId: entry.callId,
        agentId: entry.agentId,
        task: "stale process record",
        site: f.site
      });
      const claimed = await scheduler.claim("fixture", 60_000, entry.callId);
      await writeStaleRecord(f, {
        callId: entry.callId,
        agentId: entry.agentId,
        pid: entry.child.pid,
        host: entry.host,
        startedAt: entry.startedAt,
        leaseToken: claimed.lease.token
      });
    }

    const service = new SubagentProcessService({
      workspaceRoot: f.workspace,
      harnessRoot: harness,
      env: {},
      pollMs: 50,
      graceMs: 200
    });
    try {
      for (const entry of cases) {
        const result = await service.stop({ taskId: TASK_ID, runId: RUN_ID, callId: entry.callId });
        assert.equal(
          groupAlive(entry.child.pid),
          true,
          `stopping a stale record must not signal the unrelated group ${entry.child.pid}`
        );
        assert.equal(
          result?.status,
          "failed",
          `a record with no result is settled as ended, not cancelled (${entry.callId})`
        );
      }
    } finally {
      service.close();
    }

    for (const entry of cases) {
      assert.equal(
        groupAlive(entry.child.pid),
        true,
        `the unrelated process group ${entry.child.pid} must not be signalled`
      );
      assert.equal(alive(entry.child.pid), true, "the unrelated group leader is still running");
    }
    const items = await queueItems(f);
    for (const entry of cases) {
      assert.equal(items.find((item) => item.stepId === entry.callId).status, "failed");
      const [callback] = await callbacks(f, entry.callId);
      assert.equal(callback.payload.status, "failed", JSON.stringify(callback.payload));
    }
  }
);

test(
  "a launch that cannot start settles the call instead of crashing the backend",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const provider = await startLocalProvider({
      model: "p46-subagent-model",
      handle: () => ({ text: "never reached" })
    });
    t.after(() => provider.close());
    await writeFile(
      join(f.root, "config.json"),
      JSON.stringify({
        api: "openai-completions",
        baseUrl: provider.baseUrl,
        apiKey: "fixture-key",
        model: "p46-subagent-model"
      })
    );
    const callId = "call-p46-missing-site";
    await queueCall(f, {
      callId,
      agentId: "subagent_9",
      task: "launch without a work site",
      site: join(f.root, "missing-work-site")
    });
    const backend = startBackend(f, provider);
    const [callback] = await waitForCallback(f, callId);
    assert.equal(callback.payload.status, "failed", JSON.stringify(callback.payload));
    assert.match(callback.payload.error, /did not start/i);
    assert.equal(
      (await queueItems(f)).find((item) => item.stepId === callId).status,
      "failed",
      "a launch failure is a terminal failure"
    );
    await delay(500);
    assert.equal(backend.child.exitCode, null, "the backend keeps running after the launch failure");
  }
);

test("stopping a call that already finished reports its durable outcome", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const provider = await startLocalProvider({
    model: "p46-subagent-model",
    handle: () => ({ text: "P46_ALREADY_DONE" })
  });
  t.after(() => provider.close());
  await writeFile(
    join(f.root, "config.json"),
    JSON.stringify({
      api: "openai-completions",
      baseUrl: provider.baseUrl,
      apiKey: "fixture-key",
      model: "p46-subagent-model"
    })
  );
  const callId = "call-p46-already-succeeded";
  await queueCall(f, { callId, agentId: "subagent_10", task: "已完成的调用", site: f.site });
  startBackend(f, provider);
  const [callback] = await waitForCallback(f, callId);
  assert.equal(callback.payload.status, "succeeded");
  await waitFor(
    async () => (await queueItems(f)).find((item) => item.stepId === callId)?.status === "completed",
    "the call to finish"
  );
  await waitFor(async () => {
    const record = await readJson(recordPath(f, "subagent_10"), undefined);
    return record?.settledAt ? record : undefined;
  }, "the finished call to settle");

  const service = new SubagentProcessService({
    workspaceRoot: f.workspace,
    harnessRoot: harness,
    env: {},
    pollMs: 50
  });
  try {
    const result = await service.stop({ taskId: TASK_ID, runId: RUN_ID, callId });
    assert.equal(result?.status, "succeeded", "an already-finished call keeps its terminal status");
  } finally {
    service.close();
  }
  const messages = await callbacks(f, callId);
  assert.equal(messages.length, 1, "stopping a finished call does not add or replace its callback");
  assert.equal(messages[0].payload.status, "succeeded");
});

test(
  "a delegated launcher refuses a missing model environment instead of reading the work site",
  { timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p46-subagent-launch-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const site = join(root, "site");
    await mkdir(site, { recursive: true });
    const provider = await startLocalProvider({ handle: () => ({ text: "work site config was used" }) });
    t.after(() => provider.close());
    await writeFile(
      join(site, "config.json"),
      JSON.stringify({
        api: "openai-completions",
        baseUrl: provider.baseUrl,
        apiKey: "site-config-key",
        model: "site-config-model"
      })
    );
    const child = spawn(
      process.execPath,
      [join(harness, "scripts", "start-pi.mjs"), "--print", "--mode", "json"],
      {
        cwd: site,
        env: isolatedPiEnvironment({
          HOME: root,
          TMPDIR: root,
          ATRIA_HOME: join(root, "home"),
          COWORK_CONFIG_ROOT: site,
          COWORK_HARNESS_ROOT: harness,
          COWORK_WORKSPACE: join(root, "workspace"),
          COWORK_TASK_ID: "launcher-task",
          COWORK_RUN_ID: "launcher-run",
          COWORK_AGENT_ROLE: "executor",
          COWORK_AGENT_ID: "subagent_x",
          COWORK_SUBAGENT_CALL_ID: "launcher-call",
          COWORK_SUBAGENT_TOKEN: "launcher-token",
          COWORK_SUBAGENT_RESULT: join(root, "result.json"),
          PI_CODING_AGENT_DIR: join(root, "pi"),
          PI_OFFLINE: "1"
        }),
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    const outcome = await Promise.race([
      once(child, "close").then(([code]) => code),
      delay(20_000).then(() => "timeout")
    ]);
    if (outcome === "timeout") {
      child.kill("SIGKILL");
      assert.fail(`the launcher kept running without model environment: ${output}`);
    }
    assert.notEqual(outcome, 0, `the launcher must refuse to start: ${output}`);
    assert.match(output, /COWORK_API_BASE/, "the error names the missing environment variable");
    assert.equal(
      provider.requests.length,
      0,
      "a config.json inside the work site must never supply model settings"
    );
  }
);
