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

const PROJECT_PATH =
  /^\/api\/projects\/([^/]+)\/(developments|merge-config|reviews|merges|deliveries)(?:\/([^/]+))?$/;
const TASK_PATH = /^\/api\/tasks\/([^/]+)\/(developments|reviews|merges|deliveries)(?:\/([^/]+))?$/;
const BACKEND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/;

function declaredBackend(request: IncomingMessage): string | undefined {
  const value = request.headers["x-cowork-backend-id"];
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : "";
  if (!BACKEND_ID.test(text)) throw new HttpError(400, "后端身份格式不合法", "invalid_backend_id");
  return text || undefined;
}

/**
 * The observation entry's marker: read the stored records, act on nothing.
 *
 * Only the documented value is accepted. Silently ignoring an unrecognized
 * marker would leave a caller believing it is watching a node while the read
 * replays that node's pending deliveries on its behalf.
 */
function readOnlyRead(request: IncomingMessage): boolean {
  const value = request.headers["x-cowork-read-only"];
  if (value === undefined) return false;
  if (value !== "1") throw new HttpError(400, "只读标记格式不合法", "invalid_read_only");
  return true;
}

function reply(response: ServerResponse, status: number, body: unknown): true {
  sendJson(response, status, body);
  return true;
}

/**
 * The fixed-candidate review surface.
 *
 * Reads are project-scoped and may name a development. Writes that bind or
 * verify a work item's identity need a Main Task, so the durable queue — not
 * the request body — decides which call, agent and checkout are involved.
 */
async function handleReviewRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ports: ProjectDevelopmentRoutePorts,
  scope: {
    projectId: string;
    taskId?: string;
    scopedTaskId?: string;
    itemId?: string;
    /** An authenticated remote backend: the authority only stores its facts. */
    declared?: string;
  }
): Promise<boolean> {
  const service = ports.service;
  const task = scope.taskId ?? scope.scopedTaskId;
  const list = async (developmentId?: string) => ({
    projectId: scope.projectId,
    ...(developmentId
      ? {
          plan:
            (task
              ? await service.reviewPlanForTask(task, developmentId)
              : await service.reviewPlan(scope.projectId, developmentId)) ?? null
        }
      : {}),
    ...(developmentId
      ? {
          qualification:
            (await (
              task
                ? service.deliveryForTask(task, developmentId)
                : service.delivery(scope.projectId, developmentId)
            )
              // eslint-disable-next-line no-restricted-syntax -- 交付资格缺失是正常状态；读取失败时列表仍要返回其余字段，这里用 null 表示没有资格记录
              .catch(() => undefined)) ?? null
        }
      : {}),
    reviews: task
      ? await service.queryReviewsForTask(task, developmentId)
      : await service.queryReviews(scope.projectId, developmentId)
  });
  const requireTask = () => {
    if (!task) throw new HttpError(400, "该审查操作须来自 Main 会话", "review_task_required");
    return task;
  };

  if (request.method === "GET") {
    if (scope.itemId !== undefined) {
      const review = task
        ? await service.getReviewForTask(task, scope.itemId)
        : await service.getReview(scope.projectId, scope.itemId);
      return reply(response, 200, { review });
    }
    return reply(response, 200, await list(url.searchParams.get("developmentId") ?? undefined));
  }
  if (request.method !== "POST") throw new HttpError(405, "method not allowed");
  const body = await readJsonBody(request);
  switch (body.action) {
    case "query":
      return reply(
        response,
        200,
        await list(typeof body.developmentId === "string" ? body.developmentId : undefined)
      );
    case "get": {
      if (typeof body.reviewId !== "string") throw new HttpError(400, "get 需要 reviewId");
      const review = task
        ? await service.getReviewForTask(task, body.reviewId)
        : await service.getReview(scope.projectId, body.reviewId);
      return reply(response, 200, { review });
    }
    case "plan": {
      if (scope.declared)
        return reply(response, 200, {
          plan: await service.recordReviewPlan(scope.projectId, body.developmentId, body)
        });
      const plan = task
        ? await service.setReviewPlanForTask(task, body)
        : await service.setReviewPlan(scope.projectId, body);
      return reply(response, 200, { plan });
    }
    case "start": {
      if (scope.declared)
        return reply(response, 201, {
          review: await service.recordReview(scope.projectId, body.developmentId, body)
        });
      const review = task
        ? await service.startReviewForTask(task, body)
        : await service.startReview(scope.projectId, undefined, body);
      return reply(response, 201, { review });
    }
    case "update": {
      if (!scope.declared) throw new HttpError(403, "审查状态只能由执行后端记录", "review_owner_only");
      return reply(response, 200, {
        review: await service.recordReviewUpdate(scope.projectId, body.reviewId, body)
      });
    }
    case "attach_reviewer": {
      if (scope.declared) throw new HttpError(403, "审查须在执行后端进行", "review_owner_only");
      const review = await service.attachReviewerForTask(requireTask(), body);
      return reply(response, 200, { review });
    }
    case "record_finding": {
      if (scope.declared) throw new HttpError(403, "审查须在执行后端进行", "review_owner_only");
      const review = task
        ? await service.recordFindingForTask(task, body)
        : await service.recordFinding(scope.projectId, body);
      return reply(response, 200, { review });
    }
    case "rule_finding": {
      if (scope.declared) throw new HttpError(403, "审查须在执行后端进行", "review_owner_only");
      const review = task
        ? await service.ruleFindingForTask(task, body)
        : await service.ruleFinding(scope.projectId, body);
      return reply(response, 200, { review });
    }
    case "record_rework": {
      if (scope.declared) throw new HttpError(403, "审查须在执行后端进行", "review_owner_only");
      const review = await service.recordReworkForTask(requireTask(), body);
      return reply(response, 200, { review });
    }
    case "complete": {
      if (scope.declared) throw new HttpError(403, "审查须在执行后端进行", "review_owner_only");
      const review = task
        ? await service.completeReviewForTask(task, body)
        : await service.completeReview(scope.projectId, body);
      return reply(response, 200, { review });
    }
    case "delivery": {
      if (scope.declared) throw new HttpError(403, "审查须在执行后端进行", "review_owner_only");
      if (typeof body.developmentId !== "string") throw new HttpError(400, "delivery 需要 developmentId");
      const qualification = task
        ? await service.deliveryForTask(task, body.developmentId)
        : await service.delivery(scope.projectId, body.developmentId);
      return reply(response, 200, { qualification });
    }
    default:
      throw new HttpError(400, "未知的审查操作");
  }
}

/**
 * The project merge entry.
 *
 * A local request applies or queues the candidate through the production
 * service. An authenticated remote backend only stores the operation and the
 * claims/updates it owns; the authority never runs that backend's Git.
 */
async function handleMergeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ports: ProjectDevelopmentRoutePorts,
  scope: {
    projectId: string;
    taskId?: string;
    scopedTaskId?: string;
    itemId?: string;
    declared?: string;
    /** The observation entry's read: answer from stored records, act on nothing. */
    readOnly?: boolean;
  }
): Promise<boolean> {
  const service = ports.service;
  const task = scope.taskId ?? scope.scopedTaskId;
  const list = async (developmentId?: string) => ({
    projectId: scope.projectId,
    merges: task
      ? await service.queryMergesForTask(task, developmentId, { readOnly: scope.readOnly })
      : await service.queryMerges(scope.projectId, developmentId, { readOnly: scope.readOnly })
  });
  const one = async (mergeId: string) =>
    task ? service.getMergeForTask(task, mergeId) : service.getMerge(scope.projectId, mergeId);

  if (request.method === "GET") {
    if (scope.itemId !== undefined) return reply(response, 200, { merge: await one(scope.itemId) });
    return reply(response, 200, await list(url.searchParams.get("developmentId") ?? undefined));
  }
  if (request.method !== "POST") throw new HttpError(405, "method not allowed");
  const body = await readJsonBody(request);
  switch (body.action) {
    case "query":
      return reply(
        response,
        200,
        await list(typeof body.developmentId === "string" ? body.developmentId : undefined)
      );
    case "get": {
      if (typeof body.mergeId !== "string") throw new HttpError(400, "get 需要 mergeId");
      return reply(response, 200, { merge: await one(body.mergeId) });
    }
    case "create": {
      if (!scope.declared) throw new HttpError(403, "合入操作须由执行后端记录", "merge_owner_only");
      return reply(response, 201, {
        merge: await service.recordMerge(scope.projectId, body.developmentId, body, scope.declared)
      });
    }
    case "claim": {
      if (!scope.declared) throw new HttpError(403, "合入操作须由执行后端领取", "merge_owner_only");
      if (typeof body.mergeId !== "string") throw new HttpError(400, "claim 需要 mergeId");
      return reply(response, 200, {
        merge: await service.recordMergeClaim(scope.projectId, body.mergeId, body, scope.declared)
      });
    }
    case "update": {
      if (!scope.declared) throw new HttpError(403, "合入结果须由执行后端记录", "merge_owner_only");
      if (typeof body.mergeId !== "string") throw new HttpError(400, "update 需要 mergeId");
      return reply(response, 200, {
        merge: await service.recordMergeUpdate(scope.projectId, body.mergeId, body, scope.declared)
      });
    }
    case "request": {
      if (scope.declared) throw new HttpError(403, "合入申请须在执行主机上完成验收", "merge_owner_only");
      return reply(response, 200, {
        merge: task
          ? await service.requestMergeForTask(task, body)
          : await service.requestMerge(scope.projectId, body)
      });
    }
    case "apply": {
      if (scope.declared) throw new HttpError(403, "目标分支只能由执行后端更新", "merge_owner_only");
      return reply(response, 200, {
        merges: task ? await service.applyMergesForTask(task) : await service.applyMerges(scope.projectId)
      });
    }
    default:
      throw new HttpError(400, "未知的合入操作");
  }
}

/**
 * Delivery reads and synchronization.
 *
 * A reader gets the persisted delivery receipt and its pending/synced state,
 * including the error that stopped the last attempt, so a sync failure is
 * visible instead of disappearing. A retry re-applies that persisted row; only
 * the configured execution backend may record a new receipt, and the authority
 * still verifies it against its own merged operation.
 */
async function handleDeliveryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ports: ProjectDevelopmentRoutePorts,
  scope: {
    projectId: string;
    taskId?: string;
    scopedTaskId?: string;
    itemId?: string;
    declared?: string;
    /** The observation entry's read: answer from stored records, act on nothing. */
    readOnly?: boolean;
  }
): Promise<boolean> {
  const service = ports.service;
  const task = scope.taskId ?? scope.scopedTaskId;
  const list = async (developmentId?: string) => ({
    projectId: scope.projectId,
    deliveries: task
      ? await service.deliveriesForTask(task, developmentId, { readOnly: scope.readOnly })
      : await service.deliveries(scope.projectId, developmentId, { readOnly: scope.readOnly })
  });
  const one = async (deliveryId: string) =>
    task ? service.getDeliveryForTask(task, deliveryId) : service.getDelivery(scope.projectId, deliveryId);

  if (request.method === "GET") {
    if (scope.itemId !== undefined) return reply(response, 200, { delivery: await one(scope.itemId) });
    return reply(response, 200, await list(url.searchParams.get("developmentId") ?? undefined));
  }
  if (request.method !== "POST") throw new HttpError(405, "method not allowed");
  const body = await readJsonBody(request);
  switch (body.action) {
    case "query":
      return reply(
        response,
        200,
        await list(typeof body.developmentId === "string" ? body.developmentId : undefined)
      );
    case "get": {
      if (typeof body.deliveryId !== "string") throw new HttpError(400, "get 需要 deliveryId");
      return reply(response, 200, { delivery: await one(body.deliveryId) });
    }
    case "view": {
      const view = task
        ? await service.deliveryViewForTask(task, body, { readOnly: scope.readOnly })
        : await service.deliveryView(scope.projectId, body, { readOnly: scope.readOnly });
      return reply(response, 200, { view });
    }
    case "diff": {
      // The patch is read from the checkout this backend owns. A remote
      // reader asks its own execution host, so the authority never runs Git
      // against another backend's directory.
      if (scope.declared) throw new HttpError(403, "diff 只能在需求现场所在后端读取", "delivery_owner_only");
      const patch = task
        ? await service.deliveryPatchForTask(task, body, { readOnly: scope.readOnly })
        : await service.deliveryPatch(scope.projectId, body, { readOnly: scope.readOnly });
      return reply(response, 200, { diff: patch });
    }
    case "retry": {
      if (typeof body.deliveryId === "string") {
        const delivery = task
          ? await service.retryDeliveryForTask(task, body.deliveryId)
          : await service.retryDelivery(scope.projectId, body.deliveryId);
        return reply(response, 200, { delivery });
      }
      if (typeof body.developmentId === "string") {
        const delivery = task
          ? await service.retryDevelopmentDeliveryForTask(task, body.developmentId)
          : await service.retryDevelopmentDelivery(scope.projectId, body.developmentId);
        return reply(response, 200, { delivery });
      }
      throw new HttpError(400, "retry 需要 deliveryId 或 developmentId");
    }
    case "sync": {
      if (!scope.declared) throw new HttpError(403, "交付同步须由执行后端记录", "delivery_owner_only");
      return reply(response, 200, {
        delivery: await service.recordDelivery(scope.projectId, body.receipt, scope.declared)
      });
    }
    default:
      throw new HttpError(400, "未知的交付操作");
  }
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
  const readOnly = readOnlyRead(request);
  const backendId = declared ?? ports.backendId;
  let projectId: string;
  let taskId: string | undefined;
  let scopedTaskId: string | undefined;
  if (projectMatch) {
    projectId = decodeURIComponent(projectMatch[1]);
    const scopedTask = request.headers["x-cowork-task-id"];
    if (scopedTask !== undefined) {
      const task = typeof scopedTask === "string" ? scopedTask : "";
      // eslint-disable-next-line no-restricted-syntax -- 请求头的任务可能在本机目录里查不到，绑定查询失败按不匹配处理，下面回 403 不越权读取别的项目
      const bound = task ? await ports.taskProject(task).catch(() => undefined) : undefined;
      if (!bound || bound.projectId !== projectId)
        throw new HttpError(403, "开发记录只能访问当前会话所属项目", "project_scope_denied");
      scopedTaskId = task;
    }
  } else {
    taskId = decodeURIComponent(taskMatch![1]);
    // eslint-disable-next-line no-restricted-syntax -- 任务目录被清理后绑定查询会失败，此时该任务不归属任何项目，下面按未绑定回 404
    const bound = await ports.taskProject(taskId).catch(() => undefined);
    if (!bound) throw new HttpError(404, "会话不属于任何项目", "project_unbound");
    projectId = bound.projectId;
  }
  const itemId =
    projectMatch?.[3] !== undefined
      ? decodeURIComponent(projectMatch[3])
      : taskMatch?.[3] !== undefined
        ? decodeURIComponent(taskMatch[3])
        : undefined;
  const kind = (projectMatch?.[2] ?? taskMatch?.[2] ?? "developments") as
    "developments" | "merge-config" | "reviews" | "merges" | "deliveries";

  if (kind === "deliveries") {
    return handleDeliveryRequest(request, response, url, ports, {
      projectId,
      taskId,
      scopedTaskId,
      itemId,
      declared,
      readOnly
    });
  }

  if (kind === "reviews") {
    return handleReviewRequest(request, response, url, ports, {
      projectId,
      taskId,
      scopedTaskId,
      itemId,
      declared
    });
  }

  if (kind === "merges") {
    return handleMergeRequest(request, response, url, ports, {
      projectId,
      taskId,
      scopedTaskId,
      itemId,
      declared,
      readOnly
    });
  }

  if (kind === "merge-config") {
    if (taskId !== undefined) return false;
    if (request.method === "GET")
      return reply(response, 200, { mergeConfig: (await ports.service.mergeConfig(projectId)) ?? null });
    if (request.method !== "POST") throw new HttpError(405, "method not allowed");
    const body = await readJsonBody(request);
    const input = {
      repository: body.repository,
      targetBranch: body.targetBranch,
      // A remote backend configures the entry it can reach; a local request
      // defaults to the serving backend.
      executionBackendId: body.executionBackendId ?? declared
    };
    // An authenticated remote backend already checked its own repository. The
    // authority stores the shared entry and never executes or validates a path
    // that belongs to another host's checkout.
    return reply(response, 200, {
      mergeConfig: declared
        ? await ports.service.recordMergeConfig(projectId, input, declared)
        : await ports.service.setMergeConfig(projectId, input)
    });
  }

  if (request.method === "GET") {
    if (itemId !== undefined)
      return reply(response, 200, {
        development: taskId
          ? await ports.service.getForTask(taskId, itemId, backendId, { readOnly })
          : await ports.service.get(projectId, itemId, backendId, { readOnly })
      });
    return reply(response, 200, {
      projectId,
      developments: taskId
        ? await ports.service.listForTask(taskId, backendId, { readOnly })
        : await ports.service.list(projectId, backendId, { readOnly })
    });
  }
  if (request.method !== "POST") throw new HttpError(405, "method not allowed");
  const body = await readJsonBody(request);
  try {
    switch (body.action) {
      case "query":
        return reply(response, 200, {
          projectId,
          developments: taskId
            ? await ports.service.listForTask(taskId, backendId, { readOnly })
            : await ports.service.list(projectId, backendId, { readOnly })
        });
      case "get": {
        if (typeof body.developmentId !== "string") throw new HttpError(400, "get 需要 developmentId");
        return reply(response, 200, {
          development: taskId
            ? await ports.service.getForTask(taskId, body.developmentId, backendId, { readOnly })
            : await ports.service.get(projectId, body.developmentId, backendId, { readOnly })
        });
      }
      case "create":
        // A remote backend owns the repository and the checkout; the authority
        // only records the shared fact it validated and never prepares a
        // workspace in another host's data root.
        if (declared)
          return reply(response, 201, {
            development: await ports.service.record(projectId, taskId ? { ...body, taskId } : body)
          });
        return reply(response, 201, {
          development: taskId
            ? await ports.service.createForTask(taskId, body)
            : await ports.service.create(projectId, body)
        });
      case "update": {
        if (typeof body.developmentId !== "string") throw new HttpError(400, "update 需要 developmentId");
        return reply(response, 200, {
          development: taskId
            ? await ports.service.updateForTask(taskId, body.developmentId, body, backendId)
            : await ports.service.update(projectId, body.developmentId, body, backendId)
        });
      }
      case "ensure_workspace": {
        // Continuing a checkout is an execution-host action. The authority must
        // not run Git against a repository that belongs to another backend.
        if (declared)
          throw new HttpError(403, "需求现场只能在执行后端继续", "development_workspace_owner_only");
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
          ? await ports.service.findForTask(taskId, body.requirementId, backendId, { readOnly })
          : await ports.service.find(projectId, body.requirementId, backendId, { readOnly });
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
