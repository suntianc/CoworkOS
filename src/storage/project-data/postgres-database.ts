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
    // eslint-disable-next-line no-restricted-syntax -- 连接串可能是 key=value DSN 或写错的 URL；解析失败按"没有可用 URL"返回 undefined，调用方随后回退到 host/port 字段
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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- rows 的类型是 T[]，空结果集在类型上无法表达；驱动返回零行或省略字段时仍要回退到 unknown
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
        // eslint-disable-next-line no-restricted-syntax -- 事务已因原始错误失败，连接可能已经不可用；回滚失败由下面 rethrow 的原始错误表达
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
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- pg 的 QueryResult<QueryResultRow> 与 rows: T[] 互不可赋值，去掉 as unknown 中转就编译不过；断言只用于把驱动行恢复成调用方声明的 T[]
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
      return await client.query(postgresPlaceholders(sql), [...params]);
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
    // eslint-disable-next-line no-restricted-syntax -- 探测失败的连接池正在被丢弃；close 自身的失败不能覆盖下面要抛出的连接失败，否则用户看不到真实的连接原因
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
