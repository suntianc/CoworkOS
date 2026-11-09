import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export interface TrajectoryEntry {
  id: string;
  kind: "tool" | "message" | "state";
  title: string;
  text: string;
  time?: string;
  status: "running" | "completed" | "failed";
  result?: string;
}
interface TraceCache {
  offset: number;
  pending: string;
  entries: TrajectoryEntry[];
  total: number;
  busy?: Promise<void>;
}
const caches = new Map<string, TraceCache>();
const clip = (value: unknown, max = 6000): string => {
  const text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
function contentText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      if (!part || typeof part !== "object" || !("text" in part)) return [];
      const text = String(part.text ?? "").trim();
      return text ? [text] : [];
    })
    .join("\n");
}

interface TraceRecord {
  type?: string;
  payload?: TraceRecord;
  occurredAt?: string;
  timestamp?: string;
  eventId?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
  result?: { content?: unknown; isError?: boolean; details?: { ok?: boolean } };
  message?: { role?: string; content?: unknown; stopReason?: string };
}
function consume(cache: TraceCache, record: TraceRecord): void {
  const event =
    record.type?.startsWith("trace.") || record.type === "runtime_event" ? record.payload || {} : record;
  const time = record.occurredAt || event.timestamp;
  const id = event.toolCallId || record.eventId || `${cache.total}:${time || ""}`;
  const add = (entry: TrajectoryEntry) => {
    cache.entries.push(entry);
    cache.total++;
    if (cache.entries.length > 120) cache.entries.shift();
  };
  if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
    const previous =
      event.toolCallId &&
      cache.entries.find((entry) => entry.kind === "tool" && entry.id === event.toolCallId);
    const entry: TrajectoryEntry = previous || {
      id,
      kind: "tool",
      title: event.toolName || "工具调用",
      text: clip(event.args),
      time,
      status: "running"
    };
    if (event.type === "tool_execution_end") {
      entry.status =
        event.isError || event.result?.isError || event.result?.details?.ok === false
          ? "failed"
          : "completed";
      entry.result = clip(contentText(event.result?.content) || event.result);
    }
    if (!previous) add(entry);
  } else if (event.type === "message_end" && event.message?.role === "assistant") {
    const text = contentText(event.message.content);
    if (text)
      add({
        id,
        kind: "message",
        title: "智能体回复",
        text: clip(text),
        time,
        status: event.message.stopReason === "error" ? "failed" : "completed"
      });
  } else if (event.type === "agent_start" || event.type === "agent_end") {
    add({
      id,
      kind: "state",
      title: event.type === "agent_start" ? "开始执行" : "执行结束",
      text: "",
      time,
      status: "completed"
    });
  }
}

/** Compact the actual persisted trace. Subsequent refreshes read only appended
 * bytes, avoiding repeated full reads of large streaming event logs. */
export async function readAgentTrajectory(
  path: string
): Promise<{ entries: TrajectoryEntry[]; total: number }> {
  const info = await stat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return { entries: [], total: 0 };
  let cache = caches.get(path);
  if (!cache || info.size < cache.offset) {
    cache = { offset: 0, pending: "", entries: [], total: 0 };
    caches.set(path, cache);
    if (caches.size > 32) caches.delete(caches.keys().next().value!);
  }
  const current = cache;
  if (current.busy) await current.busy;
  if (info.size > current.offset) {
    current.busy = (async () => {
      for await (const chunk of createReadStream(path, {
        start: current.offset,
        end: info.size - 1,
        encoding: "utf8"
      })) {
        const lines = (current.pending + chunk).split("\n");
        current.pending = lines.pop() || "";
        for (const line of lines) {
          try {
            consume(current, JSON.parse(line));
            // eslint-disable-next-line no-restricted-syntax -- 事件日志按行追加，进程中断或正在写入的最后一行可能不完整，跳过它才能继续读取后续真实事件
          } catch {
            /* interrupted or malformed trace line */
          }
        }
      }
      current.offset = info.size;
    })();
    try {
      await current.busy;
    } finally {
      current.busy = undefined;
    }
  }
  return { entries: current.entries.map((entry) => ({ ...entry })), total: current.total };
}
