import {
  ProjectDataConflictError,
  ProjectDataInvalidError,
  ledgerIdentifier,
  ledgerProjectDirectory
} from "./project-ledger.js";

/**
 * A requirement's development record: the agreed goal, completion criteria,
 * suggested route and the code baseline it starts from, plus the isolated Git
 * workspace a backend checked out for it.
 *
 * The record is shared project data; the workspace directory is a per-backend
 * execution fact, so the same development can be found on every backend while
 * only the backend that created the checkout reports that directory. Delivery
 * is recorded by later tickets; this record stays `active` until then.
 */
export type DevelopmentRoute = "quick" | "direct" | "full";
export type DevelopmentStatus = "active";
export type DevelopmentWorkspaceState = "ready" | "failed";

export const DEVELOPMENT_ROUTES: readonly DevelopmentRoute[] = ["quick", "direct", "full"];
export const DEVELOPMENT_STATUSES: readonly DevelopmentStatus[] = ["active"];
export const DEVELOPMENT_WORKSPACE_STATES: readonly DevelopmentWorkspaceState[] = ["ready", "failed"];

export interface DevelopmentBaseline {
  /** The repository branch the work starts from. */
  branch: string;
  /** The commit that branch pointed at when the record was created. */
  commit: string;
}

export interface DevelopmentWorkspace {
  workspaceId: string;
  backendId: string;
  /** This backend's checkout; never the user's own working copy. */
  directory: string;
  branch: string;
  baseCommit: string;
  state: DevelopmentWorkspaceState;
  /** Why the checkout could not be prepared or verified; kept for recovery. */
  error?: string;
}

export interface DevelopmentRecord {
  projectId: string;
  developmentId: string;
  requirementId: string;
  requirementTitle: string;
  goal: string;
  completionCriteria: string[];
  route: DevelopmentRoute;
  status: DevelopmentStatus;
  revision: number;
  baseline: DevelopmentBaseline;
  /** The Main session and Task container that recorded this development. */
  sessionId?: string;
  taskId?: string;
  /** This backend's isolated checkout; absent before it is prepared or on another backend. */
  workspace?: DevelopmentWorkspace;
  createdAt: string;
  updatedAt: string;
}

/**
 * The project's merge entry: where the target branch lives and which backend
 * performs updates. Later tickets use it for the shared merge queue; this
 * ticket only needs a stable, locatable repository to branch workspaces from.
 */
export interface MergeConfig {
  projectId: string;
  repository: string;
  targetBranch: string;
  executionBackendId: string;
  createdAt: string;
  updatedAt: string;
}

/** The existing record is named, so a create retry can continue it instead of guessing. */
export class DevelopmentExistsError extends ProjectDataConflictError {
  constructor(
    message: string,
    readonly developmentId: string
  ) {
    super(message, undefined, "development_exists");
  }
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

export function developmentGoal(value: unknown): string {
  return bounded(value, "开发目标", 4000);
}

export function developmentCompletionCriteria(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20)
    throw new ProjectDataInvalidError("完成标准须为 1–20 条");
  return value.map((item) => bounded(item, "完成标准", 1000));
}

export function developmentRoute(value: unknown, fallback?: DevelopmentRoute): DevelopmentRoute {
  if (value === undefined || value === null) {
    if (fallback) return fallback;
    throw new ProjectDataInvalidError(`开发路线须为 ${DEVELOPMENT_ROUTES.join(" / ")}`);
  }
  if (typeof value !== "string" || !DEVELOPMENT_ROUTES.includes(value as DevelopmentRoute))
    throw new ProjectDataInvalidError(`开发路线须为 ${DEVELOPMENT_ROUTES.join(" / ")}`);
  return value as DevelopmentRoute;
}

export function developmentStatus(value: unknown): DevelopmentStatus {
  if (typeof value !== "string" || !DEVELOPMENT_STATUSES.includes(value as DevelopmentStatus))
    throw new ProjectDataInvalidError(`开发记录状态须为 ${DEVELOPMENT_STATUSES.join(" / ")}`);
  return value as DevelopmentStatus;
}

export function developmentBranch(value: unknown, label = "分支"): string {
  const text = bounded(value, label, 200);
  if (text.startsWith("-") || text.includes("..") || text.endsWith("/") || text.endsWith(".lock"))
    throw new ProjectDataInvalidError(`${label}格式不合法`);
  return text;
}

export function developmentCommit(value: unknown): string {
  if (typeof value !== "string" || !COMMIT.test(value))
    throw new ProjectDataInvalidError("基线提交须为 7–64 位小写十六进制");
  return value;
}

export function developmentBaseline(value: unknown): DevelopmentBaseline {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("代码基线必须是对象");
  const input = value as Record<string, unknown>;
  return {
    branch: developmentBranch(input.branch, "基线分支"),
    commit: developmentCommit(input.commit)
  };
}

export function mergeRepository(value: unknown): string {
  return ledgerProjectDirectory(value);
}

export function mergeTargetBranch(value: unknown): string {
  return developmentBranch(value, "目标分支");
}

export function mergeExecutionBackendId(value: unknown): string {
  return ledgerIdentifier(value, "合入执行后端");
}

export function developmentIdentifier(value: unknown, label: string): string {
  return ledgerIdentifier(value, label);
}

export function developmentWorkspace(value: unknown): DevelopmentWorkspace {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("需求现场必须是对象");
  const input = value as Record<string, unknown>;
  const state = input.state;
  if (typeof state !== "string" || !DEVELOPMENT_WORKSPACE_STATES.includes(state as DevelopmentWorkspaceState))
    throw new ProjectDataInvalidError(`现场状态须为 ${DEVELOPMENT_WORKSPACE_STATES.join(" / ")}`);
  return {
    workspaceId: developmentIdentifier(input.workspaceId, "现场 ID"),
    backendId: developmentIdentifier(input.backendId, "现场后端"),
    directory: ledgerProjectDirectory(input.directory),
    branch: developmentBranch(input.branch, "现场分支"),
    baseCommit: developmentCommit(input.baseCommit),
    state: state as DevelopmentWorkspaceState,
    ...(input.error === undefined ? {} : { error: bounded(input.error, "现场错误", 2000) })
  };
}
