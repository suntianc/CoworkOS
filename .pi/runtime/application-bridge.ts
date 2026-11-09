import { capabilityProvider } from "../../dist/src/runtime/capability-provider.js";
import {
  attachmentGrants,
  attachmentCapabilityProvider
} from "../../dist/src/workspace/attachment-capabilities.js";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { LocalWorkspaceStore } from "../../dist/src/workspace/workspace-store.js";
import {
  ApplicationToolSession,
  applicationCapabilityProvider,
  resourceGrants,
  acceptResourceCandidate
} from "../../dist/src/applications/agent-capabilities.js";
import { ApplicationService } from "../../dist/src/applications/application-service.js";
import { applicationServiceForTask } from "../../dist/src/applications/task-service.js";
import { WorkbenchTabStore } from "../../dist/src/applications/tab-store.js";
import { JsonlEventStore } from "../../dist/src/storage/event-store.js";
import { MCP_TOOL_TIMEOUT_MS } from "../../dist/src/applications/mcp-supervisor.js";
import { postLocalApiJson } from "../../dist/src/applications/mcp/local-api-client.js";
import {
  assertMainRequestExecutionScope,
  mainRequestExecutionScope,
  type MainRequestExecutionScope
} from "../../dist/src/runtime/main-request-execution-scope.js";
import type { RuntimeToolResult } from "./helpers.ts";

import { errorMessage } from "./helpers.ts";
import { createApplicationToolQueue, APPLICATION_TOOL_EXECUTION } from "./application-tool-execution.ts";

/** Report the published image's dimensions, never the caller's requested size. */
function pngDimensions(body: string | Uint8Array): { width: number; height: number } | undefined {
  if (typeof body === "string") return undefined;
  const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (
    bytes.length < 33 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    return undefined;
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** Owns application context, bound capabilities and domain tools, independent of Run lifecycle. */
export function createApplicationBridge({
  pi,
  workspaceRoot,
  taskId,
  mainRunId,
  harnessRoot
}: {
  pi: ExtensionAPI;
  workspaceRoot: string;
  taskId: string;
  mainRunId: string;
  harnessRoot: string;
}) {
  let workbench = new ApplicationService(workspaceRoot);
  const runApplicationTool = createApplicationToolQueue();
  const applicationSession = new ApplicationToolSession(workbench, {
    taskId,
    actor: { type: "agent", id: "main" },
    emit: (event) => emitApplicationEvent(event)
  });
  const observedRevisions = applicationSession.observedRevisions;
  /**
   * The global tab strip, when the Dashboard told us where it is.
   *
   * A document the Agent creates has to appear as a tab in the same strip the
   * browser reads, or `create_resource` is telling the user about a tab that
   * does not exist. The path comes from the Dashboard because the strip spans
   * every task and lives outside any one workspace; a run started without it
   * (a bare CLI invocation) simply creates no tab.
   */
  const tabStore = process.env.COWORK_TABS_INDEX
    ? new WorkbenchTabStore(process.env.COWORK_TABS_INDEX)
    : undefined;
  /**
   * Put an application window in the strip, and bring it to the front.
   *
   * Bringing it to the front is also what binds the conversation to it, exactly
   * as the Dashboard's own tab route does: the strip and the binding are two
   * views of one fact. Without the binding the Agent would create a document
   * and then be handed a NULL context on its next turn, with the application's
   * own tools retired along with it.
   *
   * Failing to open a tab must never fail the document that was already
   * created, so this only ever logs by omission.
   */
  const openWorkbenchTab = async (resourceId: string): Promise<{ tabOpened: boolean; bound: boolean }> => {
    // Keyed by the document: one file, one tab, whoever references it.
    const tabOpened = tabStore
      ? await tabStore.open({ kind: "application", resourceId }).then(
          () => true,
          () => false
        )
      : false;
    // Binding is also needed in CLI sessions that have no browser tab store.
    const bound = await workbench.bindResource(taskId, resourceId).then(
      () => true,
      () => false
    );
    return { tabOpened, bound };
  };
  /**
   * Publish a resource event so an open editor sees the Agent's edit.
   *
   * The browser's only live-refresh path is a `resource.*` record on the Task
   * SSE stream. Without this sink the Agent's writes were invisible: the user
   * kept typing against a stale baseline until their next save conflicted or
   * silently reverted the Agent's work.
   */
  const emitApplicationEvent = (event: {
    type: string;
    taskId: string;
    appType: string;
    resourceId?: string;
    appInstanceId?: string;
    revision?: number;
    payload: Record<string, unknown>;
  }): void => {
    void new JsonlEventStore(join(workspaceRoot, taskId, "runs", mainRunId, "run_events.jsonl"))
      .append({
        eventId: `app-${randomUUID()}`,
        type: event.type,
        taskId,
        runId: mainRunId,
        agentId: "main",
        occurredAt: new Date().toISOString(),
        payload: {
          appType: event.appType,
          resourceId: event.resourceId,
          appInstanceId: event.appInstanceId,
          revision: event.revision,
          ...event.payload
        }
      })
      // eslint-disable-next-line no-restricted-syntax -- 资源写入已经成功；事件流通知失败时没有任何后续步骤依赖它，不能因此把成功的工具调用报告为失败
      .catch(() => {
        /* a missed notification must not fail the write that succeeded */
      });
  };
  const mainActor = { type: "agent" as const, id: "main" };
  /**
   * Resources whose context was injected into the turn now running.
   *
   * The cursor advances only once a turn carrying the context has settled. If
   * the model fails before ever reading it, the same user changes are injected
   * again rather than being silently marked as seen.
   */
  let injectedResources: Array<{ resourceId: string; revision: number }> = [];
  /** The rendered section awaiting the next prompt assembly. */
  let pendingApplicationContext = "";
  /**
   * What the currently bound application contributes to this turn.
   *
   * Binding is not only context: an application brings the domain knowledge
   * needed to work in it. Skills are announced in the prompt so Main can load
   * one on demand, and declared tools are registered while bound. Unbinding has
   * to take both away again, which is why this is tracked rather than left to
   * accumulate.
   */
  let boundApplication: Awaited<ReturnType<ApplicationService["boundCapabilities"]>>;
  const boundAdapterTools = new Set<string>();

  /**
   * Where the bound application's MCP servers can be reached.
   *
   * The servers belong to the Dashboard, because a window outlives any single
   * Agent run and stdio ownership cannot be handed over. Without this address
   * an application simply contributes no tools of its own; nothing else
   * changes, so a CLI run with no Dashboard still works.
   */
  const dashboardBase = process.env.COWORK_DASHBOARD_URL;

  /** Tools the bound window's MCP server offers this turn. */
  let boundMcpTools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = [];
  let boundResourceOwner: { root: string; path: string } | undefined;
  let protectedReplayScope: MainRequestExecutionScope | undefined;
  const executionScope = async (projectDirectory: string) => {
    const bound = boundApplication;
    const mcpTools = boundMcpTools;
    const owner = boundResourceOwner;
    if (bound && !owner) throw new Error("无法确认应用资源执行归属");
    return mainRequestExecutionScope({
      taskStorageRoot: workspaceRoot,
      projectDirectory,
      resourceWorkspaceRoot: owner?.root ?? workbench.resourceWorkspaceRoot,
      application: bound && owner ? { ...bound, resourcePath: owner.path } : undefined,
      mcpTools
    });
  };
  const assertReplayTarget = async () => {
    if (protectedReplayScope)
      assertMainRequestExecutionScope(
        protectedReplayScope,
        await executionScope(protectedReplayScope.projectDirectory)
      );
  };

  const mcpFetch = async (
    path: string,
    init?: { method: string; body: string },
    signal?: AbortSignal
  ): Promise<unknown> => {
    signal?.throwIfAborted();
    if (!dashboardBase) throw new Error("没有 Dashboard 地址，无法访问应用的 MCP 服务器");
    const response = init
      ? await postLocalApiJson(`${dashboardBase}${path}`, init.body, MCP_TOOL_TIMEOUT_MS + 10_000, signal)
      : await fetch(`${dashboardBase}${path}`, {
          signal,
          headers: {
            "content-type": "application/json",
            ...(process.env.COWORK_API_TOKEN ? { "x-atria-token": process.env.COWORK_API_TOKEN } : {})
          }
        });
    // eslint-disable-next-line no-restricted-syntax -- 响应正文可能不是 JSON（网关错误页、空 body），此时仍要按 status 报错而不是抛出解析异常
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = (payload as { error?: { message?: string } }).error?.message;
      throw new Error(detail ?? `HTTP ${response.status}`);
    }
    return payload;
  };

  /**
   * Ask the bound window's server what it offers.
   *
   * Discovered per turn rather than cached: the binding can move between
   * turns, and a server can be restarted with a different tool set. An
   * unreachable server means no application tools, not a failed turn.
   */
  const discoverMcpTools = async (): Promise<void> => {
    boundMcpTools = [];
    if (!dashboardBase || !boundApplication?.hasMcpServer) return;
    try {
      const payload = (await mcpFetch(
        `/api/workbench/mcp/tools?resourceId=${encodeURIComponent(boundApplication.resourceId)}`
      )) as { tools?: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }> };
      boundMcpTools = (payload.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description ?? tool.name,
        parameters: tool.parameters ?? { type: "object", properties: {} }
      }));
      // eslint-disable-next-line no-restricted-syntax -- 绑定窗口的 MCP 服务器没启动是常见情况，本轮就是没有应用工具；失败已由空工具列表表达，不中断对话
    } catch {
      // A window whose server never started is the common case here, not an
      // error worth interrupting the turn for.
      boundMcpTools = [];
    }
  };

  /**
   * Prepare the active application section before a turn is assembled.
   *
   * It runs before initial prompt assembly and again in the per-request
   * context hook, so initial tools and mid-turn changes are both available. A damaged
   * resource must not stop Main from answering, so a failure here simply omits
   * the section.
   */
  const prepareApplicationContext = async (): Promise<void> => {
    try {
      workbench = await applicationServiceForTask(workspaceRoot, taskId);
      applicationSession.service = workbench;
      const context = await workbench.activeContext({ taskId, agentId: "main" });
      if (!context) {
        pendingApplicationContext = await workbench.emptyApplicationContext(taskId);
        injectedResources = [];
        boundApplication = undefined;
        boundResourceOwner = undefined;
        retireAdapterTools();
        return;
      }
      pendingApplicationContext = workbench.context.render(context);
      injectedResources = [{ resourceId: context.resource.resourceId, revision: context.resource.revision }];
      await workbench.context.recordInjected(
        taskId,
        "main",
        context.resource.resourceId,
        context.resource.revision
      );
      boundApplication = await workbench.boundCapabilities({ taskId, agentId: "main" });
      boundResourceOwner = undefined;
      if (boundApplication) {
        const owner = await workbench.serviceForResource(taskId, boundApplication.resourceId);
        const read = await owner.readResource(taskId, boundApplication.resourceId, { limit: 1 });
        boundResourceOwner = {
          root: await realpath(owner.resourceWorkspaceRoot),
          path: await realpath(owner.resources.absolutePath(read.resource))
        };
      }
      await discoverMcpTools();
      registerAdapterTools();
      // eslint-disable-next-line no-restricted-syntax -- 损坏的资源或读取失败只应让本轮少一段应用上下文，主对话必须继续回答；下面已把状态复位为空上下文
    } catch {
      pendingApplicationContext = "";
      injectedResources = [];
      boundApplication = undefined;
      boundResourceOwner = undefined;
      boundMcpTools = [];
      retireAdapterTools();
    }
  };

  /** Hide tools belonging to an application that is no longer bound. */
  const retireAdapterTools = (): void => {
    if (!boundAdapterTools.size) return;
    pi.setActiveTools(pi.getActiveTools().filter((name: string) => !boundAdapterTools.has(name)));
    boundAdapterTools.clear();
  };

  /**
   * Name the bound document the way the user does, and reconcile the filename.
   *
   * A resource has a title the person chose and a path the store picked, and
   * they are allowed to differ: `availablePath` sidesteps a name collision, so
   * 「算法.md」 can be stored as `算法 2.md`. Printing both without comment made
   * the prompt look self-contradictory — it named one file and then said the
   * user meant a differently-named one — and a real run spent four `bash`
   * calls searching the disk to decide which was real. So the title leads, and
   * the path appears only when it adds something, with the relationship stated.
   */
  const describeBoundResource = (bound: NonNullable<typeof boundApplication>): string[] => {
    const fileName = bound.resourcePath.split("/").pop() ?? bound.resourcePath;
    const lines = [`本轮绑定了「${bound.displayName}」，正在编辑《${bound.resourceTitle}》。`];
    if (fileName === bound.resourceTitle) {
      lines.push(`它的文件是 ${bound.resourcePath}。`);
    } else {
      lines.push(
        `它在磁盘上的文件名是 ${fileName}（完整路径 ${bound.resourcePath}）——` +
          `标题和文件名不一致是正常的：创建时遇到同名文件，存储会自动换一个文件名，标题保持用户起的那个。` +
          `这两个名字指的是同一份文档。`
      );
    }
    return lines;
  };

  /**
   * Expose the bound application's own tools for this turn.
   *
   * They are registered once per name and then activated/deactivated, because
   * Pi has no unregister: activation is what controls visibility.
   */
  const registerAdapterTools = (): void => {
    const tools = boundApplication?.tools ?? [];
    // An MCP tool whose name an in-process tool already took can never run: the
    // loops below register in-process first, and the MCP loop skips a name that
    // is already registered. Nothing said so — the tool appeared in the model's
    // list and quietly resolved to the other implementation. Drop it here
    // instead, so the name the model is offered is the one that will answer.
    const inProcess = new Set(tools.map((tool) => tool.name));
    boundMcpTools = boundMcpTools.filter((tool) => !inProcess.has(tool.name));
    // In-process tools and the window's MCP tools are the same thing to the
    // model, so they share one visibility pass: a name from either source that
    // is no longer wanted has to be deactivated, or it lingers after a rebind.
    const wanted = new Set([...inProcess, ...boundMcpTools.map((tool) => tool.name)]);
    // Deactivate, do not merely untrack. Removing the name from the set left
    // the tool in `getActiveTools()` with nothing able to take it away again,
    // so after rebinding the model saw a CAD tool while editing a text file.
    const stale = [...boundAdapterTools].filter((name) => !wanted.has(name));
    if (stale.length) {
      pi.setActiveTools(pi.getActiveTools().filter((name: string) => !stale.includes(name)));
      for (const name of stale) boundAdapterTools.delete(name);
    }
    for (const tool of tools) {
      if (registeredAdapterTools.has(tool.name)) {
        boundAdapterTools.add(tool.name);
        continue;
      }
      registeredAdapterTools.add(tool.name);
      boundAdapterTools.add(tool.name);
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: `${tool.description}\n${APPLICATION_TOOL_EXECUTION}${tool.requiresFreshRead ? "\n每轮用户请求的首次修改前，先调用应用读取工具查看当前保存状态；上一轮的读取或上下文摘要不能替代本轮读取。" : ""}`,
        parameters: tool.parameters,
        async execute(
          _toolCallId: string,
          params: Record<string, unknown>,
          _signal: AbortSignal | undefined,
          _onUpdate: unknown,
          ctx: ExtensionContext
        ): Promise<RuntimeToolResult> {
          // Resolved per call, not captured: the binding may have moved since
          // this tool was registered.
          const bound = boundApplication;
          const definition = bound?.tools.find((entry) => entry.name === tool.name);
          if (!bound || !definition) {
            const payload = {
              ok: false,
              code: "application_not_found",
              error: `${tool.name} 需要先绑定对应的应用`
            };
            return {
              content: [{ type: "text", text: JSON.stringify(payload) }],
              details: payload,
              isError: true
            };
          }
          return runApplicationTool(bound.resourceId, async () => {
            try {
              await assertReplayTarget();
              const outcome = await applicationSession.execute(
                bound.resourceId,
                definition,
                params,
                _signal,
                protectedReplayScope?.application ?? undefined
              );
              const applied = outcome.applied;
              const images = outcome.images;
              const imageInput = ctx.model?.input.includes("image") ?? false;
              const payload = {
                ok: true,
                result: outcome.result,
                ...(applied.length ? { applied } : {}),
                ...(images.length
                  ? {
                      visualFeedback: {
                        images: images.length,
                        delivered: imageInput,
                        ...(!imageInput
                          ? {
                              reason:
                                "当前模型未声明图像输入能力，使用文字几何诊断；可在支持视觉的模型连接中启用 supportsImages。"
                            }
                          : {})
                      }
                    }
                  : {})
              };
              return {
                content: [
                  { type: "text", text: JSON.stringify(payload) },
                  ...(imageInput ? images.map((image) => ({ type: "image" as const, ...image })) : [])
                ],
                details: payload
              };
            } catch (error) {
              const payload =
                error && typeof error === "object" && "code" in error
                  ? {
                      ok: false,
                      code: (error as { code: string }).code,
                      error: errorMessage(error),
                      details: (error as { details?: unknown }).details
                    }
                  : { ok: false, code: "invalid_operation", error: errorMessage(error) };
              const readTool = workbench
                .definitions()
                .find((app) => app.appType === bound.appType)?.entryReadTool;
              const nextAction =
                readTool &&
                (payload.code === "operation_precondition_failed" || payload.code === "revision_conflict")
                  ? { tool: readTool, arguments: {} }
                  : undefined;
              const recovery = { ...payload, ...(nextAction ? { nextAction } : {}) };
              return {
                content: [{ type: "text", text: JSON.stringify(recovery) }],
                details: recovery,
                isError: true
              };
            }
          });
        }
      });
    }
    for (const tool of boundMcpTools) {
      if (registeredAdapterTools.has(tool.name)) {
        boundAdapterTools.add(tool.name);
        continue;
      }
      registeredAdapterTools.add(tool.name);
      boundAdapterTools.add(tool.name);
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: `${tool.description}\n${APPLICATION_TOOL_EXECUTION}`,
        parameters: tool.parameters,
        async execute(
          _toolCallId: string,
          params: Record<string, unknown>,
          signal?: AbortSignal
        ): Promise<RuntimeToolResult> {
          // Resolved per call, not captured: the binding may have moved since
          // this tool was registered, and a tool from the previous application
          // must not act on the current one's resource.
          const bound = boundApplication;
          if (!bound || !boundMcpTools.some((entry) => entry.name === tool.name)) {
            const payload = {
              ok: false,
              code: "application_not_found",
              error: `${tool.name} 需要先绑定对应的应用`
            };
            return {
              content: [{ type: "text", text: JSON.stringify(payload) }],
              details: payload,
              isError: true
            };
          }
          return runApplicationTool(bound.resourceId, async () => {
            try {
              await assertReplayTarget();
              const outcome = (await mcpFetch(
                "/api/workbench/mcp/call",
                {
                  method: "POST",
                  body: JSON.stringify({
                    taskId,
                    name: tool.name,
                    params,
                    resourceId: bound.resourceId,
                    ...(protectedReplayScope?.application
                      ? { executionTarget: protectedReplayScope.application }
                      : {})
                  })
                },
                signal
              )) as {
                result?: unknown;
                operations?: Array<{ operationType: string; payload: unknown }>;
                baseRevision?: number;
              };
              // The server returns operations rather than writing, so the write
              // still goes through revision CAS: a conflicting edit in the open
              // editor wins a 409 instead of being silently overwritten.
              const applied = [];
              let baseRevision = outcome.baseRevision ?? 0;
              signal?.throwIfAborted();
              for (const operation of outcome.operations ?? []) {
                const result = await workbench.applyOperation(
                  {
                    taskId,
                    resourceId: bound.resourceId,
                    appType: bound.appType,
                    operationId: `op_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
                    operationType: operation.operationType,
                    baseRevision,
                    payload: operation.payload,
                    actor: mainActor,
                    signal,
                    expectedResourceWorkspaceRoot: protectedReplayScope?.application?.resourceWorkspaceRoot
                  },
                  emitApplicationEvent
                );
                baseRevision = result.resource.revision;
                applied.push({ revision: result.resource.revision, summary: result.event.summary });
                await workbench.context
                  .recordAcknowledged(taskId, "main", bound.resourceId, result.resource.revision)
                  // eslint-disable-next-line no-restricted-syntax -- 操作已提交成功；这一行只推进“已读”游标，写失败时下一轮会重新注入未读变更
                  .catch(() => {});
              }
              const payload = { ok: true, result: outcome.result, ...(applied.length ? { applied } : {}) };
              return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
            } catch (error) {
              const payload =
                error && typeof error === "object" && "code" in error
                  ? {
                      ok: false,
                      code: (error as { code: string }).code,
                      error: errorMessage(error),
                      details: (error as { details?: unknown }).details
                    }
                  : { ok: false, code: "invalid_operation", error: errorMessage(error) };
              return {
                content: [{ type: "text", text: JSON.stringify(payload) }],
                details: payload,
                isError: true
              };
            }
          });
        }
      });
    }
    if (boundAdapterTools.size) {
      const active = pi.getActiveTools();
      const missing = [...boundAdapterTools].filter((name) => !active.includes(name));
      if (missing.length) pi.setActiveTools([...active, ...missing]);
    }
  };
  const registeredAdapterTools = new Set<string>();
  const protocolToolNames = new Set([
    "list_applications",
    "list_resources",
    "list_resource_changes",
    "create_resource",
    "export_resource",
    "apply_resource_operation",
    "accept_resource_candidate"
  ]);
  // Pi determines failure from exceptions or tool_result hooks, not the
  // isError property on a returned extension result. Preserve the structured
  // error/recovery payload while marking the real transcript and UI as failed.
  pi.on("tool_result", (event) => {
    if (!registeredAdapterTools.has(event.toolName) && !protocolToolNames.has(event.toolName)) return;
    const details = event.details;
    if (details && typeof details === "object" && "ok" in details && details.ok === false)
      return { isError: true };
  });

  function registerGenericTools() {
    /**
     * Whatever a tool reports, reduced to something the session can record.
     *
     * The session recorder clones tool results with `structuredClone`, so a
     * single unclonable value can invalidate the whole turn. Use the same JSON
     * reduction as text content so argument errors remain recordable and the
     * model can correct its input.
     */
    const recordable = (payload: unknown): unknown => {
      try {
        structuredClone(payload);
        return payload;
        // eslint-disable-next-line no-restricted-syntax -- 工具结果可能含不可结构化克隆的值（函数、句柄），此时改用 JSON 归约而不是让整轮会话记录失败
      } catch {
        try {
          return JSON.parse(JSON.stringify(payload));
          // eslint-disable-next-line no-restricted-syntax -- 含循环引用或 BigInt 的结果连 JSON 也无法序列化，只能退化为说明文本交给模型
        } catch {
          return { note: "工具结果无法序列化，已省略细节" };
        }
      }
    };
    const ok = (payload: unknown): RuntimeToolResult => ({
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: recordable(payload)
    });
    // A tool must hand the model something it can act on. A conflict that
    // arrives as a thrown string forces it to guess; a code plus the current
    // revision tells it exactly how to recover.
    const failed = (error: unknown): RuntimeToolResult => {
      const payload =
        error && typeof error === "object" && "code" in error
          ? {
              ok: false,
              code: (error as { code: string }).code,
              error: errorMessage(error),
              details: (error as { details?: unknown }).details
            }
          : { ok: false, code: "invalid_operation", error: errorMessage(error) };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: recordable(payload),
        isError: true
      };
    };

    pi.registerTool({
      name: "list_applications",
      label: "List Applications",
      description:
        "List the workbench applications available in this build: which resource kinds each can open, what it can do, and which operation types it accepts. Use this before creating a resource when you are unsure which application owns a kind.",
      promptSnippet: "See which workbench applications and operations exist",
      parameters: Type.Object({}),
      async execute(): Promise<RuntimeToolResult> {
        return ok({ applications: workbench.catalogDefinitions() });
      }
    });

    pi.registerTool({
      name: "list_resources",
      label: "List Shared Resources",
      description:
        "List the shared application resources on this Task: id, title, kind, owning application, current revision and which tab shows it. This is an index, not content; bind a resource and use its application's own read tool to see inside one.",
      promptSnippet: "List the shared resources the user can edit",
      parameters: Type.Object({
        kind: Type.Optional(Type.String({ description: "Filter to one resource kind, e.g. text/markdown." }))
      }),
      async execute(_toolCallId, params): Promise<RuntimeToolResult> {
        try {
          const resources = await workbench.listResources(taskId);
          const kind = typeof params.kind === "string" ? params.kind : undefined;
          return ok({ resources: kind ? resources.filter((resource) => resource.kind === kind) : resources });
        } catch (error) {
          return failed(error);
        }
      }
    });

    // Adapters own content reads and pagination. The platform exposes only its
    // shared version log, independent of each application's document format.
    pi.registerTool({
      name: "list_resource_changes",
      label: "List Resource Changes",
      description:
        "List the versioned changes applied to a shared resource: which revision, who made it, and the owning application's own summary of it. This is the version log, never content — read a document with the bound application's own read tool.",
      promptSnippet: "See what changed on a resource and who changed it",
      promptGuidelines: [
        "Use this after a revision_conflict to see what the user changed before you recompute your edit.",
        "Pass afterRevision to see only what happened since you last looked.",
        "It reports summaries, not content. To see the text itself, use the application's own read tool."
      ],
      parameters: Type.Object({
        resourceId: Type.String({
          description:
            "The resource whose history you want, from list_resources or the active application context."
        }),
        afterRevision: Type.Optional(
          Type.Number({ description: "Return only operations after this revision." })
        ),
        limit: Type.Optional(Type.Number({ description: "Maximum operations to return; default 100." }))
      }),
      async execute(_toolCallId, params): Promise<RuntimeToolResult> {
        try {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 资源 ID 来自模型或直接调用给出的工具参数，缺失时保留空串，让 read_resource 用原来的资源校验错误拒绝而不是把 "undefined" 当 ID
          const read = await workbench.readResource(taskId, String(params.resourceId ?? ""), {
            afterRevision: typeof params.afterRevision === "number" ? params.afterRevision : undefined,
            limit: typeof params.limit === "number" ? params.limit : undefined
          });
          // Deliberately no `content` and no size: this tool answers "what
          // happened", and a resource's content belongs to its application.
          return ok({
            resource: read.resource,
            selection: read.selection
              ? { schema: read.selection.schema, summary: read.selection.summary }
              : undefined,
            operations: read.operations.map((event) => ({
              revision: event.revision,
              actor: event.actor,
              operationType: event.operationType,
              summary: event.summary,
              occurredAt: event.occurredAt
            })),
            hasMore: read.hasMore
          });
        } catch (error) {
          return failed(error);
        }
      }
    });

    pi.registerTool({
      name: "create_resource",
      label: "Create Shared Resource",
      description:
        "Create and bind a NEW editable resource without first opening its application. This always creates a separate file and tab, even if its title matches an existing resource. For follow-up changes to the bound document/model, use its read/edit tools instead. Omit initialContent to create the application's valid empty document/model; do not guess its format. Opens the editor when a Dashboard is connected and enables the application's own tools before returning. Use the returned tools to read and edit the new resource.",
      promptSnippet: "Create a resource the user can edit alongside you",
      promptGuidelines: [
        "When the user asks to refine, improve or make the current work more complex, read and edit the bound resource in place, preserving their manual edits. Create another resource only when they ask for a new file, a separate variant or a copy.",
        "Use this for something the user will edit with you. A finished deliverable they only download belongs in artifacts/ as an ordinary file.",
        "The title becomes the tab name and the exported filename, so make it describe the content.",
        "Follow the application's creationHint from list_applications. Omit initialContent for a valid empty resource, then use its domain tools to build the content.",
        "The result reports editorOpened, bound, availableTools and nextAction. Call nextAction first, then continue with those tools; do not search files or inspect harness source to find the new resource."
      ],
      parameters: Type.Object({
        kind: Type.String({ description: "Resource kind, e.g. text/markdown. See list_applications." }),
        title: Type.String({ description: "Human-readable title; becomes the tab name." }),
        initialContent: Type.Optional(
          Type.Union(
            [
              Type.String({
                description: "Text content, or serialized JSON only if the application accepts it."
              }),
              Type.Object(
                {},
                {
                  additionalProperties: true,
                  description:
                    "Structured model content matching the application's format; pass an object, not a JSON-encoded string."
                }
              )
            ],
            {
              description:
                "Optional initial content. Omit for the application's valid empty document/model; see its creationHint."
            }
          )
        ),
        appType: Type.Optional(
          Type.String({
            description: "Force a specific application; omit to let the registry choose by kind."
          })
        )
      }),
      async execute(_toolCallId, params): Promise<RuntimeToolResult> {
        try {
          const created = await workbench.createResource(
            {
              taskId,
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 资源类型与标题来自工具参数，缺失时保留空串，create_resource 才能按原来的字段校验拒绝
              kind: String(params.kind ?? ""),
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 标题来自工具参数，缺失时保留空串，create_resource 才能按原来的标题校验拒绝
              title: String(params.title ?? ""),
              initialContent: params.initialContent,
              appType: typeof params.appType === "string" && params.appType ? params.appType : undefined,
              actor: mainActor
            },
            emitApplicationEvent
          );
          // The Agent's own creation is already known to it; starting the
          // cursor at the current revision keeps its own write from coming
          // back as an unread user change.
          await workbench.context
            .recordAcknowledged(taskId, "main", created.resource.resourceId, created.resource.revision)
            // eslint-disable-next-line no-restricted-syntax -- 资源与标签页已创建成功；游标写失败时这份新资源只会作为未读变更再注入一次
            .catch(() => {});
          // The tool's own description promises the tab is open, so opening it
          // is part of the act, not a follow-up the UI has to notice.
          const opened = await openWorkbenchTab(created.resource.resourceId);
          // Refresh during tool execution: Pi's next-turn tool loadout is
          // assembled before the later context hook can register new tools.
          await prepareApplicationContext();
          const availableTools =
            opened.bound && boundApplication?.resourceId === created.resource.resourceId
              ? [...boundAdapterTools].filter((name) => pi.getActiveTools().includes(name))
              : [];
          const readTool = workbench
            .definitions()
            .find((app) => app.appType === created.resource.appType)?.entryReadTool;
          const nextAction =
            readTool && availableTools.includes(readTool) ? { tool: readTool, arguments: {} } : undefined;
          return ok({
            resource: created.resource,
            editorOpened: opened.tabOpened,
            bound: opened.bound,
            availableTools,
            ...(nextAction ? { nextAction } : {}),
            nextStep: availableTools.length
              ? nextAction
                ? `下一步先调用 ${nextAction.tool}({}) 读取这份新资源，再用其余专用工具修改。工具已经启用，不需要查找文件或检查工具源码。`
                : `继续使用这些已启用的应用工具：${availableTools.join(", ")}。先读取模型或文档，再提交修改；不需要查找文件或检查工具源码。`
              : "资源已保存。应用工具暂不可用，请报告接入状态，不要通过直接覆盖文件绕过编辑协议。",
            note: opened.tabOpened
              ? "资源已创建，对应的标签页已在工作台打开。"
              : "资源已创建并保存。当前没有可用的编辑器标签。"
          });
        } catch (error) {
          return failed(error);
        }
      }
    });

    pi.registerTool({
      name: "accept_resource_candidate",
      label: "Accept Reviewed Resource Candidate",
      description:
        "Apply a Subagent's reviewed candidatePath to its referenced resource in one atomic revision. Read the candidate and inspect its evidence before acceptance. A version conflict preserves the current document and candidate; re-read and re-delegate, never blindly retry or replace the candidate's baseRevision. Repeating the same accepted candidate is idempotent.",
      parameters: Type.Object({ candidatePath: Type.String() }),
      async execute(_toolCallId, params, signal): Promise<RuntimeToolResult> {
        try {
          const outcome = await acceptResourceCandidate(workbench, {
            workspaceRoot,
            taskId,
            candidatePath: params.candidatePath,
            actor: mainActor,
            signal,
            emit: emitApplicationEvent
          });
          observedRevisions.set(outcome.resourceId, outcome.revision);
          await workbench.context.recordAcknowledged(taskId, "main", outcome.resourceId, outcome.revision);
          return ok({ ok: true, ...outcome });
        } catch (error) {
          return failed(error);
        }
      }
    });

    pi.registerTool({
      name: "export_resource",
      label: "Export Shared Resource",
      description:
        "Export a referenced resource using its application's declared formats and options. Publishes the generated file in this Task's downloadable artifacts and returns its actual path and metadata. Does not edit or rebind the resource. Discover formats with list_applications; domain options belong to the application's tools and skills.",
      parameters: Type.Object({
        resourceId: Type.String(),
        format: Type.String(),
        options: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
      }),
      async execute(_toolCallId, params, signal): Promise<RuntimeToolResult> {
        try {
          signal?.throwIfAborted();
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 资源 ID 来自模型或直接调用给出的工具参数，缺失时保留空串，render_for_download 才能按原来的资源校验拒绝
          const resourceId = String(params.resourceId ?? "");
          const exported = await workbench.renderForDownload({
            taskId,
            resourceId,
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 导出格式来自工具参数，缺失时保留空串，render_for_download 才能按原来的格式校验拒绝
            format: String(params.format ?? ""),
            options: params.options,
            signal
          });
          signal?.throwIfAborted();
          const fileName = basename(exported.fileName);
          if (!fileName || fileName === "." || fileName === ".." || fileName.includes("\\"))
            throw new Error("应用返回了无效的导出文件名");
          const artifact = await new LocalWorkspaceStore(workspaceRoot).publishArtifact({
            taskId,
            runId: mainRunId,
            producerAgentId: "main",
            relativePath: `exports/${resourceId}/${randomUUID().slice(0, 8)}-${fileName}`,
            displayName: fileName,
            mimeType: exported.mimeType,
            sourceResourceId: resourceId,
            content: exported.body
          });
          return ok({
            ok: true,
            artifact,
            path: join(workspaceRoot, taskId, "artifacts", artifact.relativePath),
            ...(exported.mimeType === "image/png" ? pngDimensions(exported.body) : undefined)
          });
        } catch (error) {
          return failed(error);
        }
      }
    });

    pi.registerTool({
      name: "apply_resource_operation",
      label: "Edit Shared Resource",
      description:
        "Apply one application-declared operation when no dedicated application tool covers it. Prefer the bound application's own tools; they use the same versioned storage. Pass payload as a JSON object. baseRevision must be the revision you last read; revision_conflict means read again and recompute. Never rewrite a resource with write/edit, which bypasses versioning and risks losing the user's work.",
      promptSnippet: "Fall back to the raw resource protocol",
      promptGuidelines: [
        "Read the resource first. The revision it returns is your baseRevision.",
        // This tool is the protocol, and its text operations are offset-based
        // because a protocol has to be precise. Two real runs show what happens
        // when a model is pointed here: one failed six times on "at 必须是非负
        // 整数" and wrote nothing; another read "第 3 行 ## 目标用户" from the
        // context summary, passed `from: 4`, and wrote into line 1 — reported
        // as a success, because 4 is a valid offset.
        "Prefer the bound application's own tools over this one. Use generic file tools for ordinary workspace files.",
        "Use this tool directly only when the application declares no dedicated tool for what you need. For text operations, use exact character offsets; for structured models, follow the owning application's payload schema.",
        "Never derive an offset from a line number. Context summaries and operation summaries speak in lines; from/to/at are UTF-16 character offsets. A line number is usually a valid offset, so this mistake is accepted and corrupts the document instead of failing.",
        "On revision_conflict, call list_resource_changes with afterRevision to see what the user changed, re-read the resource with the application's own read tool, then recompute your edit against the new revision. Never reverse a user's change unless they asked for it.",
        "Operation types and payload shapes come from the owning application; list_applications reports them.",
        "One operation should be one meaningful change the user could read in a history list."
      ],
      parameters: Type.Object({
        resourceId: Type.String({ description: "The resource to change." }),
        operationType: Type.String({
          description: "Operation declared by the owning application, e.g. text.replace."
        }),
        baseRevision: Type.Number({
          description: "The revision you read. The write is refused if the resource has moved on."
        }),
        payload: Type.Object(
          {},
          {
            additionalProperties: true,
            description:
              "Operation payload as a JSON object, never a JSON-encoded string. Validated against the owning application's schema."
          }
        ),
        operationId: Type.Optional(
          Type.String({ description: "Stable id for safe retries; omit to generate one." })
        )
      }),
      async execute(_toolCallId, params): Promise<RuntimeToolResult> {
        try {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 资源 ID 来自模型或直接调用给出的工具参数，缺失时保留空串，apply_operation 才能按原来的资源校验拒绝
          const resourceId = String(params.resourceId ?? "");
          // Referenced, not owned: the conversation must have a reference to
          // this resource, but the resource itself belongs to its application
          // and may be referenced by other conversations at the same time.
          const resources = await workbench.listResources(taskId);
          const resource = resources.find((entry) => entry.resourceId === resourceId);
          if (!resource)
            return failed({
              code: "resource_not_found",
              message: `资源不存在或本对话没有引用它：${resourceId}`
            });
          const outcome = await workbench.applyOperation(
            {
              taskId,
              resourceId,
              appType: resource.appType,
              operationId:
                typeof params.operationId === "string" && params.operationId
                  ? params.operationId
                  : `op_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 操作类型来自工具参数，缺失时保留空串，apply_operation 才能按原来的操作类型校验拒绝
              operationType: String(params.operationType ?? ""),
              baseRevision: Number(params.baseRevision),
              payload: params.payload,
              actor: mainActor
            },
            emitApplicationEvent
          );
          await workbench.context
            .recordAcknowledged(taskId, "main", resourceId, outcome.resource.revision)
            // eslint-disable-next-line no-restricted-syntax -- 操作已按版本提交成功；游标写失败只影响“已读”标记，下一轮会重新注入该变更
            .catch(() => {});
          return ok({
            revision: outcome.resource.revision,
            summary: outcome.event.summary,
            deduplicated: outcome.deduplicated,
            contentVersion: outcome.resource.contentVersion
          });
        } catch (error) {
          return failed(error);
        }
      }
    });
  }

  return {
    capabilityProvider: capabilityProvider(
      new Map([
        [
          "applications",
          (grants, context) => applicationCapabilityProvider(workbench, harnessRoot)(grants, context)
        ],
        ["attachments", attachmentCapabilityProvider(harnessRoot)]
      ])
    ),
    delegationGrants: async (resources: unknown, attachments?: unknown) => [
      ...(await resourceGrants(workbench, taskId, resources)),
      ...(await attachmentGrants(join(workspaceRoot, taskId), attachments))
    ],
    registerGenericTools,
    executionScope,
    beginModelTurn() {
      // The replay response can contain several tools, including a tool which
      // changes the binding. Only a subsequent model turn may use that binding.
      protectedReplayScope = undefined;
    },
    protectReplayScope(scope: MainRequestExecutionScope) {
      protectedReplayScope = scope;
    },
    mainActor,
    describeBoundResource,
    get workbench() {
      return workbench;
    },
    openWorkbenchTab,
    emitApplicationEvent,
    prepareApplicationContext,
    retireAdapterTools,
    registerAdapterTools,
    get boundApplication() {
      return boundApplication;
    },
    get boundAdapterTools() {
      return boundAdapterTools;
    },
    get boundMcpTools() {
      return boundMcpTools;
    },
    get injectedResources() {
      return injectedResources;
    },
    set injectedResources(value) {
      injectedResources = value;
    },
    get pendingApplicationContext() {
      return pendingApplicationContext;
    },
    set pendingApplicationContext(value) {
      pendingApplicationContext = value;
    }
  };
}
