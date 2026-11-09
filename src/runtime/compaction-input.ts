import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { limitToolContent } from "./tool-output.js";

// Both Pi compaction serializers cut tool-result text after this many chars.
// Keep the complete receipt inside that limit so their cut cannot remove its tail.
export const COMPACTION_TOOL_RESULT_MAX_CHARS = 2_000;
const COMPACTION_UNMATCHED_CALLS_MAX_CHARS = 2_000;

interface EarlierCall {
  call: ToolCall;
  messageIndex: number;
  contentIndex: number;
}

/** Project only summary inputs; the source transcript and receipt metadata stay intact. */
export function projectCompactionMessages<T extends AgentMessage>(messages: readonly T[]): T[] {
  const pending = new Map<string, EarlierCall[]>();
  const projected = messages.map((message, index) => {
    if (message.role === "assistant") {
      for (const [contentIndex, block] of message.content.entries()) {
        if (block.type !== "toolCall") continue;
        const queue = pending.get(block.id) ?? [];
        queue.push({ call: block, messageIndex: index + 1, contentIndex: contentIndex + 1 });
        pending.set(block.id, queue);
      }
    }
    if (message.role !== "toolResult") return message;

    const queue = pending.get(message.toolCallId);
    const match = queue?.findIndex(({ call }) => call.name === message.toolName) ?? -1;
    const earlier = queue && match >= 0 ? queue.splice(match, 1)[0] : undefined;
    if (queue?.length === 0) pending.delete(message.toolCallId);
    return projectToolResult(message, index + 1, earlier) as T;
  });

  // Native serializers omit tool-call IDs. Only after matching the complete
  // covered interval can we identify calls whose identity needs a text receipt.
  const unmatchedByMessage = new Map<number, EarlierCall[]>();
  for (const queue of pending.values()) {
    for (const earlier of queue) {
      const calls = unmatchedByMessage.get(earlier.messageIndex) ?? [];
      calls.push(earlier);
      unmatchedByMessage.set(earlier.messageIndex, calls);
    }
  }
  for (const [messageIndex, calls] of unmatchedByMessage) {
    const message = projected[messageIndex - 1];
    if (message.role !== "assistant") continue;
    calls.sort((left, right) => left.contentIndex - right.contentIndex);
    projected[messageIndex - 1] = {
      ...message,
      content: [...message.content, { type: "text", text: unmatchedCallReceipt(calls) }]
    };
  }
  return projected;
}

function unmatchedCallReceipt(calls: EarlierCall[]): string {
  let receipt =
    "Unmatched tool-call evidence applies only within this summary interval. Later retained messages or current harness state may settle these calls; this does not establish that they are currently running.";
  const omitted = (count: number) =>
    `\n[${count} additional unmatched tool calls omitted from this summary input.]`;
  for (const [index, { call, messageIndex, contentIndex }] of calls.entries()) {
    const line = `\n[Tool call without result: call=${quoted(call.id, 120)}; name=${quoted(call.name, 80)}; message=${messageIndex}; content block=${contentIndex}]`;
    const remaining = calls.length - index - 1;
    const reserve = remaining ? omitted(remaining).length : 0;
    if (receipt.length + line.length + reserve > COMPACTION_UNMATCHED_CALLS_MAX_CHARS) {
      receipt += omitted(remaining + 1);
      break;
    }
    receipt += line;
  }
  return receipt;
}

function projectToolResult(
  message: ToolResultMessage,
  messageIndex: number,
  earlier?: EarlierCall
): ToolResultMessage {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const labels = [
    `[Tool receipt: name=${quoted(message.toolName, 80)}; call=${quoted(message.toolCallId, 120)}; message=${messageIndex}${earlier ? `; call message=${earlier.messageIndex}` : "; matching earlier call unavailable"}]`,
    `isError=${message.isError}`
  ];
  const details = record(message.details);
  const fields: string[] = [];
  // These are recorded values, not inferred exit codes or claims of test success.
  for (const key of ["exitCode", "failed", "timedOut", "cancelled", "signal"]) {
    const value = details[key];
    if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      fields.push(`${key}=${quoted(value, 60)}`);
  }
  if (fields.length) labels.push(fields.join("; "));
  const args = record(earlier?.call.arguments);
  const command = typeof args.command === "string" ? args.command : details.command;
  const cwd = typeof details.cwd === "string" ? details.cwd : args.cwd;
  if (typeof command === "string") labels.push(`command=${quoted(command, 260)}`);
  const argv = Array.isArray(args.args) ? args.args : details.args;
  if (Array.isArray(argv) && argv.length) {
    const selected = argv
      .slice(0, 8)
      .map((arg: unknown) =>
        typeof arg === "string" || typeof arg === "number" || typeof arg === "boolean"
          ? clip(String(arg), 60)
          : "[omitted]"
      );
    if (argv.length > selected.length) selected.push("[more arguments omitted]");
    labels.push(`args excerpt=${clip(JSON.stringify(selected), 200)}`);
  }
  if (typeof cwd === "string") labels.push(`cwd=${quoted(cwd, 160)}`);
  labels.push(`Captured output (${text.length} chars):`);
  const header = labels.join("\n") + "\n";
  const excerpt = clip(text, Math.max(0, COMPACTION_TOOL_RESULT_MAX_CHARS - header.length));
  const projected = header + excerpt;
  let inserted = false;
  const content: ToolResultMessage["content"] = [];
  for (const block of message.content) {
    if (block.type !== "text") content.push(block);
    else if (!inserted) {
      inserted = true;
      content.push({ ...block, text: projected });
    }
  }
  if (!inserted) content.unshift({ type: "text", text: projected });
  return { ...message, content };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function quoted(value: string | number | boolean, maxChars: number): string {
  return clip(JSON.stringify(value), maxChars);
}

function clip(text: string, maxChars: number): string {
  const [block] = limitToolContent([{ type: "text", text }], maxChars);
  return block.type === "text" ? block.text : "";
}
