/**
 * Which tools a delegated Subagent may hold, by role.
 *
 * A delegated process loads the same extension as Main, so the role — not the
 * extension entry — decides the tool table it sends to the model. Main's
 * orchestration tools are deliberately absent: a Subagent cannot delegate,
 * finish the Task, ask the human, park the Task or change Task capabilities.
 *
 * The Reviewer gets no write/edit tool, but does get a shell: it runs its
 * verification inside a checkout of the candidate that the backend creates for
 * it, so anything it writes stays in that copy and never reaches the candidate
 * commit, the Executor's checkout or the user's project.
 */

export type SubagentRole = "executor" | "reviewer";

/** Pi's coding tools: read, run, and edit in the work site. */
const EXECUTOR_FILE_TOOLS = ["read", "bash", "edit", "write"] as const;
/** Inspection and verification tools for a Reviewer, inside its own checkout. */
const REVIEWER_FILE_TOOLS = ["read", "bash", "grep", "find", "ls"] as const;
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
