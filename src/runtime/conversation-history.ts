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
            ].includes(value.type) ||
              /^main\.run_(completed|failed|waiting|cancelled|stopped)$/.test(value.type)
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
  return runs.flatMap((run) => {
    const records: Array<Record<string, unknown>> = run.events.map((event, index) =>
      runtimeEventRecord(taskId, run.runId, index, event)
    );
    // A resident Main serves several rounds in one Run. A stop belongs to the
    // round it stopped, so it is placed after the last message written before
    // it rather than at the end of the Run, where a later round would claim it.
    const ledger = run.ledgerEvents.filter((event) => event.type !== "main.run_stopped");
    for (const stop of run.ledgerEvents.filter((event) => event.type === "main.run_stopped")) {
      const at = Date.parse(String(stop.occurredAt ?? ""));
      let before = -1;
      if (Number.isFinite(at))
        records.forEach((record, index) => {
          const time = (record.payload as { message?: { timestamp?: unknown } } | undefined)?.message
            ?.timestamp;
          if (typeof time === "number" && time <= at) before = index;
        });
      if (before < 0) ledger.push(stop);
      else records.splice(before + 1, 0, stop);
    }
    return [...records, ...ledger];
  });
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

type Payload = Record<string, unknown> & {
  type?: unknown;
  message?: Record<string, unknown>;
  assistantMessageEvent?: Record<string, unknown>;
  toolCallId?: unknown;
};

/**
 * A saved history without what later events repeat.
 *
 * Every token delta is logged, and once a message ends its snapshot carries
 * the same content again, as do the block endings and the turn's end. A tool's
 * progress updates are likewise replaced by its final result. The page draws
 * the settled parts from the snapshot and the result, so only the events of a
 * message or tool still in progress keep their bodies, for the live view.
 * Event ids keep their log index, so a stream resumes after the last one sent.
 */
export function settledRuntimeEvents(
  records: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const dropped = new Set<number>();
  const slimmed = new Map<number, Record<string, unknown>>();
  const deltas = new Map<string, number[]>();
  const blockEnds = new Map<string, number[]>();
  const ended = new Set<string>();
  const progress = new Map<string, number[]>();
  const remember = (lookup: Map<string, number[]>, key: string, index: number) => {
    const open = lookup.get(key);
    if (open) open.push(index);
    else lookup.set(key, [index]);
  };
  const settle = (stream: string) => {
    for (const index of deltas.get(stream) ?? []) dropped.add(index);
    for (const index of blockEnds.get(stream) ?? []) {
      const record = records[index];
      const payload = record.payload as Payload;
      const { content: _content, toolCall, ...update } = payload.assistantMessageEvent ?? {};
      const call = toolCall as Record<string, unknown> | undefined;
      slimmed.set(index, {
        ...record,
        payload: {
          ...payload,
          assistantMessageEvent: call
            ? { ...update, toolCall: { type: call.type, id: call.id, name: call.name } }
            : update
        }
      });
    }
    deltas.delete(stream);
    blockEnds.delete(stream);
  };
  records.forEach((record, index) => {
    if (record.type !== "runtime_event") return;
    const stream = `${String(record.runId)}:${String(record.agentId)}`;
    const payload = (record.payload ?? {}) as Payload;
    const update = payload.assistantMessageEvent?.type;
    if (payload.type === "message_update" && typeof update === "string") {
      if (update.endsWith("_delta")) remember(deltas, stream, index);
      else if (update.endsWith("_end")) remember(blockEnds, stream, index);
      return;
    }
    if (payload.type === "tool_execution_update" || payload.type === "tool_execution_end") {
      const call = `${stream}:${String(payload.toolCallId)}`;
      if (payload.type === "tool_execution_update") remember(progress, call, index);
      else {
        for (const update of progress.get(call) ?? []) dropped.add(update);
        progress.delete(call);
      }
      return;
    }
    if (payload.type === "turn_start") ended.delete(stream);
    if (payload.type === "message_end") {
      settle(stream);
      if (payload.message?.role === "assistant") ended.add(stream);
    }
    if (payload.type !== "turn_end") return;
    settle(stream);
    // The turn's message is the one that just ended, and its tool results were
    // each logged as their own message; keep only what tells the turn apart.
    if (ended.has(stream) && payload.message) {
      const { role, id, timestamp, stopReason } = payload.message;
      const { toolResults: _results, ...rest } = payload;
      slimmed.set(index, { ...record, payload: { ...rest, message: { role, id, timestamp, stopReason } } });
    }
    ended.delete(stream);
  });
  if (!dropped.size && !slimmed.size) return records;
  return records.flatMap((record, index) => (dropped.has(index) ? [] : [slimmed.get(index) ?? record]));
}

/**
 * A runtime event as the conversation view needs it.
 *
 * Every Run records Pi's full system prompt (start and end) and an
 * `agent_end` carrying the whole message list again; together they are most of
 * a long conversation's history and the page reads none of it. Tool results,
 * callback starts and each update's token count repeat what other events
 * carry, and reasoning signatures are only for the provider. The events stay,
 * so identities and order are unchanged; only those bodies are dropped.
 */
export function viewRuntimeEvent(record: Record<string, unknown>): Record<string, unknown> {
  if (record.type !== "runtime_event") return record;
  const payload = record.payload as Record<string, unknown> | undefined;
  if (payload?.type === "agent_end" && "messages" in payload) {
    const { messages: _messages, ...rest } = payload;
    return { ...record, payload: rest };
  }
  // Each streamed update repeats the message's running token count, which
  // the page takes from the run statistics instead.
  if (payload?.type === "message_update" && "usage" in payload) {
    const { usage: _usage, ...rest } = payload;
    return { ...record, payload: rest };
  }
  const message = payload?.message as Record<string, unknown> | undefined;
  // The provider's signatures let a later request resume the reasoning; the
  // page never sends them back.
  if (message?.role === "assistant" && Array.isArray(message.content)) {
    const content = message.content as Array<Record<string, unknown>>;
    if (!content.some((part) => "thinkingSignature" in part || "textSignature" in part)) return record;
    return {
      ...record,
      payload: {
        ...payload,
        message: {
          ...message,
          content: content.map(({ thinkingSignature: _thinking, textSignature: _text, ...part }) => part)
        }
      }
    };
  }
  if (payload?.type !== "message_start" && payload?.type !== "message_end") return record;
  if (message?.role === "system")
    return { ...record, payload: { ...payload, message: { role: "system", timestamp: message.timestamp } } };
  // A tool result is drawn from its tool_execution_end, which carries it too.
  if (message?.role === "toolResult") {
    const { role, toolCallId, toolName, isError, timestamp } = message;
    return {
      ...record,
      payload: { ...payload, message: { role, toolCallId, toolName, isError, timestamp } }
    };
  }
  // A callback is read from its message_end, the start repeats the report.
  if (payload.type === "message_start" && message?.customType === "cowork-callback") {
    const details = message.details as Record<string, unknown> | undefined;
    const { role, customType, timestamp } = message;
    return {
      ...record,
      payload: {
        ...payload,
        message: {
          role,
          customType,
          timestamp,
          details: { callId: details?.callId, status: details?.status }
        }
      }
    };
  }
  return record;
}
