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
import { id, now } from "../domain/types.js";
import {
  openProjectDataDatabase,
  projectDataTarget,
  resolveProjectDataConfig,
  type ProjectDataConfig,
  type ProjectDataEngine
} from "../storage/project-data/config.js";
import type { SqlDatabase, SqlTransaction } from "../storage/project-data/database.js";

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

export interface RequirementQuery {
  text?: unknown;
  status?: unknown;
  limit?: unknown;
}

interface RequirementCreate {
  title?: unknown;
  content?: unknown;
  source?: unknown;
  references?: unknown;
}

interface RequirementUpdate {
  expectedRevision?: unknown;
  title?: unknown;
  content?: unknown;
  status?: unknown;
  note?: unknown;
  taskId?: unknown;
}

export interface ProjectDataDescription {
  engine: ProjectDataEngine;
  /** A locatable target: the SQLite file or `postgresql://host:port/database`. */
  target: string;
  serverVersion: string;
  schemaVersion: number;
  source: string;
}

const SNAPSHOT_VERSION = 1;
const TABLES = [
  "project_data_projects",
  "project_data_bindings",
  "project_data_requirements",
  "project_data_requirement_revisions",
  "project_data_decisions",
  "project_data_references"
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
  project_data_references: ["project_id", "requirement_id", "reference_id", "kind", "value", "created_at"]
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
}

/**
 * The authoritative project data service: shared identity, the requirement
 * ledger, and the backup/restore pair. HTTP, the Main tool and the CLI all use
 * this one interface, so engine choice never changes business behaviour.
 */
export class ProjectDataService {
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
  private readonly opening: Promise<ProjectDataService>;

  constructor(options: {
    config?: ProjectDataConfig;
    env?: NodeJS.ProcessEnv;
    configPath: string;
    dataRoot: string;
  }) {
    this.opening = (async () => {
      const resolved = resolveProjectDataConfig(options);
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

  service(): Promise<ProjectDataService> {
    return this.opening;
  }

  async close(): Promise<void> {
    // `ready` already reported a refused open; teardown must not report it twice.
    const service = await this.opening.catch(() => undefined);
    await service?.close();
  }
}
