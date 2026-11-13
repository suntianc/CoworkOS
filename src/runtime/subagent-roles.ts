/**
 * Which tools a delegated Subagent may hold, by role.
 *
 * A delegated process loads the same extension as Main, so the role — not the
 * extension entry — decides the tool table it sends to the model. Main's
 * orchestration tools are deliberately absent: a Subagent cannot delegate,
 * finish the Task, ask the human, park the Task or change Task capabilities.
 *
 * The Reviewer is read-only by construction: it gets no write/edit tool and no
 * shell tool, because a shell can write files regardless of which tool name
 * performed the write. Its verification is reading the change, the evidence and
 * the recorded commands; anything that must be executed is Main's or an
 * Executor's job.
 */

export type SubagentRole = "executor" | "reviewer";

/** Pi's coding tools: read, run, and edit in the work site. */
const EXECUTOR_FILE_TOOLS = ["read", "bash", "edit", "write"] as const;
/** Read-only file and search tools for a Reviewer. */
const REVIEWER_FILE_TOOLS = ["read", "grep", "find", "ls"] as const;
/** Shared Task workspace, read-only, for evidence outside the work site. */
const SHARED_WORKSPACE_TOOLS = ["browse_workspace"] as const;
/** The channels a delegated process may use. */
const CHANNEL_TOOLS = ["ask_main", "send_peer_message"] as const;

/** The exact active tool list one role's process declares to the model. */
export function subagentToolNames(role: SubagentRole): string[] {
  return role === "reviewer"
    ? [...REVIEWER_FILE_TOOLS, ...SHARED_WORKSPACE_TOOLS, ...CHANNEL_TOOLS, "submit_review"]
    : [...EXECUTOR_FILE_TOOLS, ...SHARED_WORKSPACE_TOOLS, ...CHANNEL_TOOLS];
}
