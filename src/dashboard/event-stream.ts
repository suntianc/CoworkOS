import { createHash, type Hash } from "node:crypto";
import { open, readFile, stat, readdir, type FileHandle } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { runtimeEventRecord, viewRuntimeEvent } from "../runtime/conversation-history.js";

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
    // eslint-disable-next-line no-restricted-syntax -- 文件可能尚未创建或正在被重写，调用方传给的 fallback 就是缺失时的取值
  } catch {
    return fallback;
  }
}

/** Include one extra complete line so a range beginning inside a record can
 * discard that prefix without losing a requested record or splitting UTF-8. */
async function readTailBytes(
  handle: FileHandle,
  size: number,
  limit: number,
  isClosed = () => false
): Promise<Buffer> {
  let position = size;
  let tail = Buffer.alloc(0);
  while (position > 0) {
    const length = Math.min(position, 65_536);
    position -= length;
    const chunk = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      if (isClosed()) return Buffer.alloc(0);
      const { bytesRead } = await handle.read(chunk, filled, length - filled, position + filled);
      if (isClosed()) return Buffer.alloc(0);
      if (!bytesRead) break;
      filled += bytesRead;
    }
    tail = Buffer.concat([chunk.subarray(0, filled), tail]);
    const complete = tail.toString("utf8").split(/\r?\n/).slice(0, -1).filter(Boolean);
    if (position > 0 && complete.length <= limit) continue;
    return position > 0 ? tail.subarray(tail.indexOf(10) + 1) : tail;
  }
  return tail;
}

export async function readJsonLines(path: string, limit: number): Promise<Array<Record<string, unknown>>> {
  if (limit <= 0) return [];
  try {
    const handle = await open(path, "r");
    try {
      const tail = await readTailBytes(handle, (await handle.stat()).size, limit);
      return tail
        .toString("utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-limit)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
            // eslint-disable-next-line no-restricted-syntax -- JSONL 末行可能只写了一半，跳过该行并保留它前面的完整记录
          } catch {
            return [];
          }
        });
    } finally {
      await handle.close();
    }
    // eslint-disable-next-line no-restricted-syntax -- 打开或读取失败（文件还不存在、任务目录已删）时按无历史返回，调用方继续轮询
  } catch {
    return [];
  }
}

interface JsonlReadCursor {
  offset: number;
  pending: string;
  decoder: StringDecoder;
  identity?: string;
  prefixHash?: Hash;
}

async function matchesReadPrefix(handle: FileHandle, cursor: JsonlReadCursor, isClosed: () => boolean) {
  if (!cursor.offset) return true;
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = handle.createReadStream({ start: 0, end: cursor.offset - 1, autoClose: false });
  for await (const chunk of stream) {
    if (isClosed()) return false;
    hash.update(chunk);
    bytes += (chunk as Buffer).length;
  }
  return bytes === cursor.offset && hash.digest("hex") === cursor.prefixHash?.copy().digest("hex");
}

/** Read only bytes appended since the previous poll, preserving an incomplete
 * final JSON line until the next chunk arrives. This keeps a long streaming
 * run from reparsing its entire runtime-output.log on each streaming tick. */
async function readRuntimeEventsSince(
  path: string,
  cursor: JsonlReadCursor,
  { initialLimit, isClosed = () => false }: { initialLimit?: number; isClosed?: () => boolean } = {}
): Promise<Array<Record<string, unknown>>> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (isClosed()) return [];
  if (info.size === cursor.offset && (!cursor.identity || cursor.identity === `${info.dev}:${info.ino}`))
    return [];
  const handle = await open(path, "r");
  const parsed: Array<Record<string, unknown>> = [];
  try {
    if (isClosed()) return [];
    // The path can be atomically replaced between stat and open. Bind the
    // identity, range and cursor to the same handle that supplies the bytes.
    info = await handle.stat();
    if (isClosed()) return [];
    const identity = `${info.dev}:${info.ino}`;
    const firstRead = cursor.identity === undefined;
    const replaced = cursor.identity !== undefined && cursor.identity !== identity;
    // Atomic replacement can retain the complete prefix plus an append. Check
    // that prefix only on replacement so it cannot replay old token deltas.
    const preserved =
      replaced && cursor.prefixHash && info.size >= cursor.offset
        ? await matchesReadPrefix(handle, cursor, isClosed)
        : false;
    if (isClosed()) return [];
    if (info.size < cursor.offset || (replaced && !preserved)) {
      cursor.offset = 0;
      cursor.pending = "";
      cursor.decoder = new StringDecoder("utf8");
      if (cursor.prefixHash) cursor.prefixHash = createHash("sha256");
    }
    cursor.identity = identity;
    const decode = (chunk: Buffer) => {
      const lines = (cursor.pending + cursor.decoder.write(chunk)).split(/\r?\n/);
      cursor.pending = lines.pop() || "";
      for (const line of lines) {
        try {
          const value = JSON.parse(line);
          if (value && typeof value === "object") parsed.push(value as Record<string, unknown>);
          // eslint-disable-next-line no-restricted-syntax -- 运行日志的一行可能在写入中途被读到，跳过它不能中断整条流
        } catch {
          /* retain the stream; malformed lines are not UI-fatal */
        }
      }
    };
    if (firstRead && initialLimit !== undefined) {
      const bytes = await readTailBytes(handle, info.size, initialLimit, isClosed);
      if (isClosed()) return [];
      decode(bytes);
      cursor.offset = info.size;
      return parsed.slice(-initialLimit);
    }
    if (info.size === cursor.offset) return [];
    const stream = handle.createReadStream({ start: cursor.offset, end: info.size - 1, autoClose: false });
    for await (const chunk of stream) {
      if (isClosed()) return [];
      // Appends can end inside a UTF-8 code point. Retain its undecoded bytes
      // across polls rather than flushing a new decoder at every range's end.
      decode(chunk as Buffer);
      cursor.prefixHash?.update(chunk);
      cursor.offset += (chunk as Buffer).length;
    }
  } finally {
    await handle.close();
  }
  return parsed;
}

export function streamRunEvents(
  request: IncomingMessage,
  response: ServerResponse,
  taskId: string,
  runId: string,
  taskWorkspace: string
): void {
  const eventsPath = join(taskWorkspace, taskId, "runs", runId, "run_events.jsonl");
  const runtimePath = join(taskWorkspace, taskId, "runs", runId, "runtime-output.log");
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });
  response.write(": cowork event stream connected\n\n");
  // Replay a bounded ledger tail, then follow appended bytes. Event identities
  // also suppress recent duplicates after file replacement or truncation.
  const sentEventKeys = new Set<string>();
  const runtimeReadCursor: JsonlReadCursor = {
    offset: 0,
    pending: "",
    decoder: new StringDecoder("utf8"),
    prefixHash: createHash("sha256")
  };
  const ledgerReadCursor: JsonlReadCursor = {
    offset: 0,
    pending: "",
    decoder: new StringDecoder("utf8")
  };
  let ledgerStarted = false;
  let runtimeCursor = 0;
  let closed = false;
  let emitting = false;
  let ledgerReadAt = -Infinity;
  let watchReadAt = -Infinity;
  const watchCursors = new Map<string, JsonlReadCursor>();
  const emit = async (): Promise<void> => {
    if (closed || emitting) return;
    emitting = true;
    try {
      // Durable task state changes less often than token deltas. Keep its
      // existing cadence while tailing the runtime log at interactive latency.
      const now = performance.now();
      if (now - ledgerReadAt >= 250) {
        ledgerReadAt = now;
        const events = await readRuntimeEventsSince(eventsPath, ledgerReadCursor, {
          initialLimit: ledgerStarted ? undefined : 500,
          isClosed: () => closed
        });
        ledgerStarted = true;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- closed 由 close() 在 request/response 的 close 监听里置位，TS 看不到这次写入
        if (closed) return;
        for (const event of events) {
          const eventId = typeof event.eventId === "string" ? event.eventId : "";
          const eventKey =
            eventId || `${event.occurredAt ?? ""}:${event.type ?? ""}:${JSON.stringify(event.payload ?? {})}`;
          if (sentEventKeys.has(eventKey)) continue;
          response.write(`id: ${eventId}\ndata: ${JSON.stringify(event)}\n\n`);
          sentEventKeys.add(eventKey);
        }
        // Appended ranges never replay old keys. Keep a bounded recent set for
        // a file replacement or truncation while the connection remains open.
        if (sentEventKeys.size > 6_000) {
          for (const key of sentEventKeys) {
            if (sentEventKeys.size <= 6_000) break;
            sentEventKeys.delete(key);
          }
        }
      }
      if (now - watchReadAt >= 1000) {
        watchReadAt = now;
        const directory = join(taskWorkspace, taskId, "watch", "programs");
        // eslint-disable-next-line no-restricted-syntax -- watch/programs 只在有监视程序时存在，缺失就是没有程序
        const programs = await readdir(directory).catch(() => []);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- closed 由 close() 在 request/response 的 close 监听里置位，readdir 返回后连接可能已断开
        if (closed) return;
        for (const programId of programs) {
          if (!/^[a-zA-Z0-9_-]+$/.test(programId)) continue;
          const path = join(directory, programId, "events", "events.jsonl");
          let cursor = watchCursors.get(programId);
          if (!cursor) {
            const size = await stat(path)
              .then((info) => info.size)
              // eslint-disable-next-line no-restricted-syntax -- 程序事件文件要到第一条事件才创建，缺失时从文件开头跟随
              .catch(() => 0);
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- closed 由 close() 在 request/response 的 close 监听里置位，stat 期间连接可能已断开
            if (closed) return;
            cursor = { offset: Math.max(0, size - 65_536), pending: "", decoder: new StringDecoder("utf8") };
            watchCursors.set(programId, cursor);
          }
          const events = await readRuntimeEventsSince(path, cursor, { isClosed: () => closed });
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- closed 由 close() 在 request/response 的 close 监听里置位，读文件期间连接可能已断开
          if (closed) return;
          for (const event of events) {
            const eventId = `watch-ui-${createHash("sha256").update(JSON.stringify(event)).digest("hex").slice(0, 32)}`;
            response.write(
              `id: ${eventId}\ndata: ${JSON.stringify({ eventId, type: "watch.changed", taskId, runId, occurredAt: event.occurredAt, payload: { programId, event } })}\n\n`
            );
          }
        }
      }
      const runtimeEvents = await readRuntimeEventsSince(runtimePath, runtimeReadCursor, {
        isClosed: () => closed
      });
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- closed 由 close() 在 request/response 的 close 监听里置位，读取运行日志期间连接可能已断开
      if (closed) return;
      for (const event of runtimeEvents) {
        const record = viewRuntimeEvent(runtimeEventRecord(taskId, runId, runtimeCursor, event));
        response.write(`id: ${record.eventId}\ndata: ${JSON.stringify(record)}\n\n`);
        runtimeCursor += 1;
      }
      // eslint-disable-next-line no-restricted-syntax -- 运行文件要到第一条事件落盘才存在，这一轮按无新事件处理，下一次 tick 重试
    } catch {
      // The run file may not exist until the first event is committed.
    } finally {
      emitting = false;
    }
  };
  const timer = setInterval(() => {
    void emit();
  }, 40);
  const keepAlive = setInterval(() => {
    if (!closed) response.write(": keep-alive\n\n");
  }, 15_000);
  const timeout = setTimeout(() => response.end(), 30 * 60_000);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearInterval(keepAlive);
    clearTimeout(timeout);
  };
  request.once("close", close);
  response.once("close", close);
  void emit();
}
