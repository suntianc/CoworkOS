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
