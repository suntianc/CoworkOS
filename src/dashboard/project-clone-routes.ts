import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import type { ProjectCloneService } from "./project-clone-service.js";

const startSchema = z
  .object({
    remoteUrl: z.string().trim().min(1).max(2000),
    destination: z.string().trim().min(1).max(4096),
    branch: z.string().trim().max(200).optional(),
    operationId: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,200}$/)
      .optional()
  })
  .strict();

/** Clone starts answer immediately; progress and cancellation are read by clone id. */
export async function handleProjectCloneRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  clones: ProjectCloneService | undefined
): Promise<boolean> {
  if (!clones) return false;
  if (url.pathname === "/api/project-clones") {
    if (request.method !== "POST") throw new HttpError(405, "method not allowed");
    const parsed = startSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw new HttpError(400, "克隆参数不合法", "clone_input_invalid");
    sendJson(response, 202, { clone: await clones.start(parsed.data) });
    return true;
  }
  const match = url.pathname.match(/^\/api\/project-clones\/([^/]+)(\/cancel)?$/);
  if (!match) return false;
  const cloneId = decodeURIComponent(match[1]);
  if (match[2]) {
    if (request.method !== "POST") throw new HttpError(405, "method not allowed");
    sendJson(response, 200, { clone: await clones.cancel(cloneId) });
    return true;
  }
  if (request.method !== "GET") throw new HttpError(405, "method not allowed");
  sendJson(response, 200, { clone: await clones.status(cloneId) });
  return true;
}
