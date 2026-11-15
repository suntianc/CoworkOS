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

import type { CapabilityGrant } from "./capability-provider.js";

export type SubagentRole = "executor" | "reviewer";

/** Pi's coding tools: read, run, and edit in the work site. */
const EXECUTOR_FILE_TOOLS = ["read", "bash", "edit", "write"] as const;
/** Inspection and verification tools for a Reviewer, inside its own checkout. */
const REVIEWER_FILE_TOOLS = ["read", "bash", "grep", "find", "ls"] as const;
/** Shared Task workspace, read-only, for evidence outside the work site. */
const SHARED_WORKSPACE_TOOLS = ["browse_workspace"] as const;
/**
 * Bundled and project skills, read-only.
 *
 * A published skill tells a Subagent to load itself, so both roles hold the
 * same loader Main uses over the same catalog.
 */
const SKILL_TOOLS = ["load_skill"] as const;
/** The channels a delegated process may use. */
const CHANNEL_TOOLS = ["ask_main", "send_peer_message"] as const;
/**
 * Public web reading, read-only: the same `search`/`visit` Main holds through the
 * same provider, so a delegated item reads its own sources instead of trusting a
 * summary of them. Absent when search is switched off, exactly as on Main.
 */
const WEB_TOOLS = ["search", "visit"] as const;

/** The exact active tool list one role's process declares to the model. */
export function subagentToolNames(role: SubagentRole, grants: readonly CapabilityGrant[] = []): string[] {
  const base =
    role === "reviewer"
      ? [
          ...REVIEWER_FILE_TOOLS,
          ...SKILL_TOOLS,
          ...SHARED_WORKSPACE_TOOLS,
          ...CHANNEL_TOOLS,
          ...WEB_TOOLS,
          "submit_review"
        ]
      : [...EXECUTOR_FILE_TOOLS, ...SKILL_TOOLS, ...SHARED_WORKSPACE_TOOLS, ...CHANNEL_TOOLS, ...WEB_TOOLS];
  return [...base, ...capabilityToolNames(grants)];
}

/**
 * Capability tools a work item was granted.
 *
 * Only a granted provider adds its tool: a delegated process with no grant
 * declares no attachment reader at all, rather than holding one that rejects
 * every id.
 */
export function capabilityToolNames(grants: readonly CapabilityGrant[]): string[] {
  return grants.some((grant) => grant.provider === "attachments") ? ["read_attachment"] : [];
}
