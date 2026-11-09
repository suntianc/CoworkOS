/** A durable identity for queue input used as a resumed process's first prompt. */
export interface QueuedUserTurn {
  taskId: string;
  runId: string;
  messageId: string;
  text: string;
}
const prefix = "<!-- atria-queued-user ";
export function queuedUserTurn(turn: QueuedUserTurn): string {
  const { text, ...identity } = turn;
  return `${prefix}${JSON.stringify(identity)} -->\n${text}`;
}
export function readQueuedUserTurn(content: unknown): QueuedUserTurn | undefined {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (part?.type === "text" ? part.text : "")).join("")
        : "";
  if (!text.startsWith(prefix)) return;
  const end = text.indexOf(" -->\n");
  if (end < 0) return;
  try {
    const identity = JSON.parse(text.slice(prefix.length, end));
    if (
      ![identity.taskId, identity.runId, identity.messageId].every(
        (value) =>
          typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes("..")
      )
    )
      return;
    return {
      taskId: identity.taskId,
      runId: identity.runId,
      messageId: identity.messageId,
      text: text.slice(end + 5)
    };
    // eslint-disable-next-line no-restricted-syntax -- 前缀标记随外部写入的消息文本到达，JSON 损坏时视为没有 Run 身份，按普通用户输入处理
  } catch {
    return;
  }
}
