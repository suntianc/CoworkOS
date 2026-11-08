import {
  ProjectDataInvalidError,
  ledgerIdentifier,
  ledgerProjectId,
  ledgerSource,
  type LedgerSource
} from "./project-ledger.js";

/**
 * The shared demand board.
 *
 * A board entry is a projection of one ledger requirement. It holds shared
 * facts only: which backend published it, who owns it now, and its revision.
 * The handler is a stable identity (backend, project, Task) so two backends can
 * agree on it; it is never a directory path. The effective MainSession id
 * arrives with a later ticket as an extra handler field, not as a second
 * claim model.
 */
export type BoardState =
  | "pending"
  | "claimed"
  | "in_progress"
  | "paused"
  | "cancelled"
  /**
   * The requirement's candidate was actually merged. The owner and the handling
   * Main stay recorded and the merged commit is attached; publishing is a later
   * phase and never advances from here in P4.
   */
  | "pending_release";
export type BoardEntryKind = "external";
export type BoardAssignmentKind = "user" | "main";
export type BoardEventKind = "published" | "claimed" | "paused" | "released" | "cancelled" | "delivered";
export type BoardTransitionAction = "pause" | "release" | "cancel";
export type BoardAction = "claim" | BoardTransitionAction;

export const BOARD_STATES: readonly BoardState[] = [
  "pending",
  "claimed",
  "in_progress",
  "paused",
  "cancelled",
  "pending_release"
];
export const BOARD_EVENT_KINDS: readonly BoardEventKind[] = [
  "published",
  "claimed",
  "paused",
  "released",
  "cancelled",
  "delivered"
];

/**
 * Who handles a claim.
 *
 * `projectId` is the shared project identity and `taskId` is the verifiable
 * local Task binding in use until persistent MainSession ids land. A remote
 * path is never part of this identity.
 */
export interface BoardHandler {
  backendId: string;
  projectId: string;
  taskId: string;
}

export interface BoardAssignment {
  kind: BoardAssignmentKind;
  /** The authenticated actor that made the claim; host or a delegated backend actor. */
  actorId: string;
  /** Present for a Main claim, absent for a user claim. */
  handler?: BoardHandler;
  assignedAt: string;
}

export interface BoardEntry {
  projectId: string;
  boardId: string;
  requirementId: string;
  title: string;
  content: string;
  entryKind: BoardEntryKind;
  source: LedgerSource;
  state: BoardState;
  revision: number;
  /** The backend that published the entry; a claim records its own actor/handler. */
  backendId: string;
  assignment?: BoardAssignment;
  /** Present once a real merge delivered this board need; the commit is the actual merge SHA. */
  delivery?: BoardDelivery;
  createdAt: string;
  updatedAt: string;
}

/** The merged operation a board need was delivered by. */
export interface BoardDelivery {
  mergeId: string;
  mergedCommit: string;
  mergedAt: string;
}

export interface BoardEvent {
  eventId: string;
  boardId: string;
  kind: BoardEventKind;
  requestId: string;
  actorId: string;
  handler?: BoardHandler;
  fromState?: BoardState;
  toState: BoardState;
  revision: number;
  createdAt: string;
}

/** The authenticated caller for one board action. Only the serving host has `host`. */
export interface BoardActor {
  id: string;
  host: boolean;
}

export interface BoardActionContext {
  /** The backend that asked for the action; a remote client declares its stable id. */
  backendId: string;
  actor: BoardActor;
}

export interface BoardPublishInput {
  title?: unknown;
  content?: unknown;
  source?: unknown;
  requestId?: unknown;
}

export interface BoardActionInput {
  expectedRevision?: unknown;
  requestId?: unknown;
  handler?: unknown;
}

const CONTROL = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/;
/** Host, or a delegated backend acting for its own host/session. */
const ACTOR =
  /^(?:host|backend:[A-Za-z0-9][A-Za-z0-9._:-]*:(?:host|session:[A-Za-z0-9][A-Za-z0-9._:-]*)|session:[A-Za-z0-9][A-Za-z0-9._:-]*)$/;

export function boardActorId(value: unknown): string {
  if (typeof value !== "string" || !ACTOR.test(value))
    throw new ProjectDataInvalidError("看板操作者身份不合法");
  return value;
}

export function boardIdentifier(value: unknown, label: string): string {
  return ledgerIdentifier(value, label);
}

/** A caller-supplied retry identity; the same id never records a second event. */
export function boardRequestId(value: unknown): string {
  if (typeof value !== "string") throw new ProjectDataInvalidError("requestId 必须是字符串");
  const text = value.trim();
  if (!text || text.length > 200 || CONTROL.test(text))
    throw new ProjectDataInvalidError("requestId 须为 1–200 个可打印字符");
  return text;
}

export function boardHandler(value: unknown): BoardHandler {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("处理者必须是对象");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["backendId", "projectId", "taskId"].includes(key)))
    throw new ProjectDataInvalidError("处理者只接受 backendId、projectId 与 taskId");
  return {
    backendId: ledgerIdentifier(input.backendId, "处理者 backendId"),
    projectId: ledgerProjectId(input.projectId),
    taskId: ledgerIdentifier(input.taskId, "处理者 Task ID")
  };
}

export function boardState(value: unknown): BoardState {
  if (typeof value !== "string" || !BOARD_STATES.includes(value as BoardState))
    throw new ProjectDataInvalidError(`看板状态须为 ${BOARD_STATES.join(" / ")}`);
  return value as BoardState;
}

/** Publish always enters from a controlled external source; an internal need stays ledger-only. */
export function boardSource(value: unknown): LedgerSource {
  const source = ledgerSource(value);
  if (source.kind !== "external")
    throw new ProjectDataInvalidError("只有外部受控入口的需求进入看板；内部需求只写入台账");
  return source;
}
