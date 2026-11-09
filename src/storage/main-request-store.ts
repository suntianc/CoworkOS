import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context, Model } from "@earendil-works/pi-ai";
import { withFileLock } from "./file-lock.js";
import {
  validMainRequestExecutionScope,
  type MainRequestExecutionScope
} from "../runtime/main-request-execution-scope.js";
import { readModelRequestRetry } from "../runtime/model-request-retry.js";

export type MainRequestModel = Model<"openai-completions" | "openai-responses">;
export class MainRequestSnapshotError extends Error {
  readonly status = 400;
  readonly code = "main_retry_snapshot_invalid";
}
export interface MainRequestEnvironment {
  projectDirectory: string;
  binding: string;
}
export interface MainRequestSnapshot {
  version: 1;
  taskId: string;
  runId: string;
  requestId: string;
  retryOf?: string;
  /** Stable user-input ownership; unlike requestId, this survives model requests and retries. */
  goalDelegationRequestId?: string;
  state: "pending" | "failed" | "completed";
  model: MainRequestModel;
  context: Context;
  sessionId?: string;
  environment: MainRequestEnvironment;
  /** Older snapshots remain readable for audit, but exact replay fails closed. */
  executionScope?: MainRequestExecutionScope;
  endpoint?: string;
  body: string;
  bodySha256: string;
  checksum: string;
}

export const mainRequestPath = (workspaceRoot: string, taskId: string): string =>
  join(workspaceRoot, taskId, "sessions", "main", "request-retry.json");
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
const checksum = (snapshot: Partial<MainRequestSnapshot>) =>
  hash(JSON.stringify(Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "checksum"))));
const validModel = (model: MainRequestModel | null | undefined) =>
  model &&
  typeof model.id === "string" &&
  typeof model.provider === "string" &&
  ["openai-completions", "openai-responses"].includes(model.api) &&
  typeof model.baseUrl === "string" &&
  typeof model.reasoning === "boolean" &&
  Array.isArray(model.input) &&
  Number.isFinite(model.maxTokens) &&
  Number.isFinite(model.contextWindow);

export function parseMainRequestModel(serialized: string): MainRequestModel {
  const model = JSON.parse(serialized) as MainRequestModel;
  if (!validModel(model)) throw new Error("原请求模型记录损坏，已保留记录。请检查后重试。");
  return model;
}

/** Private execution state, distinct from redacted audit archives. Never stores auth headers. */
export class MainRequestStore {
  constructor(
    readonly filePath: string,
    readonly taskId: string
  ) {}

  async read(): Promise<MainRequestSnapshot | undefined> {
    let snapshot: MainRequestSnapshot;
    try {
      snapshot = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new MainRequestSnapshotError("原请求快照无法读取，已保留记录。请检查后重试。", { cause: error });
    }
    if (
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 快照来自磁盘上的 JSON，可能是 null 或非对象；直接读 version 会抛 TypeError 而不是按损坏快照报告
      snapshot?.version !== 1 ||
      snapshot.taskId !== this.taskId ||
      typeof snapshot.runId !== "string" ||
      typeof snapshot.requestId !== "string" ||
      (snapshot.goalDelegationRequestId !== undefined &&
        (typeof snapshot.goalDelegationRequestId !== "string" ||
          !snapshot.goalDelegationRequestId.length ||
          snapshot.goalDelegationRequestId.length > 512)) ||
      !["pending", "failed", "completed"].includes(snapshot.state) ||
      !validModel(snapshot.model) ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 旧版快照可能没有 context 字段，缺失时须按损坏快照报错而不是抛 TypeError
      !Array.isArray(snapshot.context?.messages) ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 旧版快照可能没有 environment 字段，缺失时须按损坏快照报错而不是抛 TypeError
      typeof snapshot.environment?.projectDirectory !== "string" ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 同上，environment 可能整段缺失；缺 binding 时按损坏快照报错
      typeof snapshot.environment?.binding !== "string" ||
      (snapshot.executionScope !== undefined && !validMainRequestExecutionScope(snapshot.executionScope)) ||
      (snapshot.endpoint !== undefined && typeof snapshot.endpoint !== "string") ||
      typeof snapshot.body !== "string" ||
      snapshot.bodySha256 !== hash(snapshot.body) ||
      snapshot.checksum !== checksum(snapshot)
    )
      throw new MainRequestSnapshotError("原请求快照损坏，已保留记录。请检查后重试。");
    try {
      JSON.parse(snapshot.body);
      if (snapshot.endpoint) {
        const endpoint = new URL(snapshot.endpoint);
        if (
          !["http:", "https:"].includes(endpoint.protocol) ||
          endpoint.origin !== new URL(snapshot.model.baseUrl).origin
        )
          throw new Error("Invalid endpoint");
      }
    } catch (error) {
      throw new MainRequestSnapshotError("原请求正文损坏，已保留记录。请检查后重试。", { cause: error });
    }
    return snapshot;
  }

  async pending(): Promise<MainRequestSnapshot | undefined> {
    const snapshot = await this.read();
    return snapshot?.state === "completed" ? undefined : snapshot;
  }

  /** Validate the slot's Task/Run/request identity while another process cannot replace it. */
  async inspectPending<T>(inspect: (snapshot: MainRequestSnapshot | undefined) => Promise<T>): Promise<T> {
    return withFileLock(this.filePath, async () => inspect(await this.pending()), { recoverDeadOwner: true });
  }

  /** Keep a retry recoverable if its selected Run fails before opening HTTP. */
  async reassignRun(original: MainRequestSnapshot, runId: string): Promise<void> {
    await withFileLock(
      this.filePath,
      async () => {
        const current = await this.pending();
        if (
          current?.requestId !== original.requestId ||
          current.runId !== original.runId ||
          current.checksum !== original.checksum
        )
          throw new MainRequestSnapshotError("要重试的原请求已变化，已有内容仍保留。请刷新后重试。");
        if (current.runId !== runId) await this.write({ ...current, runId });
      },
      { recoverDeadOwner: true }
    );
  }

  /** Read-only compatibility: old records never enter the active replay chain. */
  async legacyPending() {
    try {
      await readFile(`${this.filePath}.cleared`, "utf8");
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const legacy = await readModelRequestRetry(join(dirname(this.filePath), "retry-request.json"));
    return legacy?.state === "completed" ? undefined : legacy;
  }

  async begin(
    input: Omit<MainRequestSnapshot, "version" | "taskId" | "state" | "bodySha256" | "checksum">,
    expected?: { runId: string; requestId: string }
  ): Promise<void> {
    const model = { ...input.model };
    delete model.headers;
    await withFileLock(
      this.filePath,
      async () => {
        if (expected) {
          const current = await this.pending();
          if (current?.runId !== expected.runId || current.requestId !== expected.requestId)
            throw new MainRequestSnapshotError("要重试的原请求已变化，已有内容仍保留。请刷新后重试。");
        }
        await this.write({
          ...input,
          model,
          version: 1,
          taskId: this.taskId,
          state: "pending",
          bodySha256: hash(input.body)
        });
      },
      { recoverDeadOwner: true }
    );
  }

  async settle(requestId: string, state: "failed" | "completed"): Promise<void> {
    await withFileLock(
      this.filePath,
      async () => {
        const snapshot = await this.read();
        // A later request, or a newly accepted user turn, owns this slot now.
        if (snapshot?.requestId === requestId) await this.write({ ...snapshot, state });
      },
      { recoverDeadOwner: true }
    );
  }

  async clear(): Promise<void> {
    await withFileLock(
      this.filePath,
      async () => {
        // Retiring a user turn must not revive a leftover legacy snapshot after restart.
        await writeFile(`${this.filePath}.cleared`, "1\n", { mode: 0o600 });
        await rm(this.filePath, { force: true });
      },
      { recoverDeadOwner: true }
    );
  }

  private async write(snapshot: Omit<MainRequestSnapshot, "checksum">): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ ...snapshot, checksum: checksum(snapshot) }), {
        mode: 0o600,
        flag: "wx"
      });
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
