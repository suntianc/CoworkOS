import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readQueuedUserTurn } from "./queued-user-turn.js";
import { conversationMessages, type ConversationMessage } from "./conversation-view.js";

export function runtimeEventRecord(
  taskId: string,
  runId: string,
  index: number,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const message = payload.message as Record<string, unknown> | undefined;
  const queued = message?.role === "user" ? readQueuedUserTurn(message.content) : undefined;
  if (queued) payload = { ...payload, message: { ...message, id: queued.messageId, content: queued.text } };
  return {
    eventId: `runtime-${runId}-${index}`,
    type: "runtime_event",
    taskId,
    runId,
    agentId: "main",
    payload
  };
}

/** A conversation outlives its active run. Replay every run in creation order,
 * using the same identities as SSE, including repeated token deltas. */
export async function readTaskRuntimeEvents(
  workspaceRoot: string,
  taskId: string
): Promise<Array<Record<string, unknown>>> {
  const directory = join(workspaceRoot, taskId, "runs");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(directory, entry.name);
        const [metadata, output, ledger] = await Promise.all([
          // eslint-disable-next-line no-restricted-syntax -- 早期 Run 从未写过 run.json，缺失时按空元数据继续，createdAt 留空并由 runId 兜底排序
          readFile(join(path, "run.json"), "utf8").catch(() => "{}"),
          // eslint-disable-next-line no-restricted-syntax -- 启动即失败的 Run 可能没有 runtime-output.log，缺失时按无事件继续回放其余 Run
          readFile(join(path, "runtime-output.log"), "utf8").catch(() => ""),
          // eslint-disable-next-line no-restricted-syntax -- 同上，run_events.jsonl 可能尚未创建，缺失只表示该 Run 没有账本事件
          readFile(join(path, "run_events.jsonl"), "utf8").catch(() => "")
        ]);
        let createdAt = "";
        try {
          createdAt = JSON.parse(metadata).createdAt || "";
          // eslint-disable-next-line no-restricted-syntax -- 更早版本的 run.json 没有 createdAt，解析失败只影响排序键，必须继续回放该 Run 的事件
        } catch {
          /* older runs may lack metadata */
        }
        const events = output.split(/\r?\n/).flatMap((line) => {
          try {
            const value = JSON.parse(line);
            return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
            // eslint-disable-next-line no-restricted-syntax -- 日志按行追加，崩溃或并发写入可能留下半行，跳过它才能回放同一文件里其余完整事件
          } catch {
            return [];
          }
        });
        const ledgerEvents = ledger.split(/\r?\n/).flatMap((line) => {
          try {
            const value = JSON.parse(line);
            return [
              "user.interjected",
              "user.message_promoted",
              "user.message_cancelled",
              "inbox.consumed"
            ].includes(value.type) || /^main\.run_(completed|failed|waiting|cancelled)$/.test(value.type)
              ? [value]
              : [];
            // eslint-disable-next-line no-restricted-syntax -- 账本是追加写的，末行可能不完整；单行解析失败不能让整个会话历史丢失
          } catch {
            return [];
          }
        });
        return { runId: entry.name, createdAt, events, ledgerEvents };
      })
  );
  runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId));
  return runs.flatMap((run) => [
    ...run.events.map((event, index) => runtimeEventRecord(taskId, run.runId, index, event)),
    ...run.ledgerEvents
  ]);
}

/** Recover older messages from immutable run logs when an earlier version
 * replaced messages.json with a fresh Pi session on each follow-up. */
export function messagesWithRuntimeHistory(
  saved: ConversationMessage[],
  events: Array<Record<string, unknown>>
): ConversationMessage[] {
  const cancelled = new Set(
    events
      .filter((event) => event.type === "user.message_cancelled")
      .map((event) => (event.payload as { messageId?: string } | undefined)?.messageId)
  );
  const consumed = new Map<string | undefined, string>();
  for (const record of events) {
    if (record.type !== "inbox.consumed") continue;
    const messageId = (record.payload as { messageId?: string } | undefined)?.messageId;
    const occurredAt = record.occurredAt;
    if (typeof messageId !== "string" || !messageId || typeof occurredAt !== "string") continue;
    const timestamp = Date.parse(occurredAt);
    if (!Number.isFinite(timestamp)) continue;
    const previous = consumed.get(messageId);
    // A replay or receipt repair in a later Run must not move the original
    // input. Invalid receipts cannot hide a subsequent valid delivery time.
    if (!previous || timestamp < Date.parse(previous)) consumed.set(messageId, occurredAt);
  }
  const promotedIds = new Set(
    events
      .filter(
        (event) =>
          ["user.message_promoted", "inbox.consumed"].includes(String(event.type)) &&
          (event.payload as { delivery?: string } | undefined)?.delivery === "steer"
      )
      .map((event) => (event.payload as { messageId?: string }).messageId)
  );
  const history = events.flatMap((record) => {
    if (record.type === "user.interjected") {
      const payload = (record.payload ?? {}) as {
        message?: string;
        messageId?: string;
        createdAt?: string;
        delivery?: "steer" | "followUp";
      };
      if (typeof payload.message !== "string" || cancelled.has(payload.messageId)) return [];
      const promoted = payload.messageId && promotedIds.has(payload.messageId);
      const delivery = promoted ? "steer" : payload.delivery;
      return [
        {
          id: payload.messageId || String(record.eventId),
          role: "user" as const,
          content: payload.message,
          timestamp: Date.parse(
            consumed.get(payload.messageId) || payload.createdAt || String(record.occurredAt)
          ),
          interjected: delivery !== "followUp" || !consumed.has(payload.messageId),
          delivery,
          pending: delivery === "followUp" && !consumed.has(payload.messageId)
        }
      ];
    }
    const event =
      record.type === "runtime_event" ? (record.payload as Record<string, unknown> | undefined) : record;
    if (event?.type !== "message_end") return [];
    const projected = conversationMessages([event.message]);
    const incoming = event.message as { role?: string; customType?: string } | undefined;
    if (incoming?.role !== "custom" || incoming.customType !== "cowork-user-message") return projected;
    // SDK runtime custom timestamps describe queue acceptance, not delivery.
    // A saved Pi entry replaces this below with its exact context timestamp.
    return projected.map((message) => {
      const receipt = consumed.get(message.id);
      const timestamp = receipt ? Date.parse(receipt) : undefined;
      return timestamp !== undefined && Number.isFinite(timestamp) ? { ...message, timestamp } : message;
    });
  });
  const used = new Set<number>();
  for (const message of saved) {
    const index = history.findIndex(
      (entry, index) =>
        !used.has(index) &&
        entry.role === message.role &&
        ((entry.id && entry.id === message.id) ||
          (entry.timestamp !== undefined && message.timestamp !== undefined
            ? entry.timestamp === message.timestamp
            : JSON.stringify(entry.content) === JSON.stringify(message.content)))
    );
    if (index < 0) {
      used.add(history.length);
      history.push(message);
    } else {
      history[index] = message;
      used.add(index);
    }
  }
  // Delivered Pi messages and the queue ledger share one stable identity.
  // Prefer the actual context position over an earlier submission timestamp.
  const seenIds = new Set<string>();
  return history
    .filter((message) => {
      if (!message.id) return true;
      if (seenIds.has(message.id)) return false;
      seenIds.add(message.id);
      return true;
    })
    .sort((a, b) => (a.timestamp !== undefined && b.timestamp !== undefined ? a.timestamp - b.timestamp : 0));
}

/**
 * A runtime event as the conversation view needs it.
 *
 * Every Run records Pi's full system prompt (start and end) and an
 * `agent_end` carrying the whole message list again; together they are most of
 * a long conversation's history and the page reads none of it. The events stay,
 * so identities and order are unchanged; only those bodies are dropped.
 */
export function viewRuntimeEvent(record: Record<string, unknown>): Record<string, unknown> {
  if (record.type !== "runtime_event") return record;
  const payload = record.payload as Record<string, unknown> | undefined;
  if (payload?.type === "agent_end" && "messages" in payload) {
    const { messages: _messages, ...rest } = payload;
    return { ...record, payload: rest };
  }
  const message = payload?.message as Record<string, unknown> | undefined;
  if (message?.role === "system" && (payload?.type === "message_start" || payload?.type === "message_end"))
    return { ...record, payload: { ...payload, message: { role: "system", timestamp: message.timestamp } } };
  return record;
}
