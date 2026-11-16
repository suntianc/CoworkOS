import { now } from "../../domain/types.js";
import { ProjectDataError } from "../../domain/project-ledger.js";
import type { SqlDatabase } from "./database.js";

/**
 * The one project data schema this build writes.
 *
 * Nothing is released yet, so there is no earlier database to upgrade: a new
 * file is created at this version and any file recorded at another version is
 * refused with its location and version, without being migrated or rewritten.
 * Date/time values are ISO text and booleans are integers so one business query
 * serves both engines.
 */
export const PROJECT_DATA_SCHEMA_VERSION = 7;

const PROJECT_DATA_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS project_data_projects (
     project_id TEXT PRIMARY KEY,
     project_name TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS project_data_bindings (
     backend_id TEXT NOT NULL,
     project_id TEXT NOT NULL REFERENCES project_data_projects(project_id) ON DELETE CASCADE,
     local_directory TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (backend_id, project_id),
     UNIQUE (backend_id, local_directory)
   )`,
  `CREATE TABLE IF NOT EXISTS project_data_requirements (
     project_id TEXT NOT NULL REFERENCES project_data_projects(project_id) ON DELETE CASCADE,
     requirement_id TEXT NOT NULL,
     title TEXT NOT NULL,
     content TEXT NOT NULL,
     source_kind TEXT NOT NULL,
     source_reference TEXT,
     status TEXT NOT NULL,
     revision INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, requirement_id)
   )`,
  `CREATE TABLE IF NOT EXISTS project_data_requirement_revisions (
     project_id TEXT NOT NULL,
     requirement_id TEXT NOT NULL,
     revision INTEGER NOT NULL,
     title TEXT NOT NULL,
     content TEXT NOT NULL,
     status TEXT NOT NULL,
     source_kind TEXT NOT NULL,
     source_reference TEXT,
     note TEXT,
     task_id TEXT,
     created_at TEXT NOT NULL,
     PRIMARY KEY (project_id, requirement_id, revision),
     FOREIGN KEY (project_id, requirement_id)
       REFERENCES project_data_requirements(project_id, requirement_id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS project_data_decisions (
     project_id TEXT NOT NULL,
     requirement_id TEXT NOT NULL,
     decision_id TEXT NOT NULL,
     text TEXT NOT NULL,
     effective INTEGER NOT NULL,
     source_kind TEXT NOT NULL,
     source_reference TEXT,
     at_revision INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (project_id, requirement_id, decision_id),
     FOREIGN KEY (project_id, requirement_id)
       REFERENCES project_data_requirements(project_id, requirement_id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS project_data_references (
     project_id TEXT NOT NULL,
     requirement_id TEXT NOT NULL,
     reference_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     value TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (project_id, requirement_id, reference_id),
     FOREIGN KEY (project_id, requirement_id)
       REFERENCES project_data_requirements(project_id, requirement_id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS project_data_requirements_project
     ON project_data_requirements(project_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS project_data_revisions_project
     ON project_data_requirement_revisions(project_id, requirement_id)`,
  // The shared demand board. Board facts project one requirement; the event rows
  // keep every accepted transition, and a request id makes a retry return the
  // committed result without appending a second event. The delivery columns keep
  // the actual merged commit beside the pending-release state, so an external
  // demand never appears released before its release phase.
  `CREATE TABLE IF NOT EXISTS project_data_board_entries (
     project_id TEXT NOT NULL,
     board_id TEXT NOT NULL,
     requirement_id TEXT NOT NULL,
     entry_kind TEXT NOT NULL,
     state TEXT NOT NULL,
     revision INTEGER NOT NULL,
     backend_id TEXT NOT NULL,
     publish_request_id TEXT NOT NULL,
     assignment_kind TEXT,
     assignee_id TEXT,
     handler_backend_id TEXT,
     handler_project_id TEXT,
     handler_task_id TEXT,
     assigned_at TEXT,
     delivery_merge_id TEXT,
     delivery_commit TEXT,
     delivery_merged_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, board_id),
     UNIQUE (project_id, requirement_id),
     UNIQUE (project_id, publish_request_id),
     FOREIGN KEY (project_id, requirement_id)
       REFERENCES project_data_requirements(project_id, requirement_id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS project_data_board_events (
     project_id TEXT NOT NULL,
     board_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     request_id TEXT NOT NULL,
     actor_id TEXT NOT NULL,
     handler_backend_id TEXT,
     handler_project_id TEXT,
     handler_task_id TEXT,
     from_state TEXT,
     to_state TEXT NOT NULL,
     revision INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (project_id, board_id, event_id),
     UNIQUE (project_id, request_id),
     FOREIGN KEY (project_id, board_id)
       REFERENCES project_data_board_entries(project_id, board_id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS project_data_board_entries_project
     ON project_data_board_entries(project_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS project_data_board_events_board
     ON project_data_board_events(project_id, board_id, revision)`,
  // A session is shared fact; its Pi transcript stays with the Task on the
  // backend that holds it. `task_id` is that backend's local container.
  `CREATE TABLE IF NOT EXISTS project_data_main_sessions (
     project_id TEXT NOT NULL REFERENCES project_data_projects(project_id) ON DELETE CASCADE,
     session_id TEXT NOT NULL,
     title TEXT NOT NULL,
     entry_kind TEXT NOT NULL,
     kind TEXT NOT NULL,
     backend_id TEXT NOT NULL,
     task_id TEXT NOT NULL,
     current_requirement_id TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, session_id),
     UNIQUE (backend_id, project_id, task_id)
   )`,
  `CREATE TABLE IF NOT EXISTS project_data_main_session_runs (
     project_id TEXT NOT NULL,
     session_id TEXT NOT NULL,
     run_id TEXT NOT NULL,
     task_id TEXT NOT NULL,
     requirement_id TEXT,
     state TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, session_id, run_id),
     FOREIGN KEY (project_id, session_id)
       REFERENCES project_data_main_sessions(project_id, session_id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS project_data_main_sessions_project
     ON project_data_main_sessions(project_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS project_data_main_session_runs_task
     ON project_data_main_session_runs(task_id, run_id)`,
  // A requirement's development record and its per-backend Git checkout. The
  // merge configuration is the project's single update entry; the checkout
  // directory stays a per-backend fact like a directory binding.
  `CREATE TABLE IF NOT EXISTS project_data_developments (
     project_id TEXT NOT NULL,
     development_id TEXT NOT NULL,
     requirement_id TEXT NOT NULL,
     goal TEXT NOT NULL,
     completion_criteria TEXT NOT NULL,
     route TEXT NOT NULL,
     status TEXT NOT NULL,
     revision INTEGER NOT NULL,
     baseline_branch TEXT NOT NULL,
     baseline_commit TEXT NOT NULL,
     session_id TEXT,
     task_id TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, development_id),
     UNIQUE (project_id, requirement_id),
     FOREIGN KEY (project_id, requirement_id)
       REFERENCES project_data_requirements(project_id, requirement_id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS project_data_development_workspaces (
     project_id TEXT NOT NULL,
     development_id TEXT NOT NULL,
     backend_id TEXT NOT NULL,
     workspace_id TEXT NOT NULL,
     directory TEXT NOT NULL,
     branch TEXT NOT NULL,
     base_commit TEXT NOT NULL,
     state TEXT NOT NULL,
     error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, development_id, backend_id),
     FOREIGN KEY (project_id, development_id)
       REFERENCES project_data_developments(project_id, development_id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS project_data_merge_configs (
     project_id TEXT PRIMARY KEY REFERENCES project_data_projects(project_id) ON DELETE CASCADE,
     repository TEXT NOT NULL,
     target_branch TEXT NOT NULL,
     execution_backend_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS project_data_developments_project
     ON project_data_developments(project_id, updated_at)`,
  // The review record a requirement's delivery is qualified against. A plan is
  // Main's channel decision; a review freezes one candidate and keeps the
  // independent Reviewer's findings, Main's rulings and the rework that
  // continued the author's original session. Findings and reworks are a bounded
  // JSON array on the review row so one version and one revision cover the whole
  // record atomically.
  `CREATE TABLE IF NOT EXISTS project_data_development_review_plans (
     project_id TEXT NOT NULL,
     development_id TEXT NOT NULL,
     channel TEXT NOT NULL,
     basis TEXT NOT NULL,
     checks TEXT NOT NULL,
     candidate_commit TEXT NOT NULL,
     candidate_tree TEXT NOT NULL,
     candidate_branch TEXT NOT NULL,
     candidate_workspace TEXT NOT NULL,
     revision INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, development_id),
     FOREIGN KEY (project_id, development_id)
       REFERENCES project_data_developments(project_id, development_id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS project_data_development_reviews (
     project_id TEXT NOT NULL,
     review_id TEXT NOT NULL,
     development_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     state TEXT NOT NULL,
     revision INTEGER NOT NULL,
     candidate_commit TEXT NOT NULL,
     candidate_tree TEXT NOT NULL,
     candidate_branch TEXT NOT NULL,
     candidate_workspace TEXT NOT NULL,
     author TEXT,
     previous_review_id TEXT,
     previous_candidate_commit TEXT,
     changed_paths TEXT NOT NULL,
     reviewer TEXT,
     findings TEXT NOT NULL,
     reworks TEXT NOT NULL,
     verdict TEXT,
     drift TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, review_id),
     FOREIGN KEY (project_id, development_id)
       REFERENCES project_data_developments(project_id, development_id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS project_data_development_reviews_project
     ON project_data_development_reviews(project_id, development_id, created_at)`,
  // One project's applications to its shared target branch. The row keeps the
  // candidate, the combined base, the checks that ran on it and the commit
  // actually written, so an interrupted process reconciles against Git instead
  // of merging twice. The partial unique index is the cross-backend promise that
  // only one operation updates this project's target at a time.
  `CREATE TABLE IF NOT EXISTS project_data_development_merges (
     project_id TEXT NOT NULL,
     merge_id TEXT NOT NULL,
     development_id TEXT NOT NULL,
     requirement_id TEXT NOT NULL,
     state TEXT NOT NULL,
     revision INTEGER NOT NULL,
     requested_by TEXT NOT NULL,
     execution_backend_id TEXT NOT NULL,
     target_branch TEXT NOT NULL,
     candidate TEXT NOT NULL,
     candidate_commit TEXT NOT NULL,
     acceptance TEXT NOT NULL,
     checks TEXT NOT NULL,
     reasons TEXT NOT NULL,
     combined_base TEXT,
     expected_target TEXT,
     merge_commit TEXT,
     owner_started_at TEXT,
     detail TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, merge_id),
     FOREIGN KEY (project_id, development_id)
       REFERENCES project_data_developments(project_id, development_id) ON DELETE CASCADE
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS project_data_development_merges_applying
     ON project_data_development_merges(project_id) WHERE state = 'applying'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS project_data_development_merges_candidate
     ON project_data_development_merges(project_id, development_id, candidate_commit)
     WHERE state IN ('waiting', 'applying', 'merged')`,
  `CREATE INDEX IF NOT EXISTS project_data_development_merges_project
     ON project_data_development_merges(project_id, development_id, created_at)`,
  // The delivery a merged operation produces. One row per real merge is the
  // idempotent identity for the ledger/board synchronization: `pending` means
  // the target already carries `merged_commit` but the shared records have not
  // accepted it yet, `synced` means both did.
  `CREATE TABLE IF NOT EXISTS project_data_deliveries (
     project_id TEXT NOT NULL,
     delivery_id TEXT NOT NULL,
     development_id TEXT NOT NULL,
     requirement_id TEXT NOT NULL,
     merge_id TEXT NOT NULL,
     candidate_commit TEXT NOT NULL,
     merged_commit TEXT NOT NULL,
     target_branch TEXT NOT NULL,
     merged_at TEXT NOT NULL,
     board_id TEXT,
     state TEXT NOT NULL,
     attempts INTEGER NOT NULL,
     error TEXT,
     synced_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, delivery_id),
     UNIQUE (project_id, merge_id),
     FOREIGN KEY (project_id, development_id)
       REFERENCES project_data_developments(project_id, development_id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS project_data_deliveries_project
     ON project_data_deliveries(project_id, development_id, created_at)`
];

/**
 * Create this build's schema in one transaction, or refuse a file recorded at a
 * version this build does not write.
 *
 * The version row is written in the same transaction as the tables, so a
 * database is either empty or complete at the current version. A file recorded
 * at another version is left byte for byte as it was: the transaction rolls
 * back and nothing is migrated, downgraded or rebuilt.
 */
export async function migrateProjectData(database: SqlDatabase): Promise<number> {
  return database.transaction(async (transaction) => {
    await transaction.execute(
      `CREATE TABLE IF NOT EXISTS project_data_migrations (
         version INTEGER PRIMARY KEY,
         applied_at TEXT NOT NULL
       )`
    );
    const rows = await transaction.query<{ version: number }>(
      "SELECT COALESCE(MAX(version), 0) AS version FROM project_data_migrations"
    );
    const version = Number(rows[0]?.version ?? 0);
    if (version === PROJECT_DATA_SCHEMA_VERSION) return version;
    if (version !== 0) throw incompatibleVersion(database.label, version);
    for (const statement of PROJECT_DATA_SCHEMA) await transaction.execute(statement);
    await transaction.execute("INSERT INTO project_data_migrations (version, applied_at) VALUES (?, ?)", [
      PROJECT_DATA_SCHEMA_VERSION,
      now()
    ]);
    return PROJECT_DATA_SCHEMA_VERSION;
  });
}

function incompatibleVersion(label: string, version: number): ProjectDataError {
  return new ProjectDataError(
    `项目数据库 ${label} 的 schema 版本为 ${version}，当前只支持 ${PROJECT_DATA_SCHEMA_VERSION}；未改写该文件，请从备份恢复或使用对应版本打开`,
    500,
    "storage_schema_version"
  );
}
