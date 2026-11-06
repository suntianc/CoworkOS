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
  readBackendStarting,
  removeBackendInstance,
  removeBackendStarting,
  writeBackendInstance,
  writeBackendStarting,
  type BackendInstance,
  type BackendPaths,
  type BackendStarting
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
 *
 * Every way into the server obeys one ownership rule for a data root. A
 * startup claim names the startup responsible for the boot; a spawned child
 * publishes its instance record under the lifecycle lock only while it still
 * owns that claim, and a direct `serve` takes the same lock and either reuses a
 * verifiable live instance or refuses with a clear conflict. That is what keeps
 * a second entry from overwriting a running instance's record and orphaning its
 * process.
 */

const START_TIMEOUT_MS = 20_000;
/**
 * How long `stop` waits for the daemon's own teardown before forcing it.
 *
 * This bounds the controller, not the daemon: the daemon waits for
 * `application.stop()` to settle and never exits mid-teardown. The value covers
 * the bounded stages the daemon itself owns — in-flight MCP startup, the MCP
 * SDK's close bounds, process-host grace and run finalisations — with headroom.
 * If it is exhausted, `stop` verifies the process is gone and reports
 * `incomplete` instead of claiming a clean stop; the instance record is kept so
 * the next start can reclaim the same backend identity.
 */
const TEARDOWN_BUDGET_MS = 30_000;
/**
 * A lock holder may be a slow stop or a startup. Waiting for it is better than
 * failing a second command with a lock timeout shorter than the work in flight.
 */
const LOCK_TIMEOUT_MS = Math.max(START_TIMEOUT_MS, TEARDOWN_BUDGET_MS) + 5_000;

export interface BackendStatus {
  state: "started" | "running" | "stopped" | "incomplete" | "absent" | "stale" | "starting" | "conflict";
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

function startupConflict(claim: BackendStarting): BackendInstanceConflict {
  return new BackendInstanceConflict(`后端正在启动（pid ${claim.pid}），请稍后重试`);
}

/** Wait for a startup that owns the claim to publish its instance record. */
async function waitForStartup(
  paths: BackendPaths,
  claim: BackendStarting
): Promise<BackendInstance | undefined> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await readBackendInstance(paths);
    if (current.value) {
      const probe = await probeBackend(current.value);
      if (probe.ok) return current.value;
    }
    if (!processIsAlive(claim.pid)) return undefined;
    await delay(100);
  }
  return undefined;
}

/** Start a detached backend, or report the one already serving this data root. */
export async function startBackend(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): Promise<BackendStatus> {
  const paths = backendPaths(atriaHome(env));
  const prepared = await withFileLock(
    join(paths.runtimeDir, "backend-lifecycle"),
    async (): Promise<
      | { kind: "running"; instance: BackendInstance }
      | { kind: "waiting"; claim: BackendStarting }
      | { kind: "starting"; claim: BackendStarting; instanceToken: string; spawned: SpawnedBackend }
    > => {
      const inspection = await inspectBackend(paths);
      if (inspection.state === "running") return { kind: "running", instance: inspection.instance };
      if (inspection.state === "conflict") throw new BackendInstanceConflict(inspection.reason);
      const starting = await readBackendStarting(paths);
      if (starting.value && processIsAlive(starting.value.pid))
        return { kind: "waiting", claim: starting.value };
      if (starting.exists) await removeBackendStarting(paths);
      await ensureBackendIdentity(paths);
      if (inspection.state === "stale") await removeBackendInstance(paths, inspection.instance);
      const claimToken = randomBytes(32).toString("hex");
      const instanceToken = env.COWORK_API_TOKEN?.trim() || randomBytes(32).toString("hex");
      const claim: BackendStarting = {
        version: 1,
        token: claimToken,
        pid: process.pid,
        startedAt: new Date().toISOString()
      };
      await writeBackendStarting(paths, claim);
      try {
        const spawned = await spawnBackend(paths, env, cwd, claimToken, instanceToken);
        return { kind: "starting", claim, instanceToken, spawned };
      } catch (error) {
        await removeBackendStarting(paths, claimToken).catch(() => undefined);
        throw error;
      }
    },
    { recoverDeadOwner: true, timeoutMs: LOCK_TIMEOUT_MS }
  );
  if (prepared.kind === "running") return { ...publicStatus(prepared.instance), state: "running" };
  if (prepared.kind === "waiting") {
    // Another startup owns the root. It publishes the instance record without
    // the lock, so wait for it here rather than holding the lock it needs.
    const observed = await waitForStartup(paths, prepared.claim);
    if (observed) return { ...publicStatus(observed), state: "running" };
    throw startupConflict(prepared.claim);
  }
  try {
    const instance = await waitForRecord(paths, prepared.spawned);
    return { ...publicStatus(instance), state: "started" };
  } catch (error) {
    await prepared.spawned.terminate();
    await removeBackendInstance(paths, { pid: prepared.spawned.pid, token: prepared.instanceToken }).catch(
      () => undefined
    );
    throw error;
  } finally {
    await removeBackendStarting(paths, prepared.claim.token).catch(() => undefined);
  }
}

interface SpawnedBackend {
  pid: number;
  exitStatus(): { code: number | null; signal: NodeJS.Signals | null } | undefined;
  spawnError(): Error | undefined;
  terminate(): Promise<void>;
}

async function spawnBackend(
  paths: BackendPaths,
  env: NodeJS.ProcessEnv,
  cwd: string,
  claimToken: string,
  instanceToken: string
): Promise<SpawnedBackend> {
  await mkdir(paths.runtimeDir, { recursive: true });
  await mkdir(dirname(paths.logPath), { recursive: true });
  const log = openSync(paths.logPath, "a", 0o600);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve", "--claim", claimToken], {
      cwd,
      env: { ...env, COWORK_API_TOKEN: instanceToken },
      detached: process.platform !== "win32",
      stdio: ["ignore", log, log]
    });
  } finally {
    closeSync(log);
  }
  child.unref();
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let error: Error | undefined;
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });
  child.once("error", (failure) => {
    error = failure;
  });
  const pid = child.pid;
  if (!pid) throw new Error(`后端进程未能启动：${error?.message ?? "没有进程 id"}`);
  return {
    pid,
    exitStatus: () => exit,
    spawnError: () => error,
    async terminate() {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* the daemon already exited */
      }
      if (!exit) await new Promise<void>((done) => child.once("exit", () => done()));
    }
  };
}

/** Wait for a spawned daemon to publish a record that proves it is this process. */
async function waitForRecord(paths: BackendPaths, spawned: SpawnedBackend): Promise<BackendInstance> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const failure = spawned.spawnError();
    if (failure) throw new Error(`后端启动失败：${failure.message}`);
    const record = await readBackendInstance(paths);
    if (record.value?.pid === spawned.pid) {
      const probe = await probeBackend(record.value);
      if (probe.ok) return record.value;
    }
    const exit = spawned.exitStatus();
    if (exit) throw new Error(`后端启动失败（${exit.code ?? exit.signal}）：\n${await logTail(paths)}`);
    if (Date.now() >= deadline) throw new Error(`后端启动超时：\n${await logTail(paths)}`);
    await delay(50);
  }
}

/**
 * Explicitly stop the backend for this data root, letting it finish managed
 * work first. `stopped` means the daemon exited after completing its own
 * teardown; a forced or incomplete teardown reports `incomplete` and leaves the
 * instance record for the next start to reclaim.
 */
export async function stopBackend(env: NodeJS.ProcessEnv = process.env): Promise<BackendStatus> {
  const paths = backendPaths(atriaHome(env));
  return withFileLock(
    join(paths.runtimeDir, "backend-lifecycle"),
    async () => {
      const inspection = await inspectBackend(paths);
      if (inspection.state === "conflict") throw new BackendInstanceConflict(inspection.reason);
      const starting = await readBackendStarting(paths);
      const startupAlive = Boolean(starting.value && processIsAlive(starting.value.pid));
      if (inspection.state === "absent") {
        if (startupAlive) throw startupConflict(starting.value!);
        return { state: "absent" };
      }
      const instance = inspection.instance;
      if (inspection.state === "stale") {
        if (startupAlive) throw startupConflict(starting.value!);
        if (starting.exists) await removeBackendStarting(paths);
        await removeBackendInstance(paths, instance);
        return { ...publicStatus(instance), state: "stopped", reason: inspection.reason };
      }
      try {
        process.kill(instance.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      const deadline = Date.now() + TEARDOWN_BUDGET_MS;
      while (processIsAlive(instance.pid) && Date.now() < deadline) await delay(50);
      const forced = processIsAlive(instance.pid);
      if (forced) {
        try {
          process.kill(instance.pid, "SIGKILL");
        } catch {
          /* the process exited between the check and the signal */
        }
        const forcedDeadline = Date.now() + 2_000;
        while (processIsAlive(instance.pid) && Date.now() < forcedDeadline) await delay(50);
      }
      if (processIsAlive(instance.pid))
        return {
          ...publicStatus(instance),
          state: "incomplete",
          reason: "后端进程在强制结束后仍然存活；实例记录已保留"
        };
      // The daemon removes its record as the last step of a complete teardown.
      // A record that outlived the process is the marker of an incomplete one.
      if ((await readBackendInstance(paths)).exists)
        return {
          ...publicStatus(instance),
          state: "incomplete",
          reason: forced
            ? `受管进程收尾未在 ${TEARDOWN_BUDGET_MS}ms 内完成，已强制结束；实例记录已保留`
            : "后端退出时未完成实例记录清理，实例记录已保留"
        };
      if (starting.exists) await removeBackendStarting(paths);
      return { ...publicStatus(instance), state: "stopped" };
    },
    { recoverDeadOwner: true, timeoutMs: LOCK_TIMEOUT_MS }
  );
}

/** Read the data root's view without changing it. */
export async function backendStatus(env: NodeJS.ProcessEnv = process.env): Promise<BackendStatus> {
  const paths = backendPaths(atriaHome(env));
  const inspection = await inspectBackend(paths);
  if (inspection.state === "running") return publicStatus(inspection.instance);
  const starting = await readBackendStarting(paths);
  if (starting.value && processIsAlive(starting.value.pid))
    return {
      state: "starting",
      pid: starting.value.pid,
      reason: `后端正在启动（pid ${starting.value.pid}）`
    };
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
 * after the port is listening and removed while the managed work settles. The
 * daemon awaits its own teardown: it never exits mid-cleanup, so a controller
 * that sees the process gone knows the record outcome is final.
 */
export async function serveBackend(claimToken?: string): Promise<void> {
  const env = process.env;
  const paths = backendPaths(atriaHome(env));
  applyProxyEnvironment(readCoworkConfig());
  if (claimToken) {
    // A `start` child: the claim token is its authority, and publication
    // re-checks it under the lock. The parent may already be gone — the backend
    // must outlive the client that started it.
    const claim = await readBackendStarting(paths);
    if (!claim.value || claim.value.token !== claimToken) throw new Error("后端启动归属已失效，未启动");
  } else {
    // A direct serve: obey the same ownership rule as `start`.
    const registered = await withFileLock(
      join(paths.runtimeDir, "backend-lifecycle"),
      async (): Promise<{ existing: BackendInstance } | { claim: BackendStarting }> => {
        const inspection = await inspectBackend(paths);
        if (inspection.state === "running") return { existing: inspection.instance };
        if (inspection.state === "conflict") throw new BackendInstanceConflict(inspection.reason);
        const starting = await readBackendStarting(paths);
        if (starting.value && processIsAlive(starting.value.pid)) throw startupConflict(starting.value);
        if (starting.exists) await removeBackendStarting(paths);
        await ensureBackendIdentity(paths);
        if (inspection.state === "stale") await removeBackendInstance(paths, inspection.instance);
        const claim: BackendStarting = {
          version: 1,
          token: randomBytes(32).toString("hex"),
          pid: process.pid,
          startedAt: new Date().toISOString()
        };
        await writeBackendStarting(paths, claim);
        return { claim };
      },
      { recoverDeadOwner: true, timeoutMs: LOCK_TIMEOUT_MS }
    );
    if ("existing" in registered) {
      process.stdout.write(`${JSON.stringify(publicStatus(registered.existing))}\n`);
      return;
    }
    claimToken = registered.claim.token;
  }
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
    await removeBackendStarting(paths, claimToken).catch(() => undefined);
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
  // Handlers exist before the record is published, so a stop that arrives
  // during publication is still a graceful teardown rather than a killed
  // process with a leftover record.
  let markReady!: () => void;
  const ready = new Promise<void>((done) => {
    markReady = done;
  });
  let published: BackendInstance | undefined;
  let stopping = false;
  let tearingDown = false;
  const teardown = (code: number) => {
    if (tearingDown) return;
    tearingDown = true;
    // No timer that exits mid-teardown: the controller bounds the wait and
    // treats a surviving record as an incomplete stop. Removing the record is
    // the daemon's own proof that managed cleanup completed.
    void application
      .stop()
      .then(
        () =>
          (published ? removeBackendInstance(paths, published) : Promise.resolve()).then(
            () => process.exit(code),
            () => process.exit(1)
          ),
        () => process.exit(1)
      )
      .catch(() => process.exit(1));
  };
  const shutdown = (code: number) => {
    if (stopping) return;
    stopping = true;
    void ready.then(() => teardown(code));
  };
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  try {
    // Publishing takes the lock and re-checks the claim: a startup that lost
    // its claim to a newer owner must abort instead of overwriting the record.
    await withFileLock(
      join(paths.runtimeDir, "backend-lifecycle"),
      async () => {
        const claim = await readBackendStarting(paths);
        if (!claim.value || claim.value.token !== claimToken) throw new Error("后端启动归属已失效，未启动");
        await writeBackendInstance(paths, instance);
        published = instance;
        await removeBackendStarting(paths, claimToken);
      },
      { recoverDeadOwner: true, timeoutMs: LOCK_TIMEOUT_MS }
    );
    markReady();
  } catch (error) {
    markReady();
    teardown(1);
    throw error;
  }
  process.stdout.write(`cowork backend listening on ${instance.url}\n`);
}

const HELP = `Usage: coworkos backend <start|status|stop> [--help]
  start    Start a detached backend for the current data root, or report the running one
  status   Report the backend instance for the current data root
  stop     Ask the backend to finish managed work and exit
The backend keeps running after the client that started it exits. It never installs a system service.`;

function claimArgument(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--claim" || !args[1])
    throw new Error("未知参数：serve 只接受内部启动归属 --claim <token>");
  const token = args[1];
  if (token.length > 200 || /[\s\0]/.test(token)) throw new Error("无效的后端启动归属");
  return token;
}

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
    await serveBackend(claimArgument(rest));
    return 0;
  }
  if (rest.length) throw new Error(`未知参数：${rest.join(" ")}`);
  if (command === "start") {
    process.stdout.write(`${JSON.stringify(await startBackend(env))}\n`);
    return 0;
  }
  if (command === "stop") {
    const result = await stopBackend(env);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.state === "incomplete" ? 1 : 0;
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
