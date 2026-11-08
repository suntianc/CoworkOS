import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { DevelopmentExistsError, developmentWorkspace } from "../domain/project-development.js";
import type { ProjectDevelopmentService } from "./project-development-service.js";

export interface DevelopmentProject {
  projectId: string;
  projectName: string;
  projectDirectory: string;
}

export interface ProjectDevelopmentRoutePorts {
  service: ProjectDevelopmentService;
  /** The serving backend: it owns the checkout it records. */
  backendId: string;
  /** Resolve a project from the local catalog; a path from a request is never used. */
  taskProject(taskId: string): Promise<DevelopmentProject | undefined>;
}

const PROJECT_PATH = /^\/api\/projects\/([^/]+)\/(developments|merge-config)(?:\/([^/]+))?$/;
const TASK_PATH = /^\/api\/tasks\/([^/]+)\/developments(?:\/([^/]+))?$/;
const BACKEND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/;

function declaredBackend(request: IncomingMessage): string | undefined {
  const value = request.headers["x-cowork-backend-id"];
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : "";
  if (!BACKEND_ID.test(text)) throw new HttpError(400, "后端身份格式不合法", "invalid_backend_id");
  return text || undefined;
}

function reply(response: ServerResponse, status: number, body: unknown): true {
  sendJson(response, status, body);
  return true;
}

/**
 * The development-record HTTP surface.
 *
 * Two shapes reach the same service: the UI/API names a project, while the Main
 * tool names only its own Task and therefore cannot address another project. A
 * Task-scoped header on the project shape is checked too, so a tool that crafts
 * another project's URL is refused. The URL never selects a repository or a
 * checkout directory; both come from the project catalog and the configured
 * merge entry.
 */
export async function handleDevelopmentRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ports: ProjectDevelopmentRoutePorts
): Promise<boolean> {
  const projectMatch = url.pathname.match(PROJECT_PATH);
  const taskMatch = url.pathname.match(TASK_PATH);
  if (!projectMatch && !taskMatch) return false;
  response.setHeader("cache-control", "no-store");
  const declared = declaredBackend(request);
  const backendId = declared ?? ports.backendId;
  let projectId: string;
  let taskId: string | undefined;
  if (projectMatch) {
    projectId = decodeURIComponent(projectMatch[1]!);
    const scopedTask = request.headers["x-cowork-task-id"];
    if (scopedTask !== undefined) {
      const task = typeof scopedTask === "string" ? scopedTask : "";
      const bound = task ? await ports.taskProject(task).catch(() => undefined) : undefined;
      if (!bound || bound.projectId !== projectId)
        throw new HttpError(403, "开发记录只能访问当前会话所属项目", "project_scope_denied");
    }
  } else {
    taskId = decodeURIComponent(taskMatch![1]!);
    const bound = await ports.taskProject(taskId).catch(() => undefined);
    if (!bound) throw new HttpError(404, "会话不属于任何项目", "project_unbound");
    projectId = bound.projectId;
  }
  const itemId =
    projectMatch?.[3] !== undefined
      ? decodeURIComponent(projectMatch[3])
      : taskMatch?.[2] !== undefined
        ? decodeURIComponent(taskMatch[2])
        : undefined;
  const kind = (projectMatch?.[2] ?? "developments") as "developments" | "merge-config";

  if (kind === "merge-config") {
    if (taskId !== undefined) return false;
    if (request.method === "GET")
      return reply(response, 200, { mergeConfig: (await ports.service.mergeConfig(projectId)) ?? null });
    if (request.method !== "POST") throw new HttpError(405, "method not allowed");
    const body = await readJsonBody(request);
    return reply(response, 200, {
      mergeConfig: await ports.service.setMergeConfig(projectId, {
        repository: body.repository,
        targetBranch: body.targetBranch,
        // A remote backend configures the entry it can reach; a local request
        // defaults to the serving backend.
        executionBackendId: body.executionBackendId ?? declared
      })
    });
  }

  if (request.method === "GET") {
    if (itemId !== undefined)
      return reply(response, 200, {
        development: taskId
          ? await ports.service.getForTask(taskId, itemId, backendId)
          : await ports.service.get(projectId, itemId, backendId)
      });
    return reply(response, 200, {
      projectId,
      developments: taskId ? await ports.service.listForTask(taskId) : await ports.service.list(projectId)
    });
  }
  if (request.method !== "POST") throw new HttpError(405, "method not allowed");
  const body = await readJsonBody(request);
  try {
    switch (body.action) {
      case "query":
        return reply(response, 200, {
          projectId,
          developments: taskId ? await ports.service.listForTask(taskId) : await ports.service.list(projectId)
        });
      case "get": {
        if (typeof body.developmentId !== "string") throw new HttpError(400, "get 需要 developmentId");
        return reply(response, 200, {
          development: taskId
            ? await ports.service.getForTask(taskId, body.developmentId, backendId)
            : await ports.service.get(projectId, body.developmentId, backendId)
        });
      }
      case "create":
        return reply(response, 201, {
          development: taskId
            ? await ports.service.createForTask(taskId, body)
            : await ports.service.create(projectId, body)
        });
      case "update": {
        if (typeof body.developmentId !== "string") throw new HttpError(400, "update 需要 developmentId");
        return reply(response, 200, {
          development: taskId
            ? await ports.service.updateForTask(taskId, body.developmentId, body)
            : await ports.service.update(projectId, body.developmentId, body)
        });
      }
      case "ensure_workspace": {
        if (typeof body.developmentId !== "string")
          throw new HttpError(400, "ensure_workspace 需要 developmentId");
        return reply(response, 200, {
          development: taskId
            ? await ports.service.ensureWorkspaceForTask(taskId, body.developmentId)
            : await ports.service.ensureWorkspace(projectId, body.developmentId)
        });
      }
      case "find_by_requirement": {
        const development = taskId
          ? await ports.service.findForTask(taskId, body.requirementId, backendId)
          : await ports.service.find(projectId, body.requirementId, backendId);
        if (!development) throw new HttpError(404, "该需求还没有开发记录", "not_found");
        return reply(response, 200, { development });
      }
      case "record_workspace": {
        if (taskId !== undefined) throw new HttpError(400, "record_workspace 只能按项目记录");
        if (typeof body.developmentId !== "string")
          throw new HttpError(400, "record_workspace 需要 developmentId");
        const workspace = developmentWorkspace(body.workspace);
        if (workspace.backendId !== backendId)
          throw new HttpError(403, "现场属于另一后端", "development_workspace_backend_mismatch");
        return reply(response, 200, {
          development: await ports.service.recordWorkspace(projectId, body.developmentId, workspace)
        });
      }
      default:
        throw new HttpError(400, "未知的开发记录操作");
    }
  } catch (error) {
    if (error instanceof DevelopmentExistsError) {
      sendJson(response, 409, {
        error: error.message,
        code: error.code,
        developmentId: error.developmentId
      });
      return true;
    }
    throw error;
  }
}
