import {
  ProjectDataConflictError,
  ProjectDataError,
  ProjectDataUnavailableError
} from "../../domain/project-ledger.js";

/** A parameter the two engines both accept: text, integers, booleans and null. */
export type SqlParameter = string | number | boolean | null;

export interface SqlTransaction {
  query<T>(sql: string, params?: readonly SqlParameter[]): Promise<T[]>;
  execute(sql: string, params?: readonly SqlParameter[]): Promise<number>;
}

/**
 * The dialect-neutral persistence seam.
 *
 * Business SQL binds `?` parameters and never names an engine; each adapter
 * owns placeholders, transactions, busy waiting and driver error mapping.
 */
export interface SqlDatabase extends SqlTransaction {
  readonly dialect: "sqlite" | "postgres";
  /** A locatable target for errors: a file path or `host:port/database`. */
  readonly label: string;
  transaction<T>(action: (transaction: SqlTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * `$1`-style placeholders for PostgreSQL.
 *
 * Single-quoted SQL literals are skipped so an escaped apostrophe cannot be
 * mistaken for a bound value.
 */
export function postgresPlaceholders(sql: string): string {
  let result = "";
  let index = 0;
  let ordinal = 0;
  let quoted = false;
  while (index < sql.length) {
    const character = sql[index]!;
    if (character === "'") {
      quoted = !quoted;
      result += character;
      index += 1;
      continue;
    }
    if (!quoted && character === "?") {
      ordinal += 1;
      result += `$${ordinal}`;
      index += 1;
      continue;
    }
    result += character;
    index += 1;
  }
  return result;
}

/** Remove a configured secret from a driver message before it can reach a client. */
export function redactSecret(message: string, secret: string | undefined): string {
  if (!secret) return message;
  return message.split(secret).join("***");
}

export function storedBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

/** Map a driver failure onto the domain's three observable outcomes. */
export function storageFailure(
  engine: "sqlite" | "postgres",
  label: string,
  error: unknown,
  secret?: string
): ProjectDataError {
  const raw = error instanceof Error ? error.message : String(error);
  const message = redactSecret(raw, secret);
  const code = (error as { code?: unknown })?.code;
  if (code === "23505" || /UNIQUE constraint failed/i.test(message))
    return new ProjectDataConflictError(`项目数据已存在（${label}）`, undefined, "duplicate");
  if (code === "23503" || /FOREIGN KEY constraint failed/i.test(message))
    return new ProjectDataConflictError(`关联的项目或需求不存在（${label}）`, undefined, "missing_reference");
  if (code === "23514" || /CHECK constraint failed/i.test(message))
    return new ProjectDataConflictError(`项目数据不满足约束（${label}）`, undefined, "constraint");
  if (code === "40001" || code === "40P01" || /database is locked|SQLITE_BUSY/i.test(message))
    return new ProjectDataConflictError(`项目数据正被占用，请重试（${label}）`, undefined, "busy");
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "28P01" || code === "3D000")
    return new ProjectDataUnavailableError(
      `无法连接${engine === "postgres" ? " PostgreSQL" : " SQLite 项目数据库"} ${label}：${message}`
    );
  return new ProjectDataError(
    `项目数据${engine === "postgres" ? "PostgreSQL" : "SQLite"}操作失败（${label}）：${message}`,
    500,
    "storage_error"
  );
}
