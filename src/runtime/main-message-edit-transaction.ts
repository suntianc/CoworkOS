import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileLock } from "../storage/file-lock.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { mainContextPaths } from "./main-context.js";
import { mainRequestPath } from "../storage/main-request-store.js";
import { mainInputPath, readMainInput } from "./main-continuation.js";
import { HumanRequestStore } from "./human.js";

interface EditTransaction {
  version: 1;
  taskId: string;
  runId: string;
  phase: "prepared" | "launch_ready";
  intent: { editId: string; prompt: string };
  sessionFile?: string;
  input?: Awaited<ReturnType<typeof readMainInput>>;
  before: Array<{ path: string; bytes: string | null }>;
  retiredHumanRequests?: string[];
}
const live = new Set<string>();
const pathFor = (root: string, taskId: string) =>
  join(root, taskId, "sessions", "main", "edit-transaction.json");
async function optional(path: string) {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}
async function atomic(path: string, bytes: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, path);
}
async function read(root: string, taskId: string): Promise<EditTransaction | undefined> {
  const bytes = await optional(pathFor(root, taskId));
  if (bytes === null) return;
  const value = JSON.parse(bytes) as EditTransaction;
  if (
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 事务文件从磁盘读出，旧版本写入的 version 不是 1 时必须拒绝恢复
    value.version !== 1 ||
    value.taskId !== taskId ||
    !/^[a-zA-Z0-9._-]+$/.test(value.runId) ||
    !["prepared", "launch_ready"].includes(value.phase) ||
    !Array.isArray(value.before) ||
    (value.retiredHumanRequests !== undefined &&
      (!Array.isArray(value.retiredHumanRequests) ||
        value.retiredHumanRequests.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9._-]+$/.test(id))))
  )
    throw new Error("编辑事务无法恢复，记录已保留。");
  const expected = snapshotPaths(root, taskId);
  if (
    value.before.length !== expected.length ||
    value.before.some(
      (entry, index) =>
        entry.path !== expected[index] || (entry.bytes !== null && typeof entry.bytes !== "string")
    )
  )
    throw new Error("编辑事务恢复路径无效，记录已保留。");
  return value;
}
function snapshotPaths(root: string, taskId: string) {
  const context = mainContextPaths(root, taskId);
  const retry = mainRequestPath(root, taskId);
  return [
    join(root, taskId, "task.json"),
    join(root, taskId, "sessions", "main", "versions.json"),
    context.messages,
    context.memory,
    context.state,
    retry,
    `${retry}.cleared`
  ];
}
export async function beginMessageEditTransaction(
  root: string,
  taskId: string,
  runId: string,
  baselineVersions: unknown,
  intent: { editId: string; prompt: string },
  retiredHumanRequests: string[] = []
) {
  const path = pathFor(root, taskId);
  if ((await optional(path)) !== null) throw new Error("此前编辑事务尚未恢复。");
  const before = await Promise.all(
    snapshotPaths(root, taskId).map(async (path) => ({ path, bytes: await optional(path) }))
  );
  if (before[1].bytes === null) before[1].bytes = JSON.stringify(baselineVersions);
  await atomic(
    path,
    JSON.stringify({ version: 1, taskId, runId, phase: "prepared", before, intent, retiredHumanRequests })
  );
  live.add(path);
}
export async function recordMessageEditBranch(root: string, taskId: string, sessionFile: string) {
  const value = await read(root, taskId);
  if (!value) throw new Error("编辑准备事务缺失。");
  await atomic(pathFor(root, taskId), JSON.stringify({ ...value, sessionFile }));
}
export async function readyMessageEditTransaction(root: string, taskId: string) {
  const value = await read(root, taskId);
  if (!value) throw new Error("编辑启动事务缺失。");
  const input = await readMainInput(mainInputPath(root, taskId, value.runId));
  const task = await new LocalWorkspaceStore(root).readTask(taskId);
  if (!input?.messageId || input.runId !== value.runId || task.activeRunId !== value.runId)
    throw new Error("编辑输入与运行身份尚未持久化。");
  await atomic(pathFor(root, taskId), JSON.stringify({ ...value, phase: "launch_ready", input }));
}
export async function finishMessageEditTransaction(root: string, taskId: string) {
  const path = pathFor(root, taskId);
  const value = await read(root, taskId);
  if (value) await rename(path, join(dirname(path), `edit-transaction-${value.runId}.json`));
  live.delete(path);
}
export async function rollbackMessageEditTransaction(root: string, taskId: string) {
  const value = await read(root, taskId);
  if (!value) return;
  // Preserve the rejected input and Run evidence; a durable rejection supersedes legacy fallbacks.
  const input = await readMainInput(mainInputPath(root, taskId, value.runId));
  if (input?.messageId && /^[a-zA-Z0-9._-]+$/.test(input.messageId)) {
    const path = join(root, taskId, "sessions", "main", "user-inputs", `${input.messageId}.json`);
    const bytes = await optional(path);
    if (bytes !== null) await atomic(path, JSON.stringify({ ...JSON.parse(bytes), accepted: false }));
  }
  for (const entry of value.before) {
    if (entry.bytes === null) await rm(entry.path, { force: true });
    else await atomic(entry.path, entry.bytes);
  }
  const human = new HumanRequestStore(root);
  for (const requestId of value.retiredHumanRequests ?? [])
    await human.restoreSuperseded(taskId, requestId, value.runId);
  await finishMessageEditTransaction(root, taskId);
}
/** Recover abandoned transactions; return whether the caller must refresh its Task snapshot. */
export async function recoverMessageEditTransaction(root: string, taskId: string): Promise<boolean> {
  const path = pathFor(root, taskId);
  if (live.has(path) || (await optional(path)) === null) return false;
  return withFileLock(path, async () => {
    const value = await read(root, taskId);
    // Another process may have recovered the observed transaction while we waited for its lock.
    if (!value) return true;
    if (value.phase === "prepared") await rollbackMessageEditTransaction(root, taskId);
    else {
      // Spawn may already have executed external actions. Keep the accepted branch and input,
      // settle the orphan Run as waiting, and never claim that those effects were undone.
      const store = new LocalWorkspaceStore(root);
      const task = await store.readTask(taskId);
      if (task.activeRunId !== value.runId) throw new Error("编辑事务与当前运行不一致，记录已保留。");
      if (task.status === "running")
        await store.transitionTask(taskId, "waiting", {
          runId: value.runId,
          reason: "message_edit_launch_recovered"
        });
      await finishMessageEditTransaction(root, taskId);
    }
    return true;
  });
}
