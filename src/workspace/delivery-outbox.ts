import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deliveryReceipt, type DeliveryReceipt } from "../domain/development-delivery.js";
import { ProjectDataInvalidError } from "../domain/project-ledger.js";

/**
 * The execution host's small, durable delivery outbox.
 *
 * A merge updates the target branch before the shared store records it. If the
 * shared service is unreachable at that moment, the real Git fact must not exist
 * only in memory: this file keeps the merged operation's identity and the
 * expected target until the merge row and its ledger/board delivery are
 * accepted. It is per project, written atomically, and read back on start and
 * on the next delivery read, so a restart retries instead of re-developing,
 * re-merging or asking Main to describe what happened. It holds only non-secret
 * identity and evidence (commits, branch, ids); no credential is copied here.
 */
export interface DeliveryIntent extends DeliveryReceipt {
  /** The shared project the operation belongs to. */
  projectId: string;
  /** The target the operation expected before publishing; reconciliation input. */
  expectedTarget?: string;
  /** The combined base it staged, kept for a readable retry. */
  combinedBase?: string;
  /** When this host published the target. */
  publishedAt: string;
  /** The last shared-write error, kept so the UI can show why sync is waiting. */
  error?: string;
  /** How many shared-write attempts this host made. */
  attempts?: number;
}

interface OutboxFile {
  version: 1;
  projectId: string;
  entries: DeliveryIntent[];
}

const MAX_ENTRIES = 200;
const FILE_VERSION = 1;

function projectKey(projectId: string): string {
  return createHash("sha256").update(projectId).digest("hex").slice(0, 32);
}

/**
 * Read one stored entry.
 *
 * A damaged file is preserved under a `.corrupt-<timestamp>` name instead of
 * being overwritten or silently discarded: the shared merged row remains the
 * primary recovery path, and the original bytes stay available for diagnosis.
 */
function intentOf(value: unknown, projectId: string): DeliveryIntent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  try {
    const receipt = deliveryReceipt(input);
    if (typeof input.projectId !== "string" || input.projectId !== projectId) return undefined;
    return {
      ...receipt,
      projectId,
      expectedTarget:
        typeof input.expectedTarget === "string" && /^[0-9a-f]{7,64}$/.test(input.expectedTarget)
          ? input.expectedTarget
          : undefined,
      combinedBase:
        typeof input.combinedBase === "string" && /^[0-9a-f]{7,64}$/.test(input.combinedBase)
          ? input.combinedBase
          : undefined,
      publishedAt:
        typeof input.publishedAt === "string" && input.publishedAt.trim()
          ? input.publishedAt
          : new Date().toISOString(),
      ...(typeof input.error === "string" && input.error.trim() ? { error: input.error.slice(0, 2000) } : {}),
      ...(Number.isSafeInteger(input.attempts) && Number(input.attempts) >= 0
        ? { attempts: Number(input.attempts) }
        : {})
    };
    // eslint-disable-next-line no-restricted-syntax -- 单条 outbox 记录校验失败即视为无效，由返回值 undefined 过滤而不是让整个读取失败
  } catch {
    return undefined;
  }
}

export class DeliveryOutbox {
  constructor(private readonly root: string) {}

  private pathFor(projectId: string): string {
    return join(this.root, `${projectKey(projectId)}.json`);
  }

  /** Projects with a local pending fact, so a restart can resume without a request. */
  async projects(): Promise<string[]> {
    let files: string[];
    try {
      files = await readdir(this.root);
      // eslint-disable-next-line no-restricted-syntax -- outbox 目录尚未创建（或不可读）时没有待同步项目，空列表由下一次写入自愈
    } catch {
      return [];
    }
    const projects = new Set<string>();
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      try {
        const parsed = JSON.parse(await readFile(join(this.root, file), "utf8")) as Partial<OutboxFile>;
        if (typeof parsed.projectId === "string" && parsed.projectId) projects.add(parsed.projectId);
        // eslint-disable-next-line no-restricted-syntax -- 单个损坏文件由 list() 改名保留并报告，发现项目不能因此失败
      } catch {
        // A damaged file is reported by list(); discovering projects must not fail.
      }
    }
    return [...projects];
  }

  async list(projectId: string): Promise<DeliveryIntent[]> {
    if (!projectId) throw new ProjectDataInvalidError("交付待同步记录需要项目 ID");
    let raw: string;
    try {
      raw = await readFile(this.pathFor(projectId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
      // eslint-disable-next-line no-restricted-syntax -- 无法解析的本地记录由 preserve() 改名保留，读取方按空列表继续同步
    } catch {
      await this.preserve(projectId);
      return [];
    }
    const file = parsed as Partial<OutboxFile>;
    if (
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 文件内容来自 JSON.parse，顶层可能是 null 或非对象
      !file ||
      typeof file !== "object" ||
      file.version !== FILE_VERSION ||
      file.projectId !== projectId ||
      !Array.isArray(file.entries)
    ) {
      await this.preserve(projectId);
      return [];
    }
    return file.entries
      .map((entry) => intentOf(entry, projectId))
      .filter((entry): entry is DeliveryIntent => Boolean(entry));
  }

  async put(intent: DeliveryIntent): Promise<void> {
    const projectId = intent.projectId;
    const entries = await this.list(projectId);
    const next = entries.filter((entry) => entry.mergeId !== intent.mergeId);
    next.push(intent);
    await this.write(projectId, next.slice(-MAX_ENTRIES));
  }

  /** Keep a failed synchronization readable on the local fact; retry clears it. */
  async fail(projectId: string, mergeId: string, message: string): Promise<void> {
    const entries = await this.list(projectId);
    const index = entries.findIndex((entry) => entry.mergeId === mergeId);
    if (index < 0) return;
    const entry = entries[index];
    entries[index] = {
      ...entry,
      error: message.slice(0, 2000),
      attempts: (entry.attempts ?? 0) + 1
    };
    await this.write(projectId, entries);
  }

  async remove(projectId: string, mergeId: string): Promise<void> {
    const entries = await this.list(projectId);
    const next = entries.filter((entry) => entry.mergeId !== mergeId);
    if (next.length === entries.length) return;
    await this.write(projectId, next);
  }

  private async write(projectId: string, entries: DeliveryIntent[]): Promise<void> {
    const path = this.pathFor(projectId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (!entries.length) {
      // Keep the directory; an empty file is a readable marker, not a record.
      await writeFile(
        path,
        `${JSON.stringify({ version: FILE_VERSION, projectId, entries: [] }, null, 2)}\n`,
        {
          mode: 0o600
        }
      );
      return;
    }
    const file: OutboxFile = { version: FILE_VERSION, projectId, entries };
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }

  private async preserve(projectId: string): Promise<void> {
    const path = this.pathFor(projectId);
    try {
      await rename(path, `${path}.corrupt-${Date.now()}`);
      // eslint-disable-next-line no-restricted-syntax -- 损坏文件改名失败不影响调用方：原读取错误已经报告并返回空列表
    } catch {
      /* the original read already reported the damage; cleanup is best effort */
    }
  }
}
