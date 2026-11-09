import { ui } from "./ui/language.js";
import { toolExecutionFailed } from "./tool-result.js";
import { assistantDisplayContent, normalizeReasoningDisplay } from "./assistant-content.js";
export { assistantDisplayContent, normalizeReasoningDisplay } from "./assistant-content.js";

function plainReasoningLine(line) {
  // Keep code and math out of emphasis stripping: **kwargs, a**2**2 and
  // $a*b*c$ contain meaningful literal stars. Only prose is normalized.
  return line
    .split(/(`+[^`]+`+|\$\$[^$]*\$\$|\$[^$]+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/g)
    .map((part, index) => {
      if (index % 2) return part.startsWith("`") ? part.replace(/^(`+)([\s\S]*?)\1$/, "$2") : part;
      return part
        .replace(/(?<![\p{L}\p{N}*_\\])(\*\*|__)(?=\S)(.*?\S)\1(?![\p{L}\p{N}*_])/gu, "$2")
        .replace(/(?<![\p{L}\p{N}*_\\])([*_])(?=\S)(.*?\S)\1(?![\p{L}\p{N}*_])/gu, "$2");
    })
    .join("");
}

// This is an excerpt of the model's own words, not a generated summary. Keep
// the first content line (including code when it comes first) so later streamed
// paragraphs cannot replace what the person has already started reading.
export function reasoningPreview(reasoning) {
  let fence;
  for (const rawLine of normalizeReasoningDisplay(reasoning).split(/\r?\n/)) {
    let line = rawLine.trim();
    const delimiter = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      fence = fence && delimiter[0] === fence[0] ? undefined : delimiter;
      continue;
    }
    if (!fence)
      line = plainReasoningLine(
        line.replace(/^(?:>\s*)+/, "").replace(/^(?:#{1,6}\s+|(?:[-*+]|\d+[.)])\s+)/, "")
      );
    if (!line || /^[\s#>*_`~=-]+$/.test(line)) continue;
    const ending = fence ? undefined : /[。！？!?]+[”’"'）)\]]*|\.+[”’"'）)\]]*(?=\s|$)/.exec(line);
    const sentence = ending ? line.slice(0, ending.index + ending[0].length) : line;
    const characters = Array.from(sentence);
    return characters.length > 88 ? `${characters.slice(0, 87).join("")}…` : sentence;
  }
  return "";
}

// Streaming deltas, block endings and message snapshots describe the same
// content blocks. Keep their identity within each assistant message so later
// snapshots update the transcript without appending the reasoning again.
export function buildLiveActivity(events) {
  const turns = [];
  const callsById = new Map();
  let turn;
  let message;

  const startTurn = () => {
    turn = { messages: [], done: false };
    turns.push(turn);
    message = undefined;
  };
  const startMessage = () => {
    if (!turn) startTurn();
    message = { blocks: new Map(), key: `${turns.length - 1}:${turn.messages.length}` };
    turn.messages.push(message);
  };
  const blockKey = (type, index, id) => (Number.isInteger(index) ? index : `${type}:${id || "default"}`);
  const ensureBlock = (type, index, id) => {
    if (!message) startMessage();
    const key = blockKey(type, index, id);
    let item = message.blocks.get(key);
    if (!item) {
      item = { type, text: "", key: `${message.key}:${key}`, messageKey: message.key };
      message.blocks.set(key, item);
    }
    return item;
  };
  const ensureCall = (id, index, name) => {
    const existing = (id && callsById.get(id)) || message?.blocks.get(blockKey("tool", index, id));
    const item = existing || ensureBlock("tool", index, id);
    item.call ||= { id, name, arguments: "", result: "", subagent: false, statusLabel: ui("调用中") };
    if (id) {
      item.call.id = id;
      callsById.set(id, item);
    }
    if (name) item.call.name = name;
    item.call.subagent = /subagent/i.test(String(item.call.name || ""));
    return item.call;
  };
  const applySnapshot = (snapshot) => {
    if (snapshot?.role !== "assistant") return;
    const content =
      typeof snapshot.content === "string" ? [{ type: "text", text: snapshot.content }] : snapshot.content;
    if (!Array.isArray(content)) return;
    if (!message) startMessage();
    message.identity ??= snapshot.id ?? snapshot.timestamp;
    message.closed = true;
    content.forEach((part, index) => {
      if (part?.type === "thinking" || part?.type === "text") {
        const item = ensureBlock(part.type === "thinking" ? "reasoning" : "answer", index);
        item.text = String((part.type === "thinking" ? part.thinking : part.text) || "");
        // An interrupted snapshot retains the text, but does not complete a
        // block that never received its own ending. Already ended blocks stay
        // complete even if a later part of the message is interrupted.
        item.complete ||= !["error", "aborted", "length"].includes(snapshot.stopReason);
      }
      if (part?.type === "toolCall") {
        const call = ensureCall(part.id, index, part.name);
        if (part.arguments !== undefined) call.arguments = prettyValue(part.arguments);
      }
    });
  };

  for (const record of events || []) {
    // Task details expose raw events; SSE can wrap them in `payload`.
    const source =
      record?.type === "runtime_event" && record.payload && typeof record.payload === "object"
        ? record.payload
        : record;
    const type = source?.type;
    if (type === "turn_start") {
      startTurn();
      continue;
    }
    if (type === "message_start" && source.message?.role === "assistant") {
      const identity = source.message.id ?? source.message.timestamp;
      // Older logs can contain deltas before their message_start. Attach the
      // late start to that implicit message rather than leaving a duplicate.
      const sameMessage = identity !== undefined && message?.identity === identity;
      if (!message || ((message.started || message.closed) && !sameMessage)) startMessage();
      message.started = true;
      message.identity = identity;
      continue;
    }
    if (type === "message_update") {
      const update = source.assistantMessageEvent || {};
      const index = update.contentIndex;
      const textType = update.type?.startsWith("thinking_")
        ? "reasoning"
        : update.type?.startsWith("text_")
          ? "answer"
          : undefined;
      if (textType) {
        const item = ensureBlock(textType, index);
        if (update.type.endsWith("_delta") && !item.complete && !message.closed)
          item.text += String(update.delta || "");
        if (update.type.endsWith("_end") && typeof update.content === "string") {
          item.text = update.content;
          item.complete = true;
        }
      }
      if (
        update.type === "toolcall_start" ||
        update.type === "toolcall_delta" ||
        update.type === "toolcall_end"
      ) {
        const call = ensureCall(
          update.toolCall?.id || update.id,
          index,
          update.toolCall?.name || update.toolName
        );
        if (update.type === "toolcall_delta") call.arguments += String(update.delta || "");
        if (update.type === "toolcall_end") {
          if (update.toolCall?.arguments !== undefined)
            call.arguments = prettyValue(update.toolCall.arguments);
          call.statusLabel = ui("执行中");
        }
      }
    }
    if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(type)) {
      const call = ensureCall(source.toolCallId, undefined, source.toolName);
      const at = recordedToolTime(source, record);
      if (source.args !== undefined) call.arguments = prettyValue(source.args);
      if (type === "tool_execution_start") {
        call.statusLabel = ui("执行中");
        if (at !== undefined) call.startedAt ??= at;
      }
      if (type === "tool_execution_update" && source.partialResult !== undefined) {
        call.rawResult = source.partialResult;
        call.result = prettyValue(source.partialResult);
      }
      if (type === "tool_execution_end") {
        call.rawResult = source.result;
        call.result = prettyValue(source.result);
        call.completed = true;
        call.failed = toolExecutionFailed(source);
        call.statusLabel = call.failed ? ui("调用失败") : ui("调用完成");
        if (at !== undefined) {
          call.endedAt = at;
          if (call.startedAt !== undefined && at >= call.startedAt) call.durationMs = at - call.startedAt;
        }
      }
    }
    if (type === "message_end") applySnapshot(source.message);
    if (type === "turn_end") {
      applySnapshot(source.message);
      if (turn) turn.done = true;
    }
  }

  return turns
    .map((current) => {
      const items = current.messages
        .flatMap((entry) => {
          const parts = [...entry.blocks.entries()]
            // Content indexes retain message order even if the event window starts
            // mid-stream and the complete snapshot fills in earlier blocks later.
            .sort(([a], [b]) => (typeof a === "number" && typeof b === "number" ? a - b : 0))
            .map(([, item]) =>
              item.type === "reasoning"
                ? { ...item, type: "thinking", thinking: item.text }
                : item.type === "answer"
                  ? { ...item, type: "text" }
                  : item
            );
          return assistantDisplayContent(parts, {
            streaming: !entry.closed && !current.done,
            includeRaw: true
          }).map((part) => ({
            ...part,
            type: part.type === "thinking" ? "reasoning" : part.type === "text" ? "answer" : part.type,
            text: part.type === "thinking" ? part.thinking : part.text,
            done: Boolean(part.complete || current.done)
          }));
        })
        .filter((item) => item.type === "tool" || item.text || (item.type === "reasoning" && !item.done));
      return {
        reasoning: items
          .filter((item) => item.type === "reasoning")
          .map((item) => item.text)
          .join("\n\n"),
        // The final response belongs to one assistant message. Match its text
        // exactly as the persisted transcript does, including split blocks;
        // preceding commentary in the same turn remains part of the history.
        answerMessageKey: current.messages.at(-1)?.key,
        answer: items
          .filter((item) => item.type === "answer" && item.messageKey === current.messages.at(-1)?.key)
          .map((item) => item.text)
          .join(""),
        calls: items.filter((item) => item.type === "tool").map((item) => item.call),
        items,
        done: current.done
      };
    })
    .filter((current) => current.items.length);
}

function recordedToolTime(source, record) {
  for (const value of [source?.occurredAt, record?.occurredAt, source?.timestamp, record?.timestamp]) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 100_000_000_000) return value;
    if (
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ) {
      const time = Date.parse(value);
      if (Number.isFinite(time)) return time;
    }
  }
}

function prettyValue(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
    // eslint-disable-next-line no-restricted-syntax -- tool payloads may hold values JSON cannot serialize (cycles, BigInt); falling back to String keeps the activity readable
  } catch {
    return String(value);
  }
}
