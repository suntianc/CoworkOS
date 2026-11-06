import { readTemporaryWorkspace } from "../workspace/temporary-workspaces.js";
import { taskApplicationProject } from "./project-context.js";
import { ApplicationRegistry } from "./registry.js";
import {
  batchOperations,
  ResourceStore,
  type OperationOutcome,
  type ResourceRead
} from "./resource-store.js";
import { InstanceStore } from "./instance-store.js";
import { ApplicationContextBuilder } from "./context-builder.js";
import { ResourceMappingStore } from "./mapping-store.js";
import { defaultRegistry } from "./builtins.js";
import { resolveTaskArtifact, type Artifact } from "../workspace/artifact-store.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { GlobalProjectCatalog } from "../workspace/project-catalog.js";
import { withFileLock } from "../storage/file-lock.js";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import {
  ApplicationError,
  resourceContentLimit,
  safeIdentifier,
  type ActiveAppContext,
  type ApplicationProject,
  type Actor,
  type AdapterToolDefinition,
  type AppInstance,
  type AppOperationEvent,
  type AppSelection,
  type ApplicationDefinition,
  type WorkspaceResource
} from "./types.js";

export interface ApplicationEvent {
  type:
    | "application.instance_opened"
    | "application.instance_updated"
    | "resource.created"
    | "resource.operation_applied"
    | "resource.selection_changed"
    | "resource.export_completed";
  taskId: string;
  appType: string;
  resourceId?: string;
  appInstanceId?: string;
  revision?: number;
  payload: Record<string, unknown>;
}

export type ApplicationEventSink = (event: ApplicationEvent) => void;

type DeliverableFile = Pick<Artifact, "relativePath" | "displayName" | "mimeType" | "size">;

/**
 * One business entry point shared by the HTTP API and the Agent tools.
 *
 * Both callers must go through the same door, or the two would eventually
 * diverge on locking, validation or which events get published — and the whole
 * point of the protocol is that a person's edit and a model's edit are
 * indistinguishable to the store.
 */
export class ApplicationService {
  readonly registry: ApplicationRegistry;
  readonly resources: ResourceStore;
  readonly instances: InstanceStore;
  readonly context: ApplicationContextBuilder;
  /**
   * Which resources each conversation references.
   *
   * This replaced ownership. A resource lives under its application and belongs
   * to no conversation; any number of conversations may reference it at once,
   * which is what lets several agents work on one document.
   */
  readonly mapping: ResourceMappingStore;

  constructor(
    private readonly workspaceRoot: string,
    private readonly customRegistry?: ApplicationRegistry,
    private readonly taskStorageRoot: string = workspaceRoot,
    private readonly defaultProject?: ApplicationProject | null
  ) {
    const registry = customRegistry ?? defaultRegistry();
    this.registry = registry;
    this.resources = new ResourceStore(workspaceRoot, registry);
    this.instances = new InstanceStore(workspaceRoot, taskStorageRoot);
    this.mapping = new ResourceMappingStore(taskStorageRoot, workspaceRoot);
    this.context = new ApplicationContextBuilder(
      taskStorageRoot,
      registry,
      this.resources,
      this.instances,
      this.mapping,
      (taskId, resourceId) => this.resourceStoreFor(taskId, resourceId)
    );
  }

  /** The default document home; Task persistence retains its separate root. */
  get resourceWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  /**
   * The resources a conversation references, resolved.
   *
   * Dangling references are pruned here rather than reported: a resource
   * deleted elsewhere should quietly leave the list, the same way the tab strip
   * drops a tab whose window is gone.
   */
  async listResources(taskId: string): Promise<WorkspaceResource[]> {
    const references = await this.mapping.list(taskId);
    const resources = (
      await Promise.all(
        references.map(async (reference) => {
          const store = await this.resourceStoreFor(taskId, reference.resourceId);
          return store.listResources([reference]);
        })
      )
    ).flat();
    if (resources.length !== references.length) {
      const alive = new Set(resources.map((entry) => entry.resourceId));
      await this.mapping.prune(taskId, (reference) => alive.has(reference.resourceId)).catch(() => {});
    }
    return resources;
  }

  /** Resolve only a persisted explicit reference, never a caller-provided filesystem root. */
  async serviceForResource(taskId: string, resourceId: string): Promise<ApplicationService> {
    await this.assertReferences(taskId, resourceId);
    const reference = (await this.mapping.list(taskId)).find((entry) => entry.resourceId === resourceId)!;
    const root = reference.workspaceRoot ?? this.taskStorageRoot;
    return resolve(root) === resolve(this.workspaceRoot)
      ? this
      : new ApplicationService(root, this.customRegistry, this.taskStorageRoot);
  }

  async resourceStoreFor(
    taskId: string,
    resourceId: string,
    expectedWorkspaceRoot?: string
  ): Promise<ResourceStore> {
    const service = await this.serviceForResource(taskId, resourceId);
    if (expectedWorkspaceRoot && (await realpath(service.resourceWorkspaceRoot)) !== expectedWorkspaceRoot)
      throw new ApplicationError("execution_scope_changed", "原请求的资源来源工作区已改变，拒绝执行工具", {});
    return service.resources;
  }

  /** Reference an existing resource from this conversation, without moving it. */
  async referenceResource(input: {
    taskId: string;
    resourceId: string;
    appType: string;
  }): Promise<WorkspaceResource> {
    const resource = await this.resources.readMetadataFor(input.appType, input.resourceId);
    await this.mapping.add(input.taskId, { resourceId: resource.resourceId, appType: resource.appType });
    return resource;
  }

  /** Stop referencing a resource. It stays where it is, for everyone else. */
  async dereferenceResource(taskId: string, resourceId: string): Promise<void> {
    await this.mapping.remove(taskId, resourceId);
  }

  definitions(): ApplicationDefinition[] {
    return this.registry.definitions();
  }

  catalogDefinitions(): ApplicationDefinition[] {
    return this.registry.catalogDefinitions();
  }

  /**
   * Create a resource and make sure something can show it.
   *
   * Creating a document the user cannot see is a half-finished action, so the
   * instance is opened here rather than left to whichever caller remembers.
   */
  async createResource(
    input: {
      taskId: string;
      appType?: string;
      kind: string;
      title: string;
      initialContent?: unknown;
      actor: Actor;
      openInstance?: boolean;
      externalPath?: string;
      importedArtifact?: WorkspaceResource["importedArtifact"];
    },
    emit?: ApplicationEventSink
  ): Promise<{
    resource: WorkspaceResource;
    snapshot: { content: unknown; revision: number };
    appInstance?: AppInstance;
  }> {
    // A new file inherits its requesting conversation even when that chat is
    // currently editing a document from another root. Existing documents keep
    // their references and physical location; creation is a separate operation.
    const project = await this.creationProject(input.taskId);
    const root = this.defaultProject?.projectDirectory ?? this.workspaceRoot;
    if (resolve(root) !== resolve(this.workspaceRoot))
      return new ApplicationService(root, this.customRegistry, this.taskStorageRoot, project).createResource(
        input,
        emit
      );
    const appType = input.appType ?? this.registry.forKind(input.kind)?.definition.appType;
    if (!appType) {
      throw new ApplicationError("unsupported_resource_kind", `没有应用可以打开 ${input.kind}`, {
        kind: input.kind
      });
    }
    const created = await this.resources.createResource({
      project,
      appType,
      kind: input.kind,
      title: input.title,
      initialContent: input.initialContent,
      actor: input.actor,
      ...(input.importedArtifact ? { importedArtifact: input.importedArtifact } : {}),
      ...(input.externalPath ? { externalPath: input.externalPath } : {})
    });
    await this.mapping.add(await this.ensureStandaloneWorkspace(), {
      resourceId: created.resource.resourceId,
      appType
    });
    // The conversation that asked for it references it. Creating is the first
    // reference, not ownership: another conversation may add its own later, and
    // this one may drop its reference without the document going anywhere.
    await this.mapping.add(input.taskId, { resourceId: created.resource.resourceId, appType });
    emit?.({
      type: "resource.created",
      taskId: input.taskId,
      appType,
      resourceId: created.resource.resourceId,
      revision: 0,
      payload: { title: created.resource.title, kind: created.resource.kind, actor: input.actor }
    });
    let appInstance: AppInstance | undefined;
    if (input.openInstance !== false) {
      // Fills an empty window of the same application if one is already open,
      // rather than leaving it in the strip beside the new document. Creating
      // a document from an empty editor is the ordinary way to use one, and
      // that window is where the person is looking.
      appInstance = await this.ensureResourceInstance(created.resource, input.taskId);
      emit?.({
        type: "application.instance_opened",
        taskId: input.taskId,
        appType,
        resourceId: created.resource.resourceId,
        appInstanceId: appInstance.appInstanceId,
        payload: { title: appInstance.title }
      });
    }
    return {
      resource: created.resource,
      snapshot: { content: created.snapshot.content, revision: created.snapshot.revision },
      appInstance
    };
  }

  /**
   * Read a resource this conversation references.
   *
   * Shared resource paths do not imply conversation access. Require an explicit
   * resource reference before exposing the document to this conversation.
   */
  async readResource(
    taskId: string,
    resourceId: string,
    options?: { afterRevision?: number; limit?: number; expectedResourceWorkspaceRoot?: string }
  ): Promise<ResourceRead> {
    await this.assertReferences(taskId, resourceId);
    const resources = await this.resourceStoreFor(taskId, resourceId, options?.expectedResourceWorkspaceRoot);
    return resources.readResource(await resources.appTypeOf(resourceId), resourceId, options);
  }

  /** Compare the latest saved operation without changing the resource. */
  async reviewResource(taskId: string, resourceId: string) {
    const service = await this.serviceForResource(taskId, resourceId);
    const read = await this.readResource(taskId, resourceId, { limit: 1 });
    const latest = read.operations.at(-1);
    const adapter = service.registry.require(read.resource.appType);
    const display = (content: unknown) =>
      adapter.reviewContent ? adapter.reviewContent(content) : Promise.resolve(adapter.serialize(content));
    const after = await display(read.snapshot.content);
    if (!latest?.inverse || latest.revision !== read.resource.revision) {
      return {
        revision: read.resource.revision,
        after,
        available: false,
        reason: "该版本没有可还原的修改记录"
      };
    }
    const operations =
      latest.inverse.operationType === "resource.batch"
        ? batchOperations(latest.inverse.payload)
        : [latest.inverse];
    let previousContent = structuredClone(read.snapshot.content);
    for (const operation of operations) {
      previousContent = service.registry
        .requireOperation(read.resource.appType, operation.operationType)
        .applyOperation({
          ...operation,
          content: previousContent,
          actor: { type: "system", id: "review" }
        }).content;
    }
    return {
      revision: read.resource.revision,
      baseRevision: latest.baseRevision,
      eventId: latest.eventId,
      before: await display(previousContent),
      after,
      available: true,
      summary: latest.summary,
      actor: latest.actor
    };
  }

  /**
   * Refuse unless this conversation references the resource.
   *
   * Conversation entry points enforce the shared-resource access rule here.
   * Internal metadata reads without conversation scope use `readResourceById`.
   */
  private async assertReferences(taskId: string, resourceId: string): Promise<void> {
    // Shape first, then access. A malformed id is `unsafe_path` whoever asks:
    // reporting "not referenced" for `../../etc/passwd` would be true but
    // useless, and would hide a traversal attempt behind an ordinary answer.
    safeIdentifier(resourceId, "resourceId");
    if (!(await this.mapping.references(taskId, resourceId))) {
      throw new ApplicationError("resource_not_found", `资源不存在或本对话没有引用它：${resourceId}`, {
        resourceId
      });
    }
  }

  /**
   * Say which document this conversation's next message is about, or none.
   *
   * Per conversation, always: a document has one tab shared by however many
   * conversations reference it, and each of them binds and unbinds on its own.
   * That separation is the whole reason the binding names a resource rather
   * than a window — a window was per-conversation by accident of storage, and
   * keying the tab that way put one file in the strip twice.
   *
   * Binding to a document the conversation does not reference stays impossible;
   * the reference is the access check that replaced path isolation.
   */
  async loadInstance(taskId: string, appInstanceId: string | undefined): Promise<AppInstance | undefined> {
    const load = async () => {
      const instance = appInstanceId ? await this.instances.readInstance(appInstanceId) : undefined;
      if (instance?.status === "closed")
        throw new ApplicationError("instance_not_found", "应用实例已关闭", {});
      if (instance)
        for (const resourceId of instance.resourceIds) {
          const resource = await this.resources.readMetadataById(resourceId);
          await this.mapping.add(taskId, { resourceId, appType: resource.appType });
        }
      await this.instances.setLoadedInstance(taskId, instance?.appInstanceId);
      return instance;
    };
    return appInstanceId ? this.instances.withInstanceLock(appInstanceId, load) : load();
  }

  /** Compatibility for callers that explicitly load a resource. */
  async bindResource(taskId: string, resourceId: string | undefined): Promise<void> {
    if (!resourceId) {
      await this.loadInstance(taskId, undefined);
      return;
    }
    await this.assertReferences(taskId, resourceId);
    const root =
      (await this.mapping.list(taskId)).find((entry) => entry.resourceId === resourceId)!.workspaceRoot ??
      this.taskStorageRoot;
    if (resolve(root) !== resolve(this.workspaceRoot))
      return new ApplicationService(root, this.customRegistry, this.taskStorageRoot).bindResource(
        taskId,
        resourceId
      );
    const resource = await this.resources.readMetadataById(resourceId);
    const instance = await this.ensureResourceInstance(resource);
    await this.loadInstance(taskId, instance.appInstanceId);
  }

  /**
   * Read a resource by id, without asking who wants it.
   *
   * For callers that are not a conversation — a tool resolving a bare id it was
   * handed, the store reading its own metadata back. Anything acting on behalf
   * of a conversation goes through `readResource`, which checks the reference.
   */
  async readResourceById(
    resourceId: string,
    options?: { afterRevision?: number; limit?: number }
  ): Promise<ResourceRead> {
    const appType = await this.resources.appTypeOf(resourceId);
    return this.resources.readResource(appType, resourceId, options);
  }

  async applyOperation(
    input: {
      signal?: AbortSignal;
      taskId: string;
      resourceId: string;
      operationId: string;
      appType: string;
      operationType: string;
      baseRevision: number;
      payload: unknown;
      actor: Actor;
      appInstanceId?: string;
      expectedResourceWorkspaceRoot?: string;
    },
    emit?: ApplicationEventSink
  ): Promise<OperationOutcome> {
    // Writing needs the same reference as reading: sharing is by invitation,
    // not by knowing an id.
    await this.assertReferences(input.taskId, input.resourceId);
    const outcome = await (
      await this.resourceStoreFor(input.taskId, input.resourceId, input.expectedResourceWorkspaceRoot)
    ).applyOperation(input);
    // A deduplicated retry already published its event. Re-emitting would make
    // a reconnecting client apply the same change twice.
    if (!outcome.deduplicated) {
      emit?.({
        type: "resource.operation_applied",
        taskId: input.taskId,
        appType: outcome.resource.appType,
        resourceId: input.resourceId,
        appInstanceId: input.appInstanceId,
        revision: outcome.event.revision,
        payload: {
          operationId: outcome.event.operationId,
          operationType: outcome.event.operationType,
          actor: outcome.event.actor,
          summary: outcome.event.summary,
          contentVersion: outcome.resource.contentVersion,
          eventId: outcome.event.eventId
        }
      });
    }
    return outcome;
  }

  async undo(
    input: {
      taskId: string;
      resourceId: string;
      actor: Actor;
      appInstanceId?: string;
      baseRevision?: number;
      eventId?: string;
    },
    emit?: ApplicationEventSink
  ): Promise<OperationOutcome> {
    await this.assertReferences(input.taskId, input.resourceId);
    const outcome = await (await this.resourceStoreFor(input.taskId, input.resourceId)).undo(input);
    if (!outcome.deduplicated) {
      emit?.({
        type: "resource.operation_applied",
        taskId: input.taskId,
        appType: outcome.resource.appType,
        resourceId: input.resourceId,
        appInstanceId: input.appInstanceId,
        revision: outcome.event.revision,
        payload: {
          operationId: outcome.event.operationId,
          operationType: outcome.event.operationType,
          actor: outcome.event.actor,
          summary: outcome.event.summary,
          undo: true,
          contentVersion: outcome.resource.contentVersion,
          eventId: outcome.event.eventId
        }
      });
    }
    return outcome;
  }

  async saveSelection(
    input: {
      taskId: string;
      resourceId: string;
      schema: string;
      data: unknown;
      appInstanceId?: string;
      actor: Actor;
    },
    emit?: ApplicationEventSink
  ): Promise<AppSelection> {
    await this.assertReferences(input.taskId, input.resourceId);
    const selection = await (
      await this.resourceStoreFor(input.taskId, input.resourceId)
    ).saveSelection(input);
    const resource = await this.readResource(input.taskId, input.resourceId, { limit: 1 });
    emit?.({
      type: "resource.selection_changed",
      taskId: input.taskId,
      appType: resource.resource.appType,
      resourceId: input.resourceId,
      appInstanceId: input.appInstanceId,
      payload: { schema: selection.schema, summary: selection.summary, updatedBy: selection.updatedBy }
    });
    return selection;
  }

  /**
   * Open an application with no document in it.
   *
   * "Open the editor" and "create a file" are different acts. Conflating them
   * meant a person who wanted to look at the application was asked to name a
   * file first — so an instance may hold no resource, and the adapter shows its
   * own empty state until one is opened or created.
   */
  /**
   * The workspace that holds applications opened on their own.
   *
   * An editor is something a person can open without having decided what it is
   * for. Requiring a conversation first got that backwards — the document comes
   * into existence, and binding it to a conversation is a later, separate act.
   * It is an ordinary Task record so every store below works unchanged, marked
   * so the sidebar does not offer it as a chat.
   */
  static readonly STANDALONE_TASK = "workspace";

  async ensureStandaloneWorkspace(): Promise<string> {
    const temporary = await readTemporaryWorkspace(this.workspaceRoot);
    const store = new LocalWorkspaceStore(temporary?.taskStorageRoot ?? this.taskStorageRoot);
    const taskId = temporary?.holdingTaskId ?? ApplicationService.STANDALONE_TASK;
    await store.createTask(taskId, {
      goal: "未归属的文档",
      kind: "workspace",
      ...(temporary
        ? { temporaryWorkspaceRoot: this.workspaceRoot, projectDirectory: this.workspaceRoot }
        : {})
    });
    // createTask is a no-op when the record exists, which leaves an older one
    // unmarked; setting it here makes the marker true for both paths.
    const current = await store.readTask(taskId);
    if (current.kind !== "workspace") await store.updateTask(taskId, { kind: "workspace" });
    return taskId;
  }

  async openApplication(
    input: { taskId: string; appType: string; fresh?: boolean },
    emit?: ApplicationEventSink
  ): Promise<AppInstance> {
    const adapter = this.registry.require(input.appType);
    // Reuse an empty instance rather than stacking up blank windows.
    const loadedId = (await this.instances.readManifest(input.taskId)).loadedInstanceId;
    const loaded = loadedId ? await this.instances.readInstance(loadedId) : undefined;
    const existing = loaded?.appType === input.appType && !loaded.resourceIds.length ? loaded : undefined;
    if (existing && !input.fresh) {
      emit?.({
        type: "application.instance_updated",
        taskId: input.taskId,
        appType: input.appType,
        appInstanceId: existing.appInstanceId,
        payload: { reused: true }
      });
      return existing;
    }
    // Reusing an existing empty window preserves its root. A new window uses
    // the same project default as a new resource, even when an older file is loaded.
    const project = await this.creationProject(input.taskId);
    const root = this.defaultProject?.projectDirectory ?? this.workspaceRoot;
    if (resolve(root) !== resolve(this.workspaceRoot))
      return new ApplicationService(root, this.customRegistry, this.taskStorageRoot, project).openApplication(
        { ...input, fresh: true },
        emit
      );
    const instance = await this.instances.createInstance({
      project,
      appType: input.appType,
      title: adapter.definition.displayName,
      resourceIds: []
    });
    emit?.({
      type: "application.instance_opened",
      taskId: input.taskId,
      appType: input.appType,
      appInstanceId: instance.appInstanceId,
      payload: { title: instance.title, empty: true }
    });
    return instance;
  }

  /**
   * Create a resource inside an application window that is already open.
   *
   * The window stays the same one the person is looking at, so a new document
   * appears in place rather than as another tab beside it.
   */
  async createInApplication(
    input: {
      taskId: string;
      appInstanceId: string;
      kind: string;
      title: string;
      initialContent?: unknown;
      nativeBody?: Uint8Array;
      sourceFile?: { path: string; contentVersion: string };
      signal?: AbortSignal;
      actor: Actor;
    },
    emit?: ApplicationEventSink
  ): Promise<{ resource: WorkspaceResource; appInstance: AppInstance }> {
    return this.instances.withInstanceLock(input.appInstanceId, async () => {
      const instance = await this.instances.readInstance(input.appInstanceId);
      if (instance.status === "closed" || instance.resourceIds.length)
        throw new ApplicationError("invalid_operation", "此实例已有文档或已关闭，请新建实例", {});
      const created = await this.resources.createResource({
        // An absent legacy field may inherit the window's original-root project;
        // an explicit null remains unassigned, regardless of the acting conversation.
        project:
          instance.project !== undefined
            ? instance.project
            : this.defaultProject !== undefined
              ? this.defaultProject
              : await this.creationProject(input.taskId),
        appType: instance.appType,
        kind: input.kind,
        title: input.title,
        initialContent: input.initialContent,
        nativeBody: input.nativeBody,
        sourceFile: input.sourceFile,
        signal: input.signal,
        actor: input.actor
      });
      await this.mapping.add(input.taskId, {
        resourceId: created.resource.resourceId,
        appType: instance.appType
      });
      emit?.({
        type: "resource.created",
        taskId: input.taskId,
        appType: instance.appType,
        resourceId: created.resource.resourceId,
        revision: 0,
        payload: { title: created.resource.title, kind: created.resource.kind, actor: input.actor }
      });
      const updated = await this.instances.updateInstance(input.taskId, input.appInstanceId, {
        resourceIds: [created.resource.resourceId],
        title: created.resource.title
      });
      await this.mapping.add(await this.ensureStandaloneWorkspace(), {
        resourceId: created.resource.resourceId,
        appType: instance.appType
      });
      for (const taskId of await this.instances.loadingTasks(instance.appInstanceId)) {
        await this.mapping.add(taskId, {
          resourceId: created.resource.resourceId,
          appType: instance.appType
        });
      }
      emit?.({
        type: "application.instance_updated",
        taskId: input.taskId,
        appType: instance.appType,
        resourceId: created.resource.resourceId,
        appInstanceId: updated.appInstanceId,
        payload: { title: updated.title }
      });
      return { resource: created.resource, appInstance: updated };
    });
  }

  /**
   * Open an existing resource, reusing the tab that already shows it.
   *
   * Two tabs on one resource would give the user two drafts of the same
   * document and no way to tell which one the Agent is editing.
   */
  async openResource(
    input: { taskId: string; resourceId: string },
    emit?: ApplicationEventSink
  ): Promise<AppInstance> {
    const reference = (await this.mapping.list(input.taskId)).find(
      (entry) => entry.resourceId === input.resourceId
    );
    const root = reference?.workspaceRoot ?? this.taskStorageRoot;
    if (reference && resolve(root) !== resolve(this.workspaceRoot))
      return new ApplicationService(root, this.customRegistry, this.taskStorageRoot).openResource(
        input,
        emit
      );
    const read = await this.readResourceById(input.resourceId, { limit: 1 });
    // Opening grants the conversation an idempotent reference before subsequent
    // reads enforce access through the shared-resource mapping.
    await this.mapping.add(input.taskId, {
      resourceId: read.resource.resourceId,
      appType: read.resource.appType
    });
    const instance = await this.ensureResourceInstance(read.resource);
    await this.mapping.add(await this.ensureStandaloneWorkspace(), {
      resourceId: input.resourceId,
      appType: read.resource.appType
    });
    emit?.({
      type: "application.instance_opened",
      taskId: input.taskId,
      appType: instance.appType,
      resourceId: input.resourceId,
      appInstanceId: instance.appInstanceId,
      payload: { title: instance.title }
    });
    return instance;
  }

  private async ensureResourceInstance(
    resource: WorkspaceResource,
    creatingTaskId?: string
  ): Promise<AppInstance> {
    const existing = await this.instances.findByResource(resource.resourceId);
    if (existing) return existing;
    const loadedId = creatingTaskId
      ? (await this.instances.readManifest(creatingTaskId)).loadedInstanceId
      : undefined;
    if (loadedId) {
      const filled = await this.instances.withInstanceLock(loadedId, async () => {
        const loaded = await this.instances.readInstance(loadedId);
        if (loaded.status === "closed" || loaded.resourceIds.length || loaded.appType !== resource.appType)
          return undefined;
        const updated = await this.instances.updateInstance(loaded.appInstanceId, {
          resourceIds: [resource.resourceId],
          title: resource.title
        });
        for (const taskId of await this.instances.loadingTasks(loaded.appInstanceId))
          await this.mapping.add(taskId, { resourceId: resource.resourceId, appType: resource.appType });
        return updated;
      });
      if (filled) return filled;
    }
    return this.instances.createInstance({
      project: resource.project,
      appType: resource.appType,
      title: resource.title,
      resourceIds: [resource.resourceId]
    });
  }

  async updateInstance(
    input: {
      taskId: string;
      appInstanceId: string;
      status?: AppInstance["status"];
      resourceIds?: string[];
      uiState?: Record<string, unknown>;
      active?: boolean;
    },
    emit?: ApplicationEventSink
  ): Promise<AppInstance> {
    if (input.status === "closed") {
      for (const taskId of await this.instances.loadingTasks(input.appInstanceId))
        await this.instances.setLoadedInstance(taskId, undefined);
    }
    const instance = await this.instances.updateInstance(input.taskId, input.appInstanceId, {
      status: input.status,
      resourceIds: input.resourceIds,
      uiState: input.uiState
    });
    if (input.active === true) await this.loadInstance(input.taskId, instance.appInstanceId);
    emit?.({
      type: "application.instance_updated",
      taskId: input.taskId,
      appType: instance.appType,
      appInstanceId: instance.appInstanceId,
      resourceId: instance.resourceIds[0],
      payload: { status: instance.status, active: input.active === true }
    });
    return instance;
  }

  /** Resolve export provenance against this conversation's resources, never by title. */
  private artifactSourceResource(
    artifact: Pick<Artifact, "relativePath" | "sha256" | "sourceResource">,
    resources: WorkspaceResource[]
  ): WorkspaceResource | undefined {
    const source = artifact.sourceResource;
    const resourceId = source?.sha256 === artifact.sha256 ? source?.resourceId : undefined;
    return resources.find((resource) => resource.resourceId === resourceId);
  }

  private importedArtifactResource(
    artifact: Pick<Artifact, "relativePath" | "sha256">,
    resources: WorkspaceResource[],
    taskId: string,
    storageRoot: string
  ): WorkspaceResource | undefined {
    return resources.find((resource) => {
      const source = resource.importedArtifact;
      return (
        source?.storageRoot === storageRoot &&
        source.taskId === taskId &&
        source.relativePath === artifact.relativePath &&
        source.sha256 === artifact.sha256
      );
    });
  }

  /**
   * Open an export's source resource, or import an unrelated artifact as a copy.
   *
   * Unrelated artifacts are copied, never adopted: a published deliverable stays exactly
   * as it was, and editing produces a separate resource that only overwrites it
   * if someone publishes again. Text is read from disk because the browser's
   * bounded preview could truncate it. Interchange conversion comes from the
   * declared UI Adapter and carries the hash of the converted source bytes.
   */
  async importArtifact(
    input: {
      taskId: string;
      relativePath: string;
      actor: Actor;
      appType?: string;
      kind?: string;
      title?: string;
      initialContent?: unknown;
      artifactSha256?: string;
      /** UI Adapter conversion, tied to the actual bytes fetched by the browser. */
      converted?: { sha256: string; kind: string; title: string; initialContent: unknown };
    },
    emit?: ApplicationEventSink
  ): Promise<{
    resource: WorkspaceResource;
    snapshot: { content: unknown; revision: number };
    appInstance?: AppInstance;
    reused?: boolean;
  }> {
    safeIdentifier(input.taskId, "taskId");
    const normalized = input.converted
      ? {
          ...input,
          artifactSha256: input.converted.sha256,
          kind: input.converted.kind,
          title: input.converted.title,
          initialContent: input.converted.initialContent
        }
      : input;
    return withFileLock(
      join(this.taskStorageRoot, input.taskId, "applications", "artifact-import.lock"),
      () => this.importArtifactLocked(normalized, emit),
      { recoverDeadOwner: true }
    );
  }

  private async importArtifactLocked(
    input: Parameters<ApplicationService["importArtifact"]>[0],
    emit?: ApplicationEventSink
  ): ReturnType<ApplicationService["importArtifact"]> {
    // resolveTaskArtifact applies the Artifact Store's own containment checks,
    // so a crafted path cannot reach outside the Task's artifacts directory.
    const resolved = await resolveTaskArtifact({
      workspaceRoot: this.taskStorageRoot,
      taskId: input.taskId,
      relativePath: input.relativePath
    });
    if (input.artifactSha256 !== undefined && input.artifactSha256 !== resolved.artifact.sha256)
      throw new ApplicationError("source_file_conflict", "产出物文件已更新，请重新打开后再导入", {
        relativePath: input.relativePath,
        currentSha256: resolved.artifact.sha256
      });
    const resources = await this.listResources(input.taskId);
    const storageRoot = await realpath(this.taskStorageRoot);
    const compatible = input.appType
      ? resources.filter((resource) => resource.appType === input.appType)
      : resources;
    const importedArtifact = {
      storageRoot,
      taskId: input.taskId,
      relativePath: resolved.artifact.relativePath,
      sha256: resolved.artifact.sha256
    };
    let source =
      this.artifactSourceResource(resolved.artifact, compatible) ??
      this.importedArtifactResource(resolved.artifact, compatible, input.taskId, storageRoot);
    if (!source) {
      // Resource creation lands before references and windows. A failed request
      // in that interval must resume the committed import after a restart,
      // including when new documents are forwarded into a project directory.
      const root = this.defaultProject?.projectDirectory ?? this.workspaceRoot;
      const owner =
        resolve(root) === resolve(this.workspaceRoot)
          ? this
          : new ApplicationService(root, this.customRegistry, this.taskStorageRoot, this.defaultProject);
      source = await owner.resources.findImportedArtifact(importedArtifact, input.appType);
      if (source)
        await owner.referenceResource({
          taskId: input.taskId,
          resourceId: source.resourceId,
          appType: source.appType
        });
    }
    if (source) {
      const appInstance = await this.openResource(
        { taskId: input.taskId, resourceId: source.resourceId },
        emit
      );
      const read = await this.readResource(input.taskId, source.resourceId);
      return { resource: read.resource, snapshot: read.snapshot, appInstance, reused: true };
    }
    if (input.initialContent !== undefined) {
      // Interchange conversion belongs to the UI Adapter. The host still
      // checks the source identity and declared MIME-to-resource mapping.
      const adapter = input.appType
        ? this.registry.require(input.appType)
        : this.registry.forFileImport(resolved.artifact.mimeType ?? "");
      const format = adapter?.definition.fileImportFormats?.find(
        (entry) => entry.mimeType === resolved.artifact.mimeType && entry.resourceKind === input.kind
      );
      if (!adapter || !format)
        throw new ApplicationError("unsupported_resource_kind", "此应用不支持转换这个产出物文件", {
          kind: input.kind,
          mimeType: resolved.artifact.mimeType
        });
      if (input.artifactSha256 === undefined)
        throw new ApplicationError("invalid_operation", "转换导入必须指定产出物文件版本", {});
      if (resolved.stat.size > resourceContentLimit(adapter.definition))
        throw new ApplicationError("resource_too_large", "产出物文件超过应用导入上限", {
          size: resolved.stat.size,
          limit: resourceContentLimit(adapter.definition)
        });
      return this.createResource(
        {
          taskId: input.taskId,
          appType: adapter.definition.appType,
          kind: format.resourceKind,
          title: input.title || resolved.artifact.displayName || input.relativePath.split("/").at(-1)!,
          initialContent: input.initialContent,
          actor: input.actor,
          importedArtifact
        },
        emit
      );
    }
    // The file's mime type *is* the resource kind, and the registry decides
    // whether any application declared it can open it. Mapping unknown types
    // onto a default kind here would let a PDF open in a text editor and be
    // destroyed on the next publish — and would put a domain decision in the
    // core, where the next Adapter would have to come and edit it.
    const kind = resolved.artifact.mimeType ?? "application/octet-stream";
    const adapter = input.appType
      ? this.registry.requireKind(input.appType, kind)
      : this.registry.forKind(kind);
    if (!adapter) {
      throw new ApplicationError("unsupported_resource_kind", `没有应用可以打开 ${kind}`, {
        kind,
        relativePath: input.relativePath
      });
    }
    if (resolved.stat.size > resourceContentLimit(adapter.definition)) {
      throw new ApplicationError(
        "resource_too_large",
        `文件超过 ${resourceContentLimit(adapter.definition) / (1024 * 1024)} MiB，无法作为可编辑资源打开`,
        {
          size: resolved.stat.size,
          limit: resourceContentLimit(adapter.definition)
        }
      );
    }
    const raw = await readFile(resolved.absolutePath);
    if (raw.byteLength > resourceContentLimit(adapter.definition))
      throw new ApplicationError("resource_too_large", "产出物文件超过应用导入上限", {
        size: raw.byteLength,
        limit: resourceContentLimit(adapter.definition)
      });
    if (createHash("sha256").update(raw).digest("hex") !== resolved.artifact.sha256)
      throw new ApplicationError("source_file_conflict", "产出物文件已更新，请重新打开后再导入", {
        relativePath: input.relativePath
      });
    // Strict decoding rejects non-UTF-8 text, including files without NUL bytes.
    // Replacement characters would otherwise corrupt the original on save.
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      throw new ApplicationError(
        "unsupported_resource_kind",
        "这个文件不是 UTF-8 文本，无法作为可编辑资源打开",
        {
          relativePath: input.relativePath
        }
      );
    }
    return this.createResource(
      {
        taskId: input.taskId,
        appType: adapter.definition.appType,
        kind,
        title: resolved.artifact.displayName || input.relativePath.split("/").at(-1) || input.relativePath,
        initialContent: text,
        actor: input.actor,
        importedArtifact
      },
      emit
    );
  }

  /**
   * Rename a resource, keeping every tab showing it in step.
   *
   * The title is not the identity — `resourceId` is — so renaming touches no
   * revision and no operation history. It does change the tab name and the
   * filename a later export would use, so the instances are updated with it
   * rather than left displaying a name the resource no longer has.
   */
  async renameResource(
    input: { taskId: string; resourceId: string; title: string },
    emit?: ApplicationEventSink
  ): Promise<WorkspaceResource> {
    // Renaming affects all references; only a conversation that references this
    // shared resource may change its name.
    await this.assertReferences(input.taskId, input.resourceId);
    const resources = await this.resourceStoreFor(input.taskId, input.resourceId);
    const root =
      (await this.mapping.list(input.taskId)).find((entry) => entry.resourceId === input.resourceId)!
        .workspaceRoot ?? this.taskStorageRoot;
    const instances = new InstanceStore(root, this.taskStorageRoot);
    const resource = await resources.rename(
      await resources.appTypeOf(input.resourceId),
      input.resourceId,
      input.title
    );
    for (const instance of await instances.listInstances(input.taskId)) {
      if (!instance.resourceIds.includes(input.resourceId) || instance.status === "closed") continue;
      const updated = await instances.updateInstance(input.taskId, instance.appInstanceId, {
        title: resource.title
      });
      emit?.({
        type: "application.instance_updated",
        taskId: input.taskId,
        appType: resource.appType,
        resourceId: input.resourceId,
        appInstanceId: updated.appInstanceId,
        payload: { title: updated.title, renamed: true }
      });
    }
    return resource;
  }

  /**
   * Render the current revision for download, without publishing it.
   *
   * "Save a copy to my own machine" must not touch `artifacts/`, or the Task's
   * deliverables panel would fill up with private copies.
   */
  async saveSourceFile(
    taskId: string,
    resourceId: string,
    expectedRevision?: number
  ): Promise<WorkspaceResource> {
    await this.assertReferences(taskId, resourceId);
    return (await this.resourceStoreFor(taskId, resourceId)).saveSourceFile(resourceId, expectedRevision);
  }

  async saveCopy(input: {
    taskId: string;
    resourceId: string;
    directory: string;
    format: string;
    revision: number;
    project?: ApplicationProject | null;
  }) {
    await this.assertReferences(input.taskId, input.resourceId);
    const service = await this.serviceForResource(input.taskId, input.resourceId);
    const saved = await service.resources.saveCopy(input);
    return saved;
  }

  async renderForDownload(input: {
    taskId: string;
    resourceId: string;
    format: string;
    options?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<{ fileName: string; mimeType: string; body: string | Uint8Array }> {
    const service = await this.serviceForResource(input.taskId, input.resourceId);
    const read = await service.readResource(input.taskId, input.resourceId, { limit: 1 });
    const adapter = service.registry.require(read.resource.appType);
    return adapter.exportResource({
      resource: read.resource,
      content: read.snapshot.content,
      format: input.format,
      options: input.options,
      signal: input.signal
    });
  }

  async previewResource(input: {
    taskId: string;
    resourceId: string;
    content: unknown;
    options?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<unknown> {
    const service = await this.serviceForResource(input.taskId, input.resourceId);
    const read = await service.readResource(input.taskId, input.resourceId, { limit: 1 });
    const adapter = service.registry.require(read.resource.appType);
    if (!adapter.previewResource) throw new ApplicationError("invalid_operation", "此应用不支持计算预览", {});
    return adapter.previewResource({
      content: input.content,
      savedContent: read.snapshot.content,
      resource: read.resource,
      options: input.options,
      signal: input.signal
    });
  }

  /** Human-facing domain commands use the same tools, candidate validation and CAS as the Agent. */
  async executeResourceCommand(
    input: {
      taskId: string;
      resourceId: string;
      command: string;
      params: Record<string, unknown>;
      baseRevision: number;
      operationId: string;
      actor: Actor;
      signal?: AbortSignal;
    },
    emit?: ApplicationEventSink
  ) {
    safeIdentifier(input.operationId, "operationId");
    input.signal?.throwIfAborted();
    const service = await this.serviceForResource(input.taskId, input.resourceId);
    const read = await service.readResource(input.taskId, input.resourceId, { limit: 1 });
    const adapter = service.registry.require(read.resource.appType);
    const tool = adapter
      .agentTools?.({ content: read.snapshot.content })
      .find((tool) => tool.name === input.command);
    if (!tool) throw new ApplicationError("invalid_operation", "此资源不支持该命令", {});
    const previous = await (
      await this.resourceStoreFor(input.taskId, input.resourceId)
    ).findOperation(input.resourceId, input.operationId);
    if (previous)
      return {
        result: { status: "ready" },
        resource: read.resource,
        snapshot: read.snapshot,
        deduplicated: true
      };
    if (input.baseRevision !== read.resource.revision)
      throw new ApplicationError("revision_conflict", "工程已更新，请重新读取后再提交", {
        currentRevision: read.resource.revision
      });
    const result = await tool.execute({
      params: input.params,
      content: read.snapshot.content,
      resource: read.resource,
      selection: read.selection,
      signal: input.signal
    });
    input.signal?.throwIfAborted();
    if ((result.operations?.length ?? 0) > 1)
      throw new ApplicationError("invalid_operation", "工作台命令必须返回一个原子操作", {});
    let deduplicated = false;
    if (result.operations?.length) {
      const operation = result.operations[0];
      const applied = await this.applyOperation(
        {
          taskId: input.taskId,
          resourceId: input.resourceId,
          operationId: input.operationId,
          baseRevision: read.resource.revision,
          appType: read.resource.appType,
          ...operation,
          actor: input.actor,
          signal: input.signal
        },
        emit
      );
      deduplicated = applied.deduplicated;
    }
    const current = await this.readResource(input.taskId, input.resourceId, { limit: 1 });
    if (deduplicated)
      return {
        result: { status: "ready" },
        resource: current.resource,
        snapshot: current.snapshot,
        deduplicated: true
      };
    return {
      ...result,
      operations: undefined,
      resource: current.resource,
      snapshot: current.snapshot,
      deduplicated: false
    };
  }

  async readResourceAttachment(input: {
    taskId: string;
    resourceId: string;
    name: string;
    revision: number;
  }) {
    const service = await this.serviceForResource(input.taskId, input.resourceId);
    const read = await service.readResource(input.taskId, input.resourceId, { limit: 1 });
    if (input.revision !== read.resource.revision)
      throw new ApplicationError("revision_conflict", "预览版本已更新", {
        currentRevision: read.resource.revision
      });
    const adapter = service.registry.require(read.resource.appType);
    if (!adapter.readAttachment)
      throw new ApplicationError("invalid_operation", "此应用没有二进制预览附件", {});
    return adapter.readAttachment({ content: read.snapshot.content, name: input.name });
  }

  async importNativeResource(
    input: {
      taskId: string;
      resourceId: string;
      body: Uint8Array;
      baseRevision: number;
      operationId: string;
      actor: Actor;
      signal?: AbortSignal;
    },
    emit?: ApplicationEventSink
  ) {
    safeIdentifier(input.operationId, "operationId");
    const service = await this.serviceForResource(input.taskId, input.resourceId);
    const read = await service.readResource(input.taskId, input.resourceId, { limit: 1 });
    const adapter = service.registry.require(read.resource.appType);
    if (!adapter.importResource)
      throw new ApplicationError("invalid_operation", "此应用不支持原生文件导入", {});
    const previous = await (
      await this.resourceStoreFor(input.taskId, input.resourceId)
    ).findOperation(input.resourceId, input.operationId);
    if (previous) return { resource: read.resource, snapshot: read.snapshot, deduplicated: true };
    if (input.baseRevision !== read.resource.revision)
      throw new ApplicationError("revision_conflict", "导入期间工程已更新", {
        currentRevision: read.resource.revision
      });
    const result = await adapter.importResource({
      content: read.snapshot.content,
      body: input.body,
      signal: input.signal
    });
    if (result.operations?.length !== 1)
      throw new ApplicationError("invalid_operation", "原生导入必须生成一个原子操作", {});
    input.signal?.throwIfAborted();
    await this.applyOperation(
      {
        taskId: input.taskId,
        resourceId: input.resourceId,
        operationId: input.operationId,
        baseRevision: read.resource.revision,
        appType: read.resource.appType,
        ...result.operations[0],
        actor: input.actor,
        signal: input.signal
      },
      emit
    );
    const current = await this.readResource(input.taskId, input.resourceId, { limit: 1 });
    return { resource: current.resource, snapshot: current.snapshot, deduplicated: false };
  }

  /**
   * What binding an application gives the Agent beyond resource context.
   *
   * Generic tools say *how* to change a resource; these say how to work in the
   * domain. They are returned rather than registered so the platform stays the
   * one place that decides when a capability becomes visible to the model —
   * unbinding has to take them away again, which a self-registering Adapter
   * could not guarantee.
   */
  async boundCapabilities(input: { taskId: string; agentId: string }): Promise<
    | {
        appType: string;
        displayName: string;
        appInstanceId?: string;
        resourceId: string;
        resourcePath: string;
        resourceTitle: string;
        workspaceDirectory: string;
        skillRoots: string[];
        systemPrompt?: string;
        tools: AdapterToolDefinition[];
        hasMcpServer: boolean;
      }
    | undefined
  > {
    const context = await this.context.build(input);
    if (!context) return undefined;
    const adapter = this.registry.require(context.appType);
    return {
      appType: context.appType,
      displayName: adapter.definition.displayName,
      // One MCP consumer per document, shared by its referencing conversations.
      ...(context.appInstanceId ? { appInstanceId: context.appInstanceId } : {}),
      resourceId: context.resource.resourceId,
      resourcePath: this.resources.absolutePath(context.resource),
      // What the person calls this document. The prompt needs it to say that
      // "这个文件" means this one — a path is not what the user says out loud.
      resourceTitle: context.resource.title,
      // A bound Agent works where the resource lives, so a relative path in a
      // command means what the user would expect it to mean.
      workspaceDirectory: this.resources.resourceFileDirectory(context.appType),
      skillRoots: adapter.definition.skillRoots ?? [],
      systemPrompt: adapter.definition.systemPrompt,
      tools: (adapter.agentTools?.() ?? []).filter((tool) => context.availableToolNames.includes(tool.name)),
      // Whether to bother asking the Dashboard for this window's tools.
      hasMcpServer: Boolean(adapter.definition.mcpServer)
    };
  }

  /**
   * Also work on a document from this conversation.
   *
   * Nothing moves. The conversation adds a reference and opens a window on the
   * same resource, so the conversation that already had it keeps it — which is
   * the whole point: several conversations, each with its own agent, editing one
   * document.
   *
   * This replaced `adoptIntoTask`, which *moved* the file and its history and
   * therefore had to take the document away from wherever it was. That is also
   * why it needed to drain the standalone workspace: with references, a sibling
   * document simply stays referenced by whoever referenced it.
   */
  async referenceIntoTask(
    input: { resourceId: string; taskId: string; appType?: string; fromTaskId?: string },
    emit?: ApplicationEventSink
  ): Promise<{ resource: WorkspaceResource; appInstance: AppInstance }> {
    const appType = input.appType ?? (await this.resources.appTypeOf(input.resourceId));
    const resource = await this.resources.readMetadataFor(appType, input.resourceId);
    await this.mapping.add(input.taskId, { resourceId: resource.resourceId, appType });
    const appInstance = await this.ensureResourceInstance(resource);
    emit?.({
      type: "application.instance_opened",
      taskId: input.taskId,
      appType,
      resourceId: resource.resourceId,
      appInstanceId: appInstance.appInstanceId,
      payload: { title: resource.title, referenced: true }
    });
    return { resource, appInstance };
  }

  /** Compatibility entry point: loading an empty instance never changes its identity. */
  async adoptEmptyWindow(input: {
    fromTaskId: string;
    appInstanceId: string;
    taskId: string;
  }): Promise<AppInstance> {
    return (await this.loadInstance(input.taskId, input.appInstanceId))!;
  }

  /** A task's goal, for labelling which conversation a tab belongs to. */
  async taskGoal(taskId: string): Promise<string | undefined> {
    const task = await new LocalWorkspaceStore(this.taskStorageRoot).readTask(taskId);
    return task.goal?.trim() || undefined;
  }

  /** Host defaults select new-file affiliation; explicit legacy services retain their supplied root. */
  private async creationProject(taskId: string): Promise<ApplicationProject | null> {
    const taskProject = await taskApplicationProject(this.taskStorageRoot, taskId);
    if (this.defaultProject !== undefined) return taskProject ?? this.defaultProject;
    const loadedId = (await this.instances.readManifest(taskId)).loadedInstanceId;
    if (loadedId) {
      const instance = await this.instances.readInstance(loadedId);
      for (const resourceId of instance.resourceIds) {
        const resource = await this.resources.readMetadataById(resourceId);
        if (resource.project !== undefined) return resource.project;
        if (resource.projectId) {
          const owner = taskProject?.projectCatalogPath
            ? (await new GlobalProjectCatalog(taskProject.projectCatalogPath).list()).find(
                (project) => project.projectId === resource.projectId
              )
            : undefined;
          return owner
            ? {
                ...owner,
                projectDirectory: this.workspaceRoot,
                projectCatalogPath: taskProject!.projectCatalogPath
              }
            : null;
        }
      }
    }
    if (taskProject && resolve(taskProject.projectDirectory) === resolve(this.workspaceRoot))
      return taskProject;
    const task = await new LocalWorkspaceStore(this.taskStorageRoot)
      .readTask(taskId)
      .catch((error: Error) => {
        if (error.message === `unknown task: ${taskId}`) return undefined;
        throw error;
      });
    if (task?.projectCatalogPath && task.kind !== "workspace") {
      const project = (await new GlobalProjectCatalog(task.projectCatalogPath).list()).find(
        (entry) => resolve(entry.projectDirectory) === resolve(this.workspaceRoot)
      );
      if (project) return { ...project, projectCatalogPath: task.projectCatalogPath };
    }
    return null;
  }

  async emptyApplicationContext(taskId: string): Promise<string> {
    const id = (await this.instances.readManifest(taskId)).loadedInstanceId;
    if (!id) return "";
    const instance = await this.instances.readInstance(id);
    if (instance.resourceIds.length) return "";
    const definition = this.registry.require(instance.appType).definition;
    // JSON keeps user-provided titles as data; no document or tool target is invented.
    return `<loaded_application>\n${JSON.stringify({ appInstanceId: id, appType: instance.appType, title: instance.title, resourceKinds: definition.resourceKinds }).replace(/</g, "\\u003c")}\n当前会话加载了这个空白应用实例，尚无文档。需要创建内容时，使用 create_resource 创建该应用支持的格式；文档会放入这个已加载的实例。\n</loaded_application>`;
  }

  async activeContext(input: { taskId: string; agentId: string }): Promise<ActiveAppContext | undefined> {
    return this.context.build(input);
  }

  /**
   * The deliverables a Task shows, as a view rather than a directory listing.
   *
   * A Task's outputs are two kinds of thing that a single directory cannot
   * express: ordinary files published under `artifacts/`, and live resources
   * that carry a version and an editor. Resources keep their own home on disk
   * precisely so one document can be mapped into more than one conversation —
   * assembling the list here is what makes that possible without copying the
   * file or linking it.
   */
  async deliverables(
    taskId: string,
    artifacts: Array<
      Pick<Artifact, "relativePath" | "displayName" | "mimeType" | "size"> &
        Partial<Pick<Artifact, "sha256" | "sourceResource">>
    >,
    known?: WorkspaceResource[]
  ): Promise<
    Array<{
      kind: "resource" | "file";
      name: string;
      relativePath?: string;
      sourceResourceId?: string;
      resourceId?: string;
      appType?: string;
      revision?: number;
      mimeType?: string;
      size?: number;
      editable: boolean;
      files?: DeliverableFile[];
      previousVersions?: Array<{
        resourceId: string;
        name: string;
        revision: number;
        updatedAt: string;
      }>;
    }>
  > {
    // Reuse an already-listed set to avoid reading and hashing every document
    // more than once per task-detail poll.
    const resources = known ?? (await this.listResources(taskId).catch(() => []));
    const storageRoot = await realpath(this.taskStorageRoot);
    const importedSourceOf = (artifact: (typeof artifacts)[number]) =>
      this.importedArtifactResource(
        { ...artifact, sha256: artifact.sha256 ?? "" },
        resources,
        taskId,
        storageRoot
      );
    const sourceOf = (artifact: (typeof artifacts)[number]) =>
      this.artifactSourceResource({ ...artifact, sha256: artifact.sha256 ?? "" }, resources);
    const editableSourceOf = (artifact: (typeof artifacts)[number]) => {
      const resource = importedSourceOf(artifact) ?? sourceOf(artifact);
      if (!resource || !artifact.mimeType) return undefined;
      if (artifact.mimeType === "application/pdf" || /^(image|audio|video)\//.test(artifact.mimeType))
        return undefined;
      const definition = this.registry.require(resource.appType).definition;
      const nativeExtension = definition.fileExtensions?.[resource.kind];
      return definition.resourceKinds.includes(artifact.mimeType) ||
        (nativeExtension && artifact.relativePath.toLowerCase().endsWith(nativeExtension.toLowerCase())) ||
        definition.fileImportFormats?.some((format) => format.mimeType === artifact.mimeType) ||
        definition.exportFormats.includes(extname(artifact.relativePath).slice(1).toLowerCase())
        ? resource
        : undefined;
    };
    const importedDocumentKey = (resource: WorkspaceResource) => {
      const origin = resource.importedArtifact;
      return origin
        ? JSON.stringify([
            origin.storageRoot,
            origin.taskId,
            origin.relativePath,
            resource.appType,
            resource.kind
          ])
        : undefined;
    };
    const linked = new Map<string, DeliverableFile[]>();
    const currentImports = new Map<string, string>();
    for (const artifact of artifacts) {
      const source = editableSourceOf(artifact);
      if (!source) continue;
      const files = linked.get(source.resourceId) ?? [];
      files.push({
        relativePath: artifact.relativePath,
        displayName: artifact.displayName,
        mimeType: artifact.mimeType,
        size: artifact.size
      });
      linked.set(source.resourceId, files);
      // A regenerated artifact has new bytes and therefore its own editable
      // import. Present its older imports as history only when this exact
      // source file still has a current, editable import in this conversation.
      const imported = importedSourceOf(artifact);
      const key = imported && importedDocumentKey(imported);
      if (key && imported?.resourceId === source.resourceId) currentImports.set(key, imported.resourceId);
    }
    const previousVersions = new Map<
      string,
      Array<{ resourceId: string; name: string; revision: number; updatedAt: string }>
    >();
    const previousResourceIds = new Set<string>();
    for (const resource of resources) {
      const key = importedDocumentKey(resource);
      const currentId = key && currentImports.get(key);
      if (!currentId || currentId === resource.resourceId) continue;
      const versions = previousVersions.get(currentId) ?? [];
      versions.push({
        resourceId: resource.resourceId,
        name: resource.title,
        revision: resource.revision,
        updatedAt: resource.updatedAt
      });
      previousVersions.set(currentId, versions);
      previousResourceIds.add(resource.resourceId);
      const files = linked.get(resource.resourceId);
      if (files) linked.set(currentId, [...(linked.get(currentId) ?? []), ...files]);
    }
    for (const versions of previousVersions.values())
      versions.sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.resourceId.localeCompare(b.resourceId)
      );
    // Only exact provenance folds editable files into their live resource.
    // Read-only exports such as PDF remain independent preview deliverables.
    // Earlier imports stay addressable without repeating one source file as
    // several top-level deliverables. No resources or drafts are modified.
    // Equal titles or bytes from another source never group another document.
    return [
      ...resources
        .filter((resource) => !previousResourceIds.has(resource.resourceId))
        .map((resource) => ({
          kind: "resource" as const,
          name: resource.title,
          resourceId: resource.resourceId,
          appType: resource.appType,
          revision: resource.revision,
          mimeType: resource.kind,
          editable: true,
          ...(linked.has(resource.resourceId) ? { files: linked.get(resource.resourceId)! } : {}),
          ...(previousVersions.has(resource.resourceId)
            ? { previousVersions: previousVersions.get(resource.resourceId)! }
            : {})
        })),
      ...artifacts
        .filter((artifact) => !editableSourceOf(artifact))
        .map((artifact) => ({
          kind: "file" as const,
          name: artifact.displayName || artifact.relativePath.split("/").at(-1) || artifact.relativePath,
          relativePath: artifact.relativePath,
          ...(sourceOf(artifact) ? { sourceResourceId: sourceOf(artifact)!.resourceId } : {}),
          mimeType: artifact.mimeType,
          size: artifact.size,
          // Whether a plain file can become a resource is the registry's call.
          editable: Boolean(
            artifact.mimeType &&
            (this.registry.forKind(artifact.mimeType) || this.registry.forFileImport(artifact.mimeType))
          )
        }))
    ];
  }

  /** The Task-detail payload: an index, never resource content. */
  async taskSummary(
    taskId: string,
    agentId = "main"
  ): Promise<{
    resources: WorkspaceResource[];
    instances: AppInstance[];
    loadedInstanceId?: string;
    boundResourceId?: string;
    unbound: boolean;
    unread: Array<{ resourceId: string; title: string; appType: string; unread: number }>;
  }> {
    const [resources, instances, manifest] = await Promise.all([
      this.listResources(taskId),
      this.instances.listInstances(taskId),
      this.instances.readManifest(taskId)
    ]);
    const unread = await this.context.unreadCounts({ taskId, agentId }, resources);
    const open = instances.filter(
      (instance) =>
        instance.status !== "closed" &&
        (instance.appInstanceId === manifest.loadedInstanceId ||
          instance.resourceIds.some((id) => resources.some((resource) => resource.resourceId === id)))
    );
    const bound =
      manifest.boundResourceId &&
      resources.some((resource) => resource.resourceId === manifest.boundResourceId)
        ? manifest.boundResourceId
        : undefined;
    return {
      resources,
      instances: open,
      loadedInstanceId: manifest.loadedInstanceId,
      boundResourceId: bound,
      unbound: !manifest.loadedInstanceId,
      unread
    };
  }
}

export { defaultRegistry } from "./builtins.js";

export type { AppOperationEvent, WorkspaceResource, AppInstance, ActiveAppContext };
