import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { HttpError, sendJson } from "./http.js";

/**
 * Idempotent management commands.
 *
 * A client that sends a change command names it with an `operationId`. The
 * command runs once; its result is written beside the data root before the
 * response leaves, and a retry with the same identity, operation and content
 * gets that saved result back instead of doing the work again. The same
 * operation id with different content is a client bug and is refused, so a
 * retry can never quietly become a different command.
 *
 * The receipt is the durable half of the contract: after a lost response or a
 * process crash the client asks for the receipt and then retries safely. The
 * window this covers is a saved result whose response never arrived. A crash
 * between the business write and saving the receipt cannot be detected here;
 * that is why a command's own business write stays the authority and this layer
 * never fabricates a result it did not observe.
 */
export interface CommandOutcome<T> {
  status: number;
  body: T;
  /** The saved result of an earlier attempt, not a second execution. */
  replayed: boolean;
}

export interface CommandReceipt<T = unknown> {
  operationId: string;
  command: string;
  status: number;
  body: T;
  completedAt: string;
}

export interface ManagedCommand<T> {
  /** The authenticated identity; receipts never cross identities. */
  principalId: string;
  /** Absent keeps the legacy single-shot behaviour for the existing UI. */
  operationId?: unknown;
  command: string;
  /** The command content the fingerprint covers, excluding the operation id. */
  content: unknown;
  apply(): Promise<{ status: number; body: T }>;
}

export interface CommandRunner {
  run<T>(input: ManagedCommand<T>): Promise<CommandOutcome<T>>;
  read(principalId: string, operationId: string): Promise<CommandReceipt | undefined>;
}

interface ReceiptDocument extends CommandReceipt {
  version: 1;
  fingerprint: string;
}

const OPERATION_ID = /^[A-Za-z0-9._:-]{1,200}$/;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable JSON: object key order must not change a command's identity. */
export function stableJson(value: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 入参是 unknown，undefined、函数与 symbol 经 JSON.stringify 返回 undefined，这里必须保留 "null" 才能继续返回字符串
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

/** The request body without the command's identity field. */
export function commandContent(body: Record<string, unknown>): Record<string, unknown> {
  const content = { ...body };
  delete content.operationId;
  return content;
}

export function operationIdOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !OPERATION_ID.test(value))
    throw new HttpError(400, "operationId 需为 1–200 个字母、数字或 . _ : - 字符", "operation_id_invalid");
  return value;
}

function validReceipt(value: unknown): value is ReceiptDocument {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<ReceiptDocument>;
  return (
    receipt.version === 1 &&
    typeof receipt.operationId === "string" &&
    typeof receipt.command === "string" &&
    typeof receipt.fingerprint === "string" &&
    typeof receipt.status === "number" &&
    typeof receipt.completedAt === "string" &&
    "body" in receipt
  );
}

/**
 * One write per (identity, operation) pair, so a retry of the same command
 * cannot race its own first attempt and apply the business change twice.
 */
export class FileCommandRunner implements CommandRunner {
  private readonly directory: string;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(directory: string) {
    this.directory = directory;
  }

  private pathFor(principalId: string, operationId: string): string {
    return join(this.directory, `${digest(`${principalId}\n${operationId}`)}.json`);
  }

  private async readReceipt(path: string): Promise<ReceiptDocument | undefined> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
      // eslint-disable-next-line no-restricted-syntax -- 回执文件可能被截断，解析失败不等于没有执行过；下面把 parsed 置空后按路径报 500，禁止重跑命令
    } catch {
      parsed = undefined;
    }
    // A damaged receipt may describe a change that already happened. Re-running
    // the command would apply it twice, so refuse and name the file instead.
    if (!validReceipt(parsed))
      throw new HttpError(500, `命令回执无法解析，请保留文件后检查：${path}`, "operation_receipt_invalid");
    return parsed;
  }

  private serialize<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.then(action, action);
    this.queues.set(key, run);
    const clear = () => {
      if (this.queues.get(key) === run) this.queues.delete(key);
    };
    run.then(clear, clear);
    return run;
  }

  async run<T>(input: ManagedCommand<T>): Promise<CommandOutcome<T>> {
    const operationId = operationIdOf(input.operationId);
    if (!operationId) return { ...(await input.apply()), replayed: false };
    const path = this.pathFor(input.principalId, operationId);
    const fingerprint = digest(stableJson({ command: input.command, content: input.content }));
    return this.serialize(path, async () => {
      const saved = await this.readReceipt(path);
      if (saved) {
        if (saved.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            `operationId ${operationId} 已用于不同的命令内容；请换用新的 operationId，或查询原结果`,
            "operation_conflict"
          );
        return { status: saved.status, body: saved.body as T, replayed: true };
      }
      const result = await input.apply();
      const receipt: ReceiptDocument = {
        version: 1,
        operationId,
        command: input.command,
        fingerprint,
        status: result.status,
        body: result.body,
        completedAt: new Date().toISOString()
      };
      await this.writeReceipt(path, receipt);
      return { ...result, replayed: false };
    });
  }

  private async writeReceipt(path: string, receipt: ReceiptDocument): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  }

  async read(principalId: string, operationId: string): Promise<CommandReceipt | undefined> {
    if (!OPERATION_ID.test(operationId)) return undefined;
    const valid = operationId;
    const receipt = await this.readReceipt(this.pathFor(principalId, valid));
    if (!receipt) return undefined;
    return {
      operationId: receipt.operationId,
      command: receipt.command,
      status: receipt.status,
      body: receipt.body,
      completedAt: receipt.completedAt
    };
  }
}

/**
 * Run a change command, or the legacy single-shot path for a client that sends
 * no operation id. A partial handler with no command store (a test that mounts
 * one router) keeps the pre-protocol behaviour.
 */
export function runCommand<T>(
  commands: CommandRunner | undefined,
  input: ManagedCommand<T>
): Promise<CommandOutcome<T>> {
  if (!commands) return input.apply().then((result) => ({ ...result, replayed: false }));
  return commands.run(input);
}

/** The saved status and body, marked when it is an earlier attempt's result. */
export function sendCommandOutcome<T>(response: ServerResponse, outcome: CommandOutcome<T>): void {
  if (outcome.replayed) response.setHeader("x-cowork-replayed", "1");
  sendJson(response, outcome.status, outcome.body);
}
