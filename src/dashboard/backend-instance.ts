import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { id } from "../domain/types.js";

/**
 * The persistent identity of one backend for one data root.
 *
 * A backend outlives the client that started it, so clients need a stable name
 * for the host they are talking to and a way to find the process that owns it.
 * The identity is written once and kept across restarts; a runtime instance
 * record describes the process currently serving that identity. Importing this
 * module reads and writes no files: only the functions below touch the data
 * root, and none of them opens a port or installs a system service.
 */
export interface BackendIdentity {
  version: 1;
  backendId: string;
  createdAt: string;
}

export interface BackendInstance extends BackendIdentity {
  pid: number;
  port: number;
  url: string;
  token: string;
  startedAt: string;
}

/** A serving process that is still starting; another startup must not replace it. */
export interface BackendStarting {
  version: 1;
  token: string;
  pid: number;
  startedAt: string;
}

export interface BackendPaths {
  runtimeDir: string;
  identityPath: string;
  instancePath: string;
  startingPath: string;
  logPath: string;
}

/** A record names a live process whose identity cannot be confirmed. */
export class BackendInstanceConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendInstanceConflict";
  }
}

export type BackendInspection =
  | { state: "absent" }
  | { state: "running"; instance: BackendInstance }
  | { state: "stale"; instance: BackendInstance; reason: string }
  | { state: "conflict"; instance?: BackendInstance; reason: string };

export interface BackendRecord<T> {
  exists: boolean;
  value?: T;
  invalid?: string;
}

export function backendPaths(home: string): BackendPaths {
  const runtimeDir = join(home, "runtime");
  return {
    runtimeDir,
    identityPath: join(runtimeDir, "backend-identity.json"),
    instancePath: join(runtimeDir, "backend-instance.json"),
    startingPath: join(runtimeDir, "backend-starting.json"),
    logPath: join(home, "logs", "backend.log")
  };
}

function identity(value: unknown): BackendIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<BackendIdentity>;
  if (record.version !== 1) return undefined;
  if (typeof record.backendId !== "string" || !record.backendId) return undefined;
  if (typeof record.createdAt !== "string" || !record.createdAt) return undefined;
  return { version: 1, backendId: record.backendId, createdAt: record.createdAt };
}

function starting(value: unknown): BackendStarting | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<BackendStarting>;
  if (record.version !== 1) return undefined;
  if (typeof record.token !== "string" || !record.token) return undefined;
  if (!Number.isInteger(record.pid) || (record.pid ?? 0) <= 0) return undefined;
  if (typeof record.startedAt !== "string" || !record.startedAt) return undefined;
  return { version: 1, token: record.token, pid: record.pid!, startedAt: record.startedAt };
}

function instance(value: unknown): BackendInstance | undefined {
  const base = identity(value);
  if (!base) return undefined;
  const record = value as Partial<BackendInstance>;
  if (!Number.isInteger(record.pid) || (record.pid ?? 0) <= 0) return undefined;
  if (!Number.isInteger(record.port) || (record.port ?? 0) <= 0 || (record.port ?? 0) > 65535)
    return undefined;
  if (typeof record.url !== "string" || !record.url) return undefined;
  if (typeof record.token !== "string" || !record.token) return undefined;
  if (typeof record.startedAt !== "string" || !record.startedAt) return undefined;
  return {
    ...base,
    pid: record.pid!,
    port: record.port!,
    url: record.url,
    token: record.token,
    startedAt: record.startedAt
  };
}

async function readRecord<T>(
  path: string,
  parse: (value: unknown) => T | undefined
): Promise<BackendRecord<T>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { exists: true, invalid: "记录不是合法 JSON" };
  }
  const value = parse(parsed);
  return value ? { exists: true, value } : { exists: true, invalid: "记录字段不完整" };
}

export function readBackendIdentity(paths: BackendPaths): Promise<BackendRecord<BackendIdentity>> {
  return readRecord(paths.identityPath, identity);
}

export function readBackendInstance(paths: BackendPaths): Promise<BackendRecord<BackendInstance>> {
  return readRecord(paths.instancePath, instance);
}

export function readBackendStarting(paths: BackendPaths): Promise<BackendRecord<BackendStarting>> {
  return readRecord(paths.startingPath, starting);
}

/** Create the identity exactly once; a damaged record is an error, not a new identity. */
export async function ensureBackendIdentity(paths: BackendPaths): Promise<BackendIdentity> {
  const current = await readBackendIdentity(paths);
  if (current.exists) {
    if (current.value) return current.value;
    throw new BackendInstanceConflict(`后端身份记录无法解析：${paths.identityPath}`);
  }
  const created: BackendIdentity = {
    version: 1,
    backendId: id("backend"),
    createdAt: new Date().toISOString()
  };
  await mkdir(paths.runtimeDir, { recursive: true });
  try {
    await writeFile(paths.identityPath, `${JSON.stringify(created, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    return created;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await readBackendIdentity(paths);
    if (raced.value) return raced.value;
    throw new BackendInstanceConflict(`后端身份记录无法解析：${paths.identityPath}`);
  }
}

export async function writeBackendInstance(paths: BackendPaths, value: BackendInstance): Promise<void> {
  await mkdir(paths.runtimeDir, { recursive: true });
  const temporary = `${paths.instancePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, paths.instancePath);
}

export async function writeBackendStarting(paths: BackendPaths, value: BackendStarting): Promise<void> {
  await mkdir(paths.runtimeDir, { recursive: true });
  const temporary = `${paths.startingPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, paths.startingPath);
}

/** Remove the record only when it still describes the instance the caller observed. */
export async function removeBackendInstance(
  paths: BackendPaths,
  expected?: { pid: number; token?: string }
): Promise<void> {
  if (expected) {
    const current = await readBackendInstance(paths);
    if (
      current.value &&
      (current.value.pid !== expected.pid ||
        (expected.token !== undefined && current.value.token !== expected.token))
    )
      return;
  }
  await rm(paths.instancePath, { force: true });
}

/** Remove a startup claim only when it is still the one the caller wrote. */
export async function removeBackendStarting(paths: BackendPaths, expectedToken?: string): Promise<void> {
  if (expectedToken) {
    const current = await readBackendStarting(paths);
    if (current.value && current.value.token !== expectedToken) return;
  }
  await rm(paths.startingPath, { force: true });
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface BackendProbe {
  ok: boolean;
  backendId?: string;
  pid?: number;
  reason?: string;
}

/** Ask the serving process who it is; the per-instance token keeps this local. */
export async function probeBackend(value: BackendInstance, timeoutMs = 3_000): Promise<BackendProbe> {
  try {
    const response = await fetch(`${value.url}/api/backend`, {
      headers: { "x-atria-token": value.token },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return { ok: false, reason: `后端身份查询返回 ${response.status}` };
    const info = (await response.json()) as { backendId?: unknown; pid?: unknown };
    if (info.backendId !== value.backendId) return { ok: false, reason: "后端身份与记录不一致" };
    if (info.pid !== value.pid) return { ok: false, reason: "响应进程与记录不一致" };
    return { ok: true, backendId: value.backendId, pid: value.pid };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** What the data root currently says about its backend. */
export async function inspectBackend(paths: BackendPaths): Promise<BackendInspection> {
  const record = await readBackendInstance(paths);
  if (!record.exists) return { state: "absent" };
  if (!record.value)
    return { state: "conflict", reason: `实例记录无法解析：${paths.instancePath}（${record.invalid}）` };
  const observed = record.value;
  if (!processIsAlive(observed.pid))
    return { state: "stale", instance: observed, reason: "记录的进程已经退出" };
  const stored = await readBackendIdentity(paths);
  if (stored.value && stored.value.backendId !== observed.backendId)
    return {
      state: "conflict",
      instance: observed,
      reason: "数据根记录的后端身份与运行实例不一致"
    };
  const probe = await probeBackend(observed);
  if (!probe.ok)
    return {
      state: "conflict",
      instance: observed,
      reason: `进程 ${observed.pid} 存在但无法确认是本数据根的后端：${probe.reason}`
    };
  return { state: "running", instance: observed };
}
