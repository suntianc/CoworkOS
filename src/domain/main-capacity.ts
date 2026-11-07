import type { MainSessionKind } from "./main-session.js";
import { ProjectDataInvalidError } from "./project-ledger.js";

/**
 * External Main capacity, recorded where the processes actually run.
 *
 * The slots and the queue are local execution facts: a slot names a Run this
 * backend started and the process that is still serving it. They never travel
 * through the shared project data, so another host cannot mistake this host's
 * pid or queue position for its own.
 *
 * `resident` bounds the regular external Mains running at once; `continuation`
 * reserves the continuation Mains and is never borrowed for regular work.
 */
export interface MainCapacitySettings {
  resident: number;
  continuation: number;
}

/** A practical bound: a single external service never needs more open Mains. */
export const MAIN_CAPACITY_LIMIT = 32;
export const MAIN_CAPACITY_QUEUE_LIMIT = 20;

export function mainCapacityCount(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    throw new ProjectDataInvalidError(`${label}须为不小于 ${minimum} 的整数`);
  if (value > MAIN_CAPACITY_LIMIT)
    throw new ProjectDataInvalidError(`${label}不能超过 ${MAIN_CAPACITY_LIMIT}`);
  return value;
}

/** A missing setting means external Mains are not enabled on this host. */
export function mainCapacitySettings(value: unknown): MainCapacitySettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("外部 Main 容量配置须为对象");
  const input = value as Record<string, unknown>;
  return {
    resident: mainCapacityCount(input.resident, "常驻配额 resident", 1),
    continuation: mainCapacityCount(input.continuation, "接续配额 continuation", 0)
  };
}

/** A durable claim that one external Main occupies (or awaits) a slot. */
export interface MainCapacitySlot {
  requestId: string;
  projectId: string;
  sessionId: string;
  taskId: string;
  runId: string;
  kind: MainSessionKind;
  requirementId?: string;
  /** The host that started the process; a pid from another host is never probed. */
  host: string;
  /** The process this backend started; absent until the spawn returns. */
  pid?: number;
  startedAt: string;
}

export interface MainCapacitySubmission {
  body?: string;
  thinkingLevel?: string;
  attachmentIds?: string[];
  textAttachments?: Array<{ name: string; text: string; size: number }>;
  source?: "composer" | "human" | "inbox";
}

/** A demand that is eligible but has no free slot yet. */
export interface MainCapacityQueueEntry extends Omit<MainCapacitySlot, "pid" | "startedAt"> {
  requestId: string;
  resume: boolean;
  model?: string;
  retryRequestId?: string;
  prompt: string;
  submission?: MainCapacitySubmission;
  origin: "http" | "worker" | "cli" | "internal";
  enqueuedAt: string;
  state: "queued" | "starting";
}

/** One demand for an external Main Run, as every entry point describes it. */
export interface MainCapacityRequest {
  requestId?: string;
  projectId: string;
  sessionId: string;
  taskId: string;
  kind: MainSessionKind;
  requirementId?: string;
  runId: string;
  resume: boolean;
  model?: string;
  retryRequestId?: string;
  prompt: string;
  submission?: MainCapacitySubmission;
  origin: "http" | "worker" | "cli" | "internal";
  /** A person waiting on the page keeps the demand; a background retry reports it full. */
  queueWhenFull: boolean;
}

/** What admission decided. A duplicate names the demand that already owns the Run. */
export type MainCapacityDecision =
  | { state: "running"; requestId: string }
  | { state: "queued"; requestId: string; position: number }
  | {
      state: "duplicate";
      requestId: string;
      runId?: string;
      position?: number;
      reason: "running" | "queued";
    };

/** The local Task this backend owns for an external session. */
export interface MainCapacityExternalTask {
  taskId: string;
  projectId: string;
  sessionId: string;
  kind: MainSessionKind;
}

export interface MainCapacityState {
  version: 1;
  /** External sessions this backend owns, so its CLI and worker can ask first. */
  externalTasks: MainCapacityExternalTask[];
  slots: MainCapacitySlot[];
  queue: MainCapacityQueueEntry[];
  updatedAt: string;
}
