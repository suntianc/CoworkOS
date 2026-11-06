import { MainMessageEditConflict, type EditTextFile } from "../runtime/main-message-edit.js";
import { readFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { type ApplicationEvent } from "../applications/application-service.js";
import { taskApplicationProject } from "../applications/project-context.js";
import { taskApplicationWorkspace } from "../applications/task-service.js";
import { McpSupervisor } from "../applications/mcp-supervisor.js";
import { handleApplicationRequest } from "./application-routes.js";
import { handleProjectExperienceRequest } from "./project-experience-routes.js";
import type { ProjectExperienceStore } from "../runtime/project-experience-store.js";
import { handleUserMemoryRequest } from "./user-memory-routes.js";
import type { UserMemoryStore } from "../runtime/user-memory-store.js";
import { serveArtifact } from "./artifact-response.js";
import { dashboardContentPolicy, HttpError, localRequestUrl, readJsonBody, sendJson } from "./http.js";
import { id } from "../domain/types.js";
import { readAgentTrajectory } from "../runtime/agent-trajectory.js";
import { CoordinatorRuntime } from "../runtime/coordinator-runtime.js";
import { HumanRequestStore } from "../runtime/human.js";
import { SubagentQuestionStore } from "../runtime/subagent-questions.js";
import { WatcherRuntime } from "../runtime/watcher.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { ProjectCatalogError } from "../workspace/project-catalog.js";
import { MainRequestConflictError } from "../runtime/main-request-retry.js";
import { MainRequestSnapshotError } from "../storage/main-request-store.js";
import { readJsonFile, streamRunEvents } from "./event-stream.js";
import { InputStore, inputPrompt } from "../workspace/input-store.js";
import { handleUploadRequest } from "./upload-routes.js";
import { handleComputerRequest } from "./computer-routes.js";
import type { ComputerUse } from "../gui/computer-use.js";

import { handleGoalRequest } from "./goal-routes.js";
import type { createGoalService } from "./goal-service.js";
import type { createWatchService } from "./watch-service.js";
import type { WatchCreation } from "../runtime/watch-management.js";
import type { createWebSearchSettings } from "./web-search-settings.js";
import type { createScienceSettings } from "./science-settings.js";
import { handleScienceSettingsRequest } from "./science-settings-routes.js";
import type { createModelSettings } from "./model-settings.js";
import type { createDashboardRunService, RunServicePorts } from "./run-service.js";
import type { createWorkspaceDirectory } from "./workspace-directory.js";
import { normalizeReasoningEffort } from "../runtime/runtime-settings.js";

type WorkspaceDirectory = ReturnType<typeof createWorkspaceDirectory>;
type RunService = ReturnType<typeof createDashboardRunService>;
export interface DashboardRoutePorts {
  userMemory?: UserMemoryStore;
  backendInfo(): { backendId: string; pid: number; startedAt: string };
  projectExperienceStore?: (projectId: string) => Promise<ProjectExperienceStore | undefined>;
  watchers?: ReturnType<typeof createWatchService>;
  goals?: ReturnType<typeof createGoalService>;
  uploads?: InputStore;
  computer: ComputerUse;
  dashboardUrl: string;
  uiRoot: string;
  webSearchSettings: ReturnType<typeof createWebSearchSettings>;
  scienceSettings: ReturnType<typeof createScienceSettings>;
  modelSettings: ReturnType<typeof createModelSettings>;
  tabStorePath: string;
  workspaceRoot(): string;
  globalTaskPayload: WorkspaceDirectory["globalTaskPayload"];
  locateTask: WorkspaceDirectory["locateTask"];
  taskListItem: WorkspaceDirectory["taskListItem"];
  knownWorkspaceRoots: WorkspaceDirectory["knownWorkspaceRoots"];
  applicationWorkspaceRoots: WorkspaceDirectory["applicationWorkspaceRoots"];
  applicationProjectForRoot: WorkspaceDirectory["applicationProjectForRoot"];
  applicationProjectForId: WorkspaceDirectory["applicationProjectForId"];
  locateResource(resourceId: string): Promise<{ workspaceRoot: string }>;
  publishApplicationEvent(taskId: string, event: ApplicationEvent): Promise<void>;
  publishToReferencers(resourceId: string, event: ApplicationEvent): Promise<void>;
  mcpSupervisor: McpSupervisor;
  availableModels(): Promise<string[]>;
  chooseLocalDirectory(): Promise<string | undefined>;
  resolveWorkspacePath(value: unknown): Promise<string>;
  registerWorkspace(root: string): Promise<void>;
  switchWorkspace(root: string): Promise<void>;
  createProject: WorkspaceDirectory["createProject"];
  updateProject(
    projectId: string,
    input: { projectName?: unknown; projectDirectory?: unknown }
  ): Promise<unknown>;
  createProjectTask: WorkspaceDirectory["createProjectTask"];
  createTemporaryTask: WorkspaceDirectory["createTemporaryTask"];
  createTemporaryWorkspace: WorkspaceDirectory["createTemporaryWorkspace"];
  withApplicationProjectLock: WorkspaceDirectory["withApplicationProjectLock"];
  normalizeModel(value: unknown): string | undefined;
  runtimeValue: RunServicePorts["runtimeValue"];
  startMainRun: RunService["startMainRun"];
  editMainMessage: RunService["editMainMessage"];
  messageVersion(taskId: string, versionId: string): Promise<unknown>;
  activeRuns: RunService["activeRuns"];
  cancelTask: RunService["cancelTask"];
  queuedMessageAction: RunService["queuedMessageAction"];
  queueInterjection: RunService["queueInterjection"];
  interjectionTarget: RunService["interjectionTarget"];
  resumeHumanAnswers: RunService["resumeHumanAnswers"];
  coordinator: CoordinatorRuntime;
  taskDetails(taskId: string): Promise<unknown>;
  appendRunEvent: RunServicePorts["appendRunEvent"];
}

/** HTTP validation and response mapping; all durable work is delegated to services. */
export function createDashboardHandler(
  ports: DashboardRoutePorts
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const {
    dashboardUrl,
    uiRoot,
    globalTaskPayload,
    locateTask,
    locateResource,
    knownWorkspaceRoots,
    publishApplicationEvent,
    publishToReferencers,
    tabStorePath,
    mcpSupervisor,
    availableModels,
    chooseLocalDirectory,
    resolveWorkspacePath,
    normalizeModel,
    runtimeValue,
    startMainRun,
    activeRuns,
    cancelTask,
    resumeHumanAnswers,
    coordinator,
    taskDetails,
    taskListItem,
    appendRunEvent
  } = ports;
  return async (request, response) => {
    try {
      const url = localRequestUrl(request, dashboardUrl);
      // Identity read-only: a host uses it to confirm that the process it
      // recorded is the one answering here, never to learn configuration.
      if (request.method === "GET" && url.pathname === "/api/backend") {
        sendJson(response, 200, ports.backendInfo());
        return;
      }
      // Bind desktop request epochs before any awaited router can cross a
      // stop/revoke/resume boundary while this request is still being admitted.
      if (await handleComputerRequest(request, response, url, ports.computer, locateTask)) return;
      if (
        ports.projectExperienceStore &&
        (await handleProjectExperienceRequest(request, response, url, ports.projectExperienceStore))
      )
        return;
      if (ports.userMemory && (await handleUserMemoryRequest(request, response, url, ports.userMemory)))
        return;
      if (ports.uploads && (await handleUploadRequest(request, response, url, ports.uploads))) return;
      if (request.method === "GET" && url.pathname === "/") {
        const html = await readFile(join(uiRoot, "index.html"), "utf8");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
          "content-security-policy": dashboardContentPolicy,
          "x-content-type-options": "nosniff"
        });
        response.end(html);
        return;
      }
      if (
        request.method === "GET" &&
        (url.pathname === "/styles.css" || url.pathname === "/app.js" || url.pathname.startsWith("/assets/"))
      ) {
        const asset = await readFile(join(uiRoot, url.pathname.slice(1)));
        const extension = url.pathname.slice(url.pathname.lastIndexOf(".")).toLowerCase();
        const contentType =
          (
            {
              ".css": "text/css; charset=utf-8",
              ".js": "text/javascript; charset=utf-8",
              ".html": "text/html; charset=utf-8",
              ".json": "application/json",
              ".svg": "image/svg+xml",
              ".png": "image/png",
              ".jpg": "image/jpeg",
              ".jpeg": "image/jpeg",
              ".webp": "image/webp",
              ".gif": "image/gif",
              ".ico": "image/x-icon",
              ".woff": "font/woff",
              ".woff2": "font/woff2",
              ".ttf": "font/ttf",
              ".gz": "application/gzip",
              ".txt": "text/plain; charset=utf-8"
            } as Record<string, string>
          )[extension] ?? "application/octet-stream";
        response.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
        response.end(asset);
        return;
      }
      if (
        ports.goals &&
        ports.watchers &&
        (await handleGoalRequest(request, response, url, ports.goals, ports.watchers.health()))
      )
        return;
      if (ports.watchers && request.method === "GET" && url.pathname === "/api/monitors") {
        sendJson(response, 200, await ports.watchers.all());
        return;
      }
      if (ports.watchers && request.method === "POST" && url.pathname === "/api/monitors") {
        const body = await readJsonBody(request);
        const result = await ports.watchers.createStandalone(body as unknown as WatchCreation);
        sendJson(response, result.activated ? 201 : 422, result);
        return;
      }
      const monitorMatch = url.pathname.match(
        /^\/api\/tasks\/([^/]+)\/monitors(?:\/([^/]+)(?:\/(events|control))?)?$/
      );
      if (ports.watchers && monitorMatch) {
        const taskId = decodeURIComponent(monitorMatch[1]);
        const monitorId = monitorMatch[2] ? decodeURIComponent(monitorMatch[2]) : undefined;
        if (request.method === "GET" && monitorId && monitorMatch[3] === "events") {
          sendJson(response, 200, { events: await ports.watchers.events(taskId, monitorId) });
          return;
        }
        if (request.method === "GET" && !monitorId) {
          sendJson(response, 200, await ports.watchers.list(taskId));
          return;
        }
        if (request.method === "POST" && monitorId && monitorMatch[3] === "control") {
          const body = await readJsonBody(request);
          sendJson(response, 200, await ports.watchers.control(taskId, monitorId, String(body.action), body));
          return;
        }
        if (request.method === "POST" && !monitorId) {
          const body = await readJsonBody(request);
          const result = await ports.watchers.create(taskId, body as unknown as WatchCreation);
          sendJson(response, result.activated ? 201 : 422, result);
          return;
        }
        sendJson(response, 405, { error: "method not allowed" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/tasks") {
        sendJson(response, 200, {
          ...(await globalTaskPayload()),
          connectionProfileId: ports.modelSettings.status().activeProfileId
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/projects/choose-directory") {
        const directory = await chooseLocalDirectory();
        sendJson(response, 200, {
          cancelled: !directory,
          ...(directory ? { projectDirectory: directory } : {})
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/projects") {
        const body = await readJsonBody(request);
        sendJson(response, 201, {
          project: await ports.createProject({
            projectName: body.projectName,
            projectDirectory: body.projectDirectory
          })
        });
        return;
      }
      const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (request.method === "PATCH" && projectMatch) {
        const body = await readJsonBody(request);
        sendJson(response, 200, {
          project: await ports.updateProject(decodeURIComponent(projectMatch[1]), {
            projectName: body.projectName,
            projectDirectory: body.projectDirectory
          })
        });
        return;
      }
      // Register an application destination without switching or moving any conversation.
      if (url.pathname === "/api/workbench/workspaces" && request.method === "GET") {
        sendJson(response, 200, {
          workspaces: await (ports.applicationWorkspaceRoots ?? knownWorkspaceRoots)()
        });
        return;
      }
      if (url.pathname === "/api/workbench/workspaces" && request.method === "POST") {
        const body = await readJsonBody(request);
        const root =
          body.workspaceRoot === undefined
            ? await chooseLocalDirectory()
            : await resolveWorkspacePath(body.workspaceRoot);
        if (root) await ports.registerWorkspace(root);
        sendJson(response, 200, {
          cancelled: !root,
          workspaceRoot: root,
          workspaces: await knownWorkspaceRoots()
        });
        return;
      }
      // Mounted before the Task routes so a resource path is never mistaken for one.
      if (
        await handleApplicationRequest(request, response, url, {
          locate: async (taskId) => {
            const location = await locateTask(taskId);
            return {
              workspaceRoot: await taskApplicationWorkspace(location.workspaceRoot, taskId),
              taskStorageRoot: location.workspaceRoot,
              projectDirectory: location.projectDirectory,
              project: await taskApplicationProject(location.workspaceRoot, taskId),
              activeRunId: location.task.activeRunId
            };
          },
          locateResource,
          workspaceRoots: ports.applicationWorkspaceRoots,
          projectForWorkspace: ports.applicationProjectForRoot,
          createTemporaryWorkspace: ports.createTemporaryWorkspace,
          resolveSaveDirectory: ports.resolveWorkspacePath,
          withProjectLock: ports.withApplicationProjectLock,
          projectForId: ports.applicationProjectForId,
          resolveWorkspace: async (value) => {
            const root = await resolveWorkspacePath(value);
            await ports.registerWorkspace(root);
            return root;
          },
          referencingTasks: async () => {
            const found = new Set<string>();
            for (const root of await knownWorkspaceRoots()) {
              for (const task of await new LocalWorkspaceStore(root).listTasks().catch(() => []))
                found.add(task.taskId);
            }
            return [...found];
          },
          publish: publishApplicationEvent,
          publishToReferencers,
          // Global, beside the workspace catalog: the strip spans every task, so it
          // cannot live inside any one of them.
          tabStorePath,
          defaultWorkspaceRoot: ports.workspaceRoot(),
          mcp: mcpSupervisor
        })
      )
        return;
      if (await handleScienceSettingsRequest(request, response, url, ports.scienceSettings)) return;
      if (url.pathname === "/api/web-search-settings") {
        if (request.method === "GET") sendJson(response, 200, ports.webSearchSettings.status());
        else if (request.method === "POST")
          sendJson(response, 200, await ports.webSearchSettings.save(await readJsonBody(request)));
        else sendJson(response, 405, { error: "method not allowed" });
        return;
      }
      if (url.pathname === "/api/model-settings/test" && request.method === "POST") {
        sendJson(response, 200, await ports.modelSettings.test(await readJsonBody(request)));
        return;
      }
      if (url.pathname === "/api/model-settings") {
        if (request.method === "GET") sendJson(response, 200, ports.modelSettings.status());
        else if (request.method === "POST")
          sendJson(response, 200, await ports.modelSettings.save(await readJsonBody(request)));
        else sendJson(response, 405, { error: "method not allowed" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/models") {
        sendJson(response, 200, {
          current: runtimeValue("COWORK_MODEL"),
          connectionProfileId: ports.modelSettings.status().activeProfileId,
          models: await availableModels(),
          configured: Boolean(runtimeValue("COWORK_API_BASE") && runtimeValue("COWORK_API_KEY"))
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/workspace/choose") {
        const body = await readJsonBody(request);
        if (body.taskId !== undefined) {
          sendJson(response, 410, { error: "会话级文件夹设置已移至项目，请在项目设置中更改文件夹。" });
          return;
        }
        const root =
          body.workspaceRoot === undefined
            ? await chooseLocalDirectory()
            : await resolveWorkspacePath(body.workspaceRoot);
        if (root) await ports.switchWorkspace(root);
        sendJson(response, 200, { cancelled: !root, ...(await globalTaskPayload()) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/tasks") {
        const body = await readJsonBody(request);
        const goal = typeof body.goal === "string" ? body.goal.trim() : "";
        if (goal.includes("\0")) throw new Error("消息包含不支持的二进制字符");
        if (!goal) throw new Error("goal must not be empty");
        const requested = typeof body.taskId === "string" ? body.taskId : id("task");
        if (!/^[a-zA-Z0-9._-]+$/.test(requested)) throw new Error("unsafe task id");
        if (body.temporary === true || body.projectId === null) {
          if (
            body.workspaceRoot !== undefined ||
            body.projectDirectory !== undefined ||
            body.projectId != null
          )
            throw new Error("临时会话不能同时指定项目或目录");
          sendJson(
            response,
            201,
            await ports.createTemporaryTask(
              requested,
              { goal: goal.slice(0, 4_000) },
              body.temporaryWorkspaceRoot
            )
          );
          return;
        }
        if (body.temporary !== undefined && body.temporary !== false)
          throw new Error("temporary 必须是布尔值");
        if (body.temporaryWorkspaceRoot !== undefined) throw new Error("临时工作区仅用于临时会话");
        if (body.projectId !== undefined) {
          if (typeof body.projectId !== "string" || !body.projectId.trim())
            throw new Error("projectId 必须是非空字符串");
          if (body.workspaceRoot !== undefined || body.projectDirectory !== undefined)
            throw new Error("会话继承项目文件夹，请在项目设置中更改");
          sendJson(
            response,
            201,
            await ports.createProjectTask(requested, body.projectId, { goal: goal.slice(0, 4_000) })
          );
          return;
        }
        if (body.projectDirectory !== undefined) throw new Error("会话文件夹设置已移至项目");
        const root =
          body.workspaceRoot === undefined
            ? ports.workspaceRoot()
            : await resolveWorkspacePath(body.workspaceRoot);
        await ports.registerWorkspace(root);
        const taskStore = new LocalWorkspaceStore(root);
        await taskStore.createTask(requested, { goal: goal.slice(0, 4_000) });
        const location = await locateTask(requested);
        sendJson(response, 201, taskListItem(location));
        return;
      }
      const streamMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/stream$/);
      if (request.method === "GET" && streamMatch) {
        const taskId = decodeURIComponent(streamMatch[1]);
        const location = await locateTask(taskId);
        const task = location.task;
        if (!task.activeRunId) {
          sendJson(response, 409, { error: "Task has no active run" });
          return;
        }
        streamRunEvents(request, response, taskId, task.activeRunId, location.workspaceRoot);
        return;
      }
      const editMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/messages\/edit$/);
      if (request.method === "POST" && editMatch) {
        const taskId = decodeURIComponent(editMatch[1]);
        const body = await readJsonBody(request);
        if (
          typeof body.body !== "string" ||
          body.body.includes("\0") ||
          ![body.messageId, body.versionId, body.runId].every(
            (value) => typeof value === "string" && /^[a-zA-Z0-9._-]{1,160}$/.test(value)
          ) ||
          typeof body.editId !== "string" ||
          !/^[a-f0-9-]{36}$/.test(body.editId) ||
          typeof body.scopeToken !== "string" ||
          !/^[a-f0-9]{64}$/.test(body.scopeToken) ||
          !Array.isArray(body.attachmentIds) ||
          body.attachmentIds.length > 10 ||
          body.attachmentIds.some((id) => typeof id !== "string" || !/^upload-[a-f0-9-]{36}$/.test(id))
        )
          throw new HttpError(400, "编辑请求或附件引用无效。");
        const textAttachments = body.textAttachments ?? [];
        if (
          !Array.isArray(textAttachments) ||
          textAttachments.length > 3 ||
          textAttachments.length + (body.attachmentIds as string[]).length > 10 ||
          textAttachments.some(
            (file) =>
              !file ||
              typeof file.name !== "string" ||
              !file.name ||
              /[\\/\0\r\n]/.test(file.name) ||
              file.name.length > 240 ||
              typeof file.text !== "string" ||
              /[\x00-\x08\x0e-\x1f]/.test(file.text) ||
              Buffer.byteLength(file.text, "utf8") > 128 * 1024
          )
        )
          throw new HttpError(400, "文本附件无效或超过 128 KB。");
        sendJson(
          response,
          202,
          await ports.editMainMessage(
            taskId,
            {
              scopeToken: body.scopeToken,
              messageId: body.messageId as string,
              versionId: body.versionId as string,
              runId: body.runId as string,
              editId: body.editId
            },
            body.body,
            body.attachmentIds as string[],
            body.model === undefined ? undefined : normalizeModel(body.model),
            textAttachments.map((file) => ({
              name: file.name,
              text: file.text,
              size: Buffer.byteLength(file.text, "utf8")
            })) as EditTextFile[]
          )
        );
        return;
      }
      const runMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/run$/);
      if (request.method === "POST" && runMatch) {
        const taskId = decodeURIComponent(runMatch[1]);
        const body = await readJsonBody(request);
        if (
          body.retryRequestId !== undefined &&
          (typeof body.retryRequestId !== "string" ||
            !/^[a-f0-9-]{36}$/.test(body.retryRequestId) ||
            body.resume !== true ||
            body.prompt !== undefined ||
            body.thinkingLevel !== undefined ||
            (body.attachmentIds !== undefined &&
              (!Array.isArray(body.attachmentIds) || body.attachmentIds.length > 0)))
        )
          throw new HttpError(400, "重试只能引用已保存的失败请求，不能附加新消息或附件。");
        let prompt = typeof body.prompt === "string" ? body.prompt : "";
        if (ports.uploads && body.attachmentIds !== undefined) {
          const location = await locateTask(taskId);
          const files = await ports.uploads.attach(location.workspaceRoot, taskId, body.attachmentIds);
          prompt += inputPrompt(join(location.workspaceRoot, taskId), files);
        }
        const runId = typeof body.runId === "string" ? body.runId : undefined;
        const model = body.model === undefined ? undefined : normalizeModel(body.model);
        const thinkingLevel =
          body.thinkingLevel === undefined
            ? undefined
            : normalizeReasoningEffort(body.thinkingLevel, "thinkingLevel");
        sendJson(
          response,
          202,
          await startMainRun(
            taskId,
            prompt,
            runId,
            body.resume === true,
            model,
            body.retryRequestId as string | undefined,
            {
              body: typeof body.body === "string" ? body.body : undefined,
              ...(thinkingLevel ? { thinkingLevel } : {})
            }
          )
        );
        return;
      }
      const versionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/message-versions\/([^/]+)$/);
      if (request.method === "GET" && versionMatch) {
        const versionId = decodeURIComponent(versionMatch[2]);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(versionId))
          throw new HttpError(400, "消息版本标识无效。");
        const version = await ports.messageVersion(decodeURIComponent(versionMatch[1]), versionId);
        if (!version) throw new HttpError(404, "消息版本不存在。");
        sendJson(response, 200, version);
        return;
      }
      const humanAnswerMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/human\/([^/]+)\/answer$/);
      if (request.method === "POST" && humanAnswerMatch) {
        const taskId = decodeURIComponent(humanAnswerMatch[1]);
        const requestId = decodeURIComponent(humanAnswerMatch[2]);
        const location = await locateTask(taskId);
        const human = new HumanRequestStore(location.workspaceRoot);
        const question = await human.read(taskId, requestId);
        if (question.runId !== location.task.activeRunId || location.task.status === "cancelled") {
          sendJson(response, 409, { error: "该问题所属运行已变更或取消，请刷新任务。" });
          return;
        }
        const body = await readJsonBody(request);
        if (typeof body.answer !== "string" || !body.answer.trim()) throw new Error("请先选择选项或填写回答");
        const result = await human.submitAnswer(taskId, requestId, body.answer);
        await appendRunEvent(location.workspaceRoot, taskId, question.runId, "human.answer_submitted", {
          requestId
        });
        const resume = await resumeHumanAnswers(taskId);
        sendJson(response, 200, { request: result.request, resume });
        return;
      }
      // Running messages either steer the next model call or follow the current turn.
      const queuedMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/interject\/([^/]+)\/(steer|cancel)$/);
      if (request.method === "POST" && queuedMatch) {
        const result = await ports.queuedMessageAction(
          decodeURIComponent(queuedMatch[1]),
          decodeURIComponent(queuedMatch[2]),
          queuedMatch[3] === "cancel" ? "cancel" : "send"
        );
        sendJson(response, result.error ? 409 : 200, result);
        return;
      }
      const interjectMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/interject$/);
      if (request.method === "POST" && interjectMatch) {
        const taskId = decodeURIComponent(interjectMatch[1]);
        const target = ports.interjectionTarget(taskId);
        if (!target) {
          sendJson(response, 409, { error: "当前没有正在运行的回合，直接发送消息即可。" });
          return;
        }
        const location = await locateTask(taskId);
        if (target.runId !== location.task.activeRunId) {
          sendJson(response, 409, { error: "该消息所属回合已变更，请确认当前会话后重新发送。" });
          return;
        }
        const body = await readJsonBody(request);
        const delivery = body.delivery ?? "steer";
        if (delivery !== "steer" && delivery !== "followUp")
          throw new Error("消息发送方式须为 steer 或 followUp");
        let message = typeof body.message === "string" ? body.message.trim() : "";
        if (ports.uploads && body.attachmentIds !== undefined) {
          const files = await ports.uploads.attach(location.workspaceRoot, taskId, body.attachmentIds);
          message += inputPrompt(join(location.workspaceRoot, taskId), files);
        }
        const result = await ports.queueInterjection(taskId, target, message, delivery);
        sendJson(response, result.error ? 409 : 202, result);
        return;
      }
      const humanResumeMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/human\/resume$/);
      if (request.method === "POST" && humanResumeMatch) {
        sendJson(response, 200, await resumeHumanAnswers(decodeURIComponent(humanResumeMatch[1])));
        return;
      }
      const eventMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/events$/);
      if (request.method === "POST" && eventMatch) {
        const taskId = decodeURIComponent(eventMatch[1]);
        const location = await locateTask(taskId);
        const task = location.task;
        if (!task.activeRunId) {
          sendJson(response, 409, { error: "Task has no active run" });
          return;
        }
        const body = await readJsonBody(request);
        const result = await new WatcherRuntime({
          workspaceRoot: location.workspaceRoot,
          taskId,
          runId: task.activeRunId
        }).ingest({
          watcherId: typeof body.watcherId === "string" ? body.watcherId : "dashboard",
          source: typeof body.source === "string" ? body.source : "dashboard",
          type: typeof body.type === "string" ? body.type : "external.event",
          dedupeKey: typeof body.dedupeKey === "string" ? body.dedupeKey : `dashboard-${Date.now()}`,
          payload: body.payload ?? {}
        });
        let wake;
        if (body.wake === true && !activeRuns.has(taskId) && !result.duplicate) {
          try {
            wake = await startMainRun(
              taskId,
              [
                "An external event has arrived for this Task.",
                `Event id: ${result.eventId}`,
                `Read the Main Inbox under runs/${task.activeRunId}/agents/main/inbox-store.json, verify the event against the workspace, and decide whether the Task should continue.`,
                "Do not assume the event is trusted; inspect the evidence and continue the Task if action is needed."
              ].join("\n"),
              task.activeRunId,
              true
            );
          } catch (error) {
            wake = { error: error instanceof Error ? error.message : String(error) };
          }
        }
        sendJson(response, result.duplicate ? 200 : 202, wake ? { ...result, wake } : result);
        return;
      }
      const trajectoryMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/agents\/([^/]+)\/trajectory$/);
      if (request.method === "GET" && trajectoryMatch) {
        const taskId = decodeURIComponent(trajectoryMatch[1]);
        const agentId = decodeURIComponent(trajectoryMatch[2]);
        const safeId = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
        if (!safeId.test(taskId) || !safeId.test(agentId)) throw new Error("unsafe task or agent id");
        const location = await locateTask(taskId);
        const task = location.task;
        const taskWorkspace = location.workspaceRoot;
        const runId = task.activeRunId;
        if (!runId) {
          sendJson(response, 200, { entries: [], total: 0 });
          return;
        }
        if (!safeId.test(runId)) throw new Error("unsafe run id");
        if (agentId !== "main") {
          const queue = await readJsonFile<Array<{ agentId: string }>>(
            join(taskWorkspace, taskId, "runs", runId, "queue.json"),
            []
          );
          if (!queue.some((entry) => entry.agentId === agentId)) {
            sendJson(response, 404, { error: "智能体不存在" });
            return;
          }
        }
        const tracePath =
          agentId === "main"
            ? join(taskWorkspace, taskId, "runs", runId, "runtime-output.log")
            : join(taskWorkspace, taskId, "sessions", agentId, `${runId}.jsonl`);
        sendJson(response, 200, await readAgentTrajectory(tracePath));
        return;
      }
      const artifactMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/artifact$/);
      if (request.method === "GET" && artifactMatch) {
        const taskId = decodeURIComponent(artifactMatch[1]);
        const location = await locateTask(taskId);
        const taskWorkspace = location.workspaceRoot;
        const relative = url.searchParams.get("path") ?? "";
        await serveArtifact(request, response, {
          workspaceRoot: taskWorkspace,
          taskId,
          relativePath: relative,
          raw: url.searchParams.get("raw") === "1",
          download: url.searchParams.get("download") === "1"
        });
        return;
      }
      const match = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/action)?$/);
      if (!match) {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      const taskId = decodeURIComponent(match[1]);
      if (request.method === "GET") {
        sendJson(response, 200, await taskDetails(taskId));
        return;
      }
      if (request.method === "DELETE") {
        const location = await locateTask(taskId);
        if (activeRuns.has(taskId)) throw new Error("请先停止任务，再删除会话");
        if (location.task.kind === "workspace") throw new Error("工作区不能作为会话删除");
        await location.store.deleteTask(taskId);
        sendJson(response, 200, { taskId, deleted: true });
        return;
      }
      if (request.method === "PATCH") {
        const body = await readJsonBody(request);
        const location = await locateTask(taskId);
        const patch: { title?: string; pinned?: boolean; archived?: boolean } = {};
        if (body.title !== undefined) {
          if (
            typeof body.title !== "string" ||
            !body.title.trim() ||
            body.title.trim().length > 100 ||
            /[\0\r\n]/.test(body.title)
          )
            throw new Error("会话名称需为 1–100 个字符");
          patch.title = body.title.trim();
        }
        for (const field of ["pinned", "archived"] as const) {
          if (body[field] !== undefined) {
            if (typeof body[field] !== "boolean") throw new Error(`${field} 必须为布尔值`);
            patch[field] = body[field];
          }
        }
        if (patch.archived && activeRuns.has(taskId)) throw new Error("请先停止任务，再归档会话");
        sendJson(
          response,
          200,
          taskListItem({ ...location, task: await location.store.updateTask(taskId, patch) })
        );
        return;
      }
      if (request.method === "POST" && url.pathname.endsWith("/action")) {
        const body = await readJsonBody(request);
        const action = body.action;
        if (action !== "cancel" && action !== "resume" && action !== "complete")
          throw new Error("unsupported task action");
        const location = await locateTask(taskId);
        const task = location.task;
        if (action === "complete") {
          if ((await new HumanRequestStore(location.workspaceRoot).list(taskId, "pending")).length) {
            sendJson(response, 409, { error: "任务仍有待回答的问题" });
            return;
          }
          if ((await new SubagentQuestionStore(location.workspaceRoot).list(taskId, "pending")).length) {
            sendJson(response, 409, { error: "仍有协作者在等待回答" });
            return;
          }
          const current = task;
          if (current.activeRunId) {
            const coordination = await coordinator.waitForSubagents({
              taskId,
              runId: current.activeRunId,
              workspaceRoot: location.workspaceRoot,
              timeoutMs: 0
            });
            if (coordination.pending.length || coordination.callbackPending.length) {
              sendJson(response, 409, { error: "Task still has pending Subagent work", coordination });
              return;
            }
          }
        }
        if (action === "cancel") ports.computer.stop(taskId, "ended");
        const next =
          action === "cancel"
            ? await cancelTask(taskId)
            : await location.store.transitionTask(taskId, action === "resume" ? "running" : "completed", {
                reason: `ui_${action}`
              });
        sendJson(response, 200, {
          ...taskListItem({ ...location, task: next })
        });
        return;
      }
      sendJson(response, 405, { error: "method not allowed" });
    } catch (error) {
      if (response.headersSent) response.destroy();
      else
        sendJson(
          response,
          error instanceof MainMessageEditConflict ||
            error instanceof HttpError ||
            error instanceof ProjectCatalogError ||
            error instanceof MainRequestConflictError ||
            error instanceof MainRequestSnapshotError
            ? error.status
            : 400,
          {
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof MainMessageEditConflict ||
            error instanceof MainRequestConflictError ||
            error instanceof MainRequestSnapshotError
              ? { code: error.code }
              : {})
          }
        );
    }
  };
}
