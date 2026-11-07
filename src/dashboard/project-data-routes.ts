import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import type { ProjectDataRuntime, ProjectDataService } from "../workspace/project-data-service.js";

export interface LedgerProject {
  projectId: string;
  projectName: string;
  projectDirectory: string;
}

export interface ProjectDataRoutePorts {
  /** Opened once at service start; every ledger request uses this one service. */
  runtime: ProjectDataRuntime;
  /** The serving backend's identity, so each backend keeps its own directory binding. */
  backendId: string;
  /** Resolve a project from the local catalog; a path from a request is never used. */
  project(projectId: string): Promise<LedgerProject | undefined>;
  /** The project a Task belongs to, for the current-project tool boundary. */
  taskProject(taskId: string): Promise<LedgerProject | undefined>;
}

async function bindProject(
  service: ProjectDataService,
  project: LedgerProject,
  backendId: string
): Promise<void> {
  await service.ensureProject({
    projectId: project.projectId,
    projectName: project.projectName,
    projectDirectory: project.projectDirectory,
    backendId
  });
}

/**
 * The ledger's HTTP surface.
 *
 * Two shapes reach the same service: the UI names a project, while the Main
 * tool names only its own Task and therefore cannot address another project.
 * A scoped Task header on the project shape is checked too, so a tool that
 * crafts another project's URL is refused instead of trusted.
 */
export async function handleProjectDataRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ports: ProjectDataRoutePorts
): Promise<boolean> {
  if (url.pathname === "/api/project-data") {
    if (request.method !== "GET") throw new HttpError(405, "method not allowed");
    const service = await ports.runtime.service();
    sendJson(response, 200, service.description);
    return true;
  }
  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/ledger(?:\/([^/]+))?$/);
  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/ledger$/);
  if (!projectMatch && !taskMatch) return false;
  const service = await ports.runtime.service();
  response.setHeader("cache-control", "no-store");
  let project: LedgerProject;
  if (projectMatch) {
    const projectId = decodeURIComponent(projectMatch[1]!);
    const scopedTask = request.headers["x-cowork-task-id"];
    if (scopedTask !== undefined) {
      const taskId = typeof scopedTask === "string" ? scopedTask : "";
      const bound = taskId ? await ports.taskProject(taskId).catch(() => undefined) : undefined;
      if (!bound || bound.projectId !== projectId)
        throw new HttpError(403, "台账工具只能访问当前会话所属项目", "project_scope_denied");
    }
    const resolved = await ports.project(projectId);
    if (!resolved) throw new HttpError(404, "项目不存在");
    project = resolved;
  } else {
    const taskId = decodeURIComponent(taskMatch![1]!);
    const resolved = await ports.taskProject(taskId).catch(() => undefined);
    if (!resolved) throw new HttpError(404, "会话不属于任何项目", "project_unbound");
    project = resolved;
  }
  await bindProject(service, project, ports.backendId);

  if (request.method === "GET") {
    if (projectMatch?.[2] !== undefined)
      return reply(response, 200, {
        requirement: await service.getRequirement(project.projectId, decodeURIComponent(projectMatch[2]))
      });
    const limit = url.searchParams.get("limit");
    return reply(response, 200, {
      projectId: project.projectId,
      requirements: await service.queryRequirements(project.projectId, {
        text: url.searchParams.get("q") ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
        limit: limit === null || limit === "" ? undefined : Number(limit)
      })
    });
  }
  if (request.method !== "POST") throw new HttpError(405, "method not allowed");
  const body = await readJsonBody(request);
  const requirementId = typeof body.requirementId === "string" ? body.requirementId : undefined;
  switch (body.action) {
    case "query":
      return reply(response, 200, {
        projectId: project.projectId,
        requirements: await service.queryRequirements(project.projectId, {
          text: body.q,
          status: body.status,
          limit: body.limit
        })
      });
    case "get":
      if (!requirementId) throw new HttpError(400, "get 需要 requirementId");
      return reply(response, 200, {
        requirement: await service.getRequirement(project.projectId, requirementId)
      });
    case "create":
      return reply(response, 201, {
        requirement: await service.createRequirement(project.projectId, {
          title: body.title,
          content: body.content,
          source: body.source,
          references: body.references
        })
      });
    case "update":
      if (!requirementId) throw new HttpError(400, "update 需要 requirementId");
      return reply(response, 200, {
        requirement: await service.updateRequirement(project.projectId, requirementId, {
          expectedRevision: body.expectedRevision,
          title: body.title,
          content: body.content,
          status: body.status,
          note: body.note,
          taskId: body.taskId
        })
      });
    case "decide":
      if (!requirementId) throw new HttpError(400, "decide 需要 requirementId");
      return reply(response, 200, {
        requirement: await service.addDecision(project.projectId, requirementId, {
          expectedRevision: body.expectedRevision,
          text: body.text,
          effective: body.effective,
          source: body.source
        })
      });
    case "set_decision_effective":
      if (!requirementId || typeof body.decisionId !== "string")
        throw new HttpError(400, "set_decision_effective 需要 requirementId 与 decisionId");
      return reply(response, 200, {
        requirement: await service.setDecisionEffective(project.projectId, requirementId, body.decisionId, {
          expectedRevision: body.expectedRevision,
          effective: body.effective
        })
      });
    default:
      throw new HttpError(400, "未知的台账操作");
  }
}

function reply(response: ServerResponse, status: number, body: unknown): true {
  sendJson(response, status, body);
  return true;
}
