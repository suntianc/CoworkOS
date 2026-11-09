import { access, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { atriaDataPaths } from "./data-home.cjs";
import { capacityReceipt, openMainCapacityGate } from "./main-capacity-gate.mjs";

// A small independent wake worker for long-running Tasks. It does not make
// semantic decisions: it only starts a resumable Main session when durable
// Inbox messages or an interrupted Main checkpoint require attention.
const args = parseArgs(process.argv.slice(2));
const workspaceRoot = resolve(args.workspace ?? atriaDataPaths().workspaceRoot);
const taskId = args.task ?? process.env.COWORK_TASK_ID;
if (!taskId) fail("main-worker 需要 --task <id>");
const pollMs = Math.max(1_000, number(args["poll-ms"], 5_000));
const once = args.once === "true";
const taskRoot = join(workspaceRoot, taskId);
const lockPath = join(taskRoot, "agents", "main", "main-worker.lock");
await mkdir(join(taskRoot, "agents", "main"), { recursive: true });
const lock = await acquireLock(lockPath);
if (!lock) {
  console.log(JSON.stringify({ started: false, reason: "main_worker_already_running", taskId }));
  process.exit(0);
}
// The same external Main budget the Dashboard applies: an exhausted service
// leaves this wake to the program's queue instead of spawning a Main of its own.
let capacity;
try {
  capacity = await openMainCapacityGate({ taskId, cwd: process.cwd() });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const WAKE_PROMPT = "Resume this Task from durable memory and process pending Inbox messages.";

let stopped = false;
const stop = () => {
  stopped = true;
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  while (!stopped) {
    const wake = await readWakeState(taskRoot);
    if (wake.shouldWake) {
      const runId = wake.runId ?? process.env.COWORK_RUN_ID ?? `main-${taskId}`;
      const external = capacity?.external;
      let admission;
      try {
        admission = external
          ? await capacity.admit({
              projectId: external.projectId,
              sessionId: external.sessionId,
              taskId,
              kind: external.kind,
              runId,
              resume: true,
              prompt: WAKE_PROMPT,
              origin: "worker",
              queueWhenFull: true
            })
          : undefined;
      } catch (error) {
        // A different input already owns this Task: report it instead of
        // starting a second Main or crashing the worker.
        if (error?.code !== "main_capacity_conflict") throw error;
        console.log(
          JSON.stringify({
            started: false,
            taskId,
            reason: "main_capacity_conflict",
            error: error.message
          })
        );
        if (once) break;
        await wait(pollMs);
        continue;
      }
      if (admission && admission.state !== "running") {
        console.log(JSON.stringify({ reason: wake.reason, ...capacityReceipt(taskId, admission, runId) }));
        if (once) break;
        await wait(pollMs);
        continue;
      }
      console.log(JSON.stringify({ started: true, taskId, runId, reason: wake.reason }));
      const child = spawn(
        process.execPath,
        [resolve("scripts", "start-pi.mjs"), "--continue", "--print", WAKE_PROMPT],
        {
          cwd: process.cwd(),
          stdio: "inherit",
          env: {
            ...process.env,
            COWORK_CLI_SESSION: "0",
            COWORK_WORKSPACE: workspaceRoot,
            COWORK_TASK_ID: taskId,
            COWORK_RUN_ID: runId,
            // This process already holds the slot; the launcher must not ask twice.
            ...(admission?.state === "running" ? { COWORK_MAIN_CAPACITY_GRANTED: admission.requestId } : {})
          }
        }
      );
      if (admission?.state === "running") await capacity.bindProcess(admission.requestId, child.pid);
      await onceExit(child);
      if (admission?.state === "running") await capacity.release(admission.requestId);
      if (once) break;
    } else if (once) {
      console.log(JSON.stringify({ started: false, taskId, reason: "no_wakeup" }));
      break;
    }
    await wait(pollMs);
  }
} finally {
  await lock.release();
}

async function readWakeState(root) {
  const task = await readJson(join(root, "task.json"), {});
  const runId = typeof task.activeRunId === "string" ? task.activeRunId : undefined;
  const inbox = runId
    ? await readJson(join(root, "runs", runId, "agents", "main", "inbox-store.json"), [])
    : [];
  const ready = Array.isArray(inbox) && inbox.some((message) => message?.state === "ready");
  let interrupted = false;
  if (runId) {
    const checkpoint = await readJson(join(root, "runs", runId, "checkpoint.json"), {});
    interrupted =
      checkpoint?.state?.status === "running" && task?.status !== "completed" && task?.status !== "cancelled";
  }
  return {
    runId,
    shouldWake: ready || interrupted,
    reason: ready ? "inbox_message" : interrupted ? "interrupted_main_checkpoint" : undefined
  };
}

async function acquireLock(path) {
  try {
    const handle = await open(path, "wx");
    await writeFile(path, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    return {
      release: async () => {
        await handle.close();
        // eslint-disable-next-line no-restricted-syntax -- 释放锁时删除锁文件是尽力清理，残留文件会被下次启动的陈旧锁判定接管
        await unlink(path).catch(() => {});
      }
    };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      const previous = JSON.parse(await readFile(path, "utf8"));
      if (Number.isInteger(previous?.pid)) process.kill(previous.pid, 0);
      return undefined;
    } catch (stale) {
      if (stale?.code !== "ESRCH" && stale?.code !== "ENOENT") return undefined;
      // eslint-disable-next-line no-restricted-syntax -- 清理陈旧锁失败时递归重取会按 EEXIST 返回未取到锁，不会误判为已持有
      await unlink(path).catch(() => {});
      return acquireLock(path);
    }
  }
}

function onceExit(child) {
  return new Promise((resolvePromise) => child.once("exit", resolvePromise));
}

function parseArgs(input) {
  const result = {};
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = input[index + 1];
    result[key] = next && !next.startsWith("--") ? ((index += 1), next) : "true";
  }
  return result;
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
function fail(message) {
  console.error(`main-worker: ${message}`);
  process.exit(1);
}
