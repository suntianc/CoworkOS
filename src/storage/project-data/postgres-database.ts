import pg from "pg";
import { ProjectDataError } from "../../domain/project-ledger.js";
import {
  postgresPlaceholders,
  storageFailure,
  type SqlDatabase,
  type SqlParameter,
  type SqlTransaction
} from "./database.js";

export interface PostgresTarget {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
}

const CONNECT_TIMEOUT_MS = 5000;

interface QueryResult {
  rows: unknown[];
  rowCount: number | null;
}

/** A `postgresql://` connection string, or undefined for a key=value DSN or a bad URL. */
function parseConnectionUrl(connectionString: string | undefined): URL | undefined {
  if (!connectionString || !/^postgres(ql)?:\/\//i.test(connectionString)) return undefined;
  try {
    return new URL(connectionString);
  } catch {
    return undefined;
  }
}

/** `host:port/database` — locatable in an error, and never the password. */
export function postgresTargetLabel(target: PostgresTarget): string {
  const url = parseConnectionUrl(target.connectionString);
  // A key=value DSN has no parseable target; never echo it back, it may hold a password.
  if (!url && target.connectionString) return "postgresql://(configured connection string)";
  const host = url?.hostname || target.host || "localhost";
  const port = url?.port || String(target.port ?? 5432);
  const database = url?.pathname.replace(/^\/+/, "") || target.database || "";
  return `postgresql://${host}:${port}/${database}`;
}

/** A pooled client with explicit transactions; placeholders stay `?` for callers. */
export class PostgresDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  readonly label: string;
  private readonly pool: pg.Pool;
  private readonly secret: string | undefined;

  constructor(private readonly target: PostgresTarget) {
    this.label = postgresTargetLabel(target);
    // `pg` also accepts a key=value DSN; only a URL carries a parseable password.
    this.secret = parseConnectionUrl(target.connectionString)?.password || target.password;
    this.pool = new pg.Pool({
      ...(target.connectionString
        ? { connectionString: target.connectionString }
        : {
            host: target.host,
            port: target.port ?? 5432,
            database: target.database,
            user: target.user,
            password: target.password
          }),
      ...(target.ssl ? { ssl: true } : {}),
      max: 4,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
      application_name: "coworkos-project-data"
    });
    // An idle client dropped by the server must not take the Dashboard down.
    this.pool.on("error", (error) => {
      console.error(`[cowork] 项目数据连接池错误：${error.message}`);
    });
  }

  /** Run one cheap read so an unreachable or rejected database fails at startup. */
  async probe(): Promise<string> {
    const { rows } = await this.run<{ server_version: string }>("SHOW server_version");
    return rows[0]?.server_version ?? "unknown";
  }

  async query<T>(sql: string, params: readonly SqlParameter[] = []): Promise<T[]> {
    return (await this.run<T>(sql, params)).rows;
  }

  async execute(sql: string, params: readonly SqlParameter[] = []): Promise<number> {
    return (await this.run(sql, params)).rowCount ?? 0;
  }

  async transaction<T>(action: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw storageFailure("postgres", this.label, error, this.secret);
    }
    const scoped: SqlTransaction = {
      query: async <R>(sql: string, params: readonly SqlParameter[] = []) =>
        (await this.runWith(client, sql, params)).rows as R[],
      execute: async (sql: string, params: readonly SqlParameter[] = []) =>
        (await this.runWith(client, sql, params)).rowCount ?? 0
    };
    try {
      await client.query("BEGIN");
      const result = await action(scoped);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* the connection is already unusable; the original failure is what matters */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async run<T>(
    sql: string,
    params: readonly SqlParameter[] = []
  ): Promise<QueryResult & { rows: T[] }> {
    try {
      return (await this.pool.query(postgresPlaceholders(sql), [...params])) as unknown as QueryResult & {
        rows: T[];
      };
    } catch (error) {
      throw storageFailure("postgres", this.label, error, this.secret);
    }
  }

  private async runWith(
    client: pg.PoolClient,
    sql: string,
    params: readonly SqlParameter[]
  ): Promise<QueryResult> {
    try {
      return (await client.query(postgresPlaceholders(sql), [...params])) as QueryResult;
    } catch (error) {
      throw storageFailure("postgres", this.label, error, this.secret);
    }
  }
}

export async function openPostgresDatabase(target: PostgresTarget): Promise<PostgresDatabase> {
  const database = new PostgresDatabase(target);
  try {
    await database.probe();
    return database;
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error instanceof ProjectDataError
      ? error
      : new ProjectDataError(
          `无法连接 PostgreSQL ${database.label}：${error instanceof Error ? error.message : String(error)}`,
          500,
          "storage_unavailable"
        );
  }
}
