/**
 * Prompt text for a role a delegated process runs.
 *
 * One copy serves the wording Main writes and the tool names the model sees, so
 * the prompt and the tool table cannot drift apart.
 */

/** The upward question channel, when the Subagent may reach Main. */
export const ASK_MAIN_GUIDANCE =
  "You can reach Main with ask_main when an ambiguity would change your approach and you cannot settle it from the workspace or the project — which evaluation script is authoritative, which of two incompatible readings of the task is meant, a constraint that turns out to be wrong. It blocks until Main answers or the wait runs out, so ask only when the answer changes what you do, not whenever you are unsure; investigate first, and never ask for something a file or command would tell you. State the assumption you will follow if nobody answers, because an unanswered question continues under it rather than failing. Ask on its own turn, not alongside other tool calls, and put one decision in one question.";

/** The same channel, when this kind of call cannot reach Main. */
export const NO_ASK_MAIN_GUIDANCE = {
  async:
    "There is no way to reach Main during this task. When you hit an ambiguity you cannot resolve from the workspace or the project, choose the most reasonable reading, say plainly in your summary which assumption you made and why, and continue.",
  sync: "This is a synchronous delegation: Main is waiting inside its own tool call and cannot be reached, so there is no way to ask it anything. When you hit an ambiguity you cannot resolve from the workspace or the project, choose the most reasonable reading, say plainly in your summary which assumption you made and why, and continue."
} as const;

/** The Subagent -> Subagent channel. */
export const SEND_PEER_MESSAGE_GUIDANCE =
  "You may use send_peer_message to send a short, non-blocking question, correction or finding to another Subagent in this Task when Main has given you its target callId. The message is queued for the peer's next safe turn and does not wait for a reply; include a file or artifact path when that is clearer than copying large content.";

/** Model-facing description of ask_main, shared by both execution paths. */
export const ASK_MAIN_TOOL_DESCRIPTION =
  "Ask Main one question that must be answered before you can continue correctly, and wait for the reply. Use it only when the answer would change your approach and the workspace, project and your own tools cannot settle it — not for anything you could read, run or reasonably decide yourself. You must state the assumption you will follow if no answer arrives: the wait is bounded, and an unanswered question continues under that assumption instead of failing. Call it on its own turn rather than beside other tool calls.";

/** Model-facing description of send_peer_message, shared by both execution paths. */
export const SEND_PEER_MESSAGE_TOOL_DESCRIPTION =
  "Send a short, non-blocking message to another Subagent in this Task. The target must be a callId supplied by Main. The message is queued for the peer's next safe turn; this tool never waits for a reply.";
