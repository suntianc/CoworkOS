import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DurableScheduler, type WorkItem, type WorkStatus } from "./scheduler.js";

const TERMINAL_STATUSES: readonly WorkStatus[] = ["completed", "failed", "cancelled"];

/** Whether one queue status is final. */
export function isTerminalWorkStatus(status: WorkStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Whether a work item is still something Main has to hear about.
 *
 * A terminal row whose callback has not been queued yet is not settled for
 * readers: the outcome exists, but not the record (the callback) Main reads it
 * from, so completion waits for both.
 */
export function workItemUnsettled(item: Pick<WorkItem, "status" | "callbackPending">): boolean {
  return !isTerminalWorkStatus(item.status) || item.callbackPending === true;
}

/**
 * Whether a Run still has delegated work in flight or an outcome Main has not
 * received yet.
 *
 * This is the one "is this Run finished with its delegates" fact: the external
 * budget keeps a slot for it (whatever the turn is doing), the subagent backend
 * keeps tracking the Run, and Main does not complete the Task while it is true.
 */
export async function hasUnfinishedSubagentWork(input: {
  workspaceRoot: string;
  taskId: string;
  runId: string;
}): Promise<boolean> {
  const runRoot = join(input.workspaceRoot, input.taskId, "runs", input.runId);
  const items = await new DurableScheduler(join(runRoot, "queue.json"))
    .list()
    // eslint-disable-next-line no-restricted-syntax -- 队列读不出来时按没有未完成项处理；进程记录仍会让它保持未完成
    .catch(() => []);
  if (items.some(workItemUnsettled)) return true;
  const agents = await readdir(join(runRoot, "agents", "subagents"), { withFileTypes: true })
    // eslint-disable-next-line no-restricted-syntax -- 没有子代理目录的 Run 就没有进程记录，按没有未结算进程处理
    .catch(() => []);
  for (const entry of agents) {
    if (!entry.isDirectory()) continue;
    const record = await readFile(join(runRoot, "agents", "subagents", entry.name, "process.json"), "utf8")
      .then((text) => JSON.parse(text) as { settledAt?: string })
      // eslint-disable-next-line no-restricted-syntax -- 记录不存在或损坏时没有可接管的进程，队列行才是那份结论
      .catch(() => undefined);
    if (record && !record.settledAt) return true;
  }
  return false;
}
