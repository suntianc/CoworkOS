import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { atriaHome } from "../../scripts/data-home.cjs";
import { readCoworkConfig } from "../runtime/config.js";
import { applyProxyEnvironment } from "../runtime/http-transport.js";
import { withFileLock } from "../storage/file-lock.js";
import { createDashboardApplication } from "../dashboard/application.js";
import {
  BackendInstanceConflict,
  backendPaths,
  ensureBackendIdentity,
  inspectBackend,
  probeBackend,
  processIsAlive,
  readBackendInstance,
  removeBackendInstance,
  writeBackendInstance,
  type BackendInstance,
  type BackendPaths
} from "../dashboard/backend-instance.js";

/**
 * The standalone backend: one process per data root that keeps serving after
 * the client that started it is gone.
 *
 * `start` returns once the detached process has published its instance record,
 * so the caller's lifetime is not the backend's lifetime. `stop` asks the
 * recorded process to finish its managed work and exit. Neither command, and
 * importing this module, registers a system service: the only OS-level service
 * entry in this repository stays scripts/monitor-service.mjs, which a person
 * runs explicitly.
 */

const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 15_000;

export interface BackendStatus {
  state: "started" | "running" | "stopped" | "absent" | "stale" | "conflict";
  backendId?: string;
  pid?: number;
  port?: number;
  url?: string;
  startedAt?: string;
  reason?: string;
}

function publicStatus(value: BackendInstance): BackendStatus {
  return {
    state: "running",
    backendId: value.backendId,
    pid: value.pid,
    port: value.port,
    url: value.url,
    startedAt: value.startedAt
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

async function logTail(paths: BackendPaths, bytes = 4_000): Promise<string> {
  try {
    const handle = await open(paths.logPath, "r");
    try {
      const info = await handle.stat();
      const length = Math.min(info.size, bytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, info.size - length);
      return buffer.toString("utf8").trim();
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

/** Start a detached backend, or report the one already serving this data root. */
export async function startBackend(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): Promise<BackendStatus> {
  const paths = backendPaths(atriaHome(env));
  return withFileLock(
    join(paths.runtimeDir, "backend-lifecycle"),
    async () => {
      const inspection = await inspectBackend(paths);
      if (inspection.state === "running") return { ...publicStatus(inspection.instance), state: "running" };
      if (inspection.state === "conflict") throw new BackendInstanceConflict(inspection.reason);
      await ensureBackendIdentity(paths);
      if (inspection.state === "stale") await removeBackendInstance(paths, inspection.instance);
      const instance = await spawnBackend(paths, env, cwd);
      return { ...publicStatus(instance), state: "started" };
    },
    { recoverDeadOwner: true, timeoutMs: START_TIMEOUT_MS + 5_000 }
  );
}

async function spawnBackend(
  paths: BackendPaths,
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<BackendInstance> {
  await mkdir(join(paths.runtimeDir), { recursive: true });
  await mkdir(dirname(paths.logPath), { recursive: true });
  const log = openSync(paths.logPath, "a", 0o600);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve"], {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", log, log]
    });
  } finally {
    closeSync(log);
  }
  child.unref();
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  const pid = child.pid;
  if (!pid) throw new Error(`后端进程未能启动：${spawnError?.message ?? "没有进程 id"}`);
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    if (spawnError) throw new Error(`后端启动失败：${spawnError.message}`);
    if (exit) throw new Error(`后端启动失败（${exit.code ?? exit.signal}）：\n${await logTail(paths)}`);
    const record = await readBackendInstance(paths);
    if (record.value?.pid === pid) {
      const probe = await probeBackend(record.value);
      if (probe.ok) return record.value;
    }
    if (Date.now() >= deadline) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* the daemon already exited */
      }
      throw new Error(`后端启动超时：\n${await logTail(paths)}`);
    }
    await delay(50);
  }
}

/** Explicitly stop the backend for this data root, letting it finish managed work first. */
export async function stopBackend(env: NodeJS.ProcessEnv = process.env): Promise<BackendStatus> {
  const paths = backendPaths(atriaHome(env));
  return withFileLock(
    join(paths.runtimeDir, "backend-lifecycle"),
    async () => {
      const inspection = await inspectBackend(paths);
      if (inspection.state === "absent") return { state: "absent" };
      if (inspection.state === "conflict") throw new BackendInstanceConflict(inspection.reason);
      const instance = inspection.instance;
      if (inspection.state === "stale") {
        await removeBackendInstance(paths, instance);
        return { ...publicStatus(instance), state: "stopped", reason: inspection.reason };
      }
      try {
        process.kill(instance.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (processIsAlive(instance.pid) && Date.now() < deadline) await delay(50);
      if (processIsAlive(instance.pid)) {
        try {
          process.kill(instance.pid, "SIGKILL");
        } catch {
          /* the process exited between the check and the signal */
        }
        const forcedDeadline = Date.now() + 2_000;
        while (processIsAlive(instance.pid) && Date.now() < forcedDeadline) await delay(50);
      }
      await removeBackendInstance(paths, instance);
      return { ...publicStatus(instance), state: "stopped" };
    },
    { recoverDeadOwner: true, timeoutMs: STOP_TIMEOUT_MS + 5_000 }
  );
}

/** Read the data root's view without changing it. */
export async function backendStatus(env: NodeJS.ProcessEnv = process.env): Promise<BackendStatus> {
  const paths = backendPaths(atriaHome(env));
  const inspection = await inspectBackend(paths);
  if (inspection.state === "running") return publicStatus(inspection.instance);
  if (inspection.state === "absent") return { state: "absent" };
  return {
    state: inspection.state,
    ...(inspection.instance
      ? { backendId: inspection.instance.backendId, pid: inspection.instance.pid }
      : {}),
    reason: inspection.reason
  };
}

/**
 * Serve until an explicit stop.
 *
 * The instance record is the readiness signal clients wait for; it is written
 * after the port is listening and removed while the managed work settles.
 */
export async function serveBackend(): Promise<void> {
  const env = process.env;
  const paths = backendPaths(atriaHome(env));
  applyProxyEnvironment(readCoworkConfig());
  const identity = await ensureBackendIdentity(paths);
  const requested = env.COWORK_UI_PORT ? Number(env.COWORK_UI_PORT) : undefined;
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > 65535))
    throw new Error("COWORK_UI_PORT 必须是 1–65535 的整数");
  const port = requested ?? (await availablePort());
  const token = env.COWORK_API_TOKEN?.trim() || randomBytes(32).toString("hex");
  env.COWORK_API_TOKEN = token;
  const startedAt = new Date().toISOString();
  const application = createDashboardApplication({
    port,
    backendIdentity: { backendId: identity.backendId, startedAt }
  });
  try {
    await new Promise<void>((resolveListen, reject) => {
      application.server.once("error", reject);
      application.server.listen(port, "127.0.0.1", () => {
        application.server.off("error", reject);
        resolveListen();
      });
    });
  } catch (error) {
    application.server.close();
    throw error;
  }
  const instance: BackendInstance = {
    version: 1,
    backendId: identity.backendId,
    createdAt: identity.createdAt,
    pid: process.pid,
    port,
    url: application.dashboardUrl,
    token,
    startedAt
  };
  try {
    await writeBackendInstance(paths, instance);
  } catch (error) {
    await application.stop().catch(() => undefined);
    throw error;
  }
  process.stdout.write(`cowork backend listening on ${instance.url}\n`);
  let stopping = false;
  const shutdown = (code: number) => {
    if (stopping) return;
    stopping = true;
    const forced = setTimeout(() => process.exit(code === 0 ? 1 : code), 5_000);
    forced.unref();
    void application
      .stop()
      .catch(() => undefined)
      .then(() => removeBackendInstance(paths, instance).catch(() => undefined))
      .then(() => {
        clearTimeout(forced);
        process.exit(code);
      });
  };
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
}

const HELP = `Usage: coworkos backend <start|status|stop> [--help]
  start    Start a detached backend for the current data root, or report the running one
  status   Report the backend instance for the current data root
  stop     Ask the backend to finish managed work and exit
The backend keeps running after the client that started it exits. It never installs a system service.`;

/** CLI entry for the standalone backend; importing this module starts nothing. */
export async function runBackendCommand(
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const [command = "status", ...rest] = args;
  if (command === "help" || args.some((argument) => isHelp(argument))) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (command === "serve") {
    await serveBackend();
    return 0;
  }
  if (rest.length) throw new Error(`未知参数：${rest.join(" ")}`);
  if (command === "start") {
    process.stdout.write(`${JSON.stringify(await startBackend(env))}\n`);
    return 0;
  }
  if (command === "stop") {
    process.stdout.write(`${JSON.stringify(await stopBackend(env))}\n`);
    return 0;
  }
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(await backendStatus(env))}\n`);
    return 0;
  }
  throw new Error(`未知后端命令：${command}`);
}

function isHelp(value: string): boolean {
  return value === "--help" || value === "-h";
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  runBackendCommand(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  );
