import { chmod, mkdir } from "node:fs/promises";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { ProjectDataError } from "../../domain/project-ledger.js";
import { storageFailure, type SqlDatabase, type SqlParameter, type SqlTransaction } from "./database.js";
import { dirname } from "node:path";

const BUSY_TIMEOUT_MS = 5000;

function bindable(params: readonly SqlParameter[]): Array<string | number | null> {
  return params.map((value) => (typeof value === "boolean" ? (value ? 1 : 0) : value));
}

/**
 * `node:sqlite` is synchronous; this adapter keeps the shared asynchronous
 * contract and serialises transactions on the one connection.
 */
export class SqliteDatabase implements SqlDatabase {
  readonly dialect = "sqlite" as const;
  readonly label: string;
  private readonly database: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly path: string,
    database: DatabaseSync
  ) {
    this.database = database;
    this.label = path;
  }

  static async open(path: string): Promise<SqliteDatabase> {
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const database = new DatabaseSync(path);
      // A bounded wait, so a second process writing the same file makes this
      // one retry instead of failing immediately.
      // The ledger is private host data; keep the file itself owner-only like
      // the other stores, even where the process umask would widen it.
      // eslint-disable-next-line no-restricted-syntax -- 数据库文件已经创建可写；chmod 受挂载点或 ACL 限制失败时数据仍可读写，不能因此报告数据库打不开
      await chmod(path, 0o600).catch(() => undefined);
      database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      database.exec("PRAGMA foreign_keys = ON");
      return new SqliteDatabase(path, database);
    } catch (error) {
      throw new ProjectDataError(
        `无法打开 SQLite 项目数据库 ${path}：${error instanceof Error ? error.message : String(error)}`,
        500,
        "storage_unavailable"
      );
    }
  }

  async query<T>(sql: string, params: readonly SqlParameter[] = []): Promise<T[]> {
    try {
      return this.statement(sql).all(...bindable(params)) as T[];
    } catch (error) {
      throw storageFailure("sqlite", this.label, error);
    }
  }

  async execute(sql: string, params: readonly SqlParameter[] = []): Promise<number> {
    try {
      return Number(this.statement(sql).run(...bindable(params)).changes);
    } catch (error) {
      throw storageFailure("sqlite", this.label, error);
    }
  }

  /** One writer queue: a transaction runs from BEGIN to COMMIT without another interleaving. */
  transaction<T>(action: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const result = await action(this);
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.database.exec("ROLLBACK");
          // eslint-disable-next-line no-restricted-syntax -- 事务已因原始错误失败；引擎可能已经自行中止，回滚失败由下面 rethrow 的原始错误表达
        } catch {
          /* the engine already aborted it; the original failure is what matters */
        }
        throw error;
      }
    });
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async close(): Promise<void> {
    this.statements.clear();
    this.database.close();
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
}
