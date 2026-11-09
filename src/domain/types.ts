import { randomUUID } from "node:crypto";

export type AgentRole = "main" | "coordinator" | "subagent";
export type TaskStatus = "created" | "running" | "paused" | "waiting" | "completed" | "failed" | "cancelled";
export type CompletionPolicy = "natural" | "explicit";
export type CompletionSignal = "none" | "finish_task" | "natural_stop" | "interrupted";
export type CallMode = "sync" | "async" | "auto";
export type ResolvedCallMode = Exclude<CallMode, "auto">;
export type Importance = "critical" | "high" | "normal" | "background";
export type Dependency = "required" | "independent";
export type CallState =
  | "created"
  | "accepted"
  | "running"
  | "waiting"
  | "succeeded"
  | "partial"
  | "failed"
  | "timed_out"
  | "cancelled";

export interface Call {
  callId: string;
  parentCallId?: string;
  callerAgentId: string;
  calleeAgentId: string;
  mode: CallMode;
  resolvedMode?: ResolvedCallMode;
  importance: Importance;
  dependency: Dependency;
  deadline?: string;
  callbackPolicy: "on_complete" | "on_partial" | "on_failure";
  interruptOnCallback: boolean;
  state: CallState;
  createdAt: string;
  updatedAt: string;
}

export interface Event<T = unknown> {
  eventId: string;
  type: string;
  taskId: string;
  runId: string;
  agentId?: string;
  callId?: string;
  causationId?: string;
  occurredAt: string;
  payload: T;
}

export type Action =
  | { type: "coordinator_call"; call: Omit<Call, "state" | "createdAt" | "updatedAt">; input: unknown }
  | { type: "subagent_call"; call: Omit<Call, "state" | "createdAt" | "updatedAt">; input: unknown }
  | { type: "call_tool"; toolName: string; input: unknown }
  | { type: "wait_for"; callId: string }
  | { type: "update_plan"; plan: unknown }
  | { type: "request_approval"; approval: unknown }
  | { type: "finish"; result: unknown };

export interface ActionBatch {
  actions: Action[];
  modelTurnId: string;
}

export interface WorkPackage {
  workPackageId: string;
  goal: string;
  inputs: unknown[];
  inputArtifacts: string[];
  constraints: string[];
  deliverables: string[];
  acceptanceCriteria: string[];
  deadline?: string;
  capabilities: string[];
}

export interface AgentResult {
  status: "succeeded" | "partial" | "failed" | "timed_out" | "cancelled";
  summary: string;
  artifacts: string[];
  metrics: Record<string, unknown>;
  errors: string[];
  validation: { passed: boolean; notes: string[] };
  sourceEventIds: string[];
}

export interface InboxMessage {
  messageId: string;
  recipientAgentId: string;
  kind: "callback" | "external_event" | "human_command" | "subagent_question" | "peer_message";
  senderAgentId?: string;
  senderCallId?: string;
  callId?: string;
  eventId: string;
  priority: number;
  state: "ready" | "leased" | "consumed";
  lease?: { consumerId: string; expiresAt: string };
  payload: unknown;
  createdAt: string;
}

/** Small, machine-readable completion contract shared by CLI, Runtime and UI. */
export interface TaskCompletion {
  policy: CompletionPolicy;
  signal: CompletionSignal;
  summary?: string;
  verifiedAt?: string;
}

/**
 * A person's request to stop Main between steps, and the boundary it stopped at.
 *
 * The request is durable so the Main process reads it from its own Task record
 * rather than through a second control channel. `pausedAt` is written only
 * when the current tool call or model reply has ended and the Run has stopped.
 */
export interface RunPause {
  requestedAt: string;
  requestedBy: "user";
  pausedAt?: string;
}

/**
 * What Agents on this Task are allowed to do beyond their private directory.
 *
 * Capabilities are granted per Task, after the work is understood, rather than
 * configured per process before it starts: one workspace holds a Task that
 * writes a report and a Task that rewrites a pipeline, and the first has no
 * business holding the second's permissions. The grant is durable and
 * auditable, so what an Agent was allowed to do is answerable after the fact.
 */
export interface TaskCapabilities {
  /** Agents may edit the user's project, not only their own directory. */
  projectWrite?: boolean;
  /** Commands run through a shell, enabling pipes, redirection and backgrounding. */
  shell?: boolean;
  /** Paths that stay read-only, relative to the project. The scorer belongs here. */
  evalPaths?: string[];
  /** Long jobs are expected, so a command is supervised rather than deadlined. */
  longRunning?: boolean;
  /** Attempts per delegated call, including the first. One disables the retry. */
  maxAttempts?: number;
  /** How the grant was made, for the audit trail. */
  grantedBy?: "user" | "operator";
  grantedAt?: string;
  /** What the user was told this was for. */
  reason?: string;
}

export interface TaskRecord {
  taskId: string;
  /**
   * What this record is for.
   *
   * A "workspace" holds application documents that do not belong to any
   * conversation yet — an editor is a thing a person can open on its own, and a
   * document made there becomes a deliverable of a conversation only when they
   * bind it. It uses the same storage as a conversation so nothing downstream
   * needs a second code path, but it is not one and must not be listed as one.
   */
  kind?: "conversation" | "workspace";
  monitoring?: { scope: "background"; sourceTaskId?: string };
  watchRecovery?: { day: string; retries: number };
  /** 3 separates final artifacts from runtime metadata and agent candidates. */
  layoutVersion?: number;
  status: TaskStatus;
  goal?: string;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  /** Model id selected for the task's Main runs. */
  model?: string;
  /** User-selected project directory; task history remains in its original storage root. */
  projectDirectory?: string;
  /** Product-managed durable work directory; absent preserves legacy project adoption. */
  temporaryWorkspaceRoot?: string;
  /** Stable project membership; storage and original history paths stay separate. */
  projectId?: string;
  /** Catalog owning the assignment, so CLI/supervisors use the same directory and lock. */
  projectCatalogPath?: string;
  constraints?: string[];
  successCriteria?: string[];
  /** Absent means the safe default: Agents write only their own directories. */
  capabilities?: TaskCapabilities;
  activeRunId?: string;
  /** A user pause waiting for the current step, then the recorded pause boundary. */
  pause?: RunPause;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  completion?: TaskCompletion;
  version: number;
}

export function now(): string {
  return new Date().toISOString();
}

export function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

const allowedTransitions: Record<CallState, CallState[]> = {
  created: ["accepted", "cancelled"],
  accepted: ["running", "cancelled", "timed_out"],
  running: ["waiting", "succeeded", "partial", "failed", "timed_out", "cancelled"],
  waiting: ["running", "succeeded", "partial", "failed", "timed_out", "cancelled"],
  succeeded: [],
  partial: ["running", "succeeded", "failed", "cancelled"],
  failed: [],
  timed_out: [],
  cancelled: []
};

export function transitionCall(call: Call, next: CallState): Call {
  if (!allowedTransitions[call.state].includes(next)) {
    throw new Error(`invalid call transition: ${call.state} -> ${next}`);
  }
  return { ...call, state: next, updatedAt: now() };
}

const allowedTaskTransitions: Record<TaskStatus, TaskStatus[]> = {
  created: ["running", "cancelled"],
  running: ["paused", "waiting", "completed", "failed", "cancelled"],
  paused: ["running", "completed", "cancelled"],
  waiting: ["running", "paused", "completed", "failed", "cancelled"],
  failed: ["running", "cancelled"],
  cancelled: ["running"],
  completed: ["running"]
};

export function transitionTask(task: TaskRecord, next: TaskStatus): TaskRecord {
  if (task.status === next) return { ...task, updatedAt: now() };
  if (!allowedTaskTransitions[task.status].includes(next)) {
    throw new Error(`invalid task transition: ${task.status} -> ${next}`);
  }
  const timestamp = now();
  const terminal = next === "completed" || next === "failed" || next === "cancelled";
  return {
    ...task,
    status: next,
    // A fresh run or a settled Task no longer carries a pause request; the
    // paused record keeps it so the interface can show where Main stopped.
    pause: terminal || next === "running" ? undefined : task.pause,
    updatedAt: timestamp,
    completedAt: terminal ? timestamp : undefined,
    lastError: next === "failed" ? task.lastError : undefined,
    version: task.version + 1
  };
}

export interface CallPolicyInput {
  requestedMode: CallMode;
  importance: Importance;
  dependency: Dependency;
  deadline?: string;
}

export function resolveCallMode(input: CallPolicyInput, currentTime = Date.now()): ResolvedCallMode {
  if (input.requestedMode !== "auto") return input.requestedMode;
  if (input.dependency === "required") return "sync";
  if (input.importance === "critical" && input.deadline) {
    const deadline = Date.parse(input.deadline);
    if (Number.isFinite(deadline) && deadline - currentTime <= 5 * 60_000) return "sync";
  }
  return "async";
}
