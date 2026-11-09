import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import {
  HttpError,
  localRequestUrl,
  presentedCredential,
  sameSecret,
  type LocalCredentialPolicy
} from "./http.js";

/**
 * Local session authorization for one backend.
 *
 * M1 is a single-owner backend with several clients: the desktop host, the Web
 * UI and local tools all reach the same process. The instance token in the
 * instance record stays the host credential that a client uses to authorize
 * once. Authorizing mints a named session, and every later request presents
 * that session instead. Revoking a session is therefore immediate for the next
 * request of that client and does not disturb the owner's other clients.
 *
 * Sessions live beside the backend identity in the data root, so a restart
 * keeps them; only the hash of a session secret is stored, so a readable data
 * root does not hand out live credentials. This module owns the credential
 * policy and the principal; the transport (Host/Origin) stays in http.ts.
 */
export type LocalPrincipal =
  { kind: "host"; principalId: "host" } | { kind: "session"; principalId: string; sessionId: string };

export const HOST_PRINCIPAL: LocalPrincipal = { kind: "host", principalId: "host" };

export interface LocalSessionSummary {
  sessionId: string;
  clientName?: string;
  protocolVersion: string;
  createdAt: string;
  revokedAt?: string;
}

interface SessionRecord extends LocalSessionSummary {
  secretHash: string;
}

export interface AuthorizedSession {
  summary: LocalSessionSummary;
  /** Handed to the client once; only its hash is kept. */
  token: string;
}

interface SessionDocument {
  version: 1;
  sessions: SessionRecord[];
}

export interface LocalRequestAdmission {
  url: URL;
  principal: LocalPrincipal;
}

const SESSION_FILE = "local-sessions.json";
const MAX_CLIENT_NAME = 120;

function secretHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function summary(record: SessionRecord): LocalSessionSummary {
  return {
    sessionId: record.sessionId,
    ...(record.clientName ? { clientName: record.clientName } : {}),
    protocolVersion: record.protocolVersion,
    createdAt: record.createdAt,
    ...(record.revokedAt ? { revokedAt: record.revokedAt } : {})
  };
}

function validRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SessionRecord>;
  return (
    typeof record.sessionId === "string" &&
    Boolean(record.sessionId) &&
    typeof record.secretHash === "string" &&
    /^[a-f0-9]{64}$/.test(record.secretHash) &&
    typeof record.protocolVersion === "string" &&
    typeof record.createdAt === "string" &&
    (record.revokedAt === undefined || typeof record.revokedAt === "string")
  );
}

function clientName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "clientName 必须是字符串", "invalid_client_name");
  const name = value.trim();
  if (!name) return undefined;
  if (name.length > MAX_CLIENT_NAME || /[\0-\x1f\x7f]/.test(name))
    throw new HttpError(400, `clientName 需为 1–${MAX_CLIENT_NAME} 个可打印字符`, "invalid_client_name");
  return name;
}

export class LocalAccess {
  readonly sessionsPath: string;
  private readonly directory: string;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly runToken = `run_${randomBytes(32).toString("hex")}`;
  private readonly runSessionId = `run_${randomBytes(9).toString("hex")}`;
  private persisting: Promise<void> = Promise.resolve();

  /** In-memory business credential for child runs; never a host credential. */
  runCredential(): string {
    return this.runToken;
  }

  /**
   * @param directory runtime directory of the data root (beside the backend identity)
   * @param bootstrapToken the host credential the serving process published
   */
  constructor(
    directory: string,
    private readonly bootstrapToken: () => string | undefined,
    private readonly localHostToken: () => string | undefined = bootstrapToken
  ) {
    this.directory = directory;
    this.sessionsPath = join(directory, SESSION_FILE);
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.sessionsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
      // eslint-disable-next-line no-restricted-syntax -- 会话文件是旁路记录，解析失败只记录位置并在无会话状态启动
    } catch {
      // A client can re-authorize; refusing to serve would take the whole
      // backend down for a damaged side record. Say where and start without it.
      console.error(`[cowork] 本地会话记录无法解析，已按无会话启动：${this.sessionsPath}`);
      return;
    }
    const document = parsed as Partial<SessionDocument> | null;
    if (document?.version !== 1 || !Array.isArray(document.sessions)) {
      console.error(`[cowork] 本地会话记录格式不完整，已按无会话启动：${this.sessionsPath}`);
      return;
    }
    for (const record of document.sessions) {
      if (!validRecord(record)) continue;
      this.sessions.set(record.sessionId, {
        sessionId: record.sessionId,
        ...(record.clientName ? { clientName: record.clientName } : {}),
        protocolVersion: record.protocolVersion,
        createdAt: record.createdAt,
        ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
        secretHash: record.secretHash
      });
    }
  }

  private persist(): Promise<void> {
    // A failed write already reported to its caller must not poison the queue:
    // the next session change still has to reach the disk.
    this.persisting = this.persisting
      // eslint-disable-next-line no-restricted-syntax -- 上一次写入的失败已经抛给调用方，队列清掉它后续会话变更才能继续落盘
      .catch(() => undefined)
      .then(async () => {
        const document: SessionDocument = { version: 1, sessions: [...this.sessions.values()] };
        const temporary = `${this.sessionsPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
        await mkdir(this.directory, { recursive: true });
        const handle = await open(temporary, "w", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, this.sessionsPath);
      });
    return this.persisting;
  }

  private findPresented(secret: string): SessionRecord | undefined {
    const digest = secretHash(secret);
    for (const record of this.sessions.values()) if (sameSecret(digest, record.secretHash)) return record;
    return undefined;
  }

  /** Authorize this client as a named session; only the host may do it. */
  async authorize(
    principal: LocalPrincipal,
    input: { clientName?: unknown; protocolVersion: string }
  ): Promise<AuthorizedSession> {
    if (principal.kind !== "host")
      throw new HttpError(403, "只有执行主机的本地凭据可以创建会话", "host_credential_required");
    const name = clientName(input.clientName);
    this.pruneRevoked();
    const token = `sess_${randomBytes(32).toString("hex")}`;
    const record: SessionRecord = {
      sessionId: `session_${randomBytes(9).toString("hex")}`,
      ...(name ? { clientName: name } : {}),
      protocolVersion: input.protocolVersion,
      createdAt: new Date().toISOString(),
      secretHash: secretHash(token)
    };
    this.sessions.set(record.sessionId, record);
    await this.persist();
    return { summary: summary(record), token };
  }

  /**
   * Drop revocation tombstones once they can no longer explain a refusal.
   *
   * A tombstone only exists so the next request of a revoked client can say
   * "revoked" instead of "unknown"; a day is far longer than that needs. Live
   * sessions are never pruned: a client that was never told it was revoked
   * keeps working until the owner ends it.
   */
  private pruneRevoked(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [sessionId, record] of this.sessions) {
      if (record.revokedAt && Date.parse(record.revokedAt) < cutoff) this.sessions.delete(sessionId);
    }
  }

  /** End one session; a session may end itself and the host may end any. */
  async revoke(principal: LocalPrincipal, sessionId: string): Promise<LocalSessionSummary> {
    if (principal.kind === "session" && principal.sessionId !== sessionId)
      throw new HttpError(403, "只能撤销当前会话", "host_credential_required");
    const record = this.sessions.get(sessionId);
    if (!record) throw new HttpError(404, "找不到该会话", "session_unknown");
    if (!record.revokedAt) {
      record.revokedAt = new Date().toISOString();
      await this.persist();
    }
    return summary(record);
  }

  /** What this principal may see: the host sees every session, a session itself. */
  list(principal: LocalPrincipal): LocalSessionSummary[] {
    const records = [...this.sessions.values()];
    return (
      principal.kind === "host"
        ? records
        : records.filter((record) => record.sessionId === principal.sessionId)
    ).map(summary);
  }

  /** The credential policy the local transport applies to `/api/*`. */
  private policy(): LocalCredentialPolicy {
    return {
      admit: (request) => {
        const expected = this.bootstrapToken();
        const presented = presentedCredential(request);
        if (!presented) {
          if (expected) throw new HttpError(401, "本地会话未授权", "unauthorized");
          return;
        }
        if (expected && sameSecret(presented, expected)) return;
        const localHost = this.localHostToken();
        if (localHost && sameSecret(presented, localHost)) return;
        if (sameSecret(presented, this.runToken)) return;
        const record = this.findPresented(presented);
        if (!record) throw new HttpError(401, "本地会话未授权", "unauthorized");
        if (record.revokedAt)
          throw new HttpError(401, "本地会话已撤销，请使用本地凭据重新授权", "session_revoked");
      }
    };
  }

  principalOf(request: IncomingMessage): LocalPrincipal {
    const presented = presentedCredential(request);
    if (!presented) return HOST_PRINCIPAL;
    const expected = this.bootstrapToken();
    if (expected && sameSecret(presented, expected)) return HOST_PRINCIPAL;
    const localHost = this.localHostToken();
    if (localHost && sameSecret(presented, localHost)) return HOST_PRINCIPAL;
    if (sameSecret(presented, this.runToken))
      return { kind: "session", principalId: `session:${this.runSessionId}`, sessionId: this.runSessionId };
    const record = this.findPresented(presented);
    return record
      ? { kind: "session", principalId: `session:${record.sessionId}`, sessionId: record.sessionId }
      : HOST_PRINCIPAL;
  }

  /** Host/Origin checks plus the local credential, for one request. */
  admit(request: IncomingMessage, dashboardUrl: string): LocalRequestAdmission {
    const url = localRequestUrl(request, dashboardUrl, this.policy());
    return { url, principal: this.principalOf(request) };
  }
}
