import { hostname } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

/**
 * A liveness signal a running Main writes for its Task.
 *
 * The supervisor's one dangerous move is spawning a Main, and spawning a
 * second one for a Task that already has a live Main puts two agents on the
 * same project at once. Deciding that safely needs more than "is the task
 * running" — a crash leaves the task running with no process. So a live Main
 * refreshes this file on a timer, and absence or staleness is what "no Main"
 * means. The pid check rejects a stale file whose process is already gone;
 * the timestamp check rejects a pid that has been reused on this host, and
 * covers a heartbeat written by a different host entirely.
 */

export interface MainHeartbeat {
  pid: number;
  host: string;
  runId: string;
  updatedAt: string;
  /**
   * Whether a turn is running right now.
   *
   * A resident Main is alive while it is idle, so liveness alone no longer
   * answers "is it working". The process writes this at every turn boundary,
   * which is also what a backend that adopted the process can read.
   */
  turnActive?: boolean;
}

/** A Main refreshed within this window is considered alive. */
export const HEARTBEAT_STALE_MS = 30_000;

function heartbeatPath(workspaceRoot: string, taskId: string): string {
  return join(workspaceRoot, taskId, "agents", "main", "heartbeat.json");
}

export async function writeHeartbeat(
  workspaceRoot: string,
  taskId: string,
  runId: string,
  state: { turnActive?: boolean } = {}
): Promise<void> {
  const path = heartbeatPath(workspaceRoot, taskId);
  const beat: MainHeartbeat = {
    pid: process.pid,
    host: hostname(),
    runId,
    updatedAt: new Date().toISOString(),
    ...(state.turnActive === undefined ? {} : { turnActive: state.turnActive })
  };
  await mkdir(join(workspaceRoot, taskId, "agents", "main"), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(beat)}\n`, "utf8");
  await rename(temporary, path);
}

export async function readHeartbeat(
  workspaceRoot: string,
  taskId: string
): Promise<MainHeartbeat | undefined> {
  try {
    const value = JSON.parse(
      await readFile(heartbeatPath(workspaceRoot, taskId), "utf8")
    ) as Partial<MainHeartbeat>;
    if (typeof value.pid !== "number" || typeof value.updatedAt !== "string") return undefined;
    return {
      pid: value.pid,
      host: typeof value.host === "string" ? value.host : "",
      runId: typeof value.runId === "string" ? value.runId : "",
      updatedAt: value.updatedAt,
      ...(typeof value.turnActive === "boolean" ? { turnActive: value.turnActive } : {})
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Whether a process is running. Only meaningful for a pid on this host. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a live Main holds this Task right now.
 *
 * Fresh-and-alive is the only "yes". A fresh heartbeat from another host is
 * trusted on its timestamp alone, since its pid means nothing here; a local
 * pid is additionally checked, so a crash is noticed before the staleness
 * window elapses rather than after it.
 */
export function mainIsAlive(
  beat: MainHeartbeat | undefined,
  nowMs = Date.now(),
  staleMs = HEARTBEAT_STALE_MS
): boolean {
  if (!beat) return false;
  const age = nowMs - Date.parse(beat.updatedAt);
  if (!Number.isFinite(age) || age > staleMs) return false;
  if (beat.host && beat.host !== hostname()) return true;
  return pidAlive(beat.pid);
}
