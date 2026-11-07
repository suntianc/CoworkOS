import { ProjectDataInvalidError } from "./project-ledger.js";

/**
 * A project's persistent Main session: one conversation that outlives the
 * requirement it is working on and the Run that is currently executing it.
 *
 * The shared record names shared facts only. A session's Pi transcript lives
 * beside the Task that holds it on the backend that runs it, so this module
 * never stores a host path; `taskId` is the local history container and
 * `backendId` says which backend owns it.
 */
export type MainSessionEntryKind = "internal" | "external";
export type MainSessionKind = "regular" | "continuation";
export type MainSessionRunState = "running" | "completed" | "failed" | "cancelled";

export const MAIN_SESSION_ENTRY_KINDS: readonly MainSessionEntryKind[] = ["internal", "external"];
export const MAIN_SESSION_KINDS: readonly MainSessionKind[] = ["regular", "continuation"];
export const MAIN_SESSION_RUN_STATES: readonly MainSessionRunState[] = [
  "running",
  "completed",
  "failed",
  "cancelled"
];

export interface MainSession {
  sessionId: string;
  projectId: string;
  title: string;
  entryKind: MainSessionEntryKind;
  kind: MainSessionKind;
  /** The backend that holds this session's Pi history and may run it. */
  backendId: string;
  /** The Task whose `sessions/main/pi` directory holds the transcript. */
  taskId: string;
  currentRequirementId?: string;
  createdAt: string;
  updatedAt: string;
}

/** A Run belongs to exactly one session, so a late response keeps its owner. */
export interface MainSessionRun {
  projectId: string;
  sessionId: string;
  runId: string;
  taskId: string;
  requirementId?: string;
  state: MainSessionRunState;
  createdAt: string;
  updatedAt: string;
}

const CONTROL = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function bounded(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new ProjectDataInvalidError(`${label}必须是字符串`);
  const text = value.trim();
  if (!text || text.length > max || CONTROL.test(text))
    throw new ProjectDataInvalidError(`${label}须为 1–${max} 个可打印字符`);
  return text;
}

export function mainSessionTitle(value: unknown): string {
  return bounded(value, "会话名称", 120);
}

export function mainSessionEntryKind(
  value: unknown,
  fallback: MainSessionEntryKind = "internal"
): MainSessionEntryKind {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !MAIN_SESSION_ENTRY_KINDS.includes(value as MainSessionEntryKind))
    throw new ProjectDataInvalidError(`会话入口类型须为 ${MAIN_SESSION_ENTRY_KINDS.join(" / ")}`);
  return value as MainSessionEntryKind;
}

export function mainSessionKind(value: unknown, fallback: MainSessionKind = "regular"): MainSessionKind {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !MAIN_SESSION_KINDS.includes(value as MainSessionKind))
    throw new ProjectDataInvalidError(`会话类型须为 ${MAIN_SESSION_KINDS.join(" / ")}`);
  return value as MainSessionKind;
}

export function mainSessionRunState(value: unknown): MainSessionRunState {
  if (typeof value !== "string" || !MAIN_SESSION_RUN_STATES.includes(value as MainSessionRunState))
    throw new ProjectDataInvalidError(`运行状态须为 ${MAIN_SESSION_RUN_STATES.join(" / ")}`);
  return value as MainSessionRunState;
}

/** The title a conversation gets when it is adopted without an explicit one. */
export function mainSessionTitleFromGoal(goal: unknown, taskId: string): string {
  const text =
    typeof goal === "string"
      ? goal
          .split("\n")[0]
          .replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
          .trim()
      : "";
  return (text || taskId).slice(0, 120);
}
