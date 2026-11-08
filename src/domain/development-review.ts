import { ProjectDataInvalidError, ledgerIdentifier, ledgerProjectDirectory } from "./project-ledger.js";
import { now } from "./types.js";

/**
 * A fixed candidate and the independent review of it.
 *
 * The candidate is a Git commit plus the tree it resolved to, frozen by the
 * program before the Reviewer starts. Everything about the review that must be
 * auditable later — who reviewed, what they found, the checks that failed, what
 * Main ruled and which candidate a fix produced — is recorded as a fact here.
 * Main decides the substance; the program only keeps the versions, identity,
 * drift and delivery prerequisites consistent.
 */
export type ReviewChannel = "self" | "independent" | "combined";
export type ReviewKind = "independent" | "combined";
export type ReviewState = "in_review" | "passed" | "failed" | "drifted";
export type FindingState = "open" | "fix_claimed" | "fixed" | "dismissed";
export type RulingDecision = "fix" | "dismiss";
export type DismissalCategory = "false_positive" | "out_of_scope" | "other";

export const REVIEW_CHANNELS: readonly ReviewChannel[] = ["self", "independent", "combined"];
export const REVIEW_KINDS: readonly ReviewKind[] = ["independent", "combined"];
export const REVIEW_STATES: readonly ReviewState[] = ["in_review", "passed", "failed", "drifted"];
export const FINDING_STATES: readonly FindingState[] = ["open", "fix_claimed", "fixed", "dismissed"];
export const RULING_DECISIONS: readonly RulingDecision[] = ["fix", "dismiss"];
export const DISMISSAL_CATEGORIES: readonly DismissalCategory[] = ["false_positive", "out_of_scope", "other"];

/** One recorded check: the command that ran, its exit code and its captured output. */
export interface ReviewCheck {
  name: string;
  command?: string;
  exitCode: number;
  output: string;
  at: string;
}

/** Main's ruling on one finding; a dismissal always says why the finding does not stand. */
export interface ReviewRuling {
  rulingId: string;
  decision: RulingDecision;
  category?: DismissalCategory;
  basis: string;
  candidateCommit: string;
  at: string;
}

export interface ReviewFinding {
  findingId: string;
  title: string;
  detail: string;
  location?: string;
  /** The candidate that was under review when this was found. */
  candidateCommit: string;
  state: FindingState;
  checks: ReviewCheck[];
  /** The verbatim failure the Reviewer produced, kept so it can be read again. */
  rawFailure?: string;
  ruling?: ReviewRuling;
  /** The candidate a recorded rework produced; set when the fix is verified. */
  fixedCommit?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewCandidate {
  commit: string;
  tree: string;
  branch: string;
  workspace: string;
}

/** The independent session that examined the candidate; never the authoring Executor. */
export interface ReviewReviewer {
  role: "reviewer";
  taskId: string;
  callId: string;
  agentId: string;
  workspace: string;
}

/** The call that produced the candidate, when it came from a delegated Executor. */
export interface ReviewAuthor {
  role: "executor";
  callId: string;
  agentId: string;
  workspace: string;
}

/**
 * A rework that continued the author's original session and checkout.
 *
 * Both call ids are recorded so a later reader can tell a real continuation
 * from a fresh Agent that was handed a summary: the agent id and workspace must
 * be the same, and the continuation must reference the call it resumed.
 */
export interface ReviewRework {
  fromCallId: string;
  fromAgentId: string;
  continuationCallId: string;
  agentId: string;
  workspace: string;
  findingIds: string[];
  at: string;
}

export interface ReviewVerdict {
  summary: string;
  checks: ReviewCheck[];
  at: string;
}

export interface DevelopmentReview {
  projectId: string;
  reviewId: string;
  developmentId: string;
  kind: ReviewKind;
  state: ReviewState;
  revision: number;
  candidate: ReviewCandidate;
  author?: ReviewAuthor;
  previousReviewId?: string;
  previousCandidateCommit?: string;
  /** Files changed between the previous candidate and this one, for a re-review. */
  changedPaths: string[];
  reviewer?: ReviewReviewer;
  findings: ReviewFinding[];
  reworks: ReviewRework[];
  verdict?: ReviewVerdict;
  /** Why the reviewed content no longer matches the fixed candidate. */
  drift?: string;
  createdAt: string;
  updatedAt: string;
}

/** The route Main chose before review: a recorded decision, not a quota. */
export interface ReviewPlan {
  projectId: string;
  developmentId: string;
  channel: ReviewChannel;
  basis: string;
  /** The author's own verification, distinct from an independent Reviewer's checks. */
  checks: ReviewCheck[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * What #04 may read as delivery qualification.
 *
 * `channel: "self"` with its checks is a complete answer for a small change:
 * missing a Reviewer report is not by itself a reason to refuse it.
 */
export interface ReviewQualification {
  developmentId: string;
  eligible: boolean;
  channel?: ReviewChannel;
  /** The current integration version. */
  candidate?: ReviewCandidate;
  /** The candidate an independent review actually approved. */
  approved?: ReviewCandidate;
  reviewId?: string;
  kind?: ReviewKind;
  independentReview: boolean;
  reasons: string[];
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

export function reviewChannel(value: unknown): ReviewChannel {
  if (typeof value !== "string" || !REVIEW_CHANNELS.includes(value as ReviewChannel))
    throw new ProjectDataInvalidError(`审查通道须为 ${REVIEW_CHANNELS.join(" / ")}`);
  return value as ReviewChannel;
}

export function reviewKind(value: unknown): ReviewKind {
  if (typeof value !== "string" || !REVIEW_KINDS.includes(value as ReviewKind))
    throw new ProjectDataInvalidError(`审查类型须为 ${REVIEW_KINDS.join(" / ")}`);
  return value as ReviewKind;
}

export function reviewState(value: unknown): ReviewState {
  if (typeof value !== "string" || !REVIEW_STATES.includes(value as ReviewState))
    throw new ProjectDataInvalidError(`审查状态须为 ${REVIEW_STATES.join(" / ")}`);
  return value as ReviewState;
}

export function findingState(value: unknown): FindingState {
  if (typeof value !== "string" || !FINDING_STATES.includes(value as FindingState))
    throw new ProjectDataInvalidError(`发现状态须为 ${FINDING_STATES.join(" / ")}`);
  return value as FindingState;
}

export function rulingDecision(value: unknown): RulingDecision {
  if (typeof value !== "string" || !RULING_DECISIONS.includes(value as RulingDecision))
    throw new ProjectDataInvalidError(`裁定须为 ${RULING_DECISIONS.join(" / ")}`);
  return value as RulingDecision;
}

export function dismissalCategory(value: unknown): DismissalCategory | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !DISMISSAL_CATEGORIES.includes(value as DismissalCategory))
    throw new ProjectDataInvalidError(`不采纳类别须为 ${DISMISSAL_CATEGORIES.join(" / ")}`);
  return value as DismissalCategory;
}

export function reviewCommit(value: unknown, label = "审查提交"): string {
  if (typeof value !== "string" || !COMMIT.test(value))
    throw new ProjectDataInvalidError(`${label}须为 7–64 位小写十六进制`);
  return value;
}

export function reviewCallId(value: unknown, label = "工作项 callId"): string {
  return ledgerIdentifier(value, label);
}

export function reviewBasis(value: unknown): string {
  return bounded(value, "裁定依据", 2000);
}

export function reviewChecks(value: unknown, label = "检查记录"): ReviewCheck[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20)
    throw new ProjectDataInvalidError(`${label}须为不超过 20 条`);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new ProjectDataInvalidError(`${label}必须是对象`);
    const input = item as Record<string, unknown>;
    const exitCode = Number(input.exitCode);
    if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)
      throw new ProjectDataInvalidError(`${label}的退出码须为 0–255 的整数`);
    return {
      name: bounded(input.name, `${label}名称`, 200),
      ...(input.command === undefined ? {} : { command: bounded(input.command, `${label}命令`, 4000) }),
      exitCode,
      output: typeof input.output === "string" ? input.output.slice(0, 8000) : "",
      at: input.at === undefined ? now() : bounded(input.at, `${label}时间`, 100)
    };
  });
}

export function reviewPlanInput(value: unknown): {
  channel: ReviewChannel;
  basis: string;
  checks: ReviewCheck[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("审查通道判断必须是对象");
  const input = value as Record<string, unknown>;
  return {
    channel: reviewChannel(input.channel),
    basis: bounded(input.basis, "审查通道依据", 2000),
    checks: reviewChecks(input.checks)
  };
}

export function reviewCandidate(value: unknown): ReviewCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("审查候选必须是对象");
  const input = value as Record<string, unknown>;
  return {
    commit: reviewCommit(input.commit, "候选提交"),
    tree: reviewCommit(input.tree, "候选树"),
    branch: bounded(input.branch, "候选分支", 200),
    workspace: ledgerProjectDirectory(input.workspace)
  };
}

export function reviewAuthor(value: unknown): ReviewAuthor {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("候选执行身份必须是对象");
  const input = value as Record<string, unknown>;
  return {
    role: "executor",
    callId: reviewCallId(input.callId, "执行工作项 callId"),
    agentId: reviewCallId(input.agentId, "执行工作项身份"),
    workspace: ledgerProjectDirectory(input.workspace)
  };
}

export function reviewReviewer(value: unknown): ReviewReviewer {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("审查身份必须是对象");
  const input = value as Record<string, unknown>;
  if (input.role !== "reviewer") throw new ProjectDataInvalidError("审查身份角色须为 reviewer");
  return {
    role: "reviewer",
    taskId: ledgerIdentifier(input.taskId, "审查任务"),
    callId: reviewCallId(input.callId, "审查工作项 callId"),
    agentId: reviewCallId(input.agentId, "审查工作项身份"),
    workspace: ledgerProjectDirectory(input.workspace)
  };
}

export function reviewRework(value: unknown): ReviewRework {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("返修记录必须是对象");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.findingIds) || input.findingIds.length === 0)
    throw new ProjectDataInvalidError("返修记录须关联至少一条发现");
  return {
    fromCallId: reviewCallId(input.fromCallId, "原执行工作项 callId"),
    fromAgentId: reviewCallId(input.fromAgentId, "原执行工作项身份"),
    continuationCallId: reviewCallId(input.continuationCallId, "返修工作项 callId"),
    agentId: reviewCallId(input.agentId, "返修工作项身份"),
    workspace: ledgerProjectDirectory(input.workspace),
    findingIds: input.findingIds.map((entry) => reviewCallId(entry, "返修发现")),
    at: input.at === undefined ? now() : bounded(input.at, "返修时间", 100)
  };
}

function reviewRuling(value: unknown): ReviewRuling {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("裁定记录必须是对象");
  const input = value as Record<string, unknown>;
  const decision = rulingDecision(input.decision);
  const category = dismissalCategory(input.category);
  if (decision === "dismiss" && !category) throw new ProjectDataInvalidError("不采纳的裁定须记录原因类别");
  return {
    rulingId: ledgerIdentifier(input.rulingId, "裁定 ID"),
    decision,
    ...(category ? { category } : {}),
    basis: reviewBasis(input.basis),
    candidateCommit: reviewCommit(input.candidateCommit, "裁定时候选提交"),
    at: input.at === undefined ? now() : bounded(input.at, "裁定时间", 100)
  };
}

export function reviewFinding(value: unknown): ReviewFinding {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("审查发现必须是对象");
  const input = value as Record<string, unknown>;
  return {
    findingId: ledgerIdentifier(input.findingId, "发现 ID"),
    title: bounded(input.title, "发现标题", 300),
    detail: bounded(input.detail, "发现说明", 4000),
    ...(optionalBounded(input.location, "发现位置", 1000)
      ? { location: optionalBounded(input.location, "发现位置", 1000)! }
      : {}),
    candidateCommit: reviewCommit(input.candidateCommit, "发现时候选提交"),
    state: findingState(input.state),
    checks: reviewChecks(input.checks, "发现检查记录"),
    ...(optionalBounded(input.rawFailure, "失败原件", 8000)
      ? { rawFailure: optionalBounded(input.rawFailure, "失败原件", 8000)! }
      : {}),
    ...(input.ruling === undefined ? {} : { ruling: reviewRuling(input.ruling) }),
    ...(input.fixedCommit === undefined ? {} : { fixedCommit: reviewCommit(input.fixedCommit, "修复提交") }),
    createdAt: bounded(input.createdAt, "发现创建时间", 100),
    updatedAt: bounded(input.updatedAt, "发现更新时间", 100)
  };
}

export function reviewFindingInput(value: unknown): {
  title: string;
  detail: string;
  location?: string;
  checks: ReviewCheck[];
  rawFailure?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("审查发现必须是对象");
  const input = value as Record<string, unknown>;
  const location = optionalBounded(input.location, "发现位置", 1000);
  const rawFailure = optionalBounded(input.rawFailure, "失败原件", 8000);
  return {
    title: bounded(input.title, "发现标题", 300),
    detail: bounded(input.detail, "发现说明", 4000),
    ...(location ? { location } : {}),
    checks: reviewChecks(input.checks, "发现检查记录"),
    ...(rawFailure ? { rawFailure } : {})
  };
}

export function reviewVerdict(value: unknown): ReviewVerdict {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("审查结论必须是对象");
  const input = value as Record<string, unknown>;
  return {
    summary: bounded(input.summary, "审查结论", 2000),
    checks: reviewChecks(input.checks, "复审检查记录"),
    at: input.at === undefined ? now() : bounded(input.at, "结论时间", 100)
  };
}

/** Files changed between two candidates; kept bounded because it is a summary, not a diff. */
export function reviewChangedPaths(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 200)
    throw new ProjectDataInvalidError("复审改动文件须为不超过 200 条");
  return value.map((entry) => bounded(entry, "复审改动文件", 500));
}

/** Validate a new review row; the identifier and timestamps are assigned by the store. */
export function reviewCreate(value: Record<string, unknown>): {
  developmentId: string;
  kind: ReviewKind;
  candidate: ReviewCandidate;
  author?: ReviewAuthor;
  previousReviewId?: string;
  previousCandidateCommit?: string;
  changedPaths: string[];
} {
  const author = value.author === undefined ? undefined : reviewAuthor(value.author);
  return {
    developmentId: ledgerIdentifier(value.developmentId, "开发记录 ID"),
    kind: reviewKind(value.kind),
    candidate: reviewCandidate(value.candidate),
    ...(author ? { author } : {}),
    ...(value.previousReviewId === undefined
      ? {}
      : { previousReviewId: ledgerIdentifier(value.previousReviewId, "上一次审查 ID") }),
    ...(value.previousCandidateCommit === undefined
      ? {}
      : { previousCandidateCommit: reviewCommit(value.previousCandidateCommit, "上一次候选提交") }),
    changedPaths: reviewChangedPaths(value.changedPaths)
  };
}

export function reviewUpdate(value: Record<string, unknown>): {
  expectedRevision: number;
  state?: ReviewState;
  reviewer?: ReviewReviewer;
  findings?: ReviewFinding[];
  reworks?: ReviewRework[];
  verdict?: ReviewVerdict;
  drift?: string;
} {
  const expectedRevision = Number(value.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
    throw new ProjectDataInvalidError("审查更新须带上读取时的 revision");
  let findings: ReviewFinding[] | undefined;
  if (value.findings !== undefined) {
    if (!Array.isArray(value.findings) || value.findings.length > 50)
      throw new ProjectDataInvalidError("审查发现须为不超过 50 条");
    findings = value.findings.map(reviewFinding);
  }
  let reworks: ReviewRework[] | undefined;
  if (value.reworks !== undefined) {
    if (!Array.isArray(value.reworks) || value.reworks.length > 20)
      throw new ProjectDataInvalidError("返修记录须为不超过 20 条");
    reworks = value.reworks.map(reviewRework);
  }
  return {
    expectedRevision,
    ...(value.state === undefined ? {} : { state: reviewState(value.state) }),
    ...(value.reviewer === undefined ? {} : { reviewer: reviewReviewer(value.reviewer) }),
    ...(findings ? { findings } : {}),
    ...(reworks ? { reworks } : {}),
    ...(value.verdict === undefined ? {} : { verdict: reviewVerdict(value.verdict) }),
    ...(value.drift === undefined ? {} : { drift: bounded(value.drift, "漂移原因", 2000) })
  };
}
