import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The page's policy, with the explicitly trusted local backends as connect
 * targets. Without them a page served by one local backend may not manage
 * another, because its own CSP would refuse the fetch.
 */
export function dashboardContentPolicy(trustedOrigins: string[] = []): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    `connect-src ${["'self'", ...trustedOrigins].join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; ");
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** A stable protocol code, for clients that branch on outcomes instead of prose. */
    readonly code?: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": String(response.getHeader("cache-control") ?? "no-cache"),
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

/** Shared transport validation; domain routers translate errors into their own envelopes. */
export async function readJsonBody(
  request: IncomingMessage,
  limit = 4 * 1024 * 1024
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "请求体过大");
    chunks.push(Buffer.from(chunk));
  }
  if (!size) return {};
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "请求体必须是 JSON 对象");
  return value as Record<string, unknown>;
}

/**
 * The local credential a request presents.
 *
 * One reader for the three shapes clients already use: header clients send
 * `x-atria-token`, the desktop host installs an HttpOnly `atria-session`
 * cookie, and other local tools may send `Authorization: Bearer`.
 */
export function presentedCredential(request: IncomingMessage): string | undefined {
  const direct = request.headers["x-atria-token"];
  if (typeof direct === "string" && direct) return direct;
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    const bearer = authorization.slice("Bearer ".length).trim();
    if (bearer) return bearer;
  }
  return (
    String(request.headers.cookie || "")
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith("atria-session="))
      ?.slice("atria-session=".length) || undefined
  );
}

export function sameSecret(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Decides whether a request may use `/api/*`; the caller owns the credential policy. */
export interface LocalCredentialPolicy {
  admit(request: IncomingMessage): void;
}

/** The environment token, for a host with no session store: keep the old single-secret check. */
export function environmentCredentialPolicy(): LocalCredentialPolicy {
  return {
    admit(request) {
      const expected = process.env.COWORK_API_TOKEN;
      if (expected && !sameSecret(presentedCredential(request), expected))
        throw new HttpError(401, "本地会话未授权", "unauthorized");
    }
  };
}

/**
 * Exact local client origins a browser page may manage this backend from.
 *
 * A page served by one local backend can manage another one; a browser sends
 * such a request with the page's Origin and needs CORS. Only the loopback
 * origins listed explicitly are accepted — no wildcard and no non-local host —
 * so the listener and the same-origin rule stay as they are for everyone else.
 * Configuration is `COWORK_TRUSTED_CLIENT_ORIGINS=http://127.0.0.1:4000,...`.
 */
export function trustedClientOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.COWORK_TRUSTED_CLIENT_ORIGINS;
  if (!raw) return [];
  const origins = new Set<string>();
  for (const item of raw.split(",")) {
    const origin = item.trim().replace(/\/+$/, "");
    if (!origin) continue;
    let valid = false;
    try {
      const parsed = new URL(origin);
      valid =
        parsed.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) &&
        parsed.origin === origin &&
        origin.length <= 120;
    } catch {
      valid = false;
    }
    // A typo must not silently widen access; the accepted list is exactly what
    // was written, and anything unreadable is reported instead of guessed.
    if (!valid) {
      console.error(`[cowork] 忽略了不是本机 http 来源的受信客户端配置：${origin}`);
      continue;
    }
    origins.add(origin);
  }
  return [...origins];
}

/** The requesting page's origin when it is an explicitly trusted local client. */
export function trustedClientOrigin(
  request: IncomingMessage,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !origin) return undefined;
  return trustedClientOrigins(env).includes(origin) ? origin : undefined;
}

/**
 * Let the named trusted page read this response.
 *
 * The credential still travels in a header the client sets, so no cookie and
 * no `Access-Control-Allow-Credentials`; the page is trusted to read the
 * responses it already sent an authorized request for.
 */
export function applyTrustedClientCors(response: ServerResponse, origin: string): void {
  response.setHeader("access-control-allow-origin", origin);
  // A browser sends the local credential cookie only when the response allows
  // credentials. The origin is exact, never a wildcard.
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
  response.setHeader("access-control-allow-headers", "accept, authorization, content-type, x-atria-token");
  response.setHeader("access-control-expose-headers", "x-cowork-replayed");
  response.setHeader("access-control-max-age", "600");
  response.setHeader("vary", "origin");
}

/**
 * This server is a local, single-user API, not a remotely accessible backend.
 * Check Host as well as Origin, so DNS rebinding cannot turn it into one.
 * Non-browser local clients (Main and MCP) intentionally need no Origin header.
 */
export function localRequestUrl(
  request: IncomingMessage,
  dashboardUrl: string,
  policy: LocalCredentialPolicy = environmentCredentialPolicy()
): URL {
  const local = new URL(dashboardUrl);
  const host = request.headers.host;
  const localhost = `localhost:${local.port}`;
  if (host !== local.host && host !== localhost) throw new HttpError(403, "只能通过本机地址访问 CoworkOS");
  const origin = `${local.protocol}//${host}`;
  const requested = request.headers.origin;
  // A page served by another trusted local backend names that origin. It is
  // still a local client; anything else keeps the single-origin rule.
  const crossOrigin = typeof requested === "string" && requested !== origin;
  if ((crossOrigin && !trustedClientOrigin(request)) || request.headers["sec-fetch-site"] === "cross-site") {
    throw new HttpError(403, "请从 CoworkOS 界面访问本地 API");
  }
  const url = new URL(request.url ?? "/", origin);
  if (url.origin !== origin) throw new HttpError(403, "请求地址不是本地 CoworkOS");
  // A browser preflight deliberately carries no credentials. Answering it
  // reveals only the origin, methods and headers, never data, so the actual
  // request still goes through the credential policy.
  if (url.pathname.startsWith("/api/") && request.method !== "OPTIONS") policy.admit(request);
  return url;
}
