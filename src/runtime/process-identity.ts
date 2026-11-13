import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Who a pid is, not just that something answers to it.
 *
 * A backend that re-adopts a child after a restart only has the pid it wrote
 * before the restart. A pid alone is not an identity: this host recycles pids,
 * so a live `kill(pid, 0)` can belong to an unrelated program. The OS start
 * time is stable for the lifetime of a process and differs for a later process
 * that reuses the same number, so it is what turns the pid into an identity.
 */
export interface ProcessIdentity {
  pid: number;
  /** The OS-reported process start time, as returned by this host. */
  startedAt: string;
}

/** Whether a process group still has members. Only meaningful for this host. */
export function processGroupIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") return processIsAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether a process number currently exists. Only meaningful for this host. */
export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still proves the process exists; it belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readStartedAt(pid: number): Promise<string | undefined> {
  try {
    const { stdout } =
      process.platform === "win32"
        ? await run(
            "powershell",
            [
              "-NoProfile",
              "-Command",
              `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
            ],
            { timeout: 5_000 }
          )
        : await run("ps", ["-p", String(pid), "-o", "lstart="], {
            timeout: 5_000,
            // The identity is compared across a backend restart; a changed
            // locale must not make the same process look like a different one.
            env: { ...process.env, LC_ALL: "C", LANG: "C" }
          });
    const startedAt = stdout.trim();
    return startedAt || undefined;
    // eslint-disable-next-line no-restricted-syntax -- 进程可能刚退出或本机没有 ps/powershell；拿不到启动时间就是无法核对身份，由调用方按“已结束”处理
  } catch {
    return undefined;
  }
}

/** Read the identity of a live process, or nothing when it is gone or unreadable. */
export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  if (!processIsAlive(pid)) return undefined;
  const startedAt = await readStartedAt(pid);
  return startedAt ? { pid, startedAt } : undefined;
}

/** Whether the process recorded earlier is still the same process. */
export async function verifyProcessIdentity(identity: ProcessIdentity): Promise<boolean> {
  if (!identity.startedAt) return false;
  const current = await readProcessIdentity(identity.pid);
  return current !== undefined && current.startedAt === identity.startedAt;
}
