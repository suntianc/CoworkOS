import { now } from "../../domain/types.js";
import type { SqlDatabase } from "./database.js";

export interface ProjectDataMigration {
  version: number;
  statements: string[];
}

/**
 * Versioned schema. Date/time values are ISO text and booleans are integers so
 * one business query serves both engines; a migration is appended, never edited
 * after it has shipped, so an existing database upgrades in order.
 */
export const PROJECT_DATA_MIGRATIONS: readonly ProjectDataMigration[] = [
  {
    version: 1,
    statements: [
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
         ON project_data_requirement_revisions(project_id, requirement_id)`
    ]
  },
  {
    // v2: the shared demand board. Board facts project one requirement; the
    // event rows keep every accepted transition, and a request id makes a retry
    // return the committed result without appending a second event.
    version: 2,
    statements: [
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
         ON project_data_board_events(project_id, board_id, revision)`
    ]
  },
  {
    version: 3,
    statements: [
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
         ON project_data_main_session_runs(task_id, run_id)`
    ]
  },
  {
    // v4: a requirement's development record and its per-backend Git checkout.
    // The merge configuration is the project's single update entry; the
    // checkout directory stays a per-backend fact like a directory binding.
    version: 4,
    statements: [
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
         ON project_data_developments(project_id, updated_at)`
    ]
  }
];

export const LATEST_PROJECT_DATA_VERSION = PROJECT_DATA_MIGRATIONS.at(-1)!.version;

/** Create the bookkeeping table and apply every migration this database lacks. */
export async function migrateProjectData(database: SqlDatabase): Promise<number> {
  await database.execute(
    `CREATE TABLE IF NOT EXISTS project_data_migrations (
       version INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`
  );
  for (const migration of PROJECT_DATA_MIGRATIONS) {
    await database.transaction(async (transaction) => {
      const applied = await transaction.query<{ version: number }>(
        "SELECT version FROM project_data_migrations WHERE version = ?",
        [migration.version]
      );
      // Another process may have applied it while this one waited for the lock.
      if (applied.length) return;
      for (const statement of migration.statements) await transaction.execute(statement);
      await transaction.execute("INSERT INTO project_data_migrations (version, applied_at) VALUES (?, ?)", [
        migration.version,
        now()
      ]);
    });
  }
  return currentProjectDataVersion(database);
}

export async function currentProjectDataVersion(database: SqlDatabase): Promise<number> {
  const rows = await database.query<{ version: number }>(
    "SELECT COALESCE(MAX(version), 0) AS version FROM project_data_migrations"
  );
  return Number(rows[0]?.version ?? 0);
}
