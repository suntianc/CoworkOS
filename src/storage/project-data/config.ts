import { isAbsolute, join, resolve } from "node:path";
import { ProjectDataError } from "../../domain/project-ledger.js";
import { openPostgresDatabase, postgresTargetLabel, type PostgresTarget } from "./postgres-database.js";
import { SqliteDatabase } from "./sqlite-database.js";
import { migrateProjectData } from "./migrations.js";
import type { SqlDatabase } from "./database.js";

export type ProjectDataEngine = "sqlite" | "postgres";

export interface ProjectDataAuthority {
  /** Origin of the one authoritative project data service. */
  url?: string;
  /** Host credential for that service; kept server-side, never returned to a renderer. */
  token?: string;
}

export interface ProjectDataConfig {
  /** Personal deployments default to SQLite; PostgreSQL is an explicit choice. */
  engine?: ProjectDataEngine;
  sqlite?: { path?: string };
  postgres?: PostgresTarget;
  /**
   * A secondary backend does not open a local engine; it reads and writes the
   * same facts through the authenticated authority client.
   */
  authority?: ProjectDataAuthority;
}

export type ResolvedProjectDataConfig =
  | {
      mode: "local";
      engine: ProjectDataEngine;
      /** The configuration file or environment variable that chose the engine. */
      source: string;
      sqlitePath?: string;
      postgres?: PostgresTarget;
    }
  | {
      mode: "authority";
      source: string;
      authority: { url: string; token: string };
    };

export type LocalProjectDataConfig = Extract<ResolvedProjectDataConfig, { mode: "local" }>;

const ENGINES: readonly ProjectDataEngine[] = ["sqlite", "postgres"];

function configurationError(source: string, detail: string): ProjectDataError {
  return new ProjectDataError(`项目数据配置错误（${source}）：${detail}`, 500, "storage_config");
}

/**
 * Resolve the engine once, at service start.
 *
 * An explicit choice is final: a bad or unreachable PostgreSQL configuration
 * refuses to start instead of silently writing a local SQLite file. Environment
 * variables override the file so an operator can point one process at a
 * dedicated database without editing user configuration.
 */
export function resolveProjectDataConfig(options: {
  config?: ProjectDataConfig;
  env?: NodeJS.ProcessEnv;
  configPath: string;
  dataRoot: string;
}): ResolvedProjectDataConfig {
  const { config = {}, env = process.env, configPath, dataRoot } = options;
  if (typeof config !== "object" || Array.isArray(config))
    throw configurationError(configPath, "projectData 必须是对象");
  if (
    config.authority !== undefined &&
    (typeof config.authority !== "object" || Array.isArray(config.authority))
  )
    throw configurationError(configPath, "projectData.authority 必须是对象");
  if (config.sqlite !== undefined && (typeof config.sqlite !== "object" || Array.isArray(config.sqlite)))
    throw configurationError(configPath, "projectData.sqlite 必须是对象");
  if (
    config.postgres !== undefined &&
    (typeof config.postgres !== "object" || Array.isArray(config.postgres))
  )
    throw configurationError(configPath, "projectData.postgres 必须是对象");
  const authorityUrl = env.COWORK_PROJECT_DATA_AUTHORITY?.trim() || config.authority?.url;
  const engineValue = env.COWORK_PROJECT_DATA_ENGINE?.trim() || config.engine;
  const source = env.COWORK_PROJECT_DATA_ENGINE?.trim()
    ? "COWORK_PROJECT_DATA_ENGINE"
    : `${configPath} 的 projectData`;
  if (authorityUrl !== undefined) {
    const authoritySource = env.COWORK_PROJECT_DATA_AUTHORITY?.trim()
      ? "COWORK_PROJECT_DATA_AUTHORITY"
      : `${configPath} 的 projectData.authority`;
    if (engineValue !== undefined || config.sqlite !== undefined || config.postgres !== undefined)
      throw configurationError(authoritySource, "authority 不能与 engine、sqlite 或 postgres 同时配置");
    if (typeof authorityUrl !== "string" || !authorityUrl.trim())
      throw configurationError(authoritySource, "authority.url 须为非空字符串");
    let parsed: URL;
    try {
      parsed = new URL(authorityUrl);
    } catch {
      throw configurationError(authoritySource, "authority.url 须为有效的 http:// 或 https:// 地址");
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.origin !== authorityUrl.replace(/\/+$/, "") ||
      parsed.username ||
      parsed.password
    )
      throw configurationError(authoritySource, "authority.url 只填写协议、主机和端口，不要包含路径或凭据");
    const token = env.COWORK_PROJECT_DATA_TOKEN?.trim() || config.authority?.token;
    if (typeof token !== "string" || !token.trim())
      throw configurationError(
        authoritySource,
        "authority 需要访问凭据（token 或 COWORK_PROJECT_DATA_TOKEN）"
      );
    return {
      mode: "authority",
      source: authoritySource,
      authority: { url: parsed.origin, token: token.trim() }
    };
  }
  if (engineValue === undefined) {
    const sqlitePath = resolveSqlitePath(config, env, dataRoot);
    return { mode: "local", engine: "sqlite", source: `${configPath} 默认 SQLite`, sqlitePath };
  }
  if (typeof engineValue !== "string" || !ENGINES.includes(engineValue as ProjectDataEngine))
    throw configurationError(source, `engine 须为 ${ENGINES.join(" / ")}`);
  if (engineValue === "sqlite") {
    return { mode: "local", engine: "sqlite", source, sqlitePath: resolveSqlitePath(config, env, dataRoot) };
  }
  const connectionString = env.COWORK_PROJECT_DATA_URL?.trim() || config.postgres?.connectionString;
  const postgres = connectionString ? { ...config.postgres, connectionString } : config.postgres;
  if (postgres?.connectionString !== undefined) {
    if (typeof postgres.connectionString !== "string" || !postgres.connectionString.trim())
      throw configurationError(source, "postgres.connectionString 须为非空字符串");
    if (/^postgres(ql)?:\/\//i.test(postgres.connectionString)) {
      try {
        new URL(postgres.connectionString);
      } catch {
        throw configurationError(
          source,
          "postgres.connectionString 须为有效的 PostgreSQL 连接地址（postgresql://…）"
        );
      }
    }
  }
  if (!postgres || (!postgres.connectionString && (!postgres.host || !postgres.database)))
    throw configurationError(
      source,
      "postgres 需要 connectionString，或 host 与 database（连接地址见 COWORK_PROJECT_DATA_URL）"
    );
  if (
    postgres.port !== undefined &&
    (!Number.isInteger(postgres.port) || postgres.port < 1 || postgres.port > 65535)
  )
    throw configurationError(source, "postgres.port 须为 1–65535 的整数");
  if (postgres.ssl !== undefined && typeof postgres.ssl !== "boolean")
    throw configurationError(source, "postgres.ssl 须为布尔值");
  for (const field of ["host", "database", "user", "password"] as const)
    if (postgres[field] !== undefined && typeof postgres[field] !== "string")
      throw configurationError(source, `postgres.${field} 须为字符串`);
  return {
    mode: "local",
    engine: "postgres",
    source,
    postgres: { ...postgres, ...(connectionString ? { connectionString } : {}) }
  };
}

function resolveSqlitePath(config: ProjectDataConfig, env: NodeJS.ProcessEnv, dataRoot: string): string {
  const value = env.COWORK_PROJECT_DATA_SQLITE?.trim() || config.sqlite?.path;
  if (value === undefined) return join(dataRoot, "project-data.sqlite");
  if (typeof value !== "string" || !value.trim())
    throw configurationError("COWORK_PROJECT_DATA_SQLITE", "sqlite.path 须为非空字符串");
  return isAbsolute(value) ? resolve(value) : resolve(dataRoot, value);
}

/** Open exactly the configured engine, migrate it, and report what is being served. */
export async function openProjectDataDatabase(
  config: LocalProjectDataConfig
): Promise<{ database: SqlDatabase; serverVersion: string; schemaVersion: number }> {
  if (config.engine === "sqlite") {
    const path = config.sqlitePath!;
    const database = await SqliteDatabase.open(path);
    try {
      const version = await migrateProjectData(database);
      const software = await database.query<{ version: string }>("SELECT sqlite_version() AS version");
      return { database, serverVersion: software[0]?.version ?? "unknown", schemaVersion: version };
    } catch (error) {
      await database.close().catch(() => undefined);
      throw error;
    }
  }
  const database = await openPostgresDatabase(config.postgres!);
  try {
    const version = await migrateProjectData(database);
    return { database, serverVersion: await database.probe(), schemaVersion: version };
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}

export function projectDataTarget(config: LocalProjectDataConfig): string {
  return config.engine === "sqlite" ? config.sqlitePath! : postgresTargetLabel(config.postgres ?? {});
}
