import { join } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { withFileLock } from "../storage/file-lock.js";

/**
 * A standing wake condition recorded by a Main that parked itself.
 *
 * Ending a turn and going to sleep look identical from outside: the work queue
 * is empty either way. Only Main knows whether the objective is finished or
 * merely quiet until the world changes, so it says so here, and the completion
 * gate reads this instead of guessing. Without a record the Task completes as
 * usual — a parked Task is the exception, not the default.
 */
export interface MainSleep {
  /** The Main Run that parked. A wake must reach this Run's Inbox. */
  runId: string;
  /** Why this Task is waiting for a wake. */
  reason: string;
  /** When the wake is due. */
  wakeAt: string;
  /** Set once the timed wake is queued, so the next cycle does not re-fire it. */
  wakeFiredAt?: string;
  parkedAt: string;
}

export function sleepPath(workspaceRoot: string, taskId: string): string {
  return join(workspaceRoot, taskId, "agents", "main", "sleep.json");
}

export async function readSleep(workspaceRoot: string, taskId: string): Promise<MainSleep | undefined> {
  try {
    const value = JSON.parse(await readFile(sleepPath(workspaceRoot, taskId), "utf8")) as Partial<MainSleep>;
    // A park without a due time could never be woken after the monitor
    // scheduler was removed; treat it as old state rather than a live park.
    if (
      typeof value.runId !== "string" ||
      typeof value.parkedAt !== "string" ||
      typeof value.wakeAt !== "string" ||
      !Number.isFinite(Date.parse(value.wakeAt))
    )
      return undefined;
    return {
      runId: value.runId,
      reason: typeof value.reason === "string" ? value.reason : "",
      wakeAt: value.wakeAt,
      wakeFiredAt: typeof value.wakeFiredAt === "string" ? value.wakeFiredAt : undefined,
      parkedAt: value.parkedAt
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeSleep(workspaceRoot: string, taskId: string, sleep: MainSleep): Promise<void> {
  await atomicWrite(sleepPath(workspaceRoot, taskId), `${JSON.stringify(sleep, null, 2)}\n`);
}

export async function clearSleep(workspaceRoot: string, taskId: string): Promise<void> {
  try {
    await unlink(sleepPath(workspaceRoot, taskId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Record that the timed wake has been queued.
 *
 * Taken under the file lock and re-read inside it: two supervisors racing on
 * the same park must produce one wake, not two.
 */
export async function markWakeFired(workspaceRoot: string, taskId: string): Promise<void> {
  const path = sleepPath(workspaceRoot, taskId);
  await withFileLock(path, async () => {
    const current = await readSleep(workspaceRoot, taskId);
    if (!current) return;
    await atomicWrite(
      path,
      `${JSON.stringify({ ...current, wakeFiredAt: new Date().toISOString() }, null, 2)}\n`
    );
  });
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}
