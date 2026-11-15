import { join } from "node:path";
import { readFile, unlink } from "node:fs/promises";
import { atomicWrite } from "../storage/atomic-file.js";

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
  /**
   * The Run that parked. The wake is delivered to whichever Run is active when
   * it falls due: the Task may have been reopened, and only that Run's Main
   * reads an Inbox.
   */
  runId: string;
  /** Why this Task is waiting for a wake. */
  reason: string;
  /** When the wake is due. */
  wakeAt: string;
  parkedAt: string;
}

export function sleepPath(workspaceRoot: string, taskId: string): string {
  return join(workspaceRoot, taskId, "agents", "main", "sleep.json");
}

export async function readSleep(workspaceRoot: string, taskId: string): Promise<MainSleep | undefined> {
  try {
    const value = JSON.parse(await readFile(sleepPath(workspaceRoot, taskId), "utf8")) as Partial<MainSleep>;
    if (
      typeof value.runId !== "string" ||
      typeof value.reason !== "string" ||
      typeof value.parkedAt !== "string" ||
      typeof value.wakeAt !== "string" ||
      !Number.isFinite(Date.parse(value.wakeAt))
    )
      throw new Error("停泊记录损坏，已保留原记录。");
    return { runId: value.runId, reason: value.reason, wakeAt: value.wakeAt, parkedAt: value.parkedAt };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeSleep(workspaceRoot: string, taskId: string, sleep: MainSleep): Promise<void> {
  await atomicWrite(sleepPath(workspaceRoot, taskId), `${JSON.stringify(sleep, null, 2)}\n`);
}

/**
 * Drop the park once its wake is durable.
 *
 * The guardian writes the wake before clearing, and the Inbox keeps a message
 * id derived from the park, so a crash between the two writes re-queues the
 * same message instead of waking the Task twice.
 */
export async function clearSleep(workspaceRoot: string, taskId: string): Promise<void> {
  try {
    await unlink(sleepPath(workspaceRoot, taskId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
