export interface CompletionDependencies {
  pendingCalls?: number;
  /** Background jobs still running. Counted from their pids, not from memory. */
  pendingJobs?: number;
  pendingCallbacks?: number;
  pendingHumanRequests?: number;
  /** Questions a Subagent raised to Main and is still blocked on. */
  pendingSubagentQuestions?: number;
  /** Main recorded a standing wake condition instead of finishing. */
  parkedForWake?: boolean;
  hasFinalAnswer?: boolean;
}

export interface CompletionAssessment {
  ready: boolean;
  reason:
    | "ready"
    | "pending_jobs"
    | "pending_subagents"
    | "pending_callbacks"
    | "pending_human"
    | "pending_subagent_questions"
    | "parked_for_wake"
    | "incomplete_response";
}

/**
 * Mechanical completion gate. It deliberately does not judge result quality:
 * Main owns semantic verification. Runtime checks only actual outstanding
 * work and whether the model finished its response, never an extra finish tool.
 */
export function assessTaskCompletion(dependencies: CompletionDependencies = {}): CompletionAssessment {
  // A training run outlives the turn that started it, so an empty tool queue
  // says nothing about whether the work is done. The job's own pid does.
  if ((dependencies.pendingJobs ?? 0) > 0) return { ready: false, reason: "pending_jobs" };
  if ((dependencies.pendingCalls ?? 0) > 0) return { ready: false, reason: "pending_subagents" };
  if ((dependencies.pendingCallbacks ?? 0) > 0) return { ready: false, reason: "pending_callbacks" };
  if ((dependencies.pendingHumanRequests ?? 0) > 0) return { ready: false, reason: "pending_human" };
  // A blocked Subagent is usually also an outstanding call, so this rarely
  // decides the outcome on its own. It is reported separately because "waiting
  // for your answer" and "still working" call for different actions from Main.
  if ((dependencies.pendingSubagentQuestions ?? 0) > 0)
    return { ready: false, reason: "pending_subagent_questions" };
  // A recorded park is an outstanding obligation like any other: Main stated it
  // expects a later event. Checking that the record exists is not judging a
  // result — the gate still never asks whether the work was any good.
  if (dependencies.parkedForWake === true) return { ready: false, reason: "parked_for_wake" };
  if (dependencies.hasFinalAnswer === false) return { ready: false, reason: "incomplete_response" };
  return { ready: true, reason: "ready" };
}

/** Tool/budget stops and truncated responses must not complete a request. */
export function isFinalAssistantMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const message = value as { role?: string; stopReason?: string; content?: unknown };
  if (message.role !== "assistant" || message.stopReason !== "stop") return false;
  if (typeof message.content === "string") return Boolean(message.content.trim());
  return (
    Array.isArray(message.content) &&
    !message.content.some((part) => part?.type === "toolCall") &&
    message.content.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim())
  );
}
