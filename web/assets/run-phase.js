import { exchangeExecutionState } from "./conversation.js";

const LIVE_AGENT_STATES = new Set(["running", "waiting", "queued"]);
// Main calling these is Main waiting on its Subagents, not Main working.
const LIVE_PROGRESS_STATES = new Set(["running", "queued"]);
const WAITING_TOOLS = new Set(["wait_for_subagents", "call_subagent"]);

/** The tool Main started last and has not returned from, if any. */
function openTool(events = []) {
  const open = new Map();
  for (const record of events) {
    const event = record?.type === "runtime_event" ? record.payload : record;
    if (event?.type === "tool_execution_start") open.set(event.toolCallId, event.toolName);
    else if (event?.type === "tool_execution_end") open.delete(event.toolCallId);
    else if (/^main\.run_/.test(event?.type || "")) open.clear();
  }
  return [...open.values()].at(-1);
}

/**
 * The one coarse state the composer shows for a conversation, or undefined
 * when there is nothing to show (idle, stopped, failed, finished).
 *
 *   working   Main is doing its own step
 *   waiting   Main waits for Subagents; `agents` of them are working
 *   asking    Main asked the person something and waits for the answer
 *   retrying  the model connection failed and is being retried
 *   pausing   a pause was asked for and Main has not reached a step boundary
 *   paused    the round is paused
 *
 * What exactly is happening (the thought, the file, the attempt) is the
 * transcript's to say; this names only which of these the round is in.
 */
export function runPhase({ task, detail, agents = [] }) {
  if (!task) return undefined;
  const own = detail?.task?.taskId === task.taskId ? detail : undefined;
  const active = Boolean(own?.runtime?.active);
  const live = agents.filter((agent) => agent.role === "subagent" && LIVE_AGENT_STATES.has(agent.state));
  // The catalog's activity is sampled; the conversation's own progress is
  // read with it and may already know of Subagents the sample has not seen.
  const progressed = (own?.progress?.agents || []).filter((agent) =>
    LIVE_PROGRESS_STATES.has(agent.status)
  ).length;
  const working = Math.max(live.length, progressed);
  if (task.status === "paused" && !active)
    return { kind: "paused", agents: working, names: live.map((agent) => agent.name || agent.agentId) };
  if ((own?.humanRequests || []).some((request) => request.status === "pending"))
    return { kind: "asking", agents: working };
  if (!active && !working) return undefined;
  if (active && task.pause) return { kind: "pausing", agents: working };
  if (active && exchangeExecutionState(own.runtimeEvents || []).retry)
    return { kind: "retrying", agents: working };
  // Main sitting in a wait for its Subagents is waiting even before any
  // count of working Subagents reaches the page.
  const waitingTool = active && WAITING_TOOLS.has(openTool(own?.runtimeEvents));
  if ((working && !active) || waitingTool) return { kind: "waiting", agents: working };
  return active ? { kind: "working", agents: working } : undefined;
}
