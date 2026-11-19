/**
 * What a delegated agent's `agent-output.log` keeps of Pi's JSON event stream.
 *
 * Only settled facts are durable, the way Codex persists a rollout: a finished
 * message, a tool's start and end, and the run's own boundaries. Everything
 * that only exists to draw a live screen — token deltas, partial tool output —
 * is left out, and the boundary events that repeat a message already written
 * keep only their timing. Every reader of this log (the trajectory panel,
 * usage, activity) uses exactly those settled events, so nothing it shows
 * changes; the log stops growing by the square of each reply.
 *
 * A line that is not an event is kept as it is, so a diagnostic Pi prints on
 * stdout still reaches the log.
 */
export function compactAgentOutputLine(line: string): string | undefined {
  let event: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return line;
    event = parsed as Record<string, unknown>;
    // eslint-disable-next-line no-restricted-syntax -- 不是 JSON 的输出行是 Pi 的诊断文本，原样保留到日志
  } catch {
    return line;
  }
  switch (event.type) {
    case "message_update":
    case "tool_execution_update":
      return undefined;
    case "message_start":
    case "turn_end":
      // message_end carries the full message; the boundary keeps when it happened.
      return JSON.stringify({ type: event.type, message: messageStamp(event.message) });
    case "agent_end": {
      // The final transcript repeats every message_end before it.
      const { messages: _messages, ...rest } = event;
      return JSON.stringify(rest);
    }
    default:
      return line;
  }
}

function messageStamp(message: unknown): Record<string, unknown> | undefined {
  if (!message || typeof message !== "object") return undefined;
  const { role, timestamp, stopReason, customType } = message as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries({ role, timestamp, stopReason, customType }).filter(([, value]) => value !== undefined)
  );
}
