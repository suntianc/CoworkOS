import type { DevelopmentMerge, MergeReceipt } from "./development-merge.js";
import { developmentBranch } from "./project-development.js";
import type { DevelopmentReview, ReviewPlan, ReviewQualification } from "./development-review.js";
import { ProjectDataInvalidError, ledgerIdentifier } from "./project-ledger.js";
import type { BoardEntry } from "./project-board.js";
import type { DevelopmentRecord } from "./project-development.js";

/**
 * A requirement's delivery after a real merge.
 *
 * The merged operation's receipt is the only reason a delivery exists. This
 * record keeps the ledger/board synchronization separate from the Git fact:
 * `pending` means the target already contains `mergedCommit` but the shared
 * ledger or board update has not completed yet; `synced` means both accepted
 * that receipt. Repeating the same receipt updates the same row, so a retry
 * never writes a second delivery or a second target commit.
 */
export type DeliveryState = "pending" | "synced";
export const DELIVERY_STATES: readonly DeliveryState[] = ["pending", "synced"];

export interface DevelopmentDelivery {
  projectId: string;
  deliveryId: string;
  developmentId: string;
  requirementId: string;
  mergeId: string;
  candidateCommit: string;
  mergedCommit: string;
  targetBranch: string;
  /** The merged operation's own timestamp; stable across retries. */
  mergedAt: string;
  /** The board item this delivery marked pending release, when the need came from the board. */
  boardId?: string;
  state: DeliveryState;
  attempts: number;
  /** Why the last ledger/board synchronization attempt failed; kept for the UI. */
  lastError?: string;
  syncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** What the execution host hands the shared service after the target moved. */
export interface DeliveryReceipt {
  mergeId: string;
  developmentId: string;
  requirementId: string;
  candidateCommit: string;
  mergedCommit: string;
  targetBranch: string;
  mergedAt: string;
}

/** The development's delivery phase, derived from recorded facts rather than a model claim. */
export type DeliveryStage = "developing" | "reviewing" | "merge_pending" | "merged" | "delivered";

/** One delegated role's recorded progress, from the durable work item and its review facts. */
export interface DeliveryRoleProgress {
  role: "executor" | "reviewer";
  callId: string;
  agentId: string;
  workspace?: string;
  /** The work item's own state when this host still has it, else the recorded review state. */
  state: string;
}

export interface DeliveryDiffFile {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * The committed change the delivery carries, read from the checkout that owns
 * it and frozen to the delivered (or accepted) version.
 *
 * `base` is the target the merge was combined with (`combinedBase`, or the
 * recorded baseline before a merge), `head` is the actual merge commit when
 * available, and `candidateCommit`/`mergedCommit` name the two versions the
 * change came from. A later local commit in the same checkout never moves it.
 */
export interface DeliveryDiff {
  base: string;
  head: string;
  candidateCommit: string;
  mergedCommit?: string;
  files: DeliveryDiffFile[];
}

/**
 * The unified patch behind one committed change.
 *
 * It is the same base/head pair as `DeliveryDiff`, with the text a read-only
 * preview shows. A large change is cut at a boundary and reported as
 * `truncated`, so the reader knows the preview is partial instead of receiving
 * a silently shortened file.
 */
export interface DeliveryPatch {
  base: string;
  head: string;
  candidateCommit: string;
  mergedCommit?: string;
  /** Present when the preview was narrowed to one changed file. */
  path?: string;
  patch: string;
  truncated: boolean;
  /** The changed files' text at the previewed commit; binary or large files are left out. */
  contents: Array<{ path: string; content: string }>;
}

/**
 * Everything a project, Task or requirement reader needs to see one delivery.
 *
 * It joins the existing shared records instead of duplicating them: the
 * development phase, role progress, plan/checks, findings and rulings, actual
 * commits, the merge operation and its receipt, the board projection and the
 * synchronization state all remain their own facts.
 */
export interface DeliveryView {
  projectId: string;
  development: DevelopmentRecord;
  stage: DeliveryStage;
  plan?: ReviewPlan;
  reviews: DevelopmentReview[];
  qualification?: ReviewQualification;
  merges: DevelopmentMerge[];
  delivery?: DevelopmentDelivery;
  board?: BoardEntry;
  diff?: DeliveryDiff;
  roles: DeliveryRoleProgress[];
  /** A local fact this host published but the shared delivery has not accepted yet. */
  pendingSync?: { mergeId: string; error?: string };
}

const CONTROL = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const COMMIT = /^[0-9a-f]{7,64}$/;
const TIME_MAX = 100;

function bounded(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new ProjectDataInvalidError(`${label}必须是字符串`);
  const text = value.trim();
  if (!text || text.length > max || CONTROL.test(text))
    throw new ProjectDataInvalidError(`${label}须为 1–${max} 个可打印字符`);
  return text;
}

export function deliveryState(value: unknown): DeliveryState {
  if (typeof value !== "string" || !DELIVERY_STATES.includes(value as DeliveryState))
    throw new ProjectDataInvalidError(`交付状态须为 ${DELIVERY_STATES.join(" / ")}`);
  return value as DeliveryState;
}

export function deliveryCommit(value: unknown, label: string): string {
  if (typeof value !== "string" || !COMMIT.test(value))
    throw new ProjectDataInvalidError(`${label}须为 7–64 位小写十六进制`);
  return value;
}

/**
 * Validate the handoff a merged operation produces.
 *
 * The shape is the same every retry, so the shared service can use it as the
 * idempotent identity (unique per `mergeId`) instead of guessing from a body.
 */
export function deliveryReceipt(value: unknown): DeliveryReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("交付回执必须是对象");
  const input = value as Record<string, unknown>;
  return {
    mergeId: ledgerIdentifier(input.mergeId, "合入操作 ID"),
    developmentId: ledgerIdentifier(input.developmentId, "开发记录 ID"),
    requirementId: ledgerIdentifier(input.requirementId, "需求 ID"),
    candidateCommit: deliveryCommit(input.candidateCommit, "候选提交"),
    mergedCommit: deliveryCommit(input.mergedCommit, "合入提交"),
    targetBranch: developmentBranch(input.targetBranch, "合入目标分支"),
    mergedAt: bounded(input.mergedAt, "合入时间", TIME_MAX)
  };
}

export function deliveryFromMerge(merge: DevelopmentMerge): DeliveryReceipt | undefined {
  const receipt: MergeReceipt | undefined = merge.receipt;
  if (!receipt) return undefined;
  return deliveryReceipt(receipt);
}
