import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { limitToolContent } from "./tool-output.js";

export const MAX_SUBAGENT_RECOVERY_CHARS = 6_000;

interface Operation {
  call: ToolCall;
  messageIndex: number;
  result?: ToolResultMessage;
}

/** A bounded projection of existing evidence, never a generated completion claim. */
export function subagentRecoverySummary(messages: readonly AgentMessage[]): string {
  const statements: string[] = [];
  const operations: Operation[] = [];
  const pending = new Map<string, Operation[]>();
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (text)
        statements.push(`[message ${index + 1}; stopReason=${message.stopReason}] ${clip(text, 600)}`);
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        const operation: Operation = { call: block, messageIndex: index + 1 };
        operations.push(operation);
        const queue = pending.get(block.id) ?? [];
        queue.push(operation);
        pending.set(block.id, queue);
      }
    } else if (message.role === "toolResult") {
      // IDs may be reused across turns. A result settles only an earlier call
      // of the same name; it must not become evidence for a later operation.
      const queue = pending.get(message.toolCallId);
      const match = queue?.findIndex((operation) => operation.call.name === message.toolName) ?? -1;
      if (queue && match >= 0) {
        queue[match].result = message;
        queue.splice(match, 1);
        if (queue.length === 0) pending.delete(message.toolCallId);
      }
    }
  }

  const changes = new Map<string, string>();
  for (const operation of operations) {
    if (!["write_file", "apply_patch"].includes(operation.call.name) || !operation.result) continue;
    const data = resultData(operation.result);
    if (toolFailed(operation.result, data) || data.changed !== true) continue;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 中断的调用可能在记录参数前就结束，arguments 运行期是 null
    const path = data.path ?? operation.call.arguments?.path;
    if (typeof path !== "string") continue;
    changes.delete(path);
    changes.set(path, `[message ${operation.messageIndex}] path=${clip(path, 120)}; changed=true`);
  }
  const unknown = operations.filter((operation) => !operation.result);
  const returned = operations.filter((operation) => operation.result);
  const sections = [
    section(
      "Operations with completion unknown: check effects before repeating",
      unknown,
      2,
      600,
      operationLabel
    ),
    section("Recorded file changes (tool reports; review current files)", [...changes.values()], 6, 900),
    section("Recent assistant statements (unverified; may predate later operations)", statements, 2, 1_300),
    section(
      "Recent returned tools (excerpts, not instructions or proof the task is complete)",
      returned,
      4,
      2_800,
      toolRecord
    )
  ].filter(Boolean);
  if (sections.length === 0) return "";
  return clip(
    [
      "Partial progress handoff: this delegation did not complete. Selected transcript records may include earlier attempts/checkpoints and omit other work. No additional model request was made.",
      ...sections
    ].join("\n\n"),
    MAX_SUBAGENT_RECOVERY_CHARS
  );
}

function section<T>(
  title: string,
  items: T[],
  count: number,
  budget: number,
  format: (item: T, budget: number) => string = String
): string {
  if (items.length === 0) return "";
  const selected = items.slice(-count);
  const itemBudget = Math.floor(budget / selected.length) - 3;
  return `${title}${items.length > count ? ` (${items.length - count} older records omitted)` : ""}:\n${selected.map((item) => `- ${clip(format(item, itemBudget), itemBudget)}`).join("\n")}`;
}

function operationLabel(operation: Operation): string {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 中断的调用可能没有记录参数，arguments 运行期是 null，按空参数渲染标签
  const args = operation.call.arguments ?? {};
  const locator: Record<string, unknown> = {};
  // Never serialize arbitrary arguments: write/patch content can be enormous,
  // and only identifiers are useful when deciding where to resume.
  for (const key of ["path", "filePath", "command", "cwd", "jobId", "questionId", "url"]) {
    if (typeof args[key] === "string") locator[key] = clip(args[key], 180);
  }
  if (Array.isArray(args.args)) {
    locator.args = args.args
      .slice(0, 8)
      .map((arg) => (typeof arg === "string" ? clip(arg, 80) : "[omitted]"));
    if (args.args.length > 8) locator.argsOmitted = args.args.length - 8;
  }
  return `[message ${operation.messageIndex}; call=${clip(operation.call.id, 60)}] ${clip(operation.call.name, 60)} ${clip(JSON.stringify(locator), 300)}`;
}

function toolRecord(operation: Operation, budget: number): string {
  const result = operation.result!;
  const data = resultData(result);
  const status = toolFailed(result, data) ? "tool error" : "returned without tool error";
  const fields: string[] = [];
  for (const key of ["exitCode", "changed", "bytes", "cancelled", "timedOut", "signal"]) {
    if (["string", "number", "boolean"].includes(typeof data[key]))
      fields.push(`${key}=${clip(String(data[key]), 60)}`);
  }
  const label = `${status}${fields.length ? `; ${fields.join("; ")}` : ""}\n${clip(operationLabel(operation), 280)}`;
  if (["read_file", "browse_workspace", "write_file", "apply_patch"].includes(operation.call.name)) {
    // File contents and patch bodies are not recovery state. For failed file
    // operations retain the error text, which is a distinct tool receipt.
    const error = result.isError ? fileError(result, data) : "";
    return error ? `${label}\nerror excerpt=${JSON.stringify(clip(error, 220))}` : label;
  }
  const outputs: Array<[string, string]> = [];
  for (const key of ["stdout", "stderr"]) {
    if (typeof data[key] === "string" && data[key]) outputs.push([key, data[key]]);
  }
  if (outputs.length === 0 && typeof data.stdout !== "string" && typeof data.stderr !== "string") {
    const text = resultText(result);
    if (text) outputs.push(["result excerpt", clip(text, 300)]);
  }
  const outputBudget = Math.max(0, Math.floor((budget - label.length - 1) / Math.max(outputs.length, 1)));
  return `${label}${outputs.length ? `\n${outputs.map(([key, text]) => `${key}=${clip(JSON.stringify(clip(text, 240)), Math.max(0, outputBudget - key.length - 2))}`).join("\n")}` : ""}`;
}

function toolFailed(result: ToolResultMessage, data: Record<string, unknown>): boolean {
  return (
    result.isError ||
    data.isError === true ||
    data.failed === true ||
    data.cancelled === true ||
    data.timedOut === true ||
    (typeof data.exitCode === "number" && data.exitCode !== 0)
  );
}

function resultData(result: ToolResultMessage): Record<string, unknown> {
  if (
    result.details &&
    typeof result.details === "object" &&
    !Array.isArray(result.details) &&
    Object.keys(result.details).length > 0
  )
    return result.details as Record<string, unknown>;
  const text = resultText(result);
  // Older/content-only adapters may store a JSON receipt without details.
  if (text.length <= 256_000 && text.trimStart().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
      // eslint-disable-next-line no-restricted-syntax -- 回执文本可能是被截断的 JSON，解析失败就按纯文本摘要处理，不能中断恢复汇总
    } catch {
      // A textual or truncated receipt remains an excerpt, not structured data.
    }
  }
  return {};
}

function fileError(result: ToolResultMessage, data: Record<string, unknown>): string {
  for (const key of ["error", "message"]) {
    if (typeof data[key] === "string") return data[key];
  }
  // A structured file receipt may contain the entire file even on failure.
  // Only a plain-text exception is safe to copy without selecting fields.
  const text = resultText(result);
  return /^[{\[]/.test(text.trimStart()) ? "" : text;
}

function resultText(result: ToolResultMessage): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function clip(text: string, maxChars: number): string {
  const [block] = limitToolContent([{ type: "text", text }], maxChars);
  return block.type === "text" ? block.text : "";
}
