import { HttpError } from "./http.js";

/**
 * The management protocol this backend speaks.
 *
 * Clients (desktop, Web, future remote entry) name the protocol version they
 * implement when they authorize. A backend that cannot serve that version says
 * so with a code and a message naming both versions, instead of failing later
 * on a field it does not understand. Capabilities tell a client what it may
 * call; they describe the protocol, not every route on the server.
 *
 * Version rule: the major number is compatibility. A client with a newer minor
 * than this backend is refused, because it may send fields this backend ignores
 * silently; a client with an older minor is accepted.
 */
export const SERVER_PROTOCOL: ProtocolVersion = { major: 1, minor: 0 };
export const MIN_CLIENT_PROTOCOL: ProtocolVersion = { major: 1, minor: 0 };
export const PROTOCOL_VERSION = versionText(SERVER_PROTOCOL);
export const MIN_CLIENT_PROTOCOL_VERSION = versionText(MIN_CLIENT_PROTOCOL);

function versionText(value: ProtocolVersion): string {
  return `${value.major}.${value.minor}`;
}

export const MANAGEMENT_CAPABILITIES = [
  "protocol.negotiate",
  "session.authorize",
  "session.revoke",
  "operations.query",
  "commands.idempotent",
  "commands.expectedRevision",
  "events.snapshot",
  "events.stream"
];

export interface ProtocolInfo {
  version: string;
  minClientVersion: string;
  capabilities: string[];
}

export interface ProtocolVersion {
  major: number;
  minor: number;
}

export function protocolInfo(): ProtocolInfo {
  return {
    version: PROTOCOL_VERSION,
    minClientVersion: MIN_CLIENT_PROTOCOL_VERSION,
    capabilities: [...MANAGEMENT_CAPABILITIES]
  };
}

export function parseProtocolVersion(value: unknown): ProtocolVersion | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const match = value.trim().match(/^(\d{1,4})\.(\d{1,4})$/);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * Check a client's declared protocol version against this backend.
 *
 * A missing version is a request error, not an incompatibility: the client
 * cannot be helped by reading a different response shape, so the refusal names
 * the field it has to send.
 */
export function negotiateProtocolVersion(value: unknown): ProtocolVersion {
  if (value === undefined || value === null)
    throw new HttpError(
      400,
      `请求缺少 protocolVersion；本后端协议为 ${PROTOCOL_VERSION}，至少支持客户端协议 ${MIN_CLIENT_PROTOCOL_VERSION}`,
      "protocol_required"
    );
  const client = parseProtocolVersion(value);
  const server = SERVER_PROTOCOL;
  const minimum = MIN_CLIENT_PROTOCOL;
  if (!client)
    throw new HttpError(
      400,
      `protocolVersion 必须是 major.minor 形式，本后端为 ${PROTOCOL_VERSION}`,
      "protocol_required"
    );
  const compatible =
    client.major === server.major && client.minor >= minimum.minor && client.minor <= server.minor;
  if (compatible) return client;
  throw new HttpError(
    409,
    `客户端协议 ${client.major}.${client.minor} 与后端协议 ${PROTOCOL_VERSION} 不兼容（支持 ${MIN_CLIENT_PROTOCOL_VERSION}–${PROTOCOL_VERSION}）；请升级客户端或后端后重试`,
    "protocol_incompatible"
  );
}
