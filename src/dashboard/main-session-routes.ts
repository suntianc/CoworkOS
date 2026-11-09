import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { createMainSessionService, type MainSessionServicePorts } from "./main-session-service.js";

const PROJECT_PATH = /^\/api\/projects\/([^/]+)\/main-sessions(?:\/([^/]+))?$/;

/**
 * The Main session HTTP surface.
 *
 * The project in the URL is resolved through the local catalog, so a request
 * cannot select an execution directory. One project is read at a time; a view
 * of another project is a separate request and cannot be merged into this one.
 */
export async function handleMainSessionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ports: MainSessionServicePorts
): Promise<boolean> {
  const match = url.pathname.match(PROJECT_PATH);
  if (!match) return false;
  const service = createMainSessionService(ports);
  const projectId = decodeURIComponent(match[1]);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 第二段路径来自可选捕获组，匹配成功时该分组也可能缺失，这里必须保留 undefined 分支
  const sessionId = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
  response.setHeader("cache-control", "no-store");
  if (request.method === "GET") {
    if (sessionId !== undefined) {
      const session = (await service.list(projectId)).find((entry) => entry.sessionId === sessionId);
      if (!session) throw new HttpError(404, "找不到该 Main 会话");
      sendJson(response, 200, { projectId, session });
      return true;
    }
    sendJson(response, 200, { projectId, sessions: await service.list(projectId) });
    return true;
  }
  if (request.method !== "POST") throw new HttpError(405, "method not allowed");
  const body = await readJsonBody(request);
  const action = body.action ?? "create";
  if (action === "create") {
    const session = await service.create(projectId, {
      title: body.title,
      entryKind: body.entryKind,
      kind: body.kind,
      requirementId: body.requirementId
    });
    sendJson(response, 201, { session });
    return true;
  }
  if (action === "select_requirement") {
    const target = sessionId ?? (typeof body.sessionId === "string" ? body.sessionId : undefined);
    if (!target) throw new HttpError(400, "select_requirement 需要 sessionId");
    if (body.requirementId === undefined) throw new HttpError(400, "select_requirement 需要 requirementId");
    sendJson(response, 200, {
      session: await service.selectRequirement(projectId, target, body.requirementId)
    });
    return true;
  }
  throw new HttpError(400, "未知的 Main 会话操作");
}
