import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import type { MainCapacityService } from "./main-capacity-service.js";

const PATH = "/api/main-capacity";

/**
 * The external Main capacity surface.
 *
 * Reading it shows the quotas, the Mains this backend is running and the
 * demands waiting for a slot. Writing changes the quotas; a reduction below
 * real usage is refused with its reason instead of ending running work.
 */
export async function handleMainCapacityRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  service: MainCapacityService
): Promise<boolean> {
  if (url.pathname !== PATH) return false;
  response.setHeader("cache-control", "no-store");
  if (request.method === "GET") {
    sendJson(response, 200, await service.describe());
    return true;
  }
  if (request.method !== "POST") throw new HttpError(405, "method not allowed");
  const body = await readJsonBody(request, 64 * 1024);
  if (body.action === "retry") {
    if (typeof body.requestId !== "string" || !body.requestId.trim() || body.requestId.length > 200)
      throw new HttpError(400, "retry 需要有效的 requestId");
    sendJson(response, 200, await service.retry(body.requestId.trim()));
    return true;
  }
  if (body.action !== undefined && body.action !== "configure") throw new HttpError(400, "未知的容量操作");
  sendJson(
    response,
    200,
    await service.configure({ resident: body.resident, continuation: body.continuation })
  );
  return true;
}
