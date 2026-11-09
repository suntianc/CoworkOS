import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { projectExperienceOptionsSchema } from "../domain/project-experience.js";
import {
  ProjectExperienceStore,
  ProjectExperienceConflictError,
  ProjectExperienceCapacityError
} from "../runtime/project-experience-store.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";

const entry = z
  .object({
    id: z.string().uuid().optional(),
    revision: z.number().int().positive().optional(),
    kind: z.enum(["experience", "skill"]),
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(500).default(""),
    content: z.string().trim().min(1).max(6000)
  })
  .strict();
const common = { snapshotRevision: z.number().int().nonnegative() };
const target = { ...common, id: z.string().uuid(), revision: z.number().int().positive() };
const inputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("configure"),
      ...common,
      settings: projectExperienceOptionsSchema
        .partial()
        .extend({
          model: z.union([projectExperienceOptionsSchema.shape.model, z.literal("")]).optional(),
          enabled: z.boolean().optional(),
          learningEnabled: z.boolean().optional(),
          autoActivate: z.boolean().optional()
        })
        .strict()
    })
    .strict(),
  z.object({ action: z.literal("save"), ...common, item: entry }).strict(),
  z
    .object({ action: z.literal("set_state"), ...target, state: z.enum(["active", "disabled", "rejected"]) })
    .strict(),
  z.object({ action: z.literal("pin"), ...target, pinned: z.boolean() }).strict(),
  z.object({ action: z.literal("rollback"), ...target, version: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("remove"), ...target }).strict()
]);

export function publicProjectExperience(document: Awaited<ReturnType<ProjectExperienceStore["read"]>>) {
  return {
    revision: document.revision,
    settings: {
      enabled: document.enabled,
      learningEnabled: document.learningEnabled,
      autoActivate: document.autoActivate,
      ...document.learningOptions
    },
    items: [...document.entries, ...document.candidates]
  };
}

/** Catalog resolution and local authentication belong to the host; paths never come from HTTP input. */
export async function handleProjectExperienceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  resolveStore: (projectId: string) => Promise<ProjectExperienceStore | undefined>
): Promise<boolean> {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/experience$/);
  if (!match) return false;
  const store = await resolveStore(decodeURIComponent(match[1]));
  if (!store) throw new HttpError(404, "项目不存在");
  response.setHeader("cache-control", "no-store");
  if (request.method === "GET") {
    sendJson(response, 200, publicProjectExperience(await store.read()));
    return true;
  }
  if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
  const parsed = inputSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) throw new HttpError(400, "项目经验参数不合法");
  const input = parsed.data;
  try {
    if (input.action === "configure") await store.configure(input.settings, input.snapshotRevision);
    else if (input.action === "save") await store.save(input.item, input.snapshotRevision);
    else if (input.action === "set_state") await store.setState(input.id, input.revision, input.state);
    else if (input.action === "pin") await store.pin(input.id, input.revision, input.pinned);
    else if (input.action === "rollback") await store.rollback(input.id, input.revision, input.version);
    else await store.remove(input.id, input.revision);
  } catch (error) {
    if (error instanceof ProjectExperienceConflictError)
      throw new HttpError(409, "项目经验已变化，请刷新后重试；草稿仍保留。");
    if (error instanceof ProjectExperienceCapacityError || error instanceof z.ZodError)
      throw new HttpError(400, "项目经验超过容量或内容不合法，请缩短或删除后重试。");
    throw error;
  }
  sendJson(response, 200, publicProjectExperience(await store.read()));
  return true;
}
