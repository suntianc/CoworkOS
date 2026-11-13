import { hostname } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { atomicWrite } from "../storage/atomic-file.js";
import { withFileLock } from "../storage/file-lock.js";
import { now } from "../domain/types.js";
import { processIsAlive, readProcessIdentity, verifyProcessIdentity } from "./process-identity.js";

/**
 * Who owns delegated execution for one workspace root.
 *
 * Delegated work has one owner: the backend that launches a process also
 * observes its exit and writes the callback. Two backends settling the same
 * workspace would duplicate that projection and each start what the other
 * queued. The serving Dashboard is the product backend and therefore takes the
 * record when it starts; the CLI worker does not take work while a live
 * Dashboard owns the root. A record left by a process that is gone is never
 * blocking: it is replaced by the first backend that can read the pid's own
 * start identity.
 */
export type SubagentOwnerKind = "dashboard" | "worker";

export interface SubagentOwnerRecord {
  version: 1;
  kind: SubagentOwnerKind;
  pid: number;
  host: string;
  startedAt: string;
  claimedAt: string;
  /** Written when this owner gave the record up. */
  releasedAt?: string;
}

export interface SubagentOwnership {
  owned: boolean;
  /** The live owner that kept this claim, when the claim was refused. */
  owner?: SubagentOwnerRecord;
}

export function subagentOwnerPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".runtime", "subagent-owner.json");
}

/** The record when the process that wrote it is still the same live process. */
export async function readLiveSubagentOwner(workspaceRoot: string): Promise<SubagentOwnerRecord | undefined> {
  const value = await readOwner(subagentOwnerPath(workspaceRoot));
  if (!value || value.releasedAt) return undefined;
  return (await ownerIsLive(value)) ? value : undefined;
}

/**
 * Take the owner record for this process.
 *
 * The Dashboard replaces a worker's claim because it is the product backend for
 * the root; every other kind yields to a live record it does not own. Liveness
 * is checked inside the lock, so two starting backends cannot both conclude the
 * record is stale and both replace it.
 */
export async function claimSubagentOwnership(
  workspaceRoot: string,
  kind: SubagentOwnerKind
): Promise<SubagentOwnership> {
  const path = subagentOwnerPath(workspaceRoot);
  const identity = await readProcessIdentity(process.pid)
    // eslint-disable-next-line no-restricted-syntax -- 读不到本机启动时间时用空串记录，下一次启动按 pid 复核；不能因此拒绝接管
    .catch(() => undefined);
  const record: SubagentOwnerRecord = {
    version: 1,
    kind,
    pid: process.pid,
    host: hostname(),
    startedAt: identity?.startedAt ?? "",
    claimedAt: now()
  };
  return await withFileLock(
    `${path}.lock`,
    async (): Promise<SubagentOwnership> => {
      const current = await readOwner(path);
      if (current && !current.releasedAt && current.pid !== process.pid && (await ownerIsLive(current))) {
        // The serving Dashboard is the product backend: it may replace a
        // worker's claim, but no second backend replaces a live Dashboard.
        if (kind !== "dashboard" || current.kind === "dashboard") return { owned: false, owner: current };
      }
      await atomicWrite(path, `${JSON.stringify(record)}\n`);
      return { owned: true };
    },
    { recoverDeadOwner: true }
  );
}

/** Give the record up when this process is the owner; another backend may take it. */
export async function releaseSubagentOwnership(workspaceRoot: string): Promise<void> {
  const path = subagentOwnerPath(workspaceRoot);
  await withFileLock(
    `${path}.lock`,
    async () => {
      const current = await readOwner(path);
      if (!current || current.pid !== process.pid) return;
      await atomicWrite(path, `${JSON.stringify({ ...current, releasedAt: now() })}\n`);
    },
    { recoverDeadOwner: true }
  );
}

async function readOwner(path: string): Promise<SubagentOwnerRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<SubagentOwnerRecord>;
    if (
      value.version !== 1 ||
      (value.kind !== "dashboard" && value.kind !== "worker") ||
      typeof value.pid !== "number" ||
      typeof value.host !== "string"
    )
      return undefined;
    return value as SubagentOwnerRecord;
    // eslint-disable-next-line no-restricted-syntax -- 记录不存在或损坏时没有可核对的属主，接管方会写入自己的记录
  } catch {
    return undefined;
  }
}

/**
 * Whether the process that wrote a record is still this host's same process.
 *
 * A record without a readable start time (a host where `ps` failed) falls back
 * to the pid, which is the most that record can support.
 */
async function ownerIsLive(record: SubagentOwnerRecord): Promise<boolean> {
  if (record.host !== hostname()) return false;
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return false;
  if (record.pid === process.pid) return true;
  if (!record.startedAt) return processIsAlive(record.pid);
  return await verifyProcessIdentity({ pid: record.pid, startedAt: record.startedAt });
}
