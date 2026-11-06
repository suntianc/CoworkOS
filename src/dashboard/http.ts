import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const dashboardContentPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

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
  if (
    (request.headers.origin && request.headers.origin !== origin) ||
    request.headers["sec-fetch-site"] === "cross-site"
  ) {
    throw new HttpError(403, "请从 CoworkOS 界面访问本地 API");
  }
  const url = new URL(request.url ?? "/", origin);
  if (url.origin !== origin) throw new HttpError(403, "请求地址不是本地 CoworkOS");
  if (url.pathname.startsWith("/api/")) policy.admit(request);
  return url;
}
