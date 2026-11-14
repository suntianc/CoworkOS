import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { normalizeReasoningEffort } from "../runtime/runtime-settings.js";
import type { SubagentBackend } from "./subagent-backend.js";

/**
 * Delegation requests from a Main process.
 *
 * Main names the work, never an identity or a path: the backend registers the
 * item in the Task's own durable queue and answers with the callId its status,
 * wait and cancel tools then use.
 */
export interface SubagentRoutePorts {
  backend: SubagentBackend;
}

const TASK_PATH = /^\/api\/tasks\/([^/]+)\/subagents$/;

export async function handleSubagentRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ports: SubagentRoutePorts
): Promise<boolean> {
  const match = url.pathname.match(TASK_PATH);
  if (!match) return false;
  if (request.method !== "POST") throw new HttpError(405, "method not allowed");
  const taskId = decodeURIComponent(match[1]);
  const body = await readJsonBody(request, 64 * 1024);
  const action = body.action;
  if (action === "dispatch") {
    const accepted = await ports.backend.dispatch({
      taskId,
      task: text(body.task, "任务", 20_000),
      mode: oneOf(body.mode, ["sync", "async"], "派单模式"),
      role: body.role === undefined ? "executor" : oneOf(body.role, ["executor", "reviewer"], "角色"),
      ...(body.dependsOn === undefined ? {} : { dependsOn: strings(body.dependsOn, "dependsOn", 16) }),
      ...(optionalText(body.developmentId) === undefined
        ? {}
        : { developmentId: text(body.developmentId, "需求 ID", 200) }),
      ...(optionalText(body.continueCallId) === undefined
        ? {}
        : { continueCallId: text(body.continueCallId, "续接工作项", 200) }),
      ...(optionalText(body.reviewId) === undefined ? {} : { reviewId: text(body.reviewId, "审查 ID", 200) }),
      ...(body.attachments === undefined ? {} : { attachments: body.attachments }),
      ...(optionalText(body.profileId) === undefined
        ? {}
        : { profileId: text(body.profileId, "连接 ID", 200) }),
      ...(optionalText(body.model) === undefined ? {} : { model: text(body.model, "模型", 200) }),
      ...(body.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: normalizeReasoningEffort(body.thinkingLevel, "thinkingLevel") })
    });
    sendJson(response, 200, { accepted: true, ...accepted });
    return true;
  }
  if (action === "cancel") {
    const accepted = await ports.backend.cancel({
      taskId,
      callId: text(body.callId, "callId", 200),
      ...(optionalText(body.reason) === undefined ? {} : { reason: text(body.reason, "原因", 2_000) })
    });
    sendJson(response, 200, accepted);
    return true;
  }
  throw new HttpError(400, "未知的子代理操作", "invalid_subagent_action");
}

function optionalText(value: unknown): unknown {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function text(value: unknown, label: string, max: number): string {
  const found = typeof value === "string" ? value.trim() : "";
  if (!found || found.length > max) throw new HttpError(400, `${label}须为 1–${max} 个字符`, "invalid_input");
  return found;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value))
    throw new HttpError(400, `${label}须为 ${allowed.join(" / ")}`, "invalid_input");
  return value as T;
}

function strings(value: unknown, label: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((entry) => typeof entry !== "string"))
    throw new HttpError(400, `${label}须为不超过 ${max} 个字符串`, "invalid_input");
  return value as string[];
}
