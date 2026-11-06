import type { IncomingMessage, ServerResponse } from "node:http";
import { negotiateProtocolVersion, protocolInfo } from "./backend-protocol.js";
import { readJsonBody, sendJson } from "./http.js";
import type { LocalAccess, LocalPrincipal } from "./local-access.js";

export interface BackendIdentityInfo {
  backendId: string;
  pid: number;
  startedAt: string;
}

/**
 * The local session protocol: authorize, inspect, revoke.
 *
 * Authorizing is the only step that spends the host credential; every later
 * call presents the session it returned. The route shape stays under
 * `/api/session` so a client can find the whole handshake in one place, and the
 * response repeats the backend identity and protocol capabilities so a client
 * does not need a second call before it shows what the connection supports.
 */
export async function handleSessionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  access: LocalAccess,
  backendInfo: () => BackendIdentityInfo,
  principal: LocalPrincipal
): Promise<boolean> {
  const match = url.pathname.match(/^\/api\/session(?:\/([^/]+))?$/);
  if (!match) return false;
  const sessionId = match[1] ? decodeURIComponent(match[1]) : undefined;
  if (!sessionId && request.method === "POST") {
    const body = await readJsonBody(request);
    const protocol = negotiateProtocolVersion(body.protocolVersion);
    const session = await access.authorize(principal, {
      clientName: body.clientName,
      protocolVersion: `${protocol.major}.${protocol.minor}`
    });
    sendJson(response, 201, {
      session: { ...session.summary, token: session.token },
      backend: backendInfo(),
      protocol: protocolInfo()
    });
    return true;
  }
  if (!sessionId && request.method === "GET") {
    sendJson(response, 200, {
      current:
        principal.kind === "session"
          ? { kind: principal.kind, sessionId: principal.sessionId }
          : { kind: principal.kind },
      sessions: access.list(principal)
    });
    return true;
  }
  if (sessionId && request.method === "DELETE") {
    const revoked = await access.revoke(principal, sessionId);
    sendJson(response, 200, { ...revoked, revoked: true });
    return true;
  }
  sendJson(response, 405, { error: "method not allowed", code: "method_not_allowed" });
  return true;
}
