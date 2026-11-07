/**
 * The shared project ledger: what a project needs, where each requirement came
 * from, and which decisions are still in force.
 *
 * These records are shared facts. A local directory is a per-backend binding,
 * never the project's identity, so the same project keeps its id when a
 * different machine holds the working copy.
 */
export type LedgerSourceKind = "internal" | "external" | "legacy";
export type RequirementStatus = "open" | "delivered" | "withdrawn";
export type RequirementReferenceKind = "task" | "session" | "delivery";

export const LEDGER_SOURCE_KINDS: readonly LedgerSourceKind[] = ["internal", "external", "legacy"];
export const REQUIREMENT_STATUSES: readonly RequirementStatus[] = ["open", "delivered", "withdrawn"];
export const REQUIREMENT_REFERENCE_KINDS: readonly RequirementReferenceKind[] = [
  "task",
  "session",
  "delivery"
];

export interface LedgerSource {
  kind: LedgerSourceKind;
  /** An opaque external label (conversation, channel, ticket); never a host path. */
  reference?: string;
}

/** The shared project row; the local directory lives in a per-backend binding. */
export interface SharedProject {
  projectId: string;
  projectName: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectIdentity {
  projectId: string;
  projectName: string;
  /** This backend's local working copy, kept apart from the shared project row. */
  projectDirectory: string;
  createdAt: string;
  updatedAt: string;
}

export interface RequirementReference {
  referenceId: string;
  kind: RequirementReferenceKind;
  value: string;
  createdAt: string;
}

export interface RequirementDecision {
  decisionId: string;
  text: string;
  /** A decision stays recorded after it is retracted; `effective` says which. */
  effective: boolean;
  source: LedgerSource;
  atRevision: number;
  createdAt: string;
}

export interface RequirementRevision {
  revision: number;
  title: string;
  content: string;
  status: RequirementStatus;
  source: LedgerSource;
  note?: string;
  taskId?: string;
  createdAt: string;
}

export interface RequirementSummary {
  projectId: string;
  requirementId: string;
  title: string;
  content: string;
  source: LedgerSource;
  status: RequirementStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  decisions: RequirementDecision[];
  references: RequirementReference[];
}

export interface RequirementDetail extends RequirementSummary {
  revisions: RequirementRevision[];
}

/** A refusal or failure whose message is safe to return to a local client. */
export class ProjectDataError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?: string
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ProjectDataInvalidError extends ProjectDataError {
  constructor(message: string) {
    super(message, 400, "invalid_project_data");
  }
}

export class ProjectDataConflictError extends ProjectDataError {
  constructor(
    message: string,
    readonly currentRevision?: number,
    code = "revision_conflict"
  ) {
    super(message, 409, code);
  }
}

export class ProjectDataNotFoundError extends ProjectDataError {
  constructor(message: string) {
    super(message, 404, "not_found");
  }
}

export class ProjectDataUnavailableError extends ProjectDataError {
  constructor(message: string) {
    super(message, 503, "storage_unavailable");
  }
}

/** The shared authority refused this backend's credential; no write is pretended. */
export class ProjectDataAuthError extends ProjectDataError {
  constructor(message: string) {
    super(message, 401, "shared_auth_failed");
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CONTROL = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function boundedText(value: unknown, label: string, max: number, { allowEmpty = false } = {}): string {
  if (typeof value !== "string") throw new ProjectDataInvalidError(`${label}必须是字符串`);
  const text = value.trim();
  if ((!allowEmpty && !text) || text.length > max || CONTROL.test(text))
    throw new ProjectDataInvalidError(`${label}须为 ${allowEmpty ? 0 : 1}–${max} 个可打印字符`);
  return text;
}

export function ledgerIdentifier(value: unknown, label: string): string {
  const text = boundedText(value, label, 300);
  if (!IDENTIFIER.test(text)) throw new ProjectDataInvalidError(`${label}格式不合法`);
  return text;
}

export function ledgerProjectId(value: unknown): string {
  // Legacy projects keep an absolute directory as their id; new projects use
  // `project_<uuid>`. Both are kept stable, so both must pass here.
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || CONTROL.test(value))
    throw new ProjectDataInvalidError("项目 ID 不合法");
  return value;
}

export function ledgerProjectDirectory(value: unknown): string {
  const text = boundedText(value, "项目目录", 1024);
  if (!text.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(text))
    throw new ProjectDataInvalidError("项目目录必须是本机绝对路径");
  return text;
}

export function ledgerProjectName(value: unknown): string {
  return boundedText(value, "项目名称", 120);
}

export function ledgerSource(value: unknown): LedgerSource {
  if (value === undefined || value === null) return { kind: "internal" };
  if (typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("需求来源必须是对象");
  const input = value as Record<string, unknown>;
  const kind = input.kind;
  if (typeof kind !== "string" || !LEDGER_SOURCE_KINDS.includes(kind as LedgerSourceKind))
    throw new ProjectDataInvalidError(`需求来源 kind 须为 ${LEDGER_SOURCE_KINDS.join(" / ")}`);
  return {
    kind: kind as LedgerSourceKind,
    ...(input.reference === undefined ? {} : { reference: boundedText(input.reference, "来源引用", 300) })
  };
}

export function ledgerStatus(value: unknown, fallback: RequirementStatus = "open"): RequirementStatus {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !REQUIREMENT_STATUSES.includes(value as RequirementStatus))
    throw new ProjectDataInvalidError(`需求状态须为 ${REQUIREMENT_STATUSES.join(" / ")}`);
  return value as RequirementStatus;
}

export function ledgerTitle(value: unknown): string {
  return boundedText(value, "需求标题", 200);
}

export function ledgerContent(value: unknown): string {
  return boundedText(value, "需求内容", 20000);
}

export function ledgerNote(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : boundedText(value, "修订说明", 2000);
}

export function ledgerTaskId(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : ledgerIdentifier(value, "Task ID");
}

export function ledgerRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new ProjectDataInvalidError("revision 必须是正整数");
  return value;
}

export function ledgerReferences(value: unknown): Array<{ kind: RequirementReferenceKind; value: string }> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) throw new ProjectDataInvalidError("需求引用须为数组");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new ProjectDataInvalidError("需求引用格式不合法");
    const input = item as Record<string, unknown>;
    if (
      typeof input.kind !== "string" ||
      !REQUIREMENT_REFERENCE_KINDS.includes(input.kind as RequirementReferenceKind)
    )
      throw new ProjectDataInvalidError(`需求引用 kind 须为 ${REQUIREMENT_REFERENCE_KINDS.join(" / ")}`);
    return {
      kind: input.kind as RequirementReferenceKind,
      value: boundedText(input.value, "需求引用内容", 500)
    };
  });
}

export function ledgerDecisionText(value: unknown): string {
  return boundedText(value, "决定内容", 4000);
}

/** Requirement text search input; `%` and `_` are matched literally. */
export function ledgerSearchText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = boundedText(value, "查询内容", 200);
  return text;
}
