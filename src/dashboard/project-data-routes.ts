import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import type { LocalPrincipal } from "./local-access.js";
import {
  boardActorId,
  type BoardActionContext,
  type BoardTransitionAction
} from "../domain/project-board.js";
import type { ProjectDataGateway, ProjectDataRuntime } from "../workspace/project-data-service.js";

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
  /** The admitted caller; board ownership derives from it, never from the request body. */
  principal: LocalPrincipal;
  /** Resolve a project from the local catalog; a path from a request is never used. */
  project(projectId: string): Promise<LedgerProject | undefined>;
  /** The project a Task belongs to, for the current-project tool boundary. */
  taskProject(taskId: string): Promise<LedgerProject | undefined>;
}

const BACKEND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/;
const BOARD_ACTIONS: readonly BoardTransitionAction[] = ["pause", "release", "cancel"];

async function bindProject(
  service: ProjectDataGateway,
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

function declaredBackend(request: IncomingMessage, fallback: string): string | undefined {
  const value = request.headers["x-cowork-backend-id"];
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : "";
  if (!BACKEND_ID.test(text)) throw new HttpError(400, "后端身份格式不合法", "invalid_backend_id");
  return text || fallback;
}

/**
 * Board ownership comes from the admitted principal. A remote backend is
 * already authenticated by its own session; it declares its local actor, which
 * is namespaced so one backend's host cannot look like another's.
 */
function boardContext(
  request: IncomingMessage,
  ports: ProjectDataRoutePorts,
  backendId: string
): BoardActionContext {
  const declared = request.headers["x-cowork-actor"];
  if (declared !== undefined) {
    if (typeof declared !== "string" || declared === "host")
      throw new HttpError(403, "远程后端不能声明本机用户身份", "board_actor_denied");
    return { backendId, actor: { id: boardActorId(declared), host: false } };
  }
  return ports.principal.kind === "host"
    ? { backendId, actor: { id: "host", host: true } }
    : { backendId, actor: { id: `session:${ports.principal.sessionId}`, host: false } };
}

function boardHandlerFor(
  body: Record<string, unknown>,
  project: LedgerProject,
  backendId: string,
  taskId?: string
): unknown {
  const input = body.handler;
  if (input === undefined && taskId) return { backendId, projectId: project.projectId, taskId };
  if (input === undefined) return undefined;
  const handler = input as Record<string, unknown>;
  if (handler.backendId !== backendId)
    throw new HttpError(403, "处理者属于另一后端", "board_handler_mismatch");
  if (handler.projectId !== project.projectId)
    throw new HttpError(409, "处理者与看板需求不属于同一项目", "board_project_mismatch");
  if (taskId !== undefined && handler.taskId !== taskId)
    throw new HttpError(403, "处理者与当前会话不一致", "board_handler_mismatch");
  return handler;
}

/**
 * The ledger and board HTTP surface.
 *
 * Two shapes reach the same service: the UI names a project, while the Main
 * tool names only its own Task and therefore cannot address another project.
 * A scoped Task header on the project shape is checked too, so a tool that
 * crafts another project's URL is refused instead of trusted. A remote backend
 * authenticates once and declares its stable backend id; it binds its own local
 * directory, which the authority stores apart from every execution path.
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
  if (url.pathname === "/api/project-data/projects") {
    if (request.method !== "GET") throw new HttpError(405, "method not allowed");
    const service = await ports.runtime.service();
    sendJson(response, 200, { projects: await service.projects() });
    return true;
  }
  if (url.pathname === "/api/project-data/bindings") {
    if (request.method !== "POST") throw new HttpError(405, "method not allowed");
    const service = await ports.runtime.service();
    const body = await readJsonBody(request);
    const backendId = declaredBackend(request, ports.backendId) ?? ports.backendId;
    const project = await service.ensureProject({
      projectId: body.projectId,
      projectName: body.projectName,
      projectDirectory: body.projectDirectory,
      backendId
    });
    sendJson(response, 200, { project });
    return true;
  }

  const projectMatch = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/(ledger|board|main-sessions)(?:\/([^/]+))?$/
  );
  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(ledger|board)$/);
  if (!projectMatch && !taskMatch) return false;
  const declared = declaredBackend(request, ports.backendId);
  // The project's local session view resolves this backend's own catalog and
  // local execution facts; only an authenticated secondary backend uses the
  // shared business surface here.
  if (projectMatch?.[2] === "main-sessions" && !declared) return false;
  const service = await ports.runtime.service();
  response.setHeader("cache-control", "no-store");
  const backendId = declared ?? ports.backendId;
  let project: LedgerProject;
  let scopedTaskId: string | undefined;
  if (projectMatch) {
    project = await resolveProject(projectMatch[1], request, ports, declared);
  } else {
    const taskId = decodeURIComponent(taskMatch![1]);
    // eslint-disable-next-line no-restricted-syntax -- 任务到项目的绑定查询是目录探测，读不到即视为该任务不归属任何项目，下面按未绑定回 404 而不是把存储错误当 500
    const resolved = await ports.taskProject(taskId).catch(() => undefined);
    if (!resolved) throw new HttpError(404, "会话不属于任何项目", "project_unbound");
    project = resolved;
    scopedTaskId = taskId;
  }
  if (!declared) await bindProject(service, project, ports.backendId);
  const kind = (projectMatch?.[2] ?? taskMatch?.[2]) as "ledger" | "board" | "main-sessions";
  const itemId = projectMatch?.[3] === undefined ? undefined : decodeURIComponent(projectMatch[3]);

  if (kind === "main-sessions") {
    // Shared session metadata for a secondary backend. The Task it names and
    // the Pi history stay on the backend that owns it, so this surface only
    // records identity; it never starts or cancels a process.
    if (request.method === "GET") {
      if (itemId !== undefined)
        return reply(response, 200, {
          record: await service.getMainSession(project.projectId, itemId)
        });
      return reply(response, 200, {
        projectId: project.projectId,
        records: await service.listMainSessions(project.projectId)
      });
    }
    if (request.method !== "POST") throw new HttpError(405, "method not allowed");
    const body = await readJsonBody(request);
    switch (body.action) {
      case "create":
        return reply(response, 201, {
          record: await service.createMainSession(project.projectId, {
            title: body.title,
            entryKind: body.entryKind,
            kind: body.kind,
            // The admitted backend owns the Task container; never a body field.
            backendId,
            taskId: body.taskId,
            requirementId: body.requirementId
          })
        });
      case "adopt":
        return reply(response, 200, {
          adopted: await service.adoptMainSessionTasks(
            project.projectId,
            backendId,
            Array.isArray(body.tasks) ? (body.tasks as Array<{ taskId: string }>) : []
          )
        });
      case "find_by_task": {
        const record = await service.findMainSessionByTask(project.projectId, backendId, body.taskId);
        if (!record) throw new HttpError(404, "找不到该 Main 会话", "not_found");
        return reply(response, 200, { record });
      }
      case "set_requirement": {
        const record = await service.getMainSession(project.projectId, body.sessionId);
        assertSessionOwner(record, backendId);
        return reply(response, 200, {
          record: await service.setMainSessionRequirement(
            project.projectId,
            body.sessionId,
            body.requirementId
          )
        });
      }
      case "record_run": {
        const record = await service.getMainSession(project.projectId, body.sessionId);
        assertSessionOwner(record, backendId);
        if (record.session.taskId !== body.taskId)
          throw new HttpError(409, "运行不属于该会话的历史容器", "session_task_mismatch");
        return reply(response, 200, {
          run: await service.recordMainSessionRun(project.projectId, body.sessionId, {
            runId: body.runId,
            taskId: body.taskId,
            requirementId: body.requirementId,
            state: body.state
          })
        });
      }
      case "settle_run": {
        // Settling is optional by contract: a Run from before sessions existed,
        // or one that already settled, simply has nothing to update.
        const record = await service.findMainSessionByTask(project.projectId, backendId, body.taskId);
        return reply(response, 200, {
          settled: record
            ? await service.settleMainSessionRun(project.projectId, body.taskId, body.runId, body.state)
            : 0
        });
      }
      default:
        throw new HttpError(400, "未知的 Main 会话操作");
    }
  }

  if (kind === "board") {
    if (request.method === "GET") {
      if (itemId !== undefined) {
        const entry = await service.boardEntry(project.projectId, itemId);
        return reply(response, 200, {
          entry,
          events: await service.boardEvents(project.projectId, itemId)
        });
      }
      return reply(response, 200, {
        projectId: project.projectId,
        entries: await service.boardEntries(project.projectId)
      });
    }
    if (request.method !== "POST") throw new HttpError(405, "method not allowed");
    const body = await readJsonBody(request);
    const context = boardContext(request, ports, backendId);
    if (body.action === "publish")
      return reply(response, 201, {
        entry: await service.publishBoardEntry(project.projectId, body, context)
      });
    if (body.action === "claim") {
      if (scopedTaskId === undefined && !declared && body.handler !== undefined) {
        const handler = body.handler as Record<string, unknown>;
        // eslint-disable-next-line no-restricted-syntax -- 认领者会话的归属查询失败时无法证明它属于本项目，下面按 403 拒绝，不能让读目录的失败变成 500
        const bound = await ports.taskProject(String(handler.taskId ?? "")).catch(() => undefined);
        if (!bound || bound.projectId !== project.projectId)
          throw new HttpError(403, "认领者会话不属于当前项目", "board_handler_mismatch");
      }
      const handler = boardHandlerFor(body, project, backendId, scopedTaskId);
      return reply(response, 200, {
        entry: await service.boardAction(
          project.projectId,
          body.boardId,
          "claim",
          { ...body, handler },
          context
        )
      });
    }
    if (typeof body.action === "string" && BOARD_ACTIONS.includes(body.action as BoardTransitionAction))
      return reply(response, 200, {
        entry: await service.boardAction(
          project.projectId,
          body.boardId,
          body.action as BoardTransitionAction,
          body,
          context
        )
      });
    throw new HttpError(400, "未知的看板操作");
  }

  if (request.method === "GET") {
    if (itemId !== undefined)
      return reply(response, 200, {
        requirement: await service.getRequirement(project.projectId, itemId)
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

async function resolveProject(
  encodedProjectId: string,
  request: IncomingMessage,
  ports: ProjectDataRoutePorts,
  declared: string | undefined
): Promise<LedgerProject> {
  const projectId = decodeURIComponent(encodedProjectId);
  if (declared) {
    // A secondary backend names the shared project; its local directory was
    // bound through the bindings route, so the authority never resolves it
    // through its own catalog and never uses a remote path as execution root.
    return { projectId, projectName: projectId, projectDirectory: "" };
  }
  const scopedTask = request.headers["x-cowork-task-id"];
  if (scopedTask !== undefined) {
    const taskId = typeof scopedTask === "string" ? scopedTask : "";
    // eslint-disable-next-line no-restricted-syntax -- x-cowork-task-id 指向的任务可能已被清理，绑定查询失败按不匹配处理，下面回 403 而不是把存储错误暴露成 500
    const bound = taskId ? await ports.taskProject(taskId).catch(() => undefined) : undefined;
    if (!bound || bound.projectId !== projectId)
      throw new HttpError(403, "台账工具只能访问当前会话所属项目", "project_scope_denied");
  }
  const resolved = await ports.project(projectId);
  if (!resolved) throw new HttpError(404, "项目不存在");
  return resolved;
}

/** A session's Run belongs to the backend that holds its history. */
function assertSessionOwner(record: { session: { backendId: string } }, backendId: string): void {
  if (record.session.backendId !== backendId)
    throw new HttpError(403, "该会话由另一后端执行，不能在此记录", "session_backend_mismatch");
}

function reply(response: ServerResponse, status: number, body: unknown): true {
  sendJson(response, status, body);
  return true;
}
