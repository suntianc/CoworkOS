import { reviewCandidate, reviewChannel, type ReviewCandidate } from "./development-review.js";
import { developmentBranch } from "./project-development.js";
import { ProjectDataInvalidError, ledgerIdentifier } from "./project-ledger.js";
import { now } from "./types.js";

/**
 * One application to the project's shared merge entry.
 *
 * Every Main keeps its own development checkout, but the target branch has one
 * writer: the execution backend named by the merge configuration. A request is
 * a durable, project-scoped operation, so two backends can compete without
 * either using a per-requirement lock as the project's coordination. The state
 * is the durable identity a later process reconciles against real Git facts.
 */
export type MergeState =
  /** Queued for the configured target; not started yet. */
  | "waiting"
  /** The execution backend is updating the target (or was interrupted doing so). */
  | "applying"
  /** The target now contains this candidate; `mergeCommit` is the actual SHA. */
  | "merged"
  /** A real Git conflict left the target untouched. */
  | "conflict"
  /** The combined version failed its checks, the candidate moved, or acceptance no longer matches. */
  | "check_failed"
  /** The operation itself failed for a locatable reason; the target was not confirmed updated. */
  | "failed";

export const MERGE_STATES: readonly MergeState[] = [
  "waiting",
  "applying",
  "merged",
  "conflict",
  "check_failed",
  "failed"
];

/**
 * One check that ran (or will run) on the combined target-plus-candidate
 * version. `exitCode`/`output`/`at` are absent while the request is still
 * queued, so a reader can tell "not run yet" from "passed".
 */
export interface MergeCheck {
  name: string;
  command: string;
  exitCode?: number;
  output?: string;
  at?: string;
}

/**
 * What a merged operation hands to the ledger/board ticket.
 *
 * It is the same identity every time, so a retry can reconcile the receipt
 * instead of merging the candidate again.
 */
export interface MergeReceipt {
  mergeId: string;
  developmentId: string;
  requirementId: string;
  candidateCommit: string;
  mergedCommit: string;
  targetBranch: string;
  mergedAt: string;
}

/**
 * The accepted version a request brings to the shared entry.
 *
 * The requester qualifies its own checkout (or reads a passed review), and the
 * execution backend re-checks these shared facts instead of trusting a model
 * claim. The approved commit/tree are frozen with the request, so a later pass
 * on a different version cannot approve this candidate.
 */
export interface MergeAcceptance {
  channel: "self" | "independent" | "combined";
  approvedCommit: string;
  approvedTree: string;
  reviewId?: string;
}

export interface DevelopmentMerge {
  projectId: string;
  mergeId: string;
  developmentId: string;
  requirementId: string;
  state: MergeState;
  revision: number;
  /** The backend whose Main applied for this merge. */
  requestedBy: string;
  /** The one backend the project configuration allows to update the target. */
  executionBackendId: string;
  targetBranch: string;
  candidate: ReviewCandidate;
  acceptance: MergeAcceptance;
  checks: MergeCheck[];
  /** Machine-readable refusal/failure reasons; `detail` carries the readable one. */
  reasons: string[];
  /** The target commit the candidate was merged onto. */
  combinedBase?: string;
  /** What the merge attempt expected the target to be before its compare-and-swap. */
  expectedTarget?: string;
  /** The commit written to the target branch, recorded before the ref moves. */
  mergeCommit?: string;
  detail?: string;
  /** The process instance that claimed an `applying` operation; a restart changes it. */
  ownerStartedAt?: string;
  /** Read-only handoff for delivery synchronization; present once merged. */
  receipt?: MergeReceipt;
  createdAt: string;
  updatedAt: string;
}

const CONTROL = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const COMMIT = /^[0-9a-f]{7,64}$/;

function bounded(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new ProjectDataInvalidError(`${label}必须是字符串`);
  const text = value.trim();
  if (!text || text.length > max || CONTROL.test(text))
    throw new ProjectDataInvalidError(`${label}须为 1–${max} 个可打印字符`);
  return text;
}

function optionalBounded(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return bounded(value, label, max);
}

export function mergeState(value: unknown): MergeState {
  if (typeof value !== "string" || !MERGE_STATES.includes(value as MergeState))
    throw new ProjectDataInvalidError(`合入状态须为 ${MERGE_STATES.join(" / ")}`);
  return value as MergeState;
}

export function mergeCommit(value: unknown, label = "合入提交"): string {
  if (typeof value !== "string" || !COMMIT.test(value))
    throw new ProjectDataInvalidError(`${label}须为 7–64 位小写十六进制`);
  return value;
}

export function mergeTargetBranch(value: unknown): string {
  return developmentBranch(value, "合入目标分支");
}

export function mergeBackendId(value: unknown, label = "合入后端"): string {
  return ledgerIdentifier(value, label);
}

/** A check the requester asks the execution backend to run on the combined version. */
export function mergeCheckCommands(value: unknown): MergeCheck[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20)
    throw new ProjectDataInvalidError("合入检查须为不超过 20 条");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new ProjectDataInvalidError("合入检查必须是对象");
    const input = item as Record<string, unknown>;
    if (input.exitCode !== undefined || input.output !== undefined)
      throw new ProjectDataInvalidError("合入检查在运行前只记录名称和命令");
    return {
      name: bounded(input.name, "合入检查名称", 200),
      command: bounded(input.command, "合入检查命令", 4000)
    };
  });
}

/** Stored check receipts; a reader sees the actual exit code and captured output. */
export function mergeCheckResults(value: unknown): MergeCheck[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20)
    throw new ProjectDataInvalidError("合入检查结果须为不超过 20 条");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new ProjectDataInvalidError("合入检查结果必须是对象");
    const input = item as Record<string, unknown>;
    const exitCode = Number(input.exitCode);
    if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)
      throw new ProjectDataInvalidError("合入检查结果的退出码须为 0–255 的整数");
    return {
      name: bounded(input.name, "合入检查名称", 200),
      command: bounded(input.command, "合入检查命令", 4000),
      exitCode,
      output: typeof input.output === "string" ? input.output.slice(0, 8000) : "",
      at: input.at === undefined ? now() : bounded(input.at, "合入检查时间", 100)
    };
  });
}

export function mergeReasons(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20)
    throw new ProjectDataInvalidError("合入原因须为不超过 20 条");
  return originalStrings(value, "合入原因", 200);
}

function originalStrings(value: unknown[], label: string, max: number): string[] {
  return value.map((entry) => bounded(entry, label, max));
}

export function mergeAcceptance(value: unknown): MergeAcceptance {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("合入验收记录必须是对象");
  const input = value as Record<string, unknown>;
  return {
    channel: reviewChannel(input.channel),
    approvedCommit: mergeCommit(input.approvedCommit, "验收提交"),
    approvedTree: mergeCommit(input.approvedTree, "验收树"),
    ...(input.reviewId === undefined ? {} : { reviewId: ledgerIdentifier(input.reviewId, "验收审查 ID") })
  };
}

export interface MergeCreate {
  candidate: ReviewCandidate;
  acceptance: MergeAcceptance;
  checks: MergeCheck[];
  requestedBy: string;
  executionBackendId: string;
  targetBranch: string;
}

/** Validate the shared operation before the store assigns its id and timestamps. */
export function mergeCreate(value: Record<string, unknown>): MergeCreate {
  const checks = mergeCheckCommands(value.checks);
  if (!checks.length) throw new ProjectDataInvalidError("合入须记录在组合版本上运行的检查命令");
  return {
    candidate: reviewCandidate(value.candidate),
    acceptance: mergeAcceptance(value.acceptance),
    checks,
    requestedBy: mergeBackendId(value.requestedBy, "合入申请后端"),
    executionBackendId: mergeBackendId(value.executionBackendId, "合入执行后端"),
    targetBranch: mergeTargetBranch(value.targetBranch)
  };
}

export interface MergeClaim {
  expectedRevision: number;
  ownerStartedAt: string;
}

/** Claiming is a compare-and-set on the persisted state, not an in-memory lock. */
export function mergeClaim(value: Record<string, unknown>): MergeClaim {
  const expectedRevision = Number(value.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
    throw new ProjectDataInvalidError("合入领取须带上读取时的 revision");
  return {
    expectedRevision,
    ownerStartedAt: bounded(value.ownerStartedAt, "合入操作身份", 200)
  };
}

export interface MergeUpdate {
  expectedRevision: number;
  state?: MergeState;
  checks?: MergeCheck[];
  reasons?: string[];
  combinedBase?: string | null;
  expectedTarget?: string | null;
  mergeCommit?: string | null;
  detail?: string | null;
}

/**
 * Update an operation's own facts. `null` clears a staged value when a moved
 * target makes the previous attempt stale; `undefined` leaves it unchanged.
 */
export function mergeUpdate(value: Record<string, unknown>): MergeUpdate {
  const expectedRevision = Number(value.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
    throw new ProjectDataInvalidError("合入更新须带上读取时的 revision");
  const cleared = (entry: unknown, label: string): string | null | undefined => {
    if (entry === undefined) return undefined;
    if (entry === null) return null;
    return mergeCommit(entry, label);
  };
  return {
    expectedRevision,
    ...(value.state === undefined ? {} : { state: mergeState(value.state) }),
    ...(value.checks === undefined ? {} : { checks: mergeCheckResults(value.checks) }),
    ...(value.reasons === undefined ? {} : { reasons: mergeReasons(value.reasons) }),
    combinedBase: cleared(value.combinedBase, "组合版本基线"),
    expectedTarget: cleared(value.expectedTarget, "预期目标提交"),
    mergeCommit: cleared(value.mergeCommit, "合入提交"),
    ...(value.detail === undefined
      ? {}
      : { detail: value.detail === null ? null : bounded(value.detail, "合入说明", 4000) })
  };
}

/** The idempotent handoff #05 reconciles against the ledger and board. */
export function mergeReceipt(merge: DevelopmentMerge): MergeReceipt | undefined {
  if (merge.state !== "merged" || !merge.mergeCommit) return undefined;
  return {
    mergeId: merge.mergeId,
    developmentId: merge.developmentId,
    requirementId: merge.requirementId,
    candidateCommit: merge.candidate.commit,
    mergedCommit: merge.mergeCommit,
    targetBranch: merge.targetBranch,
    mergedAt: merge.updatedAt
  };
}
