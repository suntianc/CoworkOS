import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import { appendLine, atomicWrite, jsonLine, missing } from "./fs-utils.js";
import { ApplicationError, type AppOperationEvent } from "./types.js";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const FORMAT = "atria.operation.v1";
const INLINE_BYTES = 16 * 1024;
const STRING_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 128 * 1024 * 1024;

/** A page keeps full events, with at least the newest event even when it alone exceeds this budget. */
export const HISTORY_PAGE_BYTES = 8 * 1024 * 1024;

export interface StoredOperation {
  /** Validated against FORMAT when read back from the log; the file is not trusted. */
  format: string;
  /** Validated when read back: a persisted header may predate or lack the event. */
  event?: AppOperationEvent;
  details: string;
  bytes: number;
}

interface StringReference {
  path: Array<string | number>;
  digest: string;
}

interface OperationDetails {
  version: 1;
  event: AppOperationEvent;
  strings: StringReference[];
}

export interface HistoryEntry {
  /** Payloads are placeholders here; hydrate before returning a complete event. */
  event: AppOperationEvent;
  bytes: number;
  offset: number;
  length: number;
  details?: string;
}

const digestOf = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const headerOf = (event: AppOperationEvent): AppOperationEvent => ({
  ...event,
  payload: null,
  ...(event.inverse ? { inverse: { operationType: event.inverse.operationType, payload: null } } : {})
});

/**
 * Append-only history with small log headers and content-addressed payloads.
 * Large strings (embedded media) are stored once, shared by forward and inverse
 * snapshots and every later save. Old inline JSONL remains readable, one line
 * at a time. Scans never retain all historical documents in memory.
 */
export class OperationHistory {
  private readonly log: string;
  private readonly blobs: string;

  constructor(directory: string) {
    this.log = join(directory, "operations.jsonl");
    this.blobs = join(directory, "history-blobs");
  }

  async *scan(): AsyncGenerator<HistoryEntry> {
    let offset = 0;
    let chunks: Buffer[] = [];
    let length = 0;
    const entry = (line: Buffer): HistoryEntry | undefined => {
      let parsed: AppOperationEvent | StoredOperation | null;
      try {
        parsed = JSON.parse(line.toString("utf8")) as AppOperationEvent | StoredOperation | null;
        // eslint-disable-next-line no-restricted-syntax -- 崩溃可能留下半行 JSONL，丢掉这一行后由恢复流程补写完整回执
      } catch {
        // Recovery appends a complete receipt after a torn tail.
        return undefined;
      }
      if (!parsed || typeof parsed !== "object") return undefined;
      if ("format" in parsed) {
        if (
          parsed.format !== FORMAT ||
          !parsed.event ||
          typeof parsed.details !== "string" ||
          !/^[a-f0-9]{64}$/.test(parsed.details) ||
          !Number.isSafeInteger(parsed.bytes) ||
          parsed.bytes < 1 ||
          parsed.bytes > MAX_EVENT_BYTES
        )
          throw this.unreadable("历史记录格式或引用无效");
        return {
          event: headerOf(parsed.event),
          bytes: parsed.bytes,
          details: parsed.details,
          offset,
          length: line.length
        };
      }
      if (!parsed.eventId || !parsed.operationId) return undefined;
      return { event: headerOf(parsed), bytes: line.length, offset, length: line.length };
    };
    try {
      for await (const raw of createReadStream(this.log)) {
        const chunk = raw as Buffer;
        let start = 0;
        for (;;) {
          const end = chunk.indexOf(10, start);
          const part = chunk.subarray(start, end < 0 ? undefined : end);
          chunks.push(part);
          length += part.length;
          if (length > MAX_EVENT_BYTES) throw this.unreadable("单条操作历史超过安全读取上限");
          if (end < 0) break;
          const line = Buffer.concat(chunks, length);
          const parsed = entry(line);
          if (parsed) yield parsed;
          offset += length + 1;
          chunks = [];
          length = 0;
          start = end + 1;
          if (start === chunk.length) break;
        }
      }
      if (length) {
        const parsed = entry(Buffer.concat(chunks, length));
        if (parsed) yield parsed;
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  async entries(): Promise<HistoryEntry[]> {
    const entries: HistoryEntry[] = [];
    for await (const entry of this.scan()) entries.push(entry);
    return entries;
  }

  async find(operationId: string): Promise<AppOperationEvent | undefined> {
    for await (const entry of this.scan()) {
      if (entry.event.operationId === operationId) return this.hydrate(entry);
    }
    return undefined;
  }

  async contains(operationId: string): Promise<boolean> {
    for await (const entry of this.scan()) if (entry.event.operationId === operationId) return true;
    return false;
  }

  async page(
    afterRevision: number | undefined,
    limit: number
  ): Promise<{ operations: AppOperationEvent[]; hasMore: boolean }> {
    const selected: HistoryEntry[] = [];
    let count = 0;
    let bytes = 0;
    for await (const entry of this.scan()) {
      if (afterRevision !== undefined && entry.event.revision <= afterRevision) continue;
      count++;
      selected.push(entry);
      bytes += entry.bytes;
      while (selected.length > 1 && (selected.length > limit || bytes > HISTORY_PAGE_BYTES)) {
        bytes -= selected.shift()!.bytes;
      }
    }
    const operations: AppOperationEvent[] = [];
    for (const entry of selected) operations.push(await this.hydrate(entry));
    return { operations, hasMore: count > selected.length };
  }

  async hydrate(entry: HistoryEntry): Promise<AppOperationEvent> {
    if (!entry.details) {
      const handle = await open(this.log, "r");
      try {
        const body = Buffer.alloc(entry.length);
        let read = 0;
        while (read < body.length) {
          const result = await handle.read(body, read, body.length - read, entry.offset + read);
          if (!result.bytesRead) throw this.unreadable("操作历史读取被截断");
          read += result.bytesRead;
        }
        return JSON.parse(body.toString("utf8")) as AppOperationEvent;
      } finally {
        await handle.close();
      }
    }
    const details = JSON.parse(await this.readBlob(entry.details)) as Partial<OperationDetails>;
    if (details.version !== 1 || !details.event || !Array.isArray(details.strings))
      throw this.unreadable("操作历史内容格式无效", entry.details);
    const strings = new Map<string, string>();
    for (const reference of details.strings) {
      if (!Array.isArray(reference.path) || !reference.path.length)
        throw this.unreadable("操作历史字符串引用无效", entry.details);
      let parent: unknown = details.event;
      for (const key of reference.path.slice(0, -1)) parent = this.child(parent, key, entry.details);
      const key = reference.path.at(-1)!;
      this.child(parent, key, entry.details);
      let value = strings.get(reference.digest);
      if (value === undefined) {
        value = JSON.parse(await this.readBlob(reference.digest)) as string;
        if (typeof value !== "string") throw this.unreadable("操作历史字符串内容无效", reference.digest);
        strings.set(reference.digest, value);
      }
      (parent as Record<string | number, unknown>)[key] = value;
    }
    if (
      details.event.eventId !== entry.event.eventId ||
      details.event.operationId !== entry.event.operationId ||
      details.event.resourceId !== entry.event.resourceId ||
      details.event.revision !== entry.event.revision
    )
      throw this.unreadable("操作历史头与内容身份不一致", entry.details);
    return details.event;
  }

  async prepare(event: AppOperationEvent): Promise<AppOperationEvent | StoredOperation> {
    const body = JSON.stringify(event);
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > MAX_EVENT_BYTES)
      throw new ApplicationError("resource_too_large", "单条操作历史超过 128 MiB 上限", {
        limit: MAX_EVENT_BYTES
      });
    let record: AppOperationEvent | StoredOperation = event;
    if (bytes > INLINE_BYTES) {
      const strings: StringReference[] = [];
      const blobs = new Map<string, string>();
      const split = (value: unknown, path: Array<string | number>): unknown => {
        if (typeof value === "string" && Buffer.byteLength(value, "utf8") >= STRING_BYTES) {
          // JSON encoding preserves lone UTF-16 surrogates, which writing the
          // raw string as UTF-8 would irreversibly replace with U+FFFD.
          const encoded = JSON.stringify(value);
          const digest = digestOf(encoded);
          strings.push({ path, digest });
          blobs.set(digest, encoded);
          return null;
        }
        if (Array.isArray(value)) return value.map((child, index) => split(child, [...path, index]));
        if (value && typeof value === "object") {
          return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [key, split(child, [...path, key])])
          );
        }
        return value;
      };
      const details: OperationDetails = { version: 1, event: split(event, []) as AppOperationEvent, strings };
      // Every referenced blob is flushed before its log header can become durable.
      for (const [digest, value] of blobs) await this.writeBlob(digest, value);
      const encoded = JSON.stringify(details);
      const digest = digestOf(encoded);
      await this.writeBlob(digest, encoded);
      record = { format: FORMAT, event: headerOf(event), details: digest, bytes };
    }
    return record;
  }

  async append(event: AppOperationEvent): Promise<void> {
    return this.appendPrepared(await this.prepare(event));
  }

  async appendPrepared(record: AppOperationEvent | StoredOperation): Promise<void> {
    // A failed append may leave bytes without a newline. Never concatenate the
    // next valid receipt onto those bytes, which would also make it unparseable.
    try {
      const handle = await open(this.log, "r");
      try {
        const { size } = await handle.stat();
        if (size) {
          const last = Buffer.alloc(1);
          await handle.read(last, 0, 1, size - 1);
          if (last[0] !== 10) await appendLine(this.log, "\n");
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await appendLine(this.log, jsonLine(record));
  }

  private blobPath(digest: string): string {
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
      throw this.unreadable("操作历史内容引用不是合法的 SHA-256");
    return join(this.blobs, `${digest}.gz`);
  }

  private async writeBlob(digest: string, value: string): Promise<void> {
    await mkdir(this.blobs, { recursive: true });
    await this.assertBlobDirectory();
    const path = this.blobPath(digest);
    try {
      await lstat(path);
      await this.readBlob(digest);
      return;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await atomicWrite(path, await compress(value));
  }

  private async readBlob(digest: string): Promise<string> {
    const path = this.blobPath(digest);
    try {
      await this.assertBlobDirectory();
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_EVENT_BYTES)
        throw new Error("内容文件不是有界普通文件");
      const body = (await decompress(await readFile(path), { maxOutputLength: MAX_EVENT_BYTES })).toString(
        "utf8"
      );
      if (digestOf(body) !== digest) throw new Error("内容 SHA-256 校验失败");
      return body;
    } catch (error) {
      throw this.unreadable(error instanceof Error ? error.message : String(error), digest);
    }
  }

  private async assertBlobDirectory(): Promise<void> {
    const info = await lstat(this.blobs);
    if (!info.isDirectory() || info.isSymbolicLink()) throw this.unreadable("操作历史内容目录不是普通目录");
  }

  private child(parent: unknown, key: string | number, digest: string): unknown {
    if (
      (typeof key !== "string" && typeof key !== "number") ||
      !parent ||
      typeof parent !== "object" ||
      !Object.hasOwn(parent, key)
    )
      throw this.unreadable("操作历史内容路径无效", digest);
    return (parent as Record<string | number, unknown>)[key];
  }

  private unreadable(reason: string, digest?: string): ApplicationError {
    return new ApplicationError("resource_recovery_required", "操作历史内容缺失或损坏，请恢复文档备份", {
      path: digest ? this.blobPath(digest) : this.log,
      reason
    });
  }
}
