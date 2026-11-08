import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ledgerContent,
  ledgerDecisionText,
  ledgerIdentifier,
  ledgerNote,
  ledgerProjectDirectory,
  ledgerProjectId,
  ledgerProjectName,
  ledgerReferences,
  ledgerRevision,
  ledgerSearchText,
  ledgerSource,
  ledgerStatus,
  ledgerTaskId,
  ledgerTitle,
  ProjectDataConflictError,
  ProjectDataInvalidError,
  ProjectDataNotFoundError,
  type LedgerSource,
  type ProjectIdentity,
  type RequirementDecision,
  type RequirementDetail,
  type RequirementReference,
  type RequirementRevision,
  type RequirementStatus,
  type RequirementSummary,
  type SharedProject
} from "../domain/project-ledger.js";
import {
  mainSessionEntryKind,
  mainSessionKind,
  mainSessionRunState,
  mainSessionTitle,
  mainSessionTitleFromGoal,
  type MainSession,
  type MainSessionRun,
  type MainSessionRunState
} from "../domain/main-session.js";
import {
  reviewAuthor,
  reviewCandidate,
  reviewChangedPaths,
  reviewChecks,
  reviewCreate,
  reviewFinding,
  reviewPlanInput,
  reviewRework,
  reviewReviewer,
  reviewState,
  reviewUpdate,
  reviewVerdict,
  type DevelopmentReview,
  type ReviewKind,
  type ReviewPlan
} from "../domain/development-review.js";
import {
  DevelopmentExistsError,
  developmentBaseline,
  developmentCommit,
  developmentCompletionCriteria,
  developmentGoal,
  developmentIdentifier,
  developmentRoute,
  developmentStatus,
  developmentWorkspace,
  mergeExecutionBackendId,
  mergeRepository,
  mergeTargetBranch,
  type DevelopmentBaseline,
  type DevelopmentRecord,
  type DevelopmentStatus,
  type DevelopmentWorkspace,
  type MergeConfig
} from "../domain/project-development.js";
import {
  type BoardAction,
  type BoardActionContext,
  type BoardActionInput,
  type BoardEntry,
  type BoardEvent,
  type BoardPublishInput
} from "../domain/project-board.js";
import { id, now } from "../domain/types.js";
import {
  openProjectDataDatabase,
  projectDataTarget,
  resolveProjectDataConfig,
  type ProjectDataConfig,
  type ProjectDataEngine
} from "../storage/project-data/config.js";
import type { SqlDatabase, SqlTransaction } from "../storage/project-data/database.js";
import { ProjectBoardRepository } from "./project-board.js";
import { RemoteProjectDataService } from "./project-data-remote.js";

interface ProjectRow {
  project_id: string;
  project_name: string;
  created_at: string;
  updated_at: string;
}
interface RequirementRow {
  project_id: string;
  requirement_id: string;
  title: string;
  content: string;
  source_kind: string;
  source_reference: string | null;
  status: string;
  revision: number;
  created_at: string;
  updated_at: string;
}
interface RevisionRow {
  revision: number;
  title: string;
  content: string;
  status: string;
  source_kind: string;
  source_reference: string | null;
  note: string | null;
  task_id: string | null;
  created_at: string;
}
interface DecisionRow {
  decision_id: string;
  text: string;
  effective: number;
  source_kind: string;
  source_reference: string | null;
  at_revision: number;
  created_at: string;
}
interface ReferenceRow {
  reference_id: string;
  kind: string;
  value: string;
  created_at: string;
}
interface MainSessionRow {
  project_id: string;
  session_id: string;
  title: string;
  entry_kind: string;
  kind: string;
  backend_id: string;
  task_id: string;
  current_requirement_id: string | null;
  created_at: string;
  updated_at: string;
  requirement_title: string | null;
}
interface MainSessionRunRow {
  project_id: string;
  session_id: string;
  run_id: string;
  task_id: string;
  requirement_id: string | null;
  state: string;
  created_at: string;
  updated_at: string;
}
interface DevelopmentRow {
  project_id: string;
  development_id: string;
  requirement_id: string;
  goal: string;
  completion_criteria: string;
  route: string;
  status: string;
  revision: number;
  baseline_branch: string;
  baseline_commit: string;
  session_id: string | null;
  task_id: string | null;
  created_at: string;
  updated_at: string;
  requirement_title?: string | null;
}
interface DevelopmentWorkspaceRow {
  project_id: string;
  development_id: string;
  backend_id: string;
  workspace_id: string;
  directory: string;
  branch: string;
  base_commit: string;
  state: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}
interface MergeConfigRow {
  project_id: string;
  repository: string;
  target_branch: string;
  execution_backend_id: string;
  created_at: string;
  updated_at: string;
}
interface ReviewPlanRow {
  project_id: string;
  development_id: string;
  channel: string;
  basis: string;
  checks: string;
  revision: number;
  created_at: string;
  updated_at: string;
}
interface ReviewRow {
  project_id: string;
  review_id: string;
  development_id: string;
  kind: string;
  state: string;
  revision: number;
  candidate_commit: string;
  candidate_tree: string;
  candidate_branch: string;
  candidate_workspace: string;
  author: string | null;
  previous_review_id: string | null;
  previous_candidate_commit: string | null;
  changed_paths: string;
  reviewer: string | null;
  findings: string;
  reworks: string;
  verdict: string | null;
  drift: string | null;
  created_at: string;
  updated_at: string;
}

/** One session with the requirement it is on and the Runs it already owns. */
export interface MainSessionRecord {
  session: MainSession;
  currentRequirementTitle?: string;
  runs: MainSessionRun[];
}

export interface RequirementQuery {
  text?: unknown;
  status?: unknown;
  limit?: unknown;
}

export interface RequirementCreate {
  title?: unknown;
  content?: unknown;
  source?: unknown;
  references?: unknown;
}

export interface RequirementUpdate {
  expectedRevision?: unknown;
  title?: unknown;
  content?: unknown;
  status?: unknown;
  note?: unknown;
  taskId?: unknown;
}

export interface DevelopmentCreate {
  requirementId?: unknown;
  goal?: unknown;
  completionCriteria?: unknown;
  route?: unknown;
  baseline?: unknown;
  sessionId?: unknown;
  taskId?: unknown;
}

export interface DevelopmentUpdate {
  expectedRevision?: unknown;
  goal?: unknown;
  completionCriteria?: unknown;
  route?: unknown;
}

export interface MergeConfigInput {
  repository?: unknown;
  targetBranch?: unknown;
  executionBackendId?: unknown;
}

export interface ProjectDataDescription {
  engine: ProjectDataEngine;
  /** A locatable target: the SQLite file or `postgresql://host:port/database`. */
  target: string;
  serverVersion: string;
  schemaVersion: number;
  source: string;
}

export interface ProjectDataBackup {
  path: string;
  engine: ProjectDataEngine;
  takenAt: string;
  schemaVersion: number;
  counts: Record<string, number>;
}

export interface ProjectDataRestore {
  takenAt: string;
  counts: Record<string, number>;
}

/**
 * The business surface every consumer uses.
 *
 * A local authority serves this from SQLite/PostgreSQL; a secondary backend
 * serves the same surface through the authenticated remote client. HTTP routes
 * and the Main tool therefore never branch on where the fact is stored.
 */
export interface ProjectDataGateway {
  readonly description: ProjectDataDescription;
  ensureProject(input: Parameters<ProjectDataRepository["ensureProject"]>[0]): Promise<ProjectIdentity>;
  projects(): Promise<SharedProject[]>;
  createRequirement(projectId: unknown, input: RequirementCreate): Promise<RequirementDetail>;
  updateRequirement(
    projectId: unknown,
    requirementId: unknown,
    input: RequirementUpdate
  ): Promise<RequirementDetail>;
  addDecision(
    projectId: unknown,
    requirementId: unknown,
    input: { expectedRevision?: unknown; text?: unknown; effective?: unknown; source?: unknown }
  ): Promise<RequirementDetail>;
  setDecisionEffective(
    projectId: unknown,
    requirementId: unknown,
    decisionId: unknown,
    input: { expectedRevision?: unknown; effective?: unknown }
  ): Promise<RequirementDetail>;
  getRequirement(projectId: unknown, requirementId: unknown): Promise<RequirementDetail>;
  queryRequirements(projectId: unknown, query?: RequirementQuery): Promise<RequirementSummary[]>;
  // Persistent Main sessions are business facts too: a secondary backend writes
  // them through this surface, never through SQL or a transaction callback.
  createMainSession(
    projectId: unknown,
    input: Parameters<ProjectDataRepository["createMainSession"]>[1]
  ): Promise<MainSessionRecord>;
  adoptMainSessionTasks(
    projectId: unknown,
    backendId: unknown,
    tasks: Parameters<ProjectDataRepository["adoptMainSessionTasks"]>[2]
  ): Promise<number>;
  listMainSessions(projectId: unknown): Promise<MainSessionRecord[]>;
  getMainSession(projectId: unknown, sessionId: unknown): Promise<MainSessionRecord>;
  findMainSessionByTask(
    projectId: unknown,
    backendId: unknown,
    taskId: unknown
  ): Promise<MainSessionRecord | undefined>;
  setMainSessionRequirement(
    projectId: unknown,
    sessionId: unknown,
    requirementId: unknown
  ): Promise<MainSessionRecord>;
  recordMainSessionRun(
    projectId: unknown,
    sessionId: unknown,
    input: Parameters<ProjectDataRepository["recordMainSessionRun"]>[2]
  ): Promise<MainSessionRun>;
  settleMainSessionRun(projectId: unknown, taskId: unknown, runId: unknown, state: unknown): Promise<number>;
  // Development records go through this same surface: the shared goal/baseline
  // and each backend's own checkout are written as business facts.
  mergeConfig(projectId: unknown): Promise<MergeConfig | undefined>;
  setMergeConfig(projectId: unknown, input: MergeConfigInput, backendId: string): Promise<MergeConfig>;
  createDevelopment(projectId: unknown, input: DevelopmentCreate): Promise<DevelopmentRecord>;
  updateDevelopment(
    projectId: unknown,
    developmentId: unknown,
    input: DevelopmentUpdate,
    backendId?: string
  ): Promise<DevelopmentRecord>;
  getDevelopment(projectId: unknown, developmentId: unknown, backendId?: string): Promise<DevelopmentRecord>;
  queryDevelopments(projectId: unknown, backendId?: string): Promise<DevelopmentRecord[]>;
  findDevelopmentByRequirement(
    projectId: unknown,
    requirementId: unknown,
    backendId?: string
  ): Promise<DevelopmentRecord | undefined>;
  recordDevelopmentWorkspace(
    projectId: unknown,
    developmentId: unknown,
    workspace: unknown
  ): Promise<DevelopmentRecord>;
  // Review plans and fixed-candidate reviews are shared delivery facts too.
  reviewPlan(projectId: unknown, developmentId: unknown): Promise<ReviewPlan | undefined>;
  setReviewPlan(projectId: unknown, developmentId: unknown, input: unknown): Promise<ReviewPlan>;
  createReview(projectId: unknown, developmentId: unknown, input: unknown): Promise<DevelopmentReview>;
  updateReview(projectId: unknown, reviewId: unknown, input: unknown): Promise<DevelopmentReview>;
  getReview(projectId: unknown, reviewId: unknown): Promise<DevelopmentReview>;
  queryReviews(projectId: unknown, developmentId?: unknown): Promise<DevelopmentReview[]>;
  boardEntries(projectId: unknown): Promise<BoardEntry[]>;
  boardEntry(projectId: unknown, boardId: unknown): Promise<BoardEntry>;
  boardEvents(projectId: unknown, boardId: unknown): Promise<BoardEvent[]>;
  publishBoardEntry(
    projectId: unknown,
    input: BoardPublishInput,
    context: BoardActionContext
  ): Promise<BoardEntry>;
  boardAction(
    projectId: unknown,
    boardId: unknown,
    action: BoardAction,
    input: BoardActionInput,
    context: BoardActionContext
  ): Promise<BoardEntry>;
  backupTo(path: string): Promise<ProjectDataBackup>;
  restoreFrom(path: string): Promise<ProjectDataRestore>;
  close(): Promise<void>;
}

const SNAPSHOT_VERSION = 4;
const TABLES = [
  "project_data_projects",
  "project_data_bindings",
  "project_data_requirements",
  "project_data_requirement_revisions",
  "project_data_decisions",
  "project_data_references",
  "project_data_board_entries",
  "project_data_board_events",
  "project_data_main_sessions",
  "project_data_main_session_runs",
  "project_data_developments",
  "project_data_development_workspaces",
  "project_data_development_review_plans",
  "project_data_development_reviews",
  "project_data_merge_configs"
] as const;
type SnapshotTable = (typeof TABLES)[number];

/** Restore accepts only these columns, so a snapshot cannot shape the INSERT. */
const TABLE_COLUMNS: Record<SnapshotTable, readonly string[]> = {
  project_data_projects: ["project_id", "project_name", "created_at", "updated_at"],
  project_data_bindings: ["backend_id", "project_id", "local_directory", "created_at", "updated_at"],
  project_data_requirements: [
    "project_id",
    "requirement_id",
    "title",
    "content",
    "source_kind",
    "source_reference",
    "status",
    "revision",
    "created_at",
    "updated_at"
  ],
  project_data_requirement_revisions: [
    "project_id",
    "requirement_id",
    "revision",
    "title",
    "content",
    "status",
    "source_kind",
    "source_reference",
    "note",
    "task_id",
    "created_at"
  ],
  project_data_decisions: [
    "project_id",
    "requirement_id",
    "decision_id",
    "text",
    "effective",
    "source_kind",
    "source_reference",
    "at_revision",
    "created_at"
  ],
  project_data_references: ["project_id", "requirement_id", "reference_id", "kind", "value", "created_at"],
  project_data_board_entries: [
    "project_id",
    "board_id",
    "requirement_id",
    "entry_kind",
    "state",
    "revision",
    "backend_id",
    "publish_request_id",
    "assignment_kind",
    "assignee_id",
    "handler_backend_id",
    "handler_project_id",
    "handler_task_id",
    "assigned_at",
    "created_at",
    "updated_at"
  ],
  project_data_board_events: [
    "project_id",
    "board_id",
    "event_id",
    "kind",
    "request_id",
    "actor_id",
    "handler_backend_id",
    "handler_project_id",
    "handler_task_id",
    "from_state",
    "to_state",
    "revision",
    "created_at"
  ],
  project_data_main_sessions: [
    "project_id",
    "session_id",
    "title",
    "entry_kind",
    "kind",
    "backend_id",
    "task_id",
    "current_requirement_id",
    "created_at",
    "updated_at"
  ],
  project_data_main_session_runs: [
    "project_id",
    "session_id",
    "run_id",
    "task_id",
    "requirement_id",
    "state",
    "created_at",
    "updated_at"
  ],
  project_data_developments: [
    "project_id",
    "development_id",
    "requirement_id",
    "goal",
    "completion_criteria",
    "route",
    "status",
    "revision",
    "baseline_branch",
    "baseline_commit",
    "session_id",
    "task_id",
    "created_at",
    "updated_at"
  ],
  project_data_development_workspaces: [
    "project_id",
    "development_id",
    "backend_id",
    "workspace_id",
    "directory",
    "branch",
    "base_commit",
    "state",
    "error",
    "created_at",
    "updated_at"
  ],
  project_data_merge_configs: [
    "project_id",
    "repository",
    "target_branch",
    "execution_backend_id",
    "created_at",
    "updated_at"
  ],
  project_data_development_review_plans: [
    "project_id",
    "development_id",
    "channel",
    "basis",
    "checks",
    "revision",
    "created_at",
    "updated_at"
  ],
  project_data_development_reviews: [
    "project_id",
    "review_id",
    "development_id",
    "kind",
    "state",
    "revision",
    "candidate_commit",
    "candidate_tree",
    "candidate_branch",
    "candidate_workspace",
    "author",
    "previous_review_id",
    "previous_candidate_commit",
    "changed_paths",
    "reviewer",
    "findings",
    "reworks",
    "verdict",
    "drift",
    "created_at",
    "updated_at"
  ]
};

interface ProjectDataSnapshot {
  version: number;
  engine: ProjectDataEngine;
  takenAt: string;
  schemaVersion: number;
  tables: Record<SnapshotTable, Array<Record<string, unknown>>>;
}

function sourceOf(kind: string, reference: string | null): LedgerSource {
  return { kind: kind as LedgerSource["kind"], ...(reference ? { reference } : {}) };
}

function decisionOf(row: DecisionRow): RequirementDecision {
  return {
    decisionId: row.decision_id,
    text: row.text,
    effective: row.effective === 1,
    source: sourceOf(row.source_kind, row.source_reference),
    atRevision: Number(row.at_revision),
    createdAt: row.created_at
  };
}

function revisionOf(row: RevisionRow): RequirementRevision {
  return {
    revision: Number(row.revision),
    title: row.title,
    content: row.content,
    status: row.status as RequirementStatus,
    source: sourceOf(row.source_kind, row.source_reference),
    ...(row.note ? { note: row.note } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    createdAt: row.created_at
  };
}

function referenceOf(row: ReferenceRow): RequirementReference {
  return {
    referenceId: row.reference_id,
    kind: row.kind as RequirementReference["kind"],
    value: row.value,
    createdAt: row.created_at
  };
}

function runOf(row: MainSessionRunRow): MainSessionRun {
  return {
    projectId: row.project_id,
    sessionId: row.session_id,
    runId: row.run_id,
    taskId: row.task_id,
    ...(row.requirement_id ? { requirementId: row.requirement_id } : {}),
    state: row.state as MainSessionRunState,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function criteriaOf(raw: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProjectDataInvalidError("开发记录的完成标准已损坏");
  }
  return developmentCompletionCriteria(value);
}

function developmentOf(row: DevelopmentRow, workspace?: DevelopmentWorkspace): DevelopmentRecord {
  return {
    projectId: row.project_id,
    developmentId: row.development_id,
    requirementId: row.requirement_id,
    requirementTitle: row.requirement_title ?? "",
    goal: row.goal,
    completionCriteria: criteriaOf(row.completion_criteria),
    route: developmentRoute(row.route),
    status: developmentStatus(row.status),
    revision: Number(row.revision),
    baseline: developmentBaseline({ branch: row.baseline_branch, commit: row.baseline_commit }),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(workspace ? { workspace } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function workspaceOf(row: DevelopmentWorkspaceRow): DevelopmentWorkspace {
  return {
    workspaceId: row.workspace_id,
    backendId: row.backend_id,
    directory: row.directory,
    branch: row.branch,
    baseCommit: row.base_commit,
    state: row.state as DevelopmentWorkspace["state"],
    ...(row.error ? { error: row.error } : {})
  };
}

function storedJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ProjectDataInvalidError(`${label}已损坏`);
  }
}

function storedArray(raw: string, label: string): unknown[] {
  const value = storedJson(raw, label);
  if (!Array.isArray(value)) throw new ProjectDataInvalidError(`${label}已损坏`);
  return value;
}

function planOf(row: ReviewPlanRow): ReviewPlan {
  return {
    projectId: row.project_id,
    developmentId: row.development_id,
    channel: row.channel as ReviewPlan["channel"],
    basis: row.basis,
    checks: reviewChecks(storedArray(row.checks, "审查通道检查")),
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function reviewOf(row: ReviewRow): DevelopmentReview {
  return {
    projectId: row.project_id,
    reviewId: row.review_id,
    developmentId: row.development_id,
    kind: row.kind as ReviewKind,
    state: reviewState(row.state),
    revision: Number(row.revision),
    candidate: reviewCandidate({
      commit: row.candidate_commit,
      tree: row.candidate_tree,
      branch: row.candidate_branch,
      workspace: row.candidate_workspace
    }),
    ...(row.author ? { author: reviewAuthor(storedJson(row.author, "候选执行身份")) } : {}),
    ...(row.previous_review_id ? { previousReviewId: row.previous_review_id } : {}),
    ...(row.previous_candidate_commit ? { previousCandidateCommit: row.previous_candidate_commit } : {}),
    changedPaths: reviewChangedPaths(storedJson(row.changed_paths, "复审改动文件")),
    ...(row.reviewer ? { reviewer: reviewReviewer(storedJson(row.reviewer, "审查身份")) } : {}),
    findings: storedArray(row.findings, "审查发现").map(reviewFinding),
    reworks: storedArray(row.reworks, "返修记录").map(reviewRework),
    ...(row.verdict ? { verdict: reviewVerdict(storedJson(row.verdict, "审查结论")) } : {}),
    ...(row.drift ? { drift: row.drift } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mergeConfigOf(row: MergeConfigRow): MergeConfig {
  return {
    projectId: row.project_id,
    repository: row.repository,
    targetBranch: row.target_branch,
    executionBackendId: row.execution_backend_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function likePattern(text: string): string {
  return `%${text.toLowerCase().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

/**
 * Ledger writes inside one transaction.
 *
 * Every method here runs on the caller's transaction, so a future board entry
 * can be committed together with the requirement it projects.
 */
export class ProjectDataRepository {
  constructor(
    private readonly transaction: SqlTransaction,
    private readonly lockRows = false
  ) {}

  /** Record the shared identity and this backend's directory binding, keeping both apart. */
  async ensureProject(input: {
    projectId: unknown;
    projectName: unknown;
    projectDirectory: unknown;
    backendId: string;
  }): Promise<ProjectIdentity> {
    const projectId = ledgerProjectId(input.projectId);
    const projectName = ledgerProjectName(input.projectName);
    const projectDirectory = ledgerProjectDirectory(input.projectDirectory);
    const timestamp = now();
    const existing = await this.transaction.query<ProjectRow>(
      "SELECT * FROM project_data_projects WHERE project_id = ?",
      [projectId]
    );
    let createdAt = timestamp;
    if (existing.length) {
      createdAt = existing[0]!.created_at;
      if (existing[0]!.project_name !== projectName)
        await this.transaction.execute(
          "UPDATE project_data_projects SET project_name = ?, updated_at = ? WHERE project_id = ?",
          [projectName, timestamp, projectId]
        );
    } else {
      await this.transaction.execute(
        "INSERT INTO project_data_projects (project_id, project_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        [projectId, projectName, timestamp, timestamp]
      );
    }
    const binding = await this.transaction.query<{ local_directory: string }>(
      "SELECT local_directory FROM project_data_bindings WHERE backend_id = ? AND project_id = ?",
      [input.backendId, projectId]
    );
    if (!binding.length)
      await this.transaction.execute(
        "INSERT INTO project_data_bindings (backend_id, project_id, local_directory, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [input.backendId, projectId, projectDirectory, timestamp, timestamp]
      );
    else if (binding[0]!.local_directory !== projectDirectory)
      await this.transaction.execute(
        "UPDATE project_data_bindings SET local_directory = ?, updated_at = ? WHERE backend_id = ? AND project_id = ?",
        [projectDirectory, timestamp, input.backendId, projectId]
      );
    return { projectId, projectName, projectDirectory, createdAt, updatedAt: timestamp };
  }

  async projects(): Promise<SharedProject[]> {
    const rows = await this.transaction.query<ProjectRow>(
      "SELECT * FROM project_data_projects ORDER BY updated_at DESC, project_id ASC"
    );
    return rows.map((row) => ({
      projectId: row.project_id,
      projectName: row.project_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  async createRequirement(projectIdValue: unknown, input: RequirementCreate): Promise<RequirementDetail> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.requireProject(projectId);
    const requirementId = id("requirement");
    const title = ledgerTitle(input.title);
    const content = ledgerContent(input.content);
    const source = ledgerSource(input.source);
    const references = ledgerReferences(input.references);
    const timestamp = now();
    await this.transaction.execute(
      `INSERT INTO project_data_requirements
         (project_id, requirement_id, title, content, source_kind, source_reference, status, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        requirementId,
        title,
        content,
        source.kind,
        source.reference ?? null,
        "open",
        1,
        timestamp,
        timestamp
      ]
    );
    await this.insertRevision(projectId, requirementId, {
      revision: 1,
      title,
      content,
      status: "open",
      source,
      createdAt: timestamp
    });
    for (const reference of references)
      await this.transaction.execute(
        "INSERT INTO project_data_references (project_id, requirement_id, reference_id, kind, value, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [projectId, requirementId, id("reference"), reference.kind, reference.value, timestamp]
      );
    return this.requirement(projectId, requirementId);
  }

  async updateRequirement(
    projectIdValue: unknown,
    requirementIdValue: unknown,
    input: RequirementUpdate
  ): Promise<RequirementDetail> {
    const projectId = ledgerProjectId(projectIdValue);
    const requirementId = ledgerIdentifier(requirementIdValue, "需求 ID");
    const expectedRevision = ledgerRevision(input.expectedRevision);
    const current = await this.requireRequirement(projectId, requirementId);
    if (Number(current.revision) !== expectedRevision)
      throw new ProjectDataConflictError(
        "需求已更新，请基于最新修订重试",
        Number(current.revision),
        "revision_conflict"
      );
    const title = input.title === undefined ? current.title : ledgerTitle(input.title);
    const content = input.content === undefined ? current.content : ledgerContent(input.content);
    const status = ledgerStatus(input.status, current.status as RequirementStatus);
    const note = ledgerNote(input.note);
    const taskId = ledgerTaskId(input.taskId);
    const revision = expectedRevision + 1;
    const timestamp = now();
    await this.insertRevision(projectId, requirementId, {
      revision,
      title,
      content,
      status,
      source: sourceOf(current.source_kind, current.source_reference),
      note,
      taskId,
      createdAt: timestamp
    });
    const changed = await this.transaction.execute(
      `UPDATE project_data_requirements
          SET title = ?, content = ?, status = ?, revision = ?, updated_at = ?
        WHERE project_id = ? AND requirement_id = ? AND revision = ?`,
      [title, content, status, revision, timestamp, projectId, requirementId, expectedRevision]
    );
    if (changed !== 1)
      throw new ProjectDataConflictError("需求已被另一写入更新，请重新读取", undefined, "revision_conflict");
    return this.requirement(projectId, requirementId);
  }

  async addDecision(
    projectIdValue: unknown,
    requirementIdValue: unknown,
    input: { expectedRevision?: unknown; text?: unknown; effective?: unknown; source?: unknown }
  ): Promise<RequirementDetail> {
    const projectId = ledgerProjectId(projectIdValue);
    const requirementId = ledgerIdentifier(requirementIdValue, "需求 ID");
    const expectedRevision = ledgerRevision(input.expectedRevision);
    const current = await this.requireRequirement(projectId, requirementId);
    if (Number(current.revision) !== expectedRevision)
      throw new ProjectDataConflictError(
        "需求已更新，请基于最新修订重试",
        Number(current.revision),
        "revision_conflict"
      );
    const source = ledgerSource(input.source);
    const effective = input.effective === undefined ? true : input.effective;
    if (typeof effective !== "boolean") throw new ProjectDataInvalidError("effective 须为布尔值");
    await this.transaction.execute(
      `INSERT INTO project_data_decisions
         (project_id, requirement_id, decision_id, text, effective, source_kind, source_reference, at_revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        requirementId,
        id("decision"),
        ledgerDecisionText(input.text),
        effective ? 1 : 0,
        source.kind,
        source.reference ?? null,
        expectedRevision,
        now()
      ]
    );
    return this.requirement(projectId, requirementId);
  }

  async setDecisionEffective(
    projectIdValue: unknown,
    requirementIdValue: unknown,
    decisionIdValue: unknown,
    input: { expectedRevision?: unknown; effective?: unknown }
  ): Promise<RequirementDetail> {
    const projectId = ledgerProjectId(projectIdValue);
    const requirementId = ledgerIdentifier(requirementIdValue, "需求 ID");
    const decisionId = ledgerIdentifier(decisionIdValue, "决定 ID");
    const expectedRevision = ledgerRevision(input.expectedRevision);
    const current = await this.requireRequirement(projectId, requirementId);
    if (Number(current.revision) !== expectedRevision)
      throw new ProjectDataConflictError(
        "需求已更新，请基于最新修订重试",
        Number(current.revision),
        "revision_conflict"
      );
    if (typeof input.effective !== "boolean") throw new ProjectDataInvalidError("effective 须为布尔值");
    const changed = await this.transaction.execute(
      "UPDATE project_data_decisions SET effective = ? WHERE project_id = ? AND requirement_id = ? AND decision_id = ?",
      [input.effective ? 1 : 0, projectId, requirementId, decisionId]
    );
    if (changed !== 1) throw new ProjectDataNotFoundError("找不到该决定");
    return this.requirement(projectId, requirementId);
  }

  async requirement(projectIdValue: unknown, requirementIdValue: unknown): Promise<RequirementDetail> {
    const projectId = ledgerProjectId(projectIdValue);
    const requirementId = ledgerIdentifier(requirementIdValue, "需求 ID");
    const row = await this.requireRequirement(projectId, requirementId);
    // One client per transaction: queries stay sequential rather than racing it.
    const decisions = await this.decisions(projectId, [requirementId]);
    const references = await this.references(projectId, [requirementId]);
    const revisions = await this.transaction.query<RevisionRow>(
      "SELECT * FROM project_data_requirement_revisions WHERE project_id = ? AND requirement_id = ? ORDER BY revision ASC",
      [projectId, requirementId]
    );
    return {
      ...this.summaryOf(row, decisions, references),
      revisions: revisions.map(revisionOf)
    };
  }

  async query(projectIdValue: unknown, query: RequirementQuery = {}): Promise<RequirementSummary[]> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.requireProject(projectId);
    const text = ledgerSearchText(query.text);
    const status = query.status === undefined ? undefined : ledgerStatus(query.status);
    const limit = query.limit === undefined ? 50 : query.limit;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new ProjectDataInvalidError("limit 须为 1–200 的整数");
    const filters = ["project_id = ?"];
    const params: Array<string | number> = [projectId];
    if (status) {
      filters.push("status = ?");
      params.push(status);
    }
    if (text) {
      filters.push("(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(content) LIKE ? ESCAPE '\\')");
      const pattern = likePattern(text);
      params.push(pattern, pattern);
    }
    params.push(limit);
    const rows = await this.transaction.query<RequirementRow>(
      `SELECT * FROM project_data_requirements WHERE ${filters.join(" AND ")}
        ORDER BY updated_at DESC, requirement_id ASC LIMIT ?`,
      params
    );
    const ids = rows.map((row) => row.requirement_id);
    const decisions = await this.decisions(projectId, ids);
    const references = await this.references(projectId, ids);
    return rows.map((row) => this.summaryOf(row, decisions, references));
  }

  /**
   * A project's persistent Main sessions.
   *
   * The transcript stays with the Task on the backend that holds it, so these
   * methods only carry shared identity: which project, which requirement, which
   * local history container and which backend may run it.
   */
  async createMainSession(
    projectIdValue: unknown,
    input: {
      title?: unknown;
      entryKind?: unknown;
      kind?: unknown;
      backendId: unknown;
      taskId: unknown;
      requirementId?: unknown;
    }
  ): Promise<MainSessionRecord> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.requireProject(projectId);
    const backendId = ledgerIdentifier(input.backendId, "后端 ID");
    const taskId = ledgerIdentifier(input.taskId, "Task ID");
    const existing = await this.mainSessionRow(projectId, backendId, taskId);
    if (existing) return this.mainSession(projectId, existing.session_id);
    const requirementId =
      input.requirementId === undefined || input.requirementId === null
        ? undefined
        : ledgerIdentifier(input.requirementId, "需求 ID");
    const requirement = requirementId ? await this.requireRequirement(projectId, requirementId) : undefined;
    const title = input.title === undefined ? (requirement?.title ?? taskId) : mainSessionTitle(input.title);
    const timestamp = now();
    await this.transaction.execute(
      `INSERT INTO project_data_main_sessions
         (project_id, session_id, title, entry_kind, kind, backend_id, task_id, current_requirement_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        id("session"),
        title,
        mainSessionEntryKind(input.entryKind),
        mainSessionKind(input.kind),
        backendId,
        taskId,
        requirementId ?? null,
        timestamp,
        timestamp
      ]
    );
    const row = (await this.mainSessionRow(projectId, backendId, taskId))!;
    if (requirementId)
      await this.insertReferences(projectId, requirementId, [
        { kind: "session", value: row.session_id },
        { kind: "task", value: taskId }
      ]);
    return this.mainSession(projectId, row.session_id);
  }

  /**
   * Map existing Tasks into sessions without moving their history.
   *
   * A conversation that predates this table already owns its Pi directory; the
   * adoption only records the identity, so a conflict means another writer got
   * there first and is not an error.
   */
  async adoptMainSessionTasks(
    projectIdValue: unknown,
    backendIdValue: unknown,
    tasks: ReadonlyArray<{ taskId: string; title?: string; goal?: string }>
  ): Promise<number> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.requireProject(projectId);
    const backendId = ledgerIdentifier(backendIdValue, "后端 ID");
    let adopted = 0;
    for (const task of tasks) {
      const taskId = ledgerIdentifier(task.taskId, "Task ID");
      const timestamp = now();
      adopted += await this.transaction.execute(
        `INSERT INTO project_data_main_sessions
           (project_id, session_id, title, entry_kind, kind, backend_id, task_id, current_requirement_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        [
          projectId,
          id("session"),
          mainSessionTitleFromGoal(task.title ?? task.goal, taskId),
          "internal",
          "regular",
          backendId,
          taskId,
          null,
          timestamp,
          timestamp
        ]
      );
    }
    return adopted;
  }

  async mainSessions(projectIdValue: unknown): Promise<MainSessionRecord[]> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.requireProject(projectId);
    const rows = await this.transaction.query<MainSessionRow>(
      `SELECT s.*, r.title AS requirement_title
         FROM project_data_main_sessions s
         LEFT JOIN project_data_requirements r
           ON r.project_id = s.project_id AND r.requirement_id = s.current_requirement_id
        WHERE s.project_id = ?
        ORDER BY s.updated_at DESC, s.session_id ASC`,
      [projectId]
    );
    const runs = await this.mainSessionRuns(
      projectId,
      rows.map((row) => row.session_id)
    );
    return rows.map((row) => this.mainSessionRecord(row, runs.get(row.session_id) ?? []));
  }

  async mainSession(projectIdValue: unknown, sessionIdValue: unknown): Promise<MainSessionRecord> {
    const projectId = ledgerProjectId(projectIdValue);
    const row = await this.requireMainSession(projectId, sessionIdValue);
    const runs = await this.mainSessionRuns(projectId, [row.session_id]);
    return this.mainSessionRecord(row, runs.get(row.session_id) ?? []);
  }

  async mainSessionByTask(
    projectIdValue: unknown,
    backendIdValue: unknown,
    taskIdValue: unknown
  ): Promise<MainSessionRecord | undefined> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.requireProject(projectId);
    const backendId = ledgerIdentifier(backendIdValue, "后端 ID");
    const taskId = ledgerIdentifier(taskIdValue, "Task ID");
    const row = await this.mainSessionRow(projectId, backendId, taskId);
    if (!row) return undefined;
    const runs = await this.mainSessionRuns(projectId, [row.session_id]);
    return this.mainSessionRecord(row, runs.get(row.session_id) ?? []);
  }

  async setMainSessionRequirement(
    projectIdValue: unknown,
    sessionIdValue: unknown,
    requirementIdValue: unknown
  ): Promise<MainSessionRecord> {
    const projectId = ledgerProjectId(projectIdValue);
    const row = await this.requireMainSession(projectId, sessionIdValue);
    const requirementId = ledgerIdentifier(requirementIdValue, "需求 ID");
    await this.requireRequirement(projectId, requirementId);
    const timestamp = now();
    await this.transaction.execute(
      "UPDATE project_data_main_sessions SET current_requirement_id = ?, updated_at = ? WHERE project_id = ? AND session_id = ?",
      [requirementId, timestamp, projectId, row.session_id]
    );
    // The requirement records the session that accepted it, so the link survives
    // the session moving on to the next requirement.
    await this.insertReferences(projectId, requirementId, [
      { kind: "session", value: row.session_id },
      { kind: "task", value: row.task_id }
    ]);
    return this.mainSession(projectId, row.session_id);
  }

  /** Record that a Run belongs to this session; a later message on it keeps the row. */
  async recordMainSessionRun(
    projectIdValue: unknown,
    sessionIdValue: unknown,
    input: { runId: unknown; taskId: unknown; requirementId?: unknown; state?: unknown }
  ): Promise<MainSessionRun> {
    const projectId = ledgerProjectId(projectIdValue);
    const session = this.sessionOf(await this.requireMainSession(projectId, sessionIdValue));
    const runId = ledgerIdentifier(input.runId, "Run ID");
    const taskId = ledgerIdentifier(input.taskId, "Task ID");
    if (taskId !== session.taskId) throw new ProjectDataInvalidError("运行不属于该会话的历史容器");
    const requirementId =
      input.requirementId === undefined || input.requirementId === null
        ? undefined
        : ledgerIdentifier(input.requirementId, "需求 ID");
    if (requirementId) await this.requireRequirement(projectId, requirementId);
    const state = input.state === undefined ? "running" : mainSessionRunState(input.state);
    const timestamp = now();
    // A re-record carries the requirement only when the caller names one; an
    // ordinary retry or continuation must keep the link it already has.
    const changed = await this.transaction.execute(
      "UPDATE project_data_main_session_runs SET requirement_id = COALESCE(?, requirement_id), state = ?, updated_at = ? WHERE project_id = ? AND session_id = ? AND run_id = ?",
      [requirementId ?? null, state, timestamp, projectId, session.sessionId, runId]
    );
    if (!changed)
      await this.transaction.execute(
        `INSERT INTO project_data_main_session_runs
           (project_id, session_id, run_id, task_id, requirement_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [projectId, session.sessionId, runId, taskId, requirementId ?? null, state, timestamp, timestamp]
      );
    await this.transaction.execute(
      `UPDATE project_data_main_sessions
          SET current_requirement_id = COALESCE(?, current_requirement_id), updated_at = ?
        WHERE project_id = ? AND session_id = ?`,
      [requirementId ?? null, timestamp, projectId, session.sessionId]
    );
    if (requirementId)
      await this.insertReferences(projectId, requirementId, [
        { kind: "session", value: session.sessionId },
        { kind: "task", value: session.taskId }
      ]);
    const row = await this.transaction.query<MainSessionRunRow>(
      "SELECT * FROM project_data_main_session_runs WHERE project_id = ? AND session_id = ? AND run_id = ?",
      [projectId, session.sessionId, runId]
    );
    return runOf(row[0]!);
  }

  /** A settled or cancelled Run keeps its owner; a later state never overwrites one. */
  async settleMainSessionRun(
    projectIdValue: unknown,
    taskIdValue: unknown,
    runIdValue: unknown,
    stateValue: unknown
  ): Promise<number> {
    const projectId = ledgerProjectId(projectIdValue);
    const taskId = ledgerIdentifier(taskIdValue, "Task ID");
    const runId = ledgerIdentifier(runIdValue, "Run ID");
    const state = mainSessionRunState(stateValue);
    return this.transaction.execute(
      `UPDATE project_data_main_session_runs SET state = ?, updated_at = ?
        WHERE project_id = ? AND task_id = ? AND run_id = ? AND state = 'running'`,
      [state, now(), projectId, taskId, runId]
    );
  }

  /**
   * The project's single merge entry. It is shared configuration, while the
   * checkout each backend prepares from it stays that backend's own fact.
   */
  async mergeConfig(projectIdValue: unknown): Promise<MergeConfig | undefined> {
    const projectId = ledgerProjectId(projectIdValue);
    const rows = await this.transaction.query<MergeConfigRow>(
      "SELECT * FROM project_data_merge_configs WHERE project_id = ?",
      [projectId]
    );
    return rows.length ? mergeConfigOf(rows[0]!) : undefined;
  }

  async setMergeConfig(
    projectIdValue: unknown,
    input: MergeConfigInput,
    backendIdValue: unknown
  ): Promise<MergeConfig> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.requireProject(projectId);
    const repository = mergeRepository(input.repository);
    const targetBranch = mergeTargetBranch(input.targetBranch);
    const executionBackendId =
      input.executionBackendId === undefined
        ? ledgerIdentifier(backendIdValue, "后端 ID")
        : mergeExecutionBackendId(input.executionBackendId);
    const timestamp = now();
    const changed = await this.transaction.execute(
      `UPDATE project_data_merge_configs
          SET repository = ?, target_branch = ?, execution_backend_id = ?, updated_at = ?
        WHERE project_id = ?`,
      [repository, targetBranch, executionBackendId, timestamp, projectId]
    );
    if (!changed)
      await this.transaction.execute(
        `INSERT INTO project_data_merge_configs
           (project_id, repository, target_branch, execution_backend_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [projectId, repository, targetBranch, executionBackendId, timestamp, timestamp]
      );
    return (await this.mergeConfig(projectId))!;
  }

  /**
   * One development record per requirement: the goal, criteria, route and
   * baseline the Main agreed before any checkout exists.
   */
  async createDevelopment(projectIdValue: unknown, input: DevelopmentCreate): Promise<DevelopmentRecord> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.requireProject(projectId);
    const requirementId = ledgerIdentifier(input.requirementId, "需求 ID");
    await this.requireRequirement(projectId, requirementId);
    const existing = await this.developmentByRequirement(projectId, requirementId);
    if (existing)
      throw new DevelopmentExistsError(
        `该需求已有开发记录（${existing.development_id}）；请读取后更新，不要重复创建`,
        existing.development_id
      );
    const goal = developmentGoal(input.goal);
    const completionCriteria = developmentCompletionCriteria(input.completionCriteria);
    const route = developmentRoute(input.route);
    const baseline = developmentBaseline(input.baseline);
    const sessionId =
      input.sessionId === undefined || input.sessionId === null
        ? undefined
        : ledgerIdentifier(input.sessionId, "会话 ID");
    const taskId =
      input.taskId === undefined || input.taskId === null
        ? undefined
        : ledgerIdentifier(input.taskId, "Task ID");
    const timestamp = now();
    await this.transaction.execute(
      `INSERT INTO project_data_developments
         (project_id, development_id, requirement_id, goal, completion_criteria, route, status, revision,
          baseline_branch, baseline_commit, session_id, task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        id("development"),
        requirementId,
        goal,
        JSON.stringify(completionCriteria),
        route,
        "active",
        1,
        baseline.branch,
        baseline.commit,
        sessionId ?? null,
        taskId ?? null,
        timestamp,
        timestamp
      ]
    );
    const created = await this.developmentByRequirement(projectId, requirementId);
    return developmentOf(created!);
  }

  /** A newer revision replaces goal, criteria or route; a stale one is refused. */
  async updateDevelopment(
    projectIdValue: unknown,
    developmentIdValue: unknown,
    input: DevelopmentUpdate,
    backendIdValue?: unknown
  ): Promise<DevelopmentRecord> {
    const projectId = ledgerProjectId(projectIdValue);
    const developmentId = developmentIdentifier(developmentIdValue, "开发记录 ID");
    const expectedRevision = ledgerRevision(input.expectedRevision);
    const current = await this.requireDevelopment(projectId, developmentId);
    if (Number(current.revision) !== expectedRevision)
      throw new ProjectDataConflictError(
        "开发记录已更新，请基于最新修订重试",
        Number(current.revision),
        "revision_conflict"
      );
    const goal = input.goal === undefined ? current.goal : developmentGoal(input.goal);
    const completionCriteria =
      input.completionCriteria === undefined
        ? criteriaOf(current.completion_criteria)
        : developmentCompletionCriteria(input.completionCriteria);
    const route = input.route === undefined ? developmentRoute(current.route) : developmentRoute(input.route);
    const revision = expectedRevision + 1;
    const timestamp = now();
    const changed = await this.transaction.execute(
      `UPDATE project_data_developments
          SET goal = ?, completion_criteria = ?, route = ?, revision = ?, updated_at = ?
        WHERE project_id = ? AND development_id = ? AND revision = ?`,
      [
        goal,
        JSON.stringify(completionCriteria),
        route,
        revision,
        timestamp,
        projectId,
        developmentId,
        expectedRevision
      ]
    );
    if (changed !== 1)
      throw new ProjectDataConflictError(
        "开发记录已被另一写入更新，请重新读取",
        undefined,
        "revision_conflict"
      );
    return this.getDevelopment(projectId, developmentId, backendIdValue);
  }

  async getDevelopment(
    projectIdValue: unknown,
    developmentIdValue: unknown,
    backendIdValue?: unknown
  ): Promise<DevelopmentRecord> {
    const projectId = ledgerProjectId(projectIdValue);
    const developmentId = developmentIdentifier(developmentIdValue, "开发记录 ID");
    const row = await this.requireDevelopment(projectId, developmentId);
    const workspace = await this.developmentWorkspaceFor(projectId, developmentId, backendIdValue);
    return developmentOf(row, workspace);
  }

  async queryDevelopments(projectIdValue: unknown, backendIdValue?: unknown): Promise<DevelopmentRecord[]> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.requireProject(projectId);
    const rows = await this.transaction.query<DevelopmentRow>(
      `SELECT d.*, r.title AS requirement_title
         FROM project_data_developments d
         LEFT JOIN project_data_requirements r
           ON r.project_id = d.project_id AND r.requirement_id = d.requirement_id
        WHERE d.project_id = ?
        ORDER BY d.updated_at DESC, d.development_id ASC`,
      [projectId]
    );
    const workspaces = await this.developmentWorkspaces(
      projectId,
      rows.map((row) => row.development_id),
      backendIdValue
    );
    return rows.map((row) => developmentOf(row, workspaces.get(row.development_id)));
  }

  async findDevelopmentByRequirement(
    projectIdValue: unknown,
    requirementIdValue: unknown,
    backendIdValue?: unknown
  ): Promise<DevelopmentRecord | undefined> {
    const projectId = ledgerProjectId(projectIdValue);
    const requirementId = ledgerIdentifier(requirementIdValue, "需求 ID");
    const row = await this.developmentByRequirement(projectId, requirementId);
    if (!row) return undefined;
    const workspace = await this.developmentWorkspaceFor(projectId, row.development_id, backendIdValue);
    return developmentOf(row, workspace);
  }

  /**
   * Record the checkout this backend prepared (or failed to prepare). A failed
   * attempt keeps the identity and directory it last had, so the requirement
   * and its workspace remain findable instead of disappearing.
   */
  async recordDevelopmentWorkspace(
    projectIdValue: unknown,
    developmentIdValue: unknown,
    workspaceValue: unknown
  ): Promise<DevelopmentRecord> {
    const projectId = ledgerProjectId(projectIdValue);
    const developmentId = developmentIdentifier(developmentIdValue, "开发记录 ID");
    await this.requireDevelopment(projectId, developmentId);
    const workspace = developmentWorkspace(workspaceValue);
    const timestamp = now();
    const changed = await this.transaction.execute(
      `UPDATE project_data_development_workspaces
          SET workspace_id = ?, directory = ?, branch = ?, base_commit = ?, state = ?, error = ?, updated_at = ?
        WHERE project_id = ? AND development_id = ? AND backend_id = ?`,
      [
        workspace.workspaceId,
        workspace.directory,
        workspace.branch,
        workspace.baseCommit,
        workspace.state,
        workspace.error ?? null,
        timestamp,
        projectId,
        developmentId,
        workspace.backendId
      ]
    );
    if (!changed)
      await this.transaction.execute(
        `INSERT INTO project_data_development_workspaces
           (project_id, development_id, backend_id, workspace_id, directory, branch, base_commit, state, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          projectId,
          developmentId,
          workspace.backendId,
          workspace.workspaceId,
          workspace.directory,
          workspace.branch,
          workspace.baseCommit,
          workspace.state,
          workspace.error ?? null,
          timestamp,
          timestamp
        ]
      );
    return this.getDevelopment(projectId, developmentId, workspace.backendId);
  }

  async reviewPlan(projectIdValue: unknown, developmentIdValue: unknown): Promise<ReviewPlan | undefined> {
    const projectId = ledgerProjectId(projectIdValue);
    const developmentId = developmentIdentifier(developmentIdValue, "开发记录 ID");
    const rows = await this.transaction.query<ReviewPlanRow>(
      `SELECT * FROM project_data_development_review_plans
        WHERE project_id = ? AND development_id = ?`,
      [projectId, developmentId]
    );
    return rows[0] ? planOf(rows[0]) : undefined;
  }

  /** The latest channel decision for one development; a later write replaces it. */
  async setReviewPlan(
    projectIdValue: unknown,
    developmentIdValue: unknown,
    inputValue: unknown
  ): Promise<ReviewPlan> {
    const projectId = ledgerProjectId(projectIdValue);
    const developmentId = developmentIdentifier(developmentIdValue, "开发记录 ID");
    await this.requireDevelopment(projectId, developmentId);
    const input = reviewPlanInput(inputValue);
    const timestamp = now();
    const existing = await this.reviewPlan(projectId, developmentId);
    const revision = (existing?.revision ?? 0) + 1;
    const checks = JSON.stringify(input.checks);
    if (existing)
      await this.transaction.execute(
        `UPDATE project_data_development_review_plans
            SET channel = ?, basis = ?, checks = ?, revision = ?, updated_at = ?
          WHERE project_id = ? AND development_id = ?`,
        [input.channel, input.basis, checks, revision, timestamp, projectId, developmentId]
      );
    else
      await this.transaction.execute(
        `INSERT INTO project_data_development_review_plans
           (project_id, development_id, channel, basis, checks, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [projectId, developmentId, input.channel, input.basis, checks, revision, timestamp, timestamp]
      );
    return (await this.reviewPlan(projectId, developmentId))!;
  }

  /** Freeze one candidate as a new review; the Reviewer attaches to it separately. */
  async createReview(
    projectIdValue: unknown,
    developmentIdValue: unknown,
    inputValue: unknown
  ): Promise<DevelopmentReview> {
    const projectId = ledgerProjectId(projectIdValue);
    const developmentId = developmentIdentifier(developmentIdValue, "开发记录 ID");
    await this.requireDevelopment(projectId, developmentId);
    const input = reviewCreate({
      ...(inputValue && typeof inputValue === "object" && !Array.isArray(inputValue)
        ? (inputValue as Record<string, unknown>)
        : {}),
      developmentId
    });
    if (input.previousReviewId) await this.requireReview(projectId, input.previousReviewId);
    const reviewId = id("review");
    const timestamp = now();
    await this.transaction.execute(
      `INSERT INTO project_data_development_reviews
         (project_id, review_id, development_id, kind, state, revision,
          candidate_commit, candidate_tree, candidate_branch, candidate_workspace,
          author, previous_review_id, previous_candidate_commit, changed_paths,
          reviewer, findings, reworks, verdict, drift, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        reviewId,
        developmentId,
        input.kind,
        "in_review",
        1,
        input.candidate.commit,
        input.candidate.tree,
        input.candidate.branch,
        input.candidate.workspace,
        input.author ? JSON.stringify(input.author) : null,
        input.previousReviewId ?? null,
        input.previousCandidateCommit ?? null,
        JSON.stringify(input.changedPaths),
        null,
        "[]",
        "[]",
        null,
        null,
        timestamp,
        timestamp
      ]
    );
    return this.getReview(projectId, reviewId);
  }

  async getReview(projectIdValue: unknown, reviewIdValue: unknown): Promise<DevelopmentReview> {
    const projectId = ledgerProjectId(projectIdValue);
    const reviewId = ledgerIdentifier(reviewIdValue, "审查 ID");
    return reviewOf(await this.requireReview(projectId, reviewId));
  }

  async queryReviews(projectIdValue: unknown, developmentIdValue?: unknown): Promise<DevelopmentReview[]> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.requireProject(projectId);
    const developmentId =
      developmentIdValue === undefined ? undefined : developmentIdentifier(developmentIdValue, "开发记录 ID");
    const rows = await this.transaction.query<ReviewRow>(
      `SELECT * FROM project_data_development_reviews
        WHERE project_id = ?${developmentId ? " AND development_id = ?" : ""}
        ORDER BY created_at ASC, review_id ASC`,
      developmentId ? [projectId, developmentId] : [projectId]
    );
    return rows.map(reviewOf);
  }

  /** Replace one review's mutable fields; a stale revision is refused, like a record update. */
  async updateReview(
    projectIdValue: unknown,
    reviewIdValue: unknown,
    inputValue: unknown
  ): Promise<DevelopmentReview> {
    const projectId = ledgerProjectId(projectIdValue);
    const reviewId = ledgerIdentifier(reviewIdValue, "审查 ID");
    const current = await this.requireReview(projectId, reviewId);
    const input = reviewUpdate(
      inputValue && typeof inputValue === "object" && !Array.isArray(inputValue)
        ? (inputValue as Record<string, unknown>)
        : {}
    );
    const timestamp = now();
    const changed = await this.transaction.execute(
      `UPDATE project_data_development_reviews
          SET state = ?, revision = ?, reviewer = ?, findings = ?, reworks = ?, verdict = ?, drift = ?, updated_at = ?
        WHERE project_id = ? AND review_id = ? AND revision = ?`,
      [
        input.state ?? current.state,
        Number(current.revision) + 1,
        input.reviewer === undefined ? current.reviewer : JSON.stringify(input.reviewer),
        input.findings === undefined ? current.findings : JSON.stringify(input.findings),
        input.reworks === undefined ? current.reworks : JSON.stringify(input.reworks),
        input.verdict === undefined ? current.verdict : JSON.stringify(input.verdict),
        input.drift === undefined ? current.drift : input.drift,
        timestamp,
        projectId,
        reviewId,
        input.expectedRevision
      ]
    );
    if (changed !== 1)
      throw new ProjectDataConflictError(
        "审查记录已被另一写入更新，请重新读取",
        undefined,
        "revision_conflict"
      );
    return this.getReview(projectId, reviewId);
  }

  private async requireReview(projectId: string, reviewId: string): Promise<ReviewRow> {
    const rows = await this.transaction.query<ReviewRow>(
      `SELECT * FROM project_data_development_reviews
        WHERE project_id = ? AND review_id = ?${this.lockRows ? " FOR UPDATE" : ""}`,
      [projectId, reviewId]
    );
    if (!rows.length) throw new ProjectDataNotFoundError("审查记录不存在");
    return rows[0]!;
  }

  async mainSessionRuns(
    projectIdValue: unknown,
    sessionIds: string[]
  ): Promise<Map<string, MainSessionRun[]>> {
    const grouped = new Map<string, MainSessionRun[]>();
    if (!sessionIds.length) return grouped;
    const rows = await this.transaction.query<MainSessionRunRow>(
      `SELECT * FROM project_data_main_session_runs
        WHERE project_id = ? AND session_id IN (${sessionIds.map(() => "?").join(", ")})
        ORDER BY created_at DESC, run_id ASC`,
      [ledgerProjectId(projectIdValue), ...sessionIds]
    );
    for (const row of rows) {
      const list = grouped.get(row.session_id) ?? [];
      // A session list stays readable; the newest Runs describe its recent work.
      if (list.length < 50) list.push(runOf(row));
      grouped.set(row.session_id, list);
    }
    return grouped;
  }

  private async developmentByRequirement(
    projectId: string,
    requirementId: string
  ): Promise<DevelopmentRow | undefined> {
    const rows = await this.transaction.query<DevelopmentRow>(
      `SELECT d.*, r.title AS requirement_title
         FROM project_data_developments d
         LEFT JOIN project_data_requirements r
           ON r.project_id = d.project_id AND r.requirement_id = d.requirement_id
        WHERE d.project_id = ? AND d.requirement_id = ?`,
      [projectId, requirementId]
    );
    return rows[0];
  }

  private async requireDevelopment(projectId: string, developmentId: string): Promise<DevelopmentRow> {
    // PostgreSQL cannot lock the nullable side of an outer join, so the row is
    // locked on its own table and the requirement title is read separately.
    const rows = await this.transaction.query<DevelopmentRow>(
      `SELECT * FROM project_data_developments
        WHERE project_id = ? AND development_id = ?${this.lockRows ? " FOR UPDATE" : ""}`,
      [projectId, developmentId]
    );
    if (!rows.length) throw new ProjectDataNotFoundError("找不到该需求的开发记录");
    const titles = await this.transaction.query<{ title: string }>(
      "SELECT title FROM project_data_requirements WHERE project_id = ? AND requirement_id = ?",
      [projectId, rows[0]!.requirement_id]
    );
    return { ...rows[0]!, requirement_title: titles[0]?.title ?? null };
  }

  private async developmentWorkspaceFor(
    projectId: string,
    developmentId: string,
    backendIdValue?: unknown
  ): Promise<DevelopmentWorkspace | undefined> {
    if (backendIdValue === undefined || backendIdValue === null) return undefined;
    const backendId = ledgerIdentifier(backendIdValue, "后端 ID");
    const rows = await this.transaction.query<DevelopmentWorkspaceRow>(
      "SELECT * FROM project_data_development_workspaces WHERE project_id = ? AND development_id = ? AND backend_id = ?",
      [projectId, developmentId, backendId]
    );
    return rows.length ? workspaceOf(rows[0]!) : undefined;
  }

  private async developmentWorkspaces(
    projectId: string,
    developmentIds: string[],
    backendIdValue?: unknown
  ): Promise<Map<string, DevelopmentWorkspace>> {
    const grouped = new Map<string, DevelopmentWorkspace>();
    if (!developmentIds.length || backendIdValue === undefined || backendIdValue === null) return grouped;
    const backendId = ledgerIdentifier(backendIdValue, "后端 ID");
    const rows = await this.transaction.query<DevelopmentWorkspaceRow>(
      `SELECT * FROM project_data_development_workspaces
        WHERE project_id = ? AND backend_id = ? AND development_id IN (${developmentIds
          .map(() => "?")
          .join(", ")})`,
      [projectId, backendId, ...developmentIds]
    );
    for (const row of rows) grouped.set(row.development_id, workspaceOf(row));
    return grouped;
  }

  private sessionOf(row: MainSessionRow): MainSession {
    return {
      sessionId: row.session_id,
      projectId: row.project_id,
      title: row.title,
      entryKind: row.entry_kind as MainSession["entryKind"],
      kind: row.kind as MainSession["kind"],
      backendId: row.backend_id,
      taskId: row.task_id,
      ...(row.current_requirement_id ? { currentRequirementId: row.current_requirement_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mainSessionRecord(row: MainSessionRow, runs: MainSessionRun[]): MainSessionRecord {
    return {
      session: this.sessionOf(row),
      ...(row.requirement_title ? { currentRequirementTitle: row.requirement_title } : {}),
      runs
    };
  }

  private async mainSessionRow(
    projectId: string,
    backendId: string,
    taskId: string
  ): Promise<MainSessionRow | undefined> {
    const rows = await this.transaction.query<MainSessionRow>(
      `SELECT s.*, r.title AS requirement_title
         FROM project_data_main_sessions s
         LEFT JOIN project_data_requirements r
           ON r.project_id = s.project_id AND r.requirement_id = s.current_requirement_id
        WHERE s.project_id = ? AND s.backend_id = ? AND s.task_id = ?`,
      [projectId, backendId, taskId]
    );
    return rows[0];
  }

  private async requireMainSession(projectId: string, sessionIdValue: unknown): Promise<MainSessionRow> {
    const sessionId = ledgerIdentifier(sessionIdValue, "会话 ID");
    const rows = await this.transaction.query<MainSessionRow>(
      `SELECT s.*, r.title AS requirement_title
         FROM project_data_main_sessions s
         LEFT JOIN project_data_requirements r
           ON r.project_id = s.project_id AND r.requirement_id = s.current_requirement_id
        WHERE s.project_id = ? AND s.session_id = ?`,
      [projectId, sessionId]
    );
    if (!rows.length) throw new ProjectDataNotFoundError("找不到该 Main 会话");
    return rows[0]!;
  }

  /** Append only the links a requirement does not already carry. */
  private async insertReferences(
    projectId: string,
    requirementId: string,
    references: Array<{ kind: RequirementReference["kind"]; value: string }>
  ): Promise<void> {
    const existing = await this.transaction.query<ReferenceRow>(
      "SELECT reference_id, kind, value FROM project_data_references WHERE project_id = ? AND requirement_id = ?",
      [projectId, requirementId]
    );
    const known = new Set(existing.map((row) => `${row.kind}\u0000${row.value}`));
    for (const reference of references) {
      if (known.has(`${reference.kind}\u0000${reference.value}`)) continue;
      known.add(`${reference.kind}\u0000${reference.value}`);
      await this.transaction.execute(
        "INSERT INTO project_data_references (project_id, requirement_id, reference_id, kind, value, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [projectId, requirementId, id("reference"), reference.kind, reference.value, now()]
      );
    }
  }

  private summaryOf(
    row: RequirementRow,
    decisions: Map<string, RequirementDecision[]>,
    references: Map<string, RequirementReference[]>
  ): RequirementSummary {
    return {
      projectId: row.project_id,
      requirementId: row.requirement_id,
      title: row.title,
      content: row.content,
      source: sourceOf(row.source_kind, row.source_reference),
      status: row.status as RequirementStatus,
      revision: Number(row.revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      decisions: decisions.get(row.requirement_id) ?? [],
      references: references.get(row.requirement_id) ?? []
    };
  }

  private async insertRevision(
    projectId: string,
    requirementId: string,
    revision: RequirementRevision
  ): Promise<void> {
    await this.transaction.execute(
      `INSERT INTO project_data_requirement_revisions
         (project_id, requirement_id, revision, title, content, status, source_kind, source_reference, note, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        requirementId,
        revision.revision,
        revision.title,
        revision.content,
        revision.status,
        revision.source.kind,
        revision.source.reference ?? null,
        revision.note ?? null,
        revision.taskId ?? null,
        revision.createdAt
      ]
    );
  }

  private async requireProject(projectId: string): Promise<ProjectRow> {
    const rows = await this.transaction.query<ProjectRow>(
      "SELECT * FROM project_data_projects WHERE project_id = ?",
      [projectId]
    );
    if (!rows.length) throw new ProjectDataNotFoundError("找不到该项目的共享记录");
    return rows[0]!;
  }

  private async requireRequirement(projectId: string, requirementId: string): Promise<RequirementRow> {
    const rows = await this.transaction.query<RequirementRow>(
      `SELECT * FROM project_data_requirements WHERE project_id = ? AND requirement_id = ?${
        this.lockRows ? " FOR UPDATE" : ""
      }`,
      [projectId, requirementId]
    );
    if (!rows.length) throw new ProjectDataNotFoundError("找不到该需求");
    return rows[0]!;
  }

  private async decisions(
    projectId: string,
    requirementIds: string[]
  ): Promise<Map<string, RequirementDecision[]>> {
    const grouped = new Map<string, RequirementDecision[]>();
    if (!requirementIds.length) return grouped;
    const rows = await this.transaction.query<DecisionRow & { requirement_id: string }>(
      `SELECT * FROM project_data_decisions WHERE project_id = ? AND requirement_id IN (${requirementIds
        .map(() => "?")
        .join(", ")}) ORDER BY created_at ASC, decision_id ASC`,
      [projectId, ...requirementIds]
    );
    for (const row of rows) {
      const list = grouped.get(row.requirement_id) ?? [];
      list.push(decisionOf(row));
      grouped.set(row.requirement_id, list);
    }
    return grouped;
  }

  private async references(
    projectId: string,
    requirementIds: string[]
  ): Promise<Map<string, RequirementReference[]>> {
    const grouped = new Map<string, RequirementReference[]>();
    if (!requirementIds.length) return grouped;
    const rows = await this.transaction.query<ReferenceRow & { requirement_id: string }>(
      `SELECT * FROM project_data_references WHERE project_id = ? AND requirement_id IN (${requirementIds
        .map(() => "?")
        .join(", ")}) ORDER BY created_at ASC, reference_id ASC`,
      [projectId, ...requirementIds]
    );
    for (const row of rows) {
      const list = grouped.get(row.requirement_id) ?? [];
      list.push(referenceOf(row));
      grouped.set(row.requirement_id, list);
    }
    return grouped;
  }

  /** Board writes share this transaction, so a published entry commits with its requirement. */
  board(): ProjectBoardRepository {
    return new ProjectBoardRepository(this.transaction, this, this.lockRows);
  }
}

/**
 * The authoritative project data service: shared identity, the requirement
 * ledger, and the backup/restore pair. HTTP, the Main tool and the CLI all use
 * this one interface, so engine choice never changes business behaviour.
 */
export class ProjectDataService implements ProjectDataGateway {
  constructor(
    private readonly database: SqlDatabase,
    readonly description: ProjectDataDescription
  ) {}

  /** Run ledger writes that commit or roll back together. */
  transaction<T>(action: (repository: ProjectDataRepository) => Promise<T>): Promise<T> {
    return this.database.transaction((transaction) =>
      action(new ProjectDataRepository(transaction, this.database.dialect === "postgres"))
    );
  }

  ensureProject(input: Parameters<ProjectDataRepository["ensureProject"]>[0]) {
    return this.transaction((repository) => repository.ensureProject(input));
  }
  projects() {
    return this.transaction((repository) => repository.projects());
  }
  createRequirement(projectId: unknown, input: RequirementCreate) {
    return this.transaction((repository) => repository.createRequirement(projectId, input));
  }
  updateRequirement(projectId: unknown, requirementId: unknown, input: RequirementUpdate) {
    return this.transaction((repository) => repository.updateRequirement(projectId, requirementId, input));
  }
  addDecision(
    projectId: unknown,
    requirementId: unknown,
    input: { expectedRevision?: unknown; text?: unknown; effective?: unknown; source?: unknown }
  ) {
    return this.transaction((repository) => repository.addDecision(projectId, requirementId, input));
  }
  setDecisionEffective(
    projectId: unknown,
    requirementId: unknown,
    decisionId: unknown,
    input: { expectedRevision?: unknown; effective?: unknown }
  ) {
    return this.transaction((repository) =>
      repository.setDecisionEffective(projectId, requirementId, decisionId, input)
    );
  }
  getRequirement(projectId: unknown, requirementId: unknown) {
    return this.transaction((repository) => repository.requirement(projectId, requirementId));
  }
  queryRequirements(projectId: unknown, query: RequirementQuery = {}) {
    return this.transaction((repository) => repository.query(projectId, query));
  }
  createMainSession(projectId: unknown, input: Parameters<ProjectDataRepository["createMainSession"]>[1]) {
    return this.transaction((repository) => repository.createMainSession(projectId, input));
  }
  adoptMainSessionTasks(
    projectId: unknown,
    backendId: unknown,
    tasks: Parameters<ProjectDataRepository["adoptMainSessionTasks"]>[2]
  ) {
    return this.transaction((repository) => repository.adoptMainSessionTasks(projectId, backendId, tasks));
  }
  listMainSessions(projectId: unknown) {
    return this.transaction((repository) => repository.mainSessions(projectId));
  }
  getMainSession(projectId: unknown, sessionId: unknown) {
    return this.transaction((repository) => repository.mainSession(projectId, sessionId));
  }
  findMainSessionByTask(projectId: unknown, backendId: unknown, taskId: unknown) {
    return this.transaction((repository) => repository.mainSessionByTask(projectId, backendId, taskId));
  }
  setMainSessionRequirement(projectId: unknown, sessionId: unknown, requirementId: unknown) {
    return this.transaction((repository) =>
      repository.setMainSessionRequirement(projectId, sessionId, requirementId)
    );
  }
  recordMainSessionRun(
    projectId: unknown,
    sessionId: unknown,
    input: Parameters<ProjectDataRepository["recordMainSessionRun"]>[2]
  ) {
    return this.transaction((repository) => repository.recordMainSessionRun(projectId, sessionId, input));
  }
  settleMainSessionRun(projectId: unknown, taskId: unknown, runId: unknown, state: unknown) {
    return this.transaction((repository) => repository.settleMainSessionRun(projectId, taskId, runId, state));
  }

  mergeConfig(projectId: unknown) {
    return this.transaction((repository) => repository.mergeConfig(projectId));
  }
  setMergeConfig(projectId: unknown, input: MergeConfigInput, backendId: string) {
    return this.transaction((repository) => repository.setMergeConfig(projectId, input, backendId));
  }
  createDevelopment(projectId: unknown, input: DevelopmentCreate) {
    return this.transaction((repository) => repository.createDevelopment(projectId, input));
  }
  updateDevelopment(
    projectId: unknown,
    developmentId: unknown,
    input: DevelopmentUpdate,
    backendId?: string
  ) {
    return this.transaction((repository) =>
      repository.updateDevelopment(projectId, developmentId, input, backendId)
    );
  }
  getDevelopment(projectId: unknown, developmentId: unknown, backendId?: string) {
    return this.transaction((repository) => repository.getDevelopment(projectId, developmentId, backendId));
  }
  queryDevelopments(projectId: unknown, backendId?: string) {
    return this.transaction((repository) => repository.queryDevelopments(projectId, backendId));
  }
  findDevelopmentByRequirement(projectId: unknown, requirementId: unknown, backendId?: string) {
    return this.transaction((repository) =>
      repository.findDevelopmentByRequirement(projectId, requirementId, backendId)
    );
  }
  recordDevelopmentWorkspace(projectId: unknown, developmentId: unknown, workspace: unknown) {
    return this.transaction((repository) =>
      repository.recordDevelopmentWorkspace(projectId, developmentId, workspace)
    );
  }
  reviewPlan(projectId: unknown, developmentId: unknown) {
    return this.transaction((repository) => repository.reviewPlan(projectId, developmentId));
  }
  setReviewPlan(projectId: unknown, developmentId: unknown, input: unknown) {
    return this.transaction((repository) => repository.setReviewPlan(projectId, developmentId, input));
  }
  createReview(projectId: unknown, developmentId: unknown, input: unknown) {
    return this.transaction((repository) => repository.createReview(projectId, developmentId, input));
  }
  updateReview(projectId: unknown, reviewId: unknown, input: unknown) {
    return this.transaction((repository) => repository.updateReview(projectId, reviewId, input));
  }
  getReview(projectId: unknown, reviewId: unknown) {
    return this.transaction((repository) => repository.getReview(projectId, reviewId));
  }
  queryReviews(projectId: unknown, developmentId?: unknown) {
    return this.transaction((repository) => repository.queryReviews(projectId, developmentId));
  }

  boardEntries(projectId: unknown) {
    const sharedProjectId = ledgerProjectId(projectId);
    return this.transaction((repository) => repository.board().list(sharedProjectId));
  }
  boardEntry(projectId: unknown, boardId: unknown) {
    const sharedProjectId = ledgerProjectId(projectId);
    return this.transaction((repository) => repository.board().get(sharedProjectId, boardId));
  }
  boardEvents(projectId: unknown, boardId: unknown) {
    const sharedProjectId = ledgerProjectId(projectId);
    return this.transaction((repository) => repository.board().events(sharedProjectId, boardId));
  }
  publishBoardEntry(projectId: unknown, input: BoardPublishInput, context: BoardActionContext) {
    const sharedProjectId = ledgerProjectId(projectId);
    return this.transaction((repository) => repository.board().publish(sharedProjectId, input, context));
  }
  boardAction(
    projectId: unknown,
    boardId: unknown,
    action: BoardAction,
    input: BoardActionInput,
    context: BoardActionContext
  ) {
    const sharedProjectId = ledgerProjectId(projectId);
    return this.transaction((repository) => {
      const board = repository.board();
      if (action === "claim") return board.claim(sharedProjectId, boardId, input, context);
      if (action === "pause") return board.pause(sharedProjectId, boardId, input, context);
      if (action === "release") return board.release(sharedProjectId, boardId, input, context);
      if (action === "cancel") return board.cancel(sharedProjectId, boardId, input, context);
      throw new ProjectDataInvalidError("未知的看板操作");
    });
  }

  /** A consistent logical snapshot of every ledger table, portable across restarts. */
  async backupTo(path: string): Promise<{
    path: string;
    engine: ProjectDataEngine;
    takenAt: string;
    schemaVersion: number;
    counts: Record<SnapshotTable, number>;
  }> {
    const takenAt = now();
    const tables = await this.database.transaction(async (transaction) => {
      const result = {} as Record<SnapshotTable, Array<Record<string, unknown>>>;
      for (const table of TABLES)
        result[table] = await transaction.query<Record<string, unknown>>(`SELECT * FROM ${table}`);
      return result;
    });
    const snapshot: ProjectDataSnapshot = {
      version: SNAPSHOT_VERSION,
      engine: this.description.engine,
      takenAt,
      schemaVersion: this.description.schemaVersion,
      tables
    };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
    return {
      path,
      engine: snapshot.engine,
      takenAt,
      schemaVersion: snapshot.schemaVersion,
      counts: Object.fromEntries(TABLES.map((table) => [table, tables[table].length])) as Record<
        SnapshotTable,
        number
      >
    };
  }

  /** Replace the ledger tables from a snapshot; a damaged file changes nothing. */
  async restoreFrom(path: string): Promise<{ takenAt: string; counts: Record<SnapshotTable, number> }> {
    const snapshot = parseSnapshot(await readFile(path, "utf8"));
    if (snapshot.engine !== this.description.engine)
      throw new ProjectDataInvalidError(
        `备份来自 ${snapshot.engine}，当前数据库是 ${this.description.engine}；请用同一模式的数据库恢复`
      );
    if (snapshot.schemaVersion !== this.description.schemaVersion)
      throw new ProjectDataInvalidError(
        `备份 schema 版本为 ${snapshot.schemaVersion}，当前为 ${this.description.schemaVersion}；请用对应版本恢复`
      );
    await this.database.transaction(async (transaction) => {
      for (const table of [...TABLES].reverse()) await transaction.execute(`DELETE FROM ${table}`);
      for (const table of TABLES) {
        for (const row of snapshot.tables[table]) {
          const columns = Object.keys(row);
          await transaction.execute(
            `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
            columns.map((column) => row[column] as string | number | null)
          );
        }
      }
    });
    return {
      takenAt: snapshot.takenAt,
      counts: Object.fromEntries(TABLES.map((table) => [table, snapshot.tables[table].length])) as Record<
        SnapshotTable,
        number
      >
    };
  }

  close(): Promise<void> {
    return this.database.close();
  }
}

function parseSnapshot(raw: string): ProjectDataSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProjectDataInvalidError("备份文件不是有效 JSON");
  }
  const snapshot = value as Partial<ProjectDataSnapshot>;
  if (snapshot && typeof snapshot === "object" && snapshot.version === 1)
    throw new ProjectDataInvalidError("备份文件是旧版本（1），不含看板数据；请用对应版本恢复或重新备份");
  if (snapshot && typeof snapshot === "object" && snapshot.version === 2)
    throw new ProjectDataInvalidError(
      "备份文件是旧版本（2），不含需求开发记录；请重新备份或使用对应版本恢复"
    );
  if (snapshot && typeof snapshot === "object" && snapshot.version === 3)
    throw new ProjectDataInvalidError(
      "备份文件是旧版本（3），不含候选审查记录；请重新备份或使用对应版本恢复"
    );
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    snapshot.version !== SNAPSHOT_VERSION ||
    (snapshot.engine !== "sqlite" && snapshot.engine !== "postgres") ||
    typeof snapshot.takenAt !== "string" ||
    typeof snapshot.schemaVersion !== "number" ||
    !snapshot.tables ||
    typeof snapshot.tables !== "object" ||
    TABLES.some((table) => !Array.isArray(snapshot.tables?.[table]))
  )
    throw new ProjectDataInvalidError("备份文件格式不完整，未恢复任何数据");
  for (const table of TABLES) {
    const columns = TABLE_COLUMNS[table];
    for (const row of snapshot.tables[table]!) {
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw new ProjectDataInvalidError(`备份文件中的 ${table} 记录损坏，未恢复任何数据`);
      for (const [column, value] of Object.entries(row)) {
        if (!columns.includes(column))
          throw new ProjectDataInvalidError(`备份文件中的 ${table}.${column} 不是已知字段，未恢复任何数据`);
        if (value !== null && typeof value !== "string" && typeof value !== "number")
          throw new ProjectDataInvalidError(`备份文件中的 ${table}.${column} 值无效，未恢复任何数据`);
      }
    }
  }
  return snapshot as ProjectDataSnapshot;
}

/**
 * Open once at service start and keep the promise for every consumer.
 *
 * Startup failure is a refusal to serve, not a reason to fall back to another
 * engine: an explicit PostgreSQL configuration that cannot be reached must
 * never quietly write a local SQLite file instead.
 */
export class ProjectDataRuntime {
  readonly ready: Promise<void>;
  private readonly opening: Promise<ProjectDataGateway>;

  constructor(options: {
    config?: ProjectDataConfig;
    env?: NodeJS.ProcessEnv;
    configPath: string;
    dataRoot: string;
    /** This backend's stable id; a remote client presents it as a namespace, not a path. */
    backendId?: string;
  }) {
    this.opening = (async () => {
      const resolved = resolveProjectDataConfig(options);
      if (resolved.mode === "authority")
        return RemoteProjectDataService.open({
          url: resolved.authority.url,
          token: resolved.authority.token,
          backendId: options.backendId ?? id("backend"),
          source: resolved.source
        });
      const { database, serverVersion, schemaVersion } = await openProjectDataDatabase(resolved);
      return new ProjectDataService(database, {
        engine: resolved.engine,
        target: projectDataTarget(resolved),
        serverVersion,
        schemaVersion,
        source: resolved.source
      });
    })();
    this.ready = this.opening.then(() => undefined);
    // A caller that awaits `ready` still sees the failure; this only stops Node
    // reporting it as unhandled before the entrypoint reaches that await.
    this.ready.catch(() => undefined);
  }

  service(): Promise<ProjectDataGateway> {
    return this.opening;
  }

  async close(): Promise<void> {
    // `ready` already reported a refused open; teardown must not report it twice.
    const service = await this.opening.catch(() => undefined);
    await service?.close();
  }
}
