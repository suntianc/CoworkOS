import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { applicationServiceForTask } from "../applications/task-service.js";

/** Structured ownership of relative file tools and bound application tools. */
export interface MainRequestExecutionScope {
  version: 1;
  taskStorageRoot: string;
  projectDirectory: string;
  application: null | {
    resourceId: string;
    appType: string;
    appInstanceId?: string;
    resourceWorkspaceRoot: string;
    resourcePath: string;
    adapterTools: string[];
    mcpTools: string[];
  };
}

type BoundApplication = {
  resourceId: string;
  appType: string;
  appInstanceId?: string;
  resourcePath: string;
  tools: readonly { name: string }[];
};

export async function mainRequestExecutionScope(input: {
  taskStorageRoot: string;
  projectDirectory: string;
  resourceWorkspaceRoot: string;
  application?: BoundApplication;
  mcpTools?: readonly { name: string }[];
}): Promise<MainRequestExecutionScope> {
  const application = input.application;
  return {
    version: 1,
    taskStorageRoot: await realpath(input.taskStorageRoot),
    projectDirectory: await realpath(input.projectDirectory),
    application: application
      ? {
          resourceId: application.resourceId,
          appType: application.appType,
          ...(application.appInstanceId ? { appInstanceId: application.appInstanceId } : {}),
          resourceWorkspaceRoot: await realpath(input.resourceWorkspaceRoot),
          resourcePath: await realpath(application.resourcePath),
          adapterTools: application.tools.map((tool) => tool.name).sort(),
          mcpTools: (input.mcpTools ?? []).map((tool) => tool.name).sort()
        }
      : null
  };
}

export async function currentMainRequestExecutionScope(input: {
  taskStorageRoot: string;
  taskId: string;
  projectDirectory: string;
}): Promise<MainRequestExecutionScope> {
  const service = await applicationServiceForTask(input.taskStorageRoot, input.taskId);
  const application = await service.boundCapabilities({ taskId: input.taskId, agentId: "main" });
  const owner = application
    ? await service.serviceForResource(input.taskId, application.resourceId)
    : service;
  const resource = application
    ? await owner.readResource(input.taskId, application.resourceId, { limit: 1 })
    : undefined;
  return mainRequestExecutionScope({
    ...input,
    resourceWorkspaceRoot: owner.resourceWorkspaceRoot,
    application:
      application && resource
        ? { ...application, resourcePath: owner.resources.absolutePath(resource.resource) }
        : undefined
  });
}

export function validMainRequestExecutionScope(value: unknown): value is MainRequestExecutionScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as MainRequestExecutionScope;
  const names = (entries: unknown): entries is string[] =>
    Array.isArray(entries) && entries.every((name) => typeof name === "string" && name.length > 0);
  const app = scope.application;
  return Boolean(
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- value 是重试快照里的 unknown 载荷，声明为 MainRequestExecutionScope 只是断言
    scope.version === 1 &&
    typeof scope.taskStorageRoot === "string" &&
    isAbsolute(scope.taskStorageRoot) &&
    typeof scope.projectDirectory === "string" &&
    isAbsolute(scope.projectDirectory) &&
    (app === null ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 归属记录来自旧版本持久化 JSON，application 字段可能整体缺失，此时应返回 false 而不是读取 undefined
      (app &&
        typeof app.resourceId === "string" &&
        app.resourceId.length > 0 &&
        typeof app.appType === "string" &&
        app.appType.length > 0 &&
        (app.appInstanceId === undefined || typeof app.appInstanceId === "string") &&
        typeof app.resourceWorkspaceRoot === "string" &&
        isAbsolute(app.resourceWorkspaceRoot) &&
        typeof app.resourcePath === "string" &&
        isAbsolute(app.resourcePath) &&
        names(app.adapterTools) &&
        names(app.mcpTools)))
  );
}

export function assertMainRequestExecutionScope(
  original: MainRequestExecutionScope | undefined,
  current: MainRequestExecutionScope,
  { checkMcpTools = true } = {}
): void {
  if (!original)
    throw new Error("原请求缺少执行归属记录，无法安全重试。原请求、历史和草稿已保留，请主动发送新消息。");
  const comparable = (scope: MainRequestExecutionScope) => ({
    version: scope.version,
    taskStorageRoot: scope.taskStorageRoot,
    projectDirectory: scope.projectDirectory,
    application: scope.application
      ? {
          resourceId: scope.application.resourceId,
          appType: scope.application.appType,
          appInstanceId: scope.application.appInstanceId,
          resourceWorkspaceRoot: scope.application.resourceWorkspaceRoot,
          resourcePath: scope.application.resourcePath,
          adapterTools: [...scope.application.adapterTools].sort(),
          mcpTools: checkMcpTools ? [...scope.application.mcpTools].sort() : []
        }
      : null
  });
  if (JSON.stringify(comparable(original)) !== JSON.stringify(comparable(current)))
    throw new Error(
      "原请求的工作目录或应用资源归属已改变，不能重发到新目标。请恢复原绑定与目录后重试；原请求、历史和草稿已保留。"
    );
}
