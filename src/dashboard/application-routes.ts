import { readTemporaryWorkspace } from "../workspace/temporary-workspaces.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApplicationService, type ApplicationEvent } from "../applications/application-service.js";
import { WorkbenchTabStore, type WorkbenchTabRecord } from "../applications/tab-store.js";
import { McpSupervisor, resourceConsumer } from "../applications/mcp-supervisor.js";
import {
  applicationErrorResponse,
  ApplicationError,
  RESOURCE_LIMITS,
  type Actor,
  type ApplicationProject
} from "../applications/types.js";
import { HttpError, readJsonBody, sendJson as send } from "./http.js";
import { ResourceMappingStore } from "../applications/mapping-store.js";
import type { InstanceSnapshot } from "../applications/instance-store.js";
import { resolve } from "node:path";
import {
  assertApplicationExecutionTarget,
  validApplicationExecutionTarget
} from "../applications/execution-target.js";
import { resolveApplicationProject } from "../applications/project-context.js";

interface ApplicationLocation {
  workspaceRoot: string;
  taskStorageRoot?: string;
  projectDirectory?: string;
  project?: ApplicationProject | null;
  activeRunId?: string;
}

/**
 * The shared workspace that holds documents belonging to no conversation.
 *
 * Named here so the routes can tell it apart from a real conversation: relating
 * a document out of it is a hand-off, while referencing one from another
 * conversation is sharing.
 */
const STANDALONE_TASK_ID = ApplicationService.STANDALONE_TASK;

/**
 * The Application HTTP surface.
 *
 * It is deliberately a separate router rather than more branches in the
 * Dashboard's request handler: resources, windows and the tab strip are their
 * own domain with their own error contract, and keeping them here is what lets
 * the Task, artifact and SSE routes stay readable.
 */
export interface ApplicationRouterContext {
  /** Resolve which workspace root owns a Task; the Dashboard knows about several. */
  locate(taskId: string): Promise<ApplicationLocation>;
  /**
   * Resolve which workspace root holds a resource.
   *
   * A document tab names only its resource, because a resource belongs to no
   * conversation — so the strip cannot reach a task to ask. The Dashboard scans
   * the roots it knows, the same way it locates a task.
   */
  locateResource(resourceId: string): Promise<{ workspaceRoot: string }>;
  /**
   * Every conversation that might reference a document.
   *
   * The strip needs this to say who is working on a shared file, and a
   * conversation can reference one without having a tab open — so the tabs
   * alone are not a complete list.
   */
  referencingTasks(): Promise<string[]>;
  /** Publish a resource event so the Task's existing SSE stream carries it. */
  publish(taskId: string, event: ApplicationEvent): Promise<void>;
  /**
   * Publish to every conversation that references a resource.
   *
   * One tab is shared by however many conversations reference the document, so
   * an edit has to reach all of their streams. Notifying only the acting
   * conversation left the other side refreshing on the 3.5s poll instead.
   */
  publishToReferencers(resourceId: string, event: ApplicationEvent): Promise<void>;
  /** Where the global tab strip is stored; it spans every task. */
  tabStorePath: string;
  /** Where a document with no conversation yet is created. */
  defaultWorkspaceRoot: string;
  createTemporaryWorkspace(): Promise<{ root: string }>;
  resolveSaveDirectory(root: unknown): Promise<string>;
  withProjectLock<T>(projectId: string, action: (project: ApplicationProject) => Promise<T>): Promise<T>;
  resolveWorkspace?(root: unknown): Promise<string>;
  workspaceRoots?(): Promise<string[]>;
  projectForWorkspace?(root: string): Promise<ApplicationProject | null>;
  projectForId?(projectId: string): Promise<ApplicationProject | null>;
  /**
   * Owns one MCP server process per open application window.
   *
   * Held by the Dashboard because a window's lifetime is the Dashboard's to
   * manage, while an Agent process is rebuilt every run. Passed in rather than
   * constructed here so the Dashboard can stop them all on the way out.
   */
  mcp: McpSupervisor;
}

const services = new Map<string, ApplicationService>();

function serviceFor(
  workspaceRoot: string,
  taskStorageRoot = workspaceRoot,
  project?: ApplicationProject | null
): ApplicationService {
  const key = JSON.stringify([resolve(workspaceRoot), resolve(taskStorageRoot), project]);
  let service = services.get(key);
  if (!service) {
    service = new ApplicationService(workspaceRoot, undefined, taskStorageRoot, project);
    services.set(key, service);
  }
  return service;
}

function locatedService(location: ApplicationLocation): ApplicationService {
  return serviceFor(
    location.workspaceRoot,
    location.taskStorageRoot ?? location.workspaceRoot,
    location.project
  );
}

/** New editor references live centrally; older root-local holding Tasks stay in place. */
async function standaloneService(
  context: ApplicationRouterContext,
  root: string
): Promise<ApplicationService> {
  const temporary = await readTemporaryWorkspace(root);
  return serviceFor(root, temporary?.taskStorageRoot ?? context.defaultWorkspaceRoot);
}

function standaloneResourceLocations(context: ApplicationRouterContext, workspaceRoot: string) {
  return [...new Set([resolve(context.defaultWorkspaceRoot), resolve(workspaceRoot)])].map(
    (taskStorageRoot) => ({ workspaceRoot, taskStorageRoot })
  );
}

async function standaloneResourceLocation(
  context: ApplicationRouterContext,
  resourceId: string
): Promise<ApplicationLocation> {
  const { workspaceRoot } = await context.locateResource(resourceId);
  const locations = standaloneResourceLocations(context, workspaceRoot);
  for (const location of locations) {
    const references = await locatedService(location).mapping.list(STANDALONE_TASK_ID);
    if (
      references.some(
        (entry) =>
          entry.resourceId === resourceId &&
          resolve(entry.workspaceRoot ?? location.taskStorageRoot) === resolve(workspaceRoot)
      )
    )
      return location;
  }
  throw new ApplicationError("resource_not_found", "资源不存在或独立编辑工作区没有引用它", { resourceId });
}

async function requireTaskWorkspace(
  taskId: string,
  location: ApplicationLocation,
  root: string
): Promise<void> {
  const storageRoot = location.taskStorageRoot ?? location.workspaceRoot;
  const allowed = [storageRoot, location.workspaceRoot, location.projectDirectory].filter(Boolean);
  if (allowed.some((entry) => resolve(entry!) === resolve(root))) return;
  if (await readTemporaryWorkspace(root)) return;
  const references = await new ResourceMappingStore(storageRoot).list(taskId);
  if (references.some((entry) => resolve(entry.workspaceRoot ?? storageRoot) === resolve(root))) return;
  throw new ApplicationError("invalid_operation", "请在此应用所在的工作区中选择会话", {});
}

async function locateInstance(
  context: ApplicationRouterContext,
  appInstanceId: string
): Promise<ApplicationLocation> {
  return instanceResolution(context).locate(appInstanceId);
}

/** Request-scoped indexes retain aliases and freshness without rescanning every root per window. */
function instanceResolution(context: ApplicationRouterContext) {
  const defaultRoot = resolve(context.defaultWorkspaceRoot);
  const index = cachedLookup<InstanceSnapshot | undefined>(async (workspaceRoot) => {
    const store = serviceFor(workspaceRoot).instances;
    if (workspaceRoot !== defaultRoot && !(await store.hasInstanceData())) return undefined;
    return store.readSnapshot();
  });
  const location = cachedLookup<ApplicationLocation>(async (workspaceRoot) => ({
    workspaceRoot,
    taskStorageRoot:
      workspaceRoot === defaultRoot
        ? defaultRoot
        : ((await readTemporaryWorkspace(workspaceRoot))?.taskStorageRoot ?? defaultRoot)
  }));
  const roots = async () => {
    const found = new Set((await context.workspaceRoots?.())?.map((root) => resolve(root)));
    if (!context.workspaceRoots)
      for (const taskId of await context.referencingTasks()) {
        // eslint-disable-next-line no-restricted-syntax -- 引用表里的任务可能已被删除，扫描跳过它而不是让整个窗口索引失败
        const task = await context.locate(taskId).catch(() => undefined);
        if (task) found.add(resolve(task.workspaceRoot));
      }
    return found;
  };
  const read = cachedLookup(async (appInstanceId) => {
    const home = (await index(defaultRoot))?.get(appInstanceId);
    if (home) return { location: await location(defaultRoot), instance: home };
    for (const root of await roots()) {
      if (root === defaultRoot) continue;
      const instance = (await index(root))?.get(appInstanceId);
      if (instance) return { location: await location(root), instance };
    }
    throw new ApplicationError("instance_not_found", "应用实例不存在", { appInstanceId });
  });
  return {
    read,
    index: (root: string) => index(resolve(root)),
    locate: async (id: string) => (await read(id)).location,
    refresh() {
      index.clear();
      read.clear();
    }
  };
}

/** The browser always acts as the person sitting in front of it. */
const uiActor: Actor = { type: "user", id: "local" };

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return await readJsonBody(request, RESOURCE_LIMITS.maxContentBytes + 1024 * 1024);
  } catch (error) {
    if (error instanceof HttpError)
      throw new ApplicationError(
        error.status === 413 ? "resource_too_large" : "invalid_operation",
        error.message
      );
    throw error;
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new ApplicationError("invalid_operation", `${field} 不能为空`, { field });
  return value;
}

/**
 * Read a numeric query parameter, refusing anything that is not one.
 *
 * `Number("abc")` is NaN, which `??` does not substitute for: it flowed into
 * `Math.min`/`slice(-NaN)` and returned the entire operation log, and into
 * `revision > NaN` and dropped every operation while reporting `hasMore: false`.
 */
function numericQuery(url: URL, field: string): number | undefined {
  const raw = url.searchParams.get(field);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ApplicationError("invalid_operation", `${field} 必须是非负整数`, { field, received: raw });
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ApplicationError("invalid_operation", `${field} 必须是非负整数`, { field });
  }
  return value;
}

/**
 * Route one request, or report that this router does not own the path.
 *
 * Return false for paths this router does not own so the Dashboard can pass
 * them to the next handler instead of prematurely returning 404.
 */
export async function handleApplicationRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ApplicationRouterContext
): Promise<boolean> {
  const method = request.method ?? "GET";
  try {
    if (method === "GET" && url.pathname === "/api/applications") {
      // The catalog is static and does not belong to a Task, so it is answered
      // from the registry alone.
      send(response, 200, { applications: new ApplicationService(".").definitions() });
      return true;
    }

    if (url.pathname === "/api/workbench/temporary-resources" && method === "GET") {
      const resources = [];
      for (const root of (await context.workspaceRoots?.()) ?? []) {
        const temporary = await readTemporaryWorkspace(root);
        if (!temporary) continue;
        const service = serviceFor(root, temporary.taskStorageRoot);
        for (const resource of await service.listResources(temporary.holdingTaskId))
          resources.push({ ...resource, accessTaskId: temporary.holdingTaskId, workspaceRoot: root });
      }
      send(response, 200, { resources });
      return true;
    }

    if (url.pathname === "/api/workbench/open-application" && method === "POST") {
      // Independent launches allocate a durable temporary workspace unless
      // the caller explicitly chooses a persistent workspace.
      const body = await readBody(request);
      const appType = requiredString(body.appType, "appType");
      new ApplicationService(".").registry.require(appType);
      const root =
        body.workspaceRoot === undefined
          ? (await context.createTemporaryWorkspace()).root
          : await resolveRequestedWorkspace(context, body.workspaceRoot);
      const project = (await context.projectForWorkspace?.(root)) ?? null;
      const service = new ApplicationService(
        root,
        undefined,
        (await readTemporaryWorkspace(root))?.taskStorageRoot ?? context.defaultWorkspaceRoot,
        project
      );
      const taskId = await service.ensureStandaloneWorkspace();
      const appInstance = await service.openApplication({ taskId, appType, fresh: true });
      // A window opened on its own gets its server like any other: the two
      // open routes must not differ in what the window can do.
      const mcpStatus = await startWindowServer(context, service, taskId, appInstance);
      const tabs = new WorkbenchTabStore(context.tabStorePath);
      await tabs.open({ kind: "application", appInstanceId: appInstance.appInstanceId });
      send(response, 201, {
        appInstance,
        taskId,
        ...(mcpStatus ? { mcp: mcpStatus } : {}),
        ...(await withResolvedTabs(tabs, context))
      });
      return true;
    }

    if (
      (url.pathname === "/api/workbench/load-instance" || url.pathname === "/api/workbench/bind-resource") &&
      method === "POST"
    ) {
      const body = await readBody(request);
      const taskId = requiredString(body.taskId, "taskId");
      const location = await context.locate(taskId);
      let service = locatedService(location);
      let appInstanceId =
        typeof body.appInstanceId === "string"
          ? body.appInstanceId
          : typeof body.fromAppInstanceId === "string"
            ? body.fromAppInstanceId
            : undefined;
      if (!appInstanceId && typeof body.resourceId === "string") {
        const resourceLocation = await context.locateResource(body.resourceId);
        await requireTaskWorkspace(taskId, location, resourceLocation.workspaceRoot);
        service = serviceFor(
          resourceLocation.workspaceRoot,
          location.taskStorageRoot ?? location.workspaceRoot
        );
        appInstanceId = (await service.openResource({ taskId, resourceId: body.resourceId })).appInstanceId;
      }
      if (appInstanceId) {
        const instanceLocation = await locateInstance(context, appInstanceId);
        await requireTaskWorkspace(taskId, location, instanceLocation.workspaceRoot);
        service = serviceFor(
          instanceLocation.workspaceRoot,
          location.taskStorageRoot ?? location.workspaceRoot
        );
      }
      const instance = await service.loadInstance(taskId, appInstanceId);
      const tabs = new WorkbenchTabStore(context.tabStorePath);
      if (instance) {
        await tabs.open({ kind: "application", appInstanceId: instance.appInstanceId }, { activate: false });
        await startWindowServer(context, service, taskId, instance);
      }
      const resource = instance?.resourceIds[0]
        ? await service.resources.readMetadataById(instance.resourceIds[0])
        : undefined;
      send(response, 200, { appInstance: instance, resource, ...(await withResolvedTabs(tabs, context)) });
      return true;
    }

    if (url.pathname.startsWith("/api/workbench/mcp/")) {
      const leaf = url.pathname.slice("/api/workbench/mcp/".length);
      if (leaf === "status" && method === "GET") {
        send(response, 200, { servers: await context.mcp.statuses() });
        return true;
      }
      if (leaf === "tools" && method === "GET") {
        // A document is named by itself; an empty editor still by its window.
        // The Agent asks by resource, because that is what it is bound to.
        const askedResource = url.searchParams.get("resourceId");
        if (askedResource) {
          const root = (await context.locateResource(askedResource)).workspaceRoot;
          const service = serviceFor(root);
          const resource = await service.resources.readMetadataById(askedResource);
          await reviveResourceServer(context, service, askedResource, resource.appType);
          send(response, 200, { tools: await context.mcp.listTools(resourceConsumer(askedResource)) });
          return true;
        }
        const taskId = requiredString(url.searchParams.get("taskId"), "taskId");
        const appInstanceId = requiredString(url.searchParams.get("appInstanceId"), "appInstanceId");
        // Revive the window's server if it is not running. The Dashboard can be
        // restarted while a window stays open in the strip, and `ensure` is only
        // called when a window is opened or bound — so without this the window
        // came back with no tools and had no way to ever get them again.
        await reviveWindowServer(context, taskId, appInstanceId);
        const owner = await locatedService(await context.locate(taskId))
          .instances.readInstance(taskId, appInstanceId)
          // eslint-disable-next-line no-restricted-syntax -- 窗口记录可能已被移除，消费者回退到 instance: 键仍然返回该窗口的工具
          .catch(() => undefined);
        const consumer = owner?.resourceIds[0]
          ? resourceConsumer(owner.resourceIds[0])
          : `instance:${appInstanceId}`;
        send(response, 200, { tools: await context.mcp.listTools(consumer) });
        return true;
      }
      if (leaf === "call" && method === "POST") {
        const body = await readBody(request);
        const controller = new AbortController();
        const cancel = () => {
          if (!response.writableEnded) controller.abort();
        };
        response.once("close", cancel);
        if (response.destroyed) cancel();
        try {
          const taskId = requiredString(body.taskId, "taskId");
          const location = await context.locate(taskId);
          const resourceId = requiredString(body.resourceId, "resourceId");
          const service = await locatedService(location).serviceForResource(taskId, resourceId);
          if (body.executionTarget !== undefined && !validApplicationExecutionTarget(body.executionTarget))
            throw new HttpError(400, "executionTarget 必须是完整的应用资源执行归属");
          const executionTarget = validApplicationExecutionTarget(body.executionTarget)
            ? body.executionTarget
            : undefined;
          // Read the resource here rather than trusting the caller's revision:
          // the server is told what is actually on disk, so its returned
          // operations are based on the real current state.
          const read = await service.readResource(taskId, resourceId, {
            limit: 1,
            expectedResourceWorkspaceRoot: executionTarget?.resourceWorkspaceRoot
          });
          if (executionTarget)
            await assertApplicationExecutionTarget(service, read.resource, executionTarget);
          // Same revival as the tools route: a call is the other way a
          // document's server is reached after a restart. Keyed by the document,
          // so a caller does not have to know which window it is looking through.
          await reviveResourceServer(context, service, resourceId, read.resource.appType);
          const outcome = await context.mcp.callTool({
            consumer: resourceConsumer(resourceId),
            signal: controller.signal,
            taskId,
            name: requiredString(body.name, "name"),
            params:
              body.params && typeof body.params === "object" ? (body.params as Record<string, unknown>) : {},
            resource: {
              resourceId,
              revision: read.resource.revision,
              path: read.resource.path,
              kind: read.resource.kind
            }
          });
          controller.signal.throwIfAborted();
          send(response, 200, { ...outcome, baseRevision: read.resource.revision });
        } finally {
          response.off("close", cancel);
        }
        return true;
      }
      send(response, 404, {
        error: { code: "invalid_operation", message: "unknown mcp route", retryable: false }
      });
      return true;
    }

    if (url.pathname === "/api/workbench/revisions" && method === "GET") {
      const tabs = await new WorkbenchTabStore(context.tabStorePath).read();
      const resolved = instanceResolution(tabResolutionContext(context));
      const requested = new Set(url.searchParams.getAll("appInstanceId"));
      const instances = await Promise.all(
        tabs.tabs
          .filter(
            (tab) =>
              tab.kind === "application" &&
              tab.appInstanceId &&
              (!requested.size || requested.has(tab.appInstanceId))
          )
          .map(async (tab) => {
            try {
              const { location, instance } = await resolved.read(tab.appInstanceId!);
              const service = locatedService(location);
              if (instance.status === "closed") return undefined;
              const resourceId = instance.resourceIds[0];
              const resource = resourceId
                ? await service.resources.readCommittedMetadataById(resourceId)
                : undefined;
              if (resourceId && !resource) return undefined;
              return {
                appInstanceId: instance.appInstanceId,
                appType: instance.appType,
                resourceId,
                revision: resource?.revision,
                contentVersion: resource?.contentVersion,
                title: resource?.title ?? instance.title
              };
              // eslint-disable-next-line no-restricted-syntax -- 关闭或删除的实例在下次常规刷新时会被裁掉，这里跳过该行即可
            } catch {
              // Closed/deleted instances disappear on the regular tab refresh.
              return undefined;
            }
          })
      );
      send(response, 200, { instances: instances.filter((instance) => instance !== undefined) });
      return true;
    }

    if (url.pathname === "/api/workbench/tabs") {
      const tabs = new WorkbenchTabStore(context.tabStorePath);
      if (method === "GET") {
        // Prune on read: a tab whose task or instance is gone would otherwise
        // sit in the strip forever pointing at nothing.
        send(response, 200, await withResolvedTabs(tabs, context));
        return true;
      }
      if (method === "POST") {
        const body = await readBody(request);
        const kind = body.kind === "conversation" ? "conversation" : "application";
        const taskId = kind === "conversation" ? requiredString(body.taskId, "taskId") : undefined;
        let appInstanceId = typeof body.appInstanceId === "string" ? body.appInstanceId : undefined;
        if (kind === "conversation") await context.locate(taskId!);
        else {
          if (!appInstanceId && typeof body.resourceId === "string") {
            const root = await context.locateResource(body.resourceId);
            const service = await standaloneService(context, root.workspaceRoot);
            appInstanceId = (
              await service.openResource({
                taskId: await service.ensureStandaloneWorkspace(),
                resourceId: body.resourceId
              })
            ).appInstanceId;
          }
          if (!appInstanceId) throw new ApplicationError("invalid_operation", "应用标签需要实例 ID", {});
          const root = await locateInstance(context, appInstanceId);
          const service = locatedService(root);
          const instance = await service.instances.readInstance(appInstanceId);
          appInstanceId = instance.appInstanceId;
          // Legacy clients may explicitly request loading alongside opening. No implicit task fallback.
          if (typeof body.bindTo === "string" && body.bindTo) {
            const target = await context.locate(body.bindTo);
            await requireTaskWorkspace(body.bindTo, target, root.workspaceRoot);
            await serviceFor(root.workspaceRoot, target.taskStorageRoot ?? target.workspaceRoot).loadInstance(
              body.bindTo,
              appInstanceId
            );
          }
          if (instance.status !== "closed")
            await startWindowServer(context, service, STANDALONE_TASK_ID, instance);
        }
        await tabs.open({ kind, taskId, appInstanceId }, { activate: body.activate !== false });
        send(response, 200, await withResolvedTabs(tabs, context));
        return true;
      }
      if (method === "PATCH") {
        const body = await readBody(request);
        // `tabId: null` means "no tab in front", which a new conversation needs
        // to record: leaving the old one active would have the next poll put
        // that editor straight back over the conversation.
        if (body.tabId === null) await tabs.clearActive();
        else {
          let id = requiredString(body.tabId, "tabId");
          if (id.startsWith("resource:"))
            id =
              (await withResolvedTabs(tabs, context)).tabs.find((tab) => tab.resourceId === id.slice(9))
                ?.tabId ?? id;
          await tabs.activate(id);
        }
        send(response, 200, await withResolvedTabs(tabs, context));
        return true;
      }
      if (method === "DELETE") {
        const body = await readBody(request);
        const tabId = requiredString(body.tabId, "tabId");
        // Closing the visible tab does not change what any conversation loads.
        await tabs.close(tabId);
        send(response, 200, await withResolvedTabs(tabs, context));
        return true;
      }
      send(response, 405, {
        error: { code: "invalid_operation", message: "method not allowed", retryable: false }
      });
      return true;
    }

    const globalInstance = url.pathname.match(/^\/api\/workbench\/instances\/([^/]+)(?:\/(.*))?$/);
    const match = url.pathname.match(
      /^\/api\/tasks\/([^/]+)\/(resources|app-instances|active-app-context)(?:\/(.*))?$/
    );
    if (!match && !globalInstance) return false;
    let taskId = globalInstance ? STANDALONE_TASK_ID : decodeURIComponent(match![1]);
    const section = globalInstance ? "app-instances" : match![2];
    const rest = globalInstance
      ? [
          decodeURIComponent(globalInstance[1]),
          ...(globalInstance[2] ? globalInstance[2].split("/").map(decodeURIComponent) : [])
        ]
      : match![3]
        ? match![3].split("/").map(decodeURIComponent)
        : [];
    let location: ApplicationLocation = globalInstance
      ? await locateInstance(context, rest[0])
      : taskId === STANDALONE_TASK_ID && section === "resources" && rest[0]
        ? await standaloneResourceLocation(context, rest[0])
        : taskId === STANDALONE_TASK_ID && section === "resources" && url.searchParams.has("workspaceRoot")
          ? {
              workspaceRoot: await resolveRequestedWorkspace(context, url.searchParams.get("workspaceRoot")),
              taskStorageRoot: context.defaultWorkspaceRoot
            }
          : await context.locate(taskId);
    if (globalInstance)
      location.project = (await context.projectForWorkspace?.(location.workspaceRoot)) ?? null;
    if (!globalInstance && taskId !== STANDALONE_TASK_ID && rest[0]) {
      if (section === "resources") {
        const reference = (
          await new ResourceMappingStore(location.taskStorageRoot ?? location.workspaceRoot).list(taskId)
        ).find((entry) => entry.resourceId === rest[0]);
        if (reference)
          location = {
            ...location,
            workspaceRoot: reference.workspaceRoot ?? location.taskStorageRoot ?? location.workspaceRoot
          };
      } else if (section === "app-instances" && !["open", "unbind"].includes(rest[0])) {
        const owner = await locateInstance(context, rest[0]);
        await requireTaskWorkspace(taskId, location, owner.workspaceRoot);
        location = {
          ...location,
          workspaceRoot: owner.workspaceRoot,
          project: (await context.projectForWorkspace?.(owner.workspaceRoot)) ?? null
        };
      }
    }
    const service = locatedService(location);
    if (globalInstance) taskId = await service.ensureStandaloneWorkspace();
    if (taskId === STANDALONE_TASK_ID && section === "resources" && !rest[0])
      await service.ensureStandaloneWorkspace();
    const emit = (event: ApplicationEvent) => {
      const shared =
        event.resourceId &&
        (event.type === "resource.operation_applied" || event.type === "resource.selection_changed");
      const published = shared
        ? context.publishToReferencers(event.resourceId!, event)
        : context.publish(taskId, event);
      void published.catch((error) => console.error("Application event publication failed:", error));
    };

    if (section === "active-app-context" && method === "GET") {
      const agentId = url.searchParams.get("agentId") ?? "main";
      const active = await service.activeContext({ taskId, agentId });
      send(
        response,
        200,
        active ? { context: active, rendered: service.context.render(active) } : { context: null }
      );
      return true;
    }

    if (section === "resources") {
      if (method === "GET" && rest.length === 0) {
        const resources =
          taskId === STANDALONE_TASK_ID
            ? (
                await Promise.all(
                  standaloneResourceLocations(context, location.workspaceRoot).map(async (scope) => {
                    const scopedService = locatedService(scope);
                    const references = (await scopedService.mapping.list(taskId)).filter(
                      (entry) =>
                        resolve(entry.workspaceRoot ?? scope.taskStorageRoot) ===
                        resolve(location.workspaceRoot)
                    );
                    return scopedService.resources.listResources(references);
                  })
                )
              ).flat()
            : await service.listResources(taskId);
        send(response, 200, {
          resources: [...new Map(resources.map((resource) => [resource.resourceId, resource])).values()]
        });
        return true;
      }
      if (method === "POST" && rest.length === 0) {
        const body = await readBody(request);
        // Opening an artifact is a distinct act from creating a blank resource:
        // Text comes from disk; interchange conversions include the file hash
        // so the service can validate and reuse their persisted import identity.
        if (typeof body.fromArtifact === "string") {
          const imported = await service.importArtifact(
            {
              taskId,
              relativePath: body.fromArtifact,
              appType: typeof body.appType === "string" ? body.appType : undefined,
              ...(body.artifactSha256 !== undefined
                ? {
                    converted: {
                      sha256: requiredString(body.artifactSha256, "artifactSha256"),
                      kind: requiredString(body.kind, "kind"),
                      title: requiredString(body.title, "title"),
                      initialContent: body.initialContent
                    }
                  }
                : {}),
              actor: uiActor
            },
            emit
          );
          send(response, 201, imported);
          return true;
        }
        const created = await service.createResource(
          {
            taskId,
            appType: typeof body.appType === "string" ? body.appType : undefined,
            kind: requiredString(body.kind, "kind"),
            title: requiredString(body.title, "title"),
            initialContent: body.initialContent,
            actor: uiActor
          },
          emit
        );
        send(response, 201, created);
        return true;
      }
      const resourceId = rest[0];
      if (method === "GET" && rest.length === 1) {
        send(
          response,
          200,
          await service.readResource(taskId, resourceId, {
            afterRevision: numericQuery(url, "afterRevision"),
            limit: numericQuery(url, "limit")
          })
        );
        return true;
      }
      if (method === "POST" && rest[1] === "save-copy") {
        const body = await readBody(request);
        const format = requiredString(body.format, "format");
        const revision = requiredNumber(body.revision, "revision");
        if (body.projectId !== undefined) {
          if (body.directory !== undefined)
            throw new ApplicationError("invalid_operation", "请选择目录或项目之一", {});
          const result = await context.withProjectLock(
            requiredString(body.projectId, "projectId"),
            (project) =>
              service.saveCopy({
                taskId,
                resourceId,
                directory: project.projectDirectory,
                project,
                format,
                revision
              })
          );
          send(response, 200, result);
        } else {
          const directory = await context.resolveSaveDirectory(requiredString(body.directory, "directory"));
          send(response, 200, await service.saveCopy({ taskId, resourceId, directory, format, revision }));
        }
        return true;
      }
      if (method === "GET" && rest[1] === "review") {
        send(response, 200, await service.reviewResource(taskId, resourceId));
        return true;
      }
      if (method === "GET" && rest[1] === "operations") {
        const read = await service.readResource(taskId, resourceId, {
          afterRevision: numericQuery(url, "afterRevision"),
          limit: numericQuery(url, "limit") ?? 100
        });
        send(response, 200, {
          operations: read.operations,
          hasMore: read.hasMore,
          revision: read.resource.revision
        });
        return true;
      }
      if (method === "POST" && rest[1] === "operations") {
        const body = await readBody(request);
        const outcome = await service.applyOperation(
          {
            taskId,
            resourceId,
            operationId: requiredString(body.operationId, "operationId"),
            appType: requiredString(body.appType, "appType"),
            operationType: requiredString(body.operationType, "operationType"),
            baseRevision: requiredNumber(body.baseRevision, "baseRevision"),
            payload: body.payload,
            appInstanceId: typeof body.appInstanceId === "string" ? body.appInstanceId : undefined,
            actor: uiActor
          },
          emit
        );
        send(response, 200, {
          event: outcome.event,
          resource: outcome.resource,
          snapshot: {
            revision: outcome.snapshot.revision,
            content: outcome.snapshot.content,
            contentVersion: outcome.snapshot.contentVersion
          },
          deduplicated: outcome.deduplicated
        });
        return true;
      }
      if (method === "POST" && rest[1] === "commands") {
        const body = await readBody(request),
          controller = new AbortController();
        const cancel = () => {
          if (!response.writableEnded) controller.abort();
        };
        response.once("close", cancel);
        try {
          if (!body.params || typeof body.params !== "object" || Array.isArray(body.params))
            throw new ApplicationError("invalid_operation", "命令参数须为对象", {});
          send(
            response,
            200,
            await service.executeResourceCommand(
              {
                taskId,
                resourceId,
                command: requiredString(body.command, "command"),
                params: body.params as Record<string, unknown>,
                baseRevision: requiredNumber(body.baseRevision, "baseRevision"),
                operationId: requiredString(body.operationId, "operationId"),
                actor: uiActor,
                signal: controller.signal
              },
              emit
            )
          );
        } finally {
          response.off("close", cancel);
        }
        return true;
      }
      if (method === "POST" && rest[1] === "import-native") {
        const controller = new AbortController(),
          chunks: Buffer[] = [];
        let size = 0;
        const cancel = () => {
          if (!response.writableEnded) controller.abort();
        };
        response.once("close", cancel);
        try {
          const revision = Number(url.searchParams.get("revision"));
          if (!url.searchParams.has("revision") || !Number.isSafeInteger(revision) || revision < 0)
            throw new ApplicationError("invalid_operation", "导入需要有效资源版本", {});
          for await (const chunk of request) {
            const bytes = Buffer.from(chunk);
            size += bytes.length;
            if (size > 64 * 1024 * 1024)
              throw new ApplicationError("resource_too_large", "导入文件超过 64 MiB", {});
            chunks.push(bytes);
          }
          send(
            response,
            200,
            await service.importNativeResource(
              {
                taskId,
                resourceId,
                body: Buffer.concat(chunks),
                baseRevision: revision,
                operationId: requiredString(url.searchParams.get("operationId"), "operationId"),
                actor: uiActor,
                signal: controller.signal
              },
              emit
            )
          );
        } finally {
          response.off("close", cancel);
        }
        return true;
      }
      if (method === "GET" && rest[1] === "attachments" && rest.length === 3) {
        const revision = Number(url.searchParams.get("revision"));
        if (!url.searchParams.has("revision") || !Number.isSafeInteger(revision) || revision < 0)
          throw new ApplicationError("invalid_operation", "附件需要有效资源版本", {});
        const attachment = await service.readResourceAttachment({
          taskId,
          resourceId,
          name: rest[2],
          revision
        });
        response.writeHead(200, {
          "content-type": attachment.mimeType,
          "x-content-type-options": "nosniff",
          "cache-control": "no-store"
        });
        response.end(attachment.body);
        return true;
      }
      if (method === "POST" && rest[1] === "undo") {
        const body = await readBody(request);
        if (
          body.baseRevision !== undefined &&
          (!Number.isSafeInteger(body.baseRevision) || Number(body.baseRevision) < 0)
        )
          throw new ApplicationError("invalid_operation", "无效的对比版本");
        const outcome = await service.undo(
          {
            taskId,
            resourceId,
            actor: uiActor,
            baseRevision: typeof body.baseRevision === "number" ? body.baseRevision : undefined,
            eventId: typeof body.eventId === "string" ? body.eventId : undefined,
            appInstanceId: typeof body.appInstanceId === "string" ? body.appInstanceId : undefined
          },
          emit
        );
        send(response, 200, {
          event: outcome.event,
          resource: outcome.resource,
          snapshot: {
            revision: outcome.snapshot.revision,
            content: outcome.snapshot.content,
            contentVersion: outcome.snapshot.contentVersion
          }
        });
        return true;
      }
      if (method === "PUT" && rest[1] === "selection") {
        const body = await readBody(request);
        send(response, 200, {
          selection: await service.saveSelection(
            {
              taskId,
              resourceId,
              schema: requiredString(body.schema, "schema"),
              data: body.data,
              appInstanceId: typeof body.appInstanceId === "string" ? body.appInstanceId : undefined,
              actor: uiActor
            },
            emit
          )
        });
        return true;
      }
      if (method === "PATCH" && rest.length === 1) {
        const body = await readBody(request);
        send(response, 200, {
          resource: await service.renameResource(
            {
              taskId,
              resourceId,
              title: requiredString(body.title, "title")
            },
            emit
          )
        });
        return true;
      }
      if (method === "POST" && rest[1] === "preview") {
        const body = await readBody(request);
        const controller = new AbortController();
        const cancel = () => {
          if (!response.writableEnded) controller.abort();
        };
        response.once("close", cancel);
        try {
          send(
            response,
            200,
            await service.previewResource({
              taskId,
              resourceId,
              content: body.content,
              options: body.options as Record<string, unknown> | undefined,
              signal: controller.signal
            })
          );
        } finally {
          response.off("close", cancel);
        }
        return true;
      }
      if (method === "POST" && rest[1] === "save-source") {
        const body = await readBody(request);
        if (body.revision !== undefined && (!Number.isInteger(body.revision) || Number(body.revision) < 0))
          throw new ApplicationError("invalid_operation", "无效文档版本", {});
        send(response, 200, {
          resource: await service.saveSourceFile(taskId, resourceId, body.revision as number | undefined)
        });
        return true;
      }
      if (method === "GET" && rest[1] === "download") {
        const rawOptions = url.searchParams.get("options");
        let options: Record<string, unknown> | undefined;
        if (rawOptions !== null) {
          if (rawOptions.length > 4096) throw new ApplicationError("invalid_operation", "导出选项过大", {});
          const parsed: unknown = JSON.parse(rawOptions);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new ApplicationError("invalid_operation", "导出选项须为对象", {});
          options = parsed as Record<string, unknown>;
        }
        // Save-a-copy, not publish: this renders the current revision for the
        // browser to write wherever the person chooses, and leaves artifacts/
        // and publishedRevision untouched.
        const controller = new AbortController();
        const cancel = () => {
          if (!response.writableEnded) controller.abort();
        };
        response.once("close", cancel);
        try {
          const rendered = await service.renderForDownload({
            taskId,
            resourceId,
            format: url.searchParams.get("format") ?? "markdown",
            options,
            signal: controller.signal
          });
          const filename = encodeURIComponent(rendered.fileName).replace(
            /['()*]/g,
            (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
          );
          response.writeHead(200, {
            "content-type": rendered.mimeType.startsWith("text/")
              ? `${rendered.mimeType}; charset=utf-8`
              : rendered.mimeType,
            "content-disposition": `attachment; filename*=UTF-8''${filename}`,
            "x-content-type-options": "nosniff",
            "cache-control": "no-store"
          });
          response.end(
            typeof rendered.body === "string" ? Buffer.from(rendered.body, "utf8") : rendered.body
          );
        } finally {
          response.off("close", cancel);
        }
        return true;
      }
      if (method === "POST" && rest[1] === "open") {
        send(response, 200, { appInstance: await service.openResource({ taskId, resourceId }, emit) });
        return true;
      }
    }

    if (section === "app-instances") {
      if (globalInstance && method === "GET" && rest.length === 1) {
        send(response, 200, { appInstance: await service.instances.readInstance(rest[0]) });
        return true;
      }
      if (method === "GET" && rest.length === 0) {
        send(response, 200, await service.taskSummary(taskId));
        return true;
      }
      // Detaching the conversation from every application is its own act, not
      // a falsy `active` on some instance: the Runtime has to tell "nothing
      // recorded yet" apart from "the user said just talk to me".
      // Opening an application is not creating a document; the window may hold
      // nothing until the person opens or creates one.
      if (method === "POST" && rest[0] === "open" && rest.length === 1) {
        const body = await readBody(request);
        const instance = await service.openApplication(
          {
            taskId,
            appType: requiredString(body.appType, "appType")
          },
          emit
        );
        // Start the application's own server, if it declares one. A failure
        // here only means this window has no tools of its own, so the window
        // still opens.
        const mcpStatus = await startWindowServer(context, service, taskId, instance);
        send(response, 201, { appInstance: instance, taskId, ...(mcpStatus ? { mcp: mcpStatus } : {}) });
        return true;
      }
      if (method === "POST" && rest[1] === "resources" && rest.length === 2) {
        const native = request.headers["content-type"] === "application/octet-stream";
        const controller = new AbortController();
        const cancel = () => {
          if (!response.writableEnded) controller.abort();
        };
        response.once("close", cancel);
        try {
          let nativeBody: Buffer | undefined;
          if (native) {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of request) {
              const bytes = Buffer.from(chunk);
              size += bytes.length;
              if (size > 64 * 1024 * 1024)
                throw new ApplicationError("resource_too_large", "导入文件超过 64 MiB", {});
              chunks.push(bytes);
            }
            if (!size) throw new ApplicationError("invalid_operation", "文件不能为空", {});
            nativeBody = Buffer.concat(chunks);
          }
          const body = native
            ? {
                kind: url.searchParams.get("kind"),
                title: url.searchParams.get("title"),
                initialContent: undefined,
                sourceFile: url.searchParams.has("sourcePath")
                  ? {
                      path: url.searchParams.get("sourcePath"),
                      contentVersion: url.searchParams.get("sourceVersion")
                    }
                  : undefined
              }
            : await readBody(request);
          if (globalInstance) await service.ensureStandaloneWorkspace();
          const created = await service.createInApplication(
            {
              taskId,
              appInstanceId: rest[0],
              kind: requiredString(body.kind, "kind"),
              title: requiredString(body.title, "title"),
              initialContent: body.initialContent,
              nativeBody,
              sourceFile: body.sourceFile as { path: string; contentVersion: string } | undefined,
              signal: controller.signal,
              actor: uiActor
            },
            emit
          );
          // eslint-disable-next-line no-restricted-syntax -- 资源已经创建成功，窗口服务器启动失败不能把这次创建变成失败响应
          await startWindowServer(context, service, taskId, created.appInstance).catch(() => {});
          send(response, 201, created);
        } finally {
          response.off("close", cancel);
        }
        return true;
      }
      if (method === "POST" && rest[0] === "unbind" && rest.length === 1) {
        await service.bindResource(taskId, undefined);
        send(response, 200, await service.taskSummary(taskId));
        return true;
      }
      if (method === "POST" && rest.length === 0) {
        const body = await readBody(request);
        const instance = await service.instances.createInstance({
          taskId,
          appType: requiredString(body.appType, "appType"),
          title: requiredString(body.title, "title"),
          resourceIds: Array.isArray(body.resourceIds)
            ? body.resourceIds.filter((id): id is string => typeof id === "string")
            : []
        });
        emit({
          type: "application.instance_opened",
          taskId,
          appType: instance.appType,
          appInstanceId: instance.appInstanceId,
          payload: { title: instance.title }
        });
        send(response, 201, { appInstance: instance });
        return true;
      }
      if (method === "PATCH" && rest.length === 1) {
        const body = await readBody(request);
        const status = body.status;
        if (status !== undefined && status !== "open" && status !== "background" && status !== "closed") {
          throw new ApplicationError("invalid_operation", "status 只能是 open、background 或 closed", {});
        }
        // The window is going away, so its server must too — otherwise every
        // closed editor leaves a process behind for the Dashboard's lifetime.
        if (status === "closed") {
          // eslint-disable-next-line no-restricted-syntax -- 窗口记录可能已被删除，读不到时按空窗口的消费者键停止即可
          const closing = await service.instances.readInstance(taskId, rest[0]).catch(() => undefined);
          const held = closing?.resourceIds[0];
          // A document may still be open elsewhere, so its consumer is only
          // released when the document itself goes; an empty window owns its
          // consumer outright.
          // eslint-disable-next-line no-restricted-syntax -- 关闭窗口是清理动作，进程可能已经退出，停止失败不影响本次状态更新
          await context.mcp.stop(held ? resourceConsumer(held) : `instance:${rest[0]}`).catch(() => {});
        }
        send(response, 200, {
          appInstance: await service.updateInstance(
            {
              taskId,
              appInstanceId: rest[0],
              status,
              resourceIds: Array.isArray(body.resourceIds)
                ? body.resourceIds.filter((id): id is string => typeof id === "string")
                : undefined,
              uiState:
                body.uiState && typeof body.uiState === "object"
                  ? (body.uiState as Record<string, unknown>)
                  : undefined,
              active: body.active === true
            },
            emit
          )
        });
        return true;
      }
    }

    send(response, 405, {
      error: { code: "invalid_operation", message: "method not allowed", retryable: false }
    });
    return true;
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return true;
    }
    const { status, body } = applicationErrorResponse(error);
    send(response, status, body);
    return true;
  }
}

/**
 * Resolve every tab to a title and a live check, dropping the dead ones.
 *
 * A tab points at a task and possibly an instance, either of which can be gone
 * by the time the strip is read — a task deleted, an instance closed from
 * another window. Resolving here keeps that decision in one place instead of
 * leaving the browser to render a tab for something that no longer exists.
 */
/** One resolved strip row, as the browser consumes it. */
type ResolvedTab = WorkbenchTabRecord & {
  title: string;
  taskGoal?: string;
  /** Task data lives independently of the application's physical resource root. */
  storageRoot?: string;
  appType?: string;
  unread?: number;
  standalone?: boolean;
  hasResource?: boolean;
  accessTaskId?: string;
  workspaceRoot?: string;
  project?: ApplicationProject | null;
  projectId?: string;
  /** Every conversation that references this document, for the chip and the acting task. */
  conversations?: Array<{ taskId: string; goal?: string; storageRoot: string }>;
  loadedConversations?: Array<{ taskId: string; goal?: string; storageRoot: string }>;
  relatedConversations?: Array<{ taskId: string; goal?: string; storageRoot: string }>;
  /** Per-conversation unread, because one shared tab has one badge but N cursors. */
  unreadByTask?: Record<string, number>;
  /** Which conversation's group this row sorts into, when one of them is open. */
  groupTaskId?: string;
  mcp?: { state: string; toolNames: string[]; error?: string };
};

/**
 * Convert a version 1 strip, which keyed document tabs by conversation.
 *
 * The store cannot do this itself: deciding whether `application:task:app_1`
 * is a document or an empty editor means reading the instance, and only here is
 * there a service to ask. Two legacy tabs on one document rekey onto the same
 * id, which merges them — that collapse *is* the fix, executing once.
 */
async function migrateLegacyTabs(
  tabs: WorkbenchTabStore,
  context: ApplicationRouterContext,
  instances: ReturnType<typeof instanceResolution>
): Promise<void> {
  for (const tab of (await tabs.read()).tabs) {
    if (tab.kind !== "application") continue;
    let appInstanceId = tab.appInstanceId;
    let root;
    if (tab.tabId.startsWith("application:")) {
      const [, taskId, legacyId] = tab.tabId.split(":");
      appInstanceId = legacyId;
      // eslint-disable-next-line no-restricted-syntax -- 旧版 Tab 可能指向已删除的任务，迁移时跳过这一条
      root = await context.locate(taskId).catch(() => undefined);
    } else if (appInstanceId) {
      // eslint-disable-next-line no-restricted-syntax -- 旧窗口可能已从实例索引消失，读不到时让 Tab 保持原样等下次刷新
      root = await instances.locate(appInstanceId).catch(() => undefined);
    } else if (tab.resourceId) {
      // eslint-disable-next-line no-restricted-syntax -- 旧版文档 Tab 可能指向已删除的资源，迁移时跳过这一条
      root = await context.locateResource(tab.resourceId).catch(() => undefined);
    }
    if (!root) continue;
    const instance = appInstanceId
      ? await instances
          .index(root.workspaceRoot)
          .then((snapshot) => snapshot?.get(appInstanceId))
          // eslint-disable-next-line no-restricted-syntax -- 某个根的快照读不出来时保留该 Tab 原样，下次刷新再迁移
          .catch(() => undefined)
      : await (async () => {
          const service = await standaloneService(context, root.workspaceRoot);
          return service.openResource({
            taskId: await service.ensureStandaloneWorkspace(),
            resourceId: tab.resourceId!
          });
        })();
    if (instance && (tab.tabId !== `window:${instance.appInstanceId}` || tab.taskId || tab.resourceId))
      await tabs.rekey(tab.tabId, { kind: "application", appInstanceId: instance.appInstanceId });
  }
}

function cachedLookup<T>(lookup: (key: string) => Promise<T>) {
  const values = new Map<string, Promise<T>>();
  const cached = (key: string) => {
    let value = values.get(key);
    if (!value) {
      value = lookup(key);
      values.set(key, value);
    }
    return value;
  };
  cached.clear = () => values.clear();
  return cached;
}

/** Discovery scans task mappings and manifests; share it within one strip snapshot only. */
function tabResolutionContext(context: ApplicationRouterContext): ApplicationRouterContext {
  let roots: Promise<string[]> | undefined;
  let tasks: Promise<string[]> | undefined;
  return {
    ...context,
    locate: cachedLookup((taskId) => context.locate(taskId)),
    locateResource: cachedLookup((resourceId) => context.locateResource(resourceId)),
    referencingTasks: () => (tasks ??= context.referencingTasks()),
    ...(context.workspaceRoots ? { workspaceRoots: () => (roots ??= context.workspaceRoots!()) } : {}),
    ...(context.projectForWorkspace
      ? { projectForWorkspace: cachedLookup((root) => context.projectForWorkspace!(root)) }
      : {}),
    ...(context.projectForId
      ? { projectForId: cachedLookup((projectId) => context.projectForId!(projectId)) }
      : {})
  };
}

async function withResolvedTabs(
  tabs: WorkbenchTabStore,
  context: ApplicationRouterContext
): Promise<{ tabs: ResolvedTab[]; activeTabId?: string }> {
  context = tabResolutionContext(context);
  const instances = instanceResolution(context);
  const accessTasks = new Map<string, Promise<{ taskId: string; referenced: Set<string> }>>();
  const taskSummaries = new Map<string, ReturnType<ApplicationService["taskSummary"]>>();
  await migrateLegacyTabs(tabs, context, instances);
  const current = await tabs.read();
  const resolved: ResolvedTab[] = [];
  const alive = new Set<string>();
  const candidates = new Set(await context.referencingTasks());
  for (const tab of current.tabs) if (tab.taskId) candidates.add(tab.taskId);
  const conversations: Array<{
    taskId: string;
    goal?: string;
    root: string;
    taskStorageRoot: string;
    loadedInstanceId?: string;
    instanceHistory: string[];
    resources: Array<{ resourceId: string; workspaceRoot: string }>;
  }> = [];
  for (const taskId of candidates) {
    if (taskId === STANDALONE_TASK_ID) continue;
    // eslint-disable-next-line no-restricted-syntax -- 候选里包含引用文档的任务，被删掉的那些不该出现在 Tab 条上
    const location = await context.locate(taskId).catch(() => undefined);
    if (!location) continue;
    const service = locatedService(location);
    const manifest = await service.instances.readManifest(taskId, () =>
      instances.index(location.workspaceRoot)
    );
    conversations.push({
      instanceHistory: manifest.instanceHistory,
      taskId,
      root: location.workspaceRoot,
      taskStorageRoot: location.taskStorageRoot ?? location.workspaceRoot,
      // eslint-disable-next-line no-restricted-syntax -- 目标读不出来时标题回退到 taskId，不影响这一行 Tab 存在
      goal: await service.taskGoal(taskId).catch(() => undefined),
      loadedInstanceId: manifest.loadedInstanceId,
      resources: (await service.mapping.list(taskId)).map((r) => ({
        resourceId: r.resourceId,
        workspaceRoot: r.workspaceRoot ?? location.taskStorageRoot ?? location.workspaceRoot
      }))
    });
  }
  // A document can be created while task discovery is in flight. Migration's
  // earlier empty-window snapshot must not hide that first resource.
  instances.refresh();
  const servers = new Map(
    // eslint-disable-next-line no-restricted-syntax -- 状态读不出来时只是没有 MCP 徽标，Tab 条仍要返回
    (await context.mcp.statuses().catch(() => [])).map((server) => [server.key, server])
  );
  for (const tab of current.tabs) {
    if (tab.kind === "conversation") {
      const conversation = conversations.find((entry) => entry.taskId === tab.taskId);
      if (!conversation) continue;
      alive.add(tab.tabId);
      resolved.push({
        ...tab,
        title: conversation.goal || conversation.taskId,
        taskGoal: conversation.goal,
        storageRoot: conversation.taskStorageRoot
      });
      continue;
    }
    if (!tab.appInstanceId) continue;
    // eslint-disable-next-line no-restricted-syntax -- 实例可能在上面的索引之后被关掉，读不到就把这个 Tab 裁掉
    const found = await instances.read(tab.appInstanceId).catch(() => undefined);
    if (!found) continue;
    const { location, instance } = found;
    const service = locatedService(location);
    if (instance.status === "closed") continue;
    const resourceId = instance.resourceIds[0];
    const resource = resourceId
      ? await service.resources
          .readMetadataById(resourceId)
          // eslint-disable-next-line no-restricted-syntax -- 文档可能已被删除或在别的根里重建，读不到就裁掉这个 Tab
          .catch(() => undefined)
      : undefined;
    if (resourceId && !resource) continue;
    const referencesResource = (entry: (typeof conversations)[number]) =>
      Boolean(
        resourceId &&
        entry.resources.some(
          (resource) =>
            resource.resourceId === resourceId && resource.workspaceRoot === location.workspaceRoot
        )
      );
    const loadedHere = (entry: (typeof conversations)[number]) =>
      entry.loadedInstanceId === instance.appInstanceId &&
      (entry.root === location.workspaceRoot || referencesResource(entry));
    const loaded = conversations.filter(loadedHere);
    const referencers = conversations.filter((entry) => loadedHere(entry) || referencesResource(entry));
    // A stable editor access context, unrelated to which chat is selected or loading the instance.
    const accessKey = JSON.stringify([location.workspaceRoot, location.taskStorageRoot]);
    let accessTask = accessTasks.get(accessKey);
    if (!accessTask) {
      accessTask = (async () => {
        const taskId = await service.ensureStandaloneWorkspace();
        return {
          taskId,
          referenced: new Set((await service.mapping.list(taskId)).map((reference) => reference.resourceId))
        };
      })();
      accessTasks.set(accessKey, accessTask);
    }
    const access = await accessTask;
    const accessTaskId = access.taskId;
    for (const id of instance.resourceIds) {
      if (access.referenced.has(id)) continue;
      await service.mapping.add(accessTaskId, { resourceId: id, appType: instance.appType });
      access.referenced.add(id);
    }
    const unreadByTask: Record<string, number> = {};
    for (const entry of referencers) {
      const key = JSON.stringify([location.workspaceRoot, entry.taskStorageRoot, entry.taskId]);
      let pendingSummary = taskSummaries.get(key);
      if (!pendingSummary) {
        pendingSummary = serviceFor(location.workspaceRoot, entry.taskStorageRoot).taskSummary(entry.taskId);
        taskSummaries.set(key, pendingSummary);
      }
      const summary = await pendingSummary;
      unreadByTask[entry.taskId] = summary.unread.find((r) => r.resourceId === resourceId)?.unread ?? 0;
    }
    const consumer = resourceId ? resourceConsumer(resourceId) : `instance:${instance.appInstanceId}`;
    const server = servers.get(consumer);
    const referenceSummary = ({ taskId, goal, taskStorageRoot }: (typeof conversations)[number]) => ({
      taskId,
      goal,
      storageRoot: taskStorageRoot
    });
    const refs = referencers.map(referenceSummary);
    const legacyProject =
      resource?.project === undefined && resource?.projectId
        ? await context.projectForId?.(resource.projectId)
        : undefined;
    const project = await resolveApplicationProject(
      resource?.project !== undefined
        ? resource.project
        : resource?.projectId
          ? legacyProject
            ? { ...legacyProject, projectDirectory: location.workspaceRoot }
            : null
          : instance.project !== undefined
            ? instance.project
            : ((await context.projectForWorkspace?.(location.workspaceRoot)) ?? null)
    );
    resolved.push({
      ...tab,
      taskId: undefined,
      accessTaskId,
      workspaceRoot: location.workspaceRoot,
      project,
      projectId: project?.projectId ?? (resource?.project === undefined ? resource?.projectId : undefined),
      appInstanceId: instance.appInstanceId,
      resourceId,
      title: resource?.title ?? instance.title,
      appType: instance.appType,
      hasResource: !!resource,
      conversations: refs,
      relatedConversations: conversations
        .filter((entry) => entry.instanceHistory.includes(instance.appInstanceId))
        .map(referenceSummary),
      loadedConversations: loaded.map(referenceSummary),
      standalone: !loaded.length,
      unreadByTask,
      unread: 0,
      ...(server ? { mcp: { state: server.state, toolNames: server.toolNames, error: server.error } } : {})
    });
    alive.add(tab.tabId);
  }
  const pruned = await tabs.prune((tab) => alive.has(tab.tabId), current.tabs);
  return { tabs: resolved, activeTabId: pruned.activeTabId };
}

async function startWindowServer(
  context: ApplicationRouterContext,
  service: ApplicationService,
  taskId: string,
  instance: { appInstanceId: string; appType: string; resourceIds?: string[] }
): Promise<{ state: string; toolNames: string[]; error?: string } | undefined> {
  const spec = service.registry.definitions().find((entry) => entry.appType === instance.appType)?.mcpServer;
  if (!spec) return undefined;
  // A document's server is reached by the document, an empty editor's by the
  // window: that is what keeps one consumer per document however many
  // conversations reference it.
  const resourceId = instance.resourceIds?.[0];
  const status = await context.mcp
    .ensure({
      consumer: resourceId ? resourceConsumer(resourceId) : `instance:${instance.appInstanceId}`,
      appType: instance.appType,
      spec
    })
    .catch((error) => ({
      state: "failed" as const,
      toolNames: [] as string[],
      error: error instanceof Error ? error.message : String(error)
    }));
  // eslint-disable-next-line no-restricted-syntax -- 绑定文档后停掉空窗口的消费者属于清理，失败只会留下一个进程，supervisor 退出时统一回收
  if (resourceId) await context.mcp.stop(`instance:${instance.appInstanceId}`).catch(() => {});
  return { state: status.state, toolNames: status.toolNames, error: status.error };
}

/**
 * Start a document's server again if it is not running.
 *
 * The document's own consumer, so one process serves it however many
 * conversations reference it — and reviving is what makes a Dashboard restart
 * invisible to a tab that stayed in the strip.
 */
async function reviveResourceServer(
  context: ApplicationRouterContext,
  service: ApplicationService,
  resourceId: string,
  appType: string
): Promise<void> {
  const consumer = resourceConsumer(resourceId);
  // eslint-disable-next-line no-restricted-syntax -- 状态读不出来时按未运行处理，ensure 本身是幂等的
  const running = (await context.mcp.statuses().catch(() => [])).find(
    (entry) => entry.key === consumer && entry.state === "running"
  );
  if (running) return;
  const spec = service.registry.definitions().find((entry) => entry.appType === appType)?.mcpServer;
  if (!spec) return;
  // eslint-disable-next-line no-restricted-syntax -- 工具服务起不来不应让文档路由失败，编辑器仍能读写文档
  await context.mcp.ensure({ consumer, appType, spec }).catch(() => {
    /* usable without tools */
  });
}

/**
 * Start an open window's server again if it is not running.
 *
 * A window lives in the durable strip, but a server is a process: restarting
 * the Dashboard leaves every open window without the tools it declared, and
 * `ensure` is only reached by opening or binding one. Reviving on first use is
 * what makes a restart invisible, and it is cheap — `ensure` returns the running
 * session when there is one, so this is a map lookup in the normal case.
 *
 * A window that is closed, gone, or declares no server is left alone.
 */
async function reviveWindowServer(
  context: ApplicationRouterContext,
  taskId: string,
  appInstanceId: string
): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax -- 窗口所在的任务可能已被删除，读不到时没有可恢复的服务器
  const location = await context.locate(taskId).catch(() => undefined);
  if (!location) return;
  const service = locatedService(location);
  // eslint-disable-next-line no-restricted-syntax -- 窗口记录可能已被删除或关闭，读不到时无事可做
  const instance = await service.instances.readInstance(taskId, appInstanceId).catch(() => undefined);
  if (!instance || instance.status === "closed") return;
  const resourceId = instance.resourceIds[0];
  const consumer = resourceId ? resourceConsumer(resourceId) : `instance:${appInstanceId}`;
  // eslint-disable-next-line no-restricted-syntax -- 状态读不出来时按未运行处理，下面的 ensure 会给出真实结果
  const running = (await context.mcp.statuses().catch(() => [])).find(
    (entry) => entry.key === consumer && entry.state === "running"
  );
  if (running) return;
  // eslint-disable-next-line no-restricted-syntax -- 窗口在恢复失败后仍要能打开，工具不可用由下一次 ensure 重试
  await startWindowServer(context, service, taskId, instance).catch(() => {
    /* the window stays usable without its tools */
  });
}

async function resolveRequestedWorkspace(context: ApplicationRouterContext, root: unknown): Promise<string> {
  if (context.resolveWorkspace) return context.resolveWorkspace(root);
  if (root === context.defaultWorkspaceRoot) return context.defaultWorkspaceRoot;
  throw new Error("无法解析应用工作区");
}
