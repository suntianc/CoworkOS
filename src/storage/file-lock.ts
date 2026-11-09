import { mkdir, readFile, rm, stat, writeFile, utimes } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";

export interface FileLockOptions {
  retryMs?: number;
  staleMs?: number;
  timeoutMs?: number;
  heartbeatMs?: number;
  /** Reclaim a dead, verified local owner; active owners never expire in this mode. */
  recoverDeadOwner?: boolean;
}

interface LockOwner {
  token: string;
  pid: number;
  host?: string;
}
async function readOwner(path: string): Promise<{ owner?: LockOwner; raw?: string }> {
  try {
    const raw = await readFile(path, "utf8");
    let value: Partial<LockOwner> | null;
    try {
      value = JSON.parse(raw) as Partial<LockOwner> | null;
      // eslint-disable-next-line no-restricted-syntax -- owner.json 可能被并发写入者截断或损坏，此时没有可用的 owner 记录，只把原始文本交给调用方做一致性比较
    } catch {
      return { raw };
    }
    if (
      !value ||
      typeof value.token !== "string" ||
      !value.token ||
      !Number.isInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      (value.host !== undefined && typeof value.host !== "string")
    )
      return { raw };
    return { owner: value as LockOwner, raw };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function cancellationPath(lockPath: string, token: string): string {
  return `${lockPath}/.cancelled-owner-${createHash("sha256").update(token).digest("hex")}`;
}
async function ownerWasCancelled(lockPath: string, owner: LockOwner): Promise<boolean> {
  if (owner.host !== hostname()) return false;
  try {
    return (await readFile(cancellationPath(lockPath, owner.token), "utf8")) === owner.token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Only the successful claimant can remove an abandoned directory generation. */
async function recoverAbandonedLock(lockPath: string, ownerPath: string, staleMs: number): Promise<void> {
  const observed = await readOwner(ownerPath);
  const local = observed.owner?.host === hostname();
  const cancelled = observed.owner && (await ownerWasCancelled(lockPath, observed.owner));
  // Legacy owners without a host still cannot be removed while their PID lives.
  if (
    observed.owner &&
    (local || observed.owner.host === undefined) &&
    pidIsAlive(observed.owner.pid) &&
    !cancelled
  )
    return;
  const observedStat = await stat(lockPath);
  const abandoned = local && observed.owner !== undefined && (!pidIsAlive(observed.owner.pid) || cancelled);
  if (!abandoned && Date.now() - observedStat.mtimeMs < staleMs) return;
  const claimPath = `${lockPath}/.dead-owner-recovery`;
  const claimToken = randomUUID();
  try {
    await mkdir(claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // Recovery can itself be interrupted. Reclaim its abandoned claim using
      // the same ownership check and atomic claim, rather than deleting a claim
      // another live recoverer still owns. A missing/corrupt owner waits for TTL.
      await recoverAbandonedLock(claimPath, `${claimPath}/owner.json`, staleMs);
      return;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const marker = `${claimPath}/${claimToken}`;
  const claimOwnerPath = `${claimPath}/owner.json`;
  let publishedClaim = false;
  const ownsClaim = async (): Promise<boolean> => {
    const current = (await readOwner(claimOwnerPath)).owner;
    return current?.token === claimToken && current.pid === process.pid && current.host === hostname();
  };
  try {
    await writeFile(marker, claimToken, { flag: "wx" });
    await writeFile(
      claimOwnerPath,
      JSON.stringify({ token: claimToken, pid: process.pid, host: hostname() }) + "\n",
      { flag: "wx" }
    );
    publishedClaim = true;
    if (!(await ownsClaim())) return;
    const current = await readOwner(ownerPath);
    const currentStat = await stat(lockPath);
    if (observedStat.dev !== currentStat.dev || observedStat.ino !== currentStat.ino) return;
    if (abandoned) {
      if (
        !current.owner ||
        current.owner.token !== observed.owner!.token ||
        current.owner.pid !== observed.owner!.pid ||
        current.owner.host !== observed.owner!.host ||
        (pidIsAlive(current.owner.pid) && !(await ownerWasCancelled(lockPath, current.owner)))
      )
        return;
    } else {
      if (
        current.raw !== observed.raw ||
        (current.owner &&
          (current.owner.host === hostname() || current.owner.host === undefined) &&
          pidIsAlive(current.owner.pid))
      )
        return;
    }
    await rm(lockPath, { recursive: true, force: true });
  } catch (error) {
    if (!["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    // The directory can be replaced before this claimant publishes its owner.
    // A marker written into that replacement cannot prove ownership by itself.
    try {
      if (publishedClaim && (await ownsClaim()) && (await readFile(marker, "utf8")) === claimToken)
        await rm(claimPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/**
 * A small cross-process lock for the JSON/JSONL files used by the local
 * runtime. mkdir is atomic on the same filesystem, so this works across
 * independent Node processes (the in-memory mutex alone does not).
 */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const ownerPath = `${lockPath}/owner.json`;
  const retryMs = options.retryMs ?? 25;
  const staleMs = options.staleMs ?? 5 * 60_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const started = Date.now();
  const token = randomUUID();
  const ownsPublishedLock = async (): Promise<boolean> => {
    const current = (await readOwner(ownerPath)).owner;
    return current?.token === token && current.pid === process.pid && current.host === hostname();
  };

  await mkdir(dirname(targetPath), { recursive: true });
  for (;;) {
    try {
      await mkdir(lockPath);
      await writeFile(
        ownerPath,
        JSON.stringify({
          token,
          pid: process.pid,
          ...(options.recoverDeadOwner ? { host: hostname() } : {}),
          acquiredAt: new Date().toISOString()
        }) + "\n",
        { encoding: "utf8", flag: options.recoverDeadOwner ? "wx" : "w" }
      );
      if (options.recoverDeadOwner) {
        let verified = false;
        // A recovery attempt may have observed an unpublished owner before we
        // wrote it. Wait for that claim to settle, then verify ownership again.
        while (await ownsPublishedLock()) {
          try {
            await stat(`${lockPath}/.dead-owner-recovery`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            verified = await ownsPublishedLock();
            break;
          }
          if (Date.now() - started >= timeoutMs) {
            // Cancel this token without touching a live claim or a replacement
            // owner's record. Another caller can then recover our abandoned
            // attempt even while this process continues serving other work.
            try {
              await writeFile(cancellationPath(lockPath, token), token, { flag: "wx" });
            } catch (error) {
              if (!["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
            }
            throw new Error(`timed out acquiring file lock: ${targetPath}`);
          }
          await new Promise((resolve) => setTimeout(resolve, retryMs));
        }
        if (!verified) continue;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - started >= timeoutMs) throw new Error(`timed out acquiring file lock: ${targetPath}`);
      try {
        if (options.recoverDeadOwner) await recoverAbandonedLock(lockPath, ownerPath, staleMs);
        else {
          const details = await stat(lockPath);
          if (Date.now() - details.mtimeMs >= staleMs) await rm(lockPath, { recursive: true, force: true });
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }

  const heartbeat = options.heartbeatMs
    ? setInterval(() => {
        void readFile(ownerPath, "utf8")
          .then(async (raw) => {
            if (JSON.parse(raw).token === token) {
              const time = new Date();
              await utimes(lockPath, time, time);
            }
          })
          // eslint-disable-next-line no-restricted-syntax -- 心跳在定时器回调里刷新锁目录时间戳；锁可能已被接管者删除或 owner.json 正在被替换，失败只丢失一次续期，不能变成未处理的拒绝终止进程
          .catch(() => {});
      }, options.heartbeatMs)
    : undefined;
  heartbeat?.unref();
  try {
    return await fn();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    try {
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { token?: string };
      if (owner.token === token) await rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
