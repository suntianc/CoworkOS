import { inspectSourceFile, sourceVersion } from "./source-file.js";
import { normalizeArtifactImportOrigin } from "./artifact-import-origin.js";
import {
  mkdir,
  appendFile,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
  lstat,
  realpath
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { withFileLock } from "../storage/file-lock.js";
import { atomicWrite, appendLine, json, jsonLine, missing } from "./fs-utils.js";
import {
  ApplicationError,
  RESOURCE_LIMITS,
  resourceContentLimit,
  bounded,
  contentVersion,
  newEventId,
  newResourceId,
  nowIso,
  safeIdentifier,
  type Actor,
  type ApplicationProject,
  type AppOperationEvent,
  type AppSelection,
  type OperationResult,
  type ResourceChangeSummary,
  type ResourceSnapshot,
  type WorkspaceResource
} from "./types.js";
import { ResourceFiles, deriveFileName } from "./resource-files.js";
import type { ApplicationRegistry } from "./registry.js";
import { OperationHistory } from "./operation-history.js";

export interface ResourceRead {
  resource: WorkspaceResource;
  snapshot: ResourceSnapshot;
  selection?: AppSelection;
  operations: AppOperationEvent[];
  /** Operations older than the returned page, for cursor paging. */
  hasMore: boolean;
}

export interface OperationRequest {
  signal?: AbortSignal;
  /**
   * Which conversation the write came from, if any.
   *
   * Recorded on the event as provenance, never used to locate the resource: the
   * resource belongs to its application, and several conversations may be
   * writing to it.
   */
  taskId?: string;
  resourceId: string;
  operationId: string;
  appType: string;
  operationType: string;
  baseRevision: number;
  payload: unknown;
  actor: Actor;
  appInstanceId?: string;
  /** Set by undo, so a later undo can tell what has already been reversed. */
  undoneEventId?: string;
}

export interface OperationOutcome {
  event: AppOperationEvent;
  resource: WorkspaceResource;
  snapshot: ResourceSnapshot;
  /** True when a retry of an already-applied operationId returned the first result. */
  deduplicated: boolean;
}

interface PendingTransaction {
  version: 1;
  resourceId: string;
  targetRevision: number;
  event: AppOperationEvent;
  resource: WorkspaceResource;
  /** The serialized bytes this transaction intends the workspace file to hold. */
  body: string;
}

interface PendingCreation {
  version: 1;
  resource: WorkspaceResource;
  body: string;
}

interface PendingRename {
  version: 1;
  resourceId: string;
  appType: string;
  source: WorkspaceResource;
  resource: WorkspaceResource;
  expectedContentVersion: string;
  sourceIdentity: { dev: number; ino: number };
}

/**
 * Durable, versioned storage for shared application resources.
 *
 * A resource *is* a file under its application's `files/` directory, or an
 * explicitly adopted external file. The user sees it, Main's ordinary file tools see it, and
 * saving is saving — there is no private object that has to be exported before
 * it becomes real. `resourceId` stays the reference key, so renaming the file
 * breaks nothing that points at it.
 *
 * What lives beside it under `applications/` is only what a file cannot carry:
 * the revision number, the operation log, the selection. The file holds the
 * content; this holds the history of how it got there.
 *
 * The store knows envelopes and versions; it never interprets a domain. Content
 * changes are produced by the resource's Adapter and the store only records
 * them, which is what keeps an editor operation and a future CAD parameter
 * change on exactly the same write path — including the locking, the revision
 * check and the crash recovery.
 *
 * One operation is written as: pending transaction → workspace file → metadata
 * → appended log → pending removed. The order matters because it is what the
 * recovery pass reads: if the process dies anywhere in the middle, the pending
 * file says what was being attempted and the durable state says how far it got.
 */
export class ResourceStore {
  /**
   * Which application owns a resource, remembered once resolved.
   *
   * Application ownership is immutable. Resolve a bare resource id to its
   * owning application before deriving its storage path.
   */
  private readonly appTypeById = new Map<string, string>();

  private readonly files: ResourceFiles;

  constructor(
    private readonly workspaceRoot: string,
    private readonly registry: ApplicationRegistry
  ) {
    this.files = new ResourceFiles(workspaceRoot, (appType) =>
      resourceContentLimit(registry.require(appType).definition)
    );
  }

  async createResource(input: {
    project?: ApplicationProject | null;
    appType: string;
    kind: string;
    title: string;
    initialContent?: unknown;
    nativeBody?: Uint8Array;
    signal?: AbortSignal;
    actor: Actor;
    resourceId?: string;
    projectId?: string;
    /** Adopt an existing file in the application's own directory. */
    adoptPath?: string;
    /**
     * Point at one of the user's own files, wherever it already lives.
     *
     * Nothing is copied: this resource reads and writes that path. Checked
     * against the harness's protected paths before it is accepted.
     */
    externalPath?: string;
    sourceFile?: { path: string; contentVersion: string };
    importedArtifact?: WorkspaceResource["importedArtifact"];
  }): Promise<{ resource: WorkspaceResource; snapshot: ResourceSnapshot }> {
    const appType = safeIdentifier(input.appType, "appType");
    const adapter = this.registry.requireKind(input.appType, input.kind);
    const title = normalizeTitle(input.title);
    const resourceId = input.resourceId ? safeIdentifier(input.resourceId, "resourceId") : newResourceId();
    const directory = this.resourceDirectory(appType, resourceId);
    await mkdir(directory, { recursive: true });
    const sourceFile = input.sourceFile
      ? await inspectSourceFile(this.files, adapter.definition, input.sourceFile)
      : undefined;
    const importedArtifact = await normalizeArtifactImportOrigin(input.importedArtifact);
    const externalPath = input.externalPath
      ? await this.files.adoptExternalPath(input.externalPath)
      : undefined;
    let content =
      input.adoptPath || externalPath
        ? undefined
        : adapter.createContent({ kind: input.kind, title, initialContent: input.initialContent });

    const initialContent = content;
    let importedOperation: { operationType: string; payload: unknown } | undefined;
    // Convert before publishing a resource or attaching it to an application.
    // Invalid native files leave the empty instance available for another try.
    if (input.nativeBody) {
      if (input.adoptPath || externalPath || !adapter.importResource)
        throw new ApplicationError("invalid_operation", "此应用不支持原生文件导入", {});
      const imported = await adapter.importResource({
        content,
        body: input.nativeBody,
        signal: input.signal
      });
      if (imported.operations?.length !== 1)
        throw new ApplicationError("invalid_operation", "原生导入必须生成一个原子操作", {});
      importedOperation = imported.operations[0];
      content = adapter.applyOperation({ ...importedOperation, content, actor: input.actor }).content;
      input.signal?.throwIfAborted();
    }

    // Reserve filenames under the application lock so concurrent creates cannot
    // select the same available name and overwrite one another.
    return withFileLock(
      join(this.applicationDirectory(appType), "resources.lock"),
      async () => {
        // Adoption reads the file rather than overwriting it: opening something
        // Main already wrote must not discard what it wrote. An external resource
        // is adoption too — the user's file is already there.
        const path = externalPath
          ? basename(externalPath)
          : input.adoptPath
            ? this.files.relativePath(input.adoptPath)
            : await this.files.availablePath(appType, deriveFileName(adapter.definition, input.kind, title));
        const resolved = externalPath
          ? adapter.parse(await this.files.read({ appType, path, externalPath }), input.kind)
          : input.adoptPath
            ? adapter.parse(await this.files.read({ appType, path }), input.kind)
            : content;
        const body = adapter.serialize(resolved);
        assertSize(body, resourceContentLimit(adapter.definition));

        const timestamp = nowIso();
        const resource: WorkspaceResource = {
          ...(input.project !== undefined
            ? { project: input.project }
            : input.projectId
              ? {}
              : { project: null }),
          resourceId,
          ...((input.project?.projectId ?? (input.project === null ? undefined : input.projectId))
            ? { projectId: input.project?.projectId ?? input.projectId }
            : {}),
          appType: input.appType,
          kind: input.kind,
          title,
          path,
          ...(externalPath ? { externalPath } : {}),
          ...(sourceFile ? { sourceFile } : {}),
          ...(importedArtifact ? { importedArtifact } : {}),
          revision: 0,
          contentVersion: contentVersion(body),
          status: "ready",
          operationCount: 0,
          createdBy: input.actor,
          updatedBy: input.actor,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        if (importedOperation) {
          await adapter.validateOperation?.({
            ...importedOperation,
            content: initialContent,
            resource,
            signal: input.signal
          });
          input.signal?.throwIfAborted();
        }
        const paths = this.paths(appType, resourceId);
        // Preserve the complete conversion before either half of its resource is
        // published. A retry can then restore the same identity even if the host
        // dies after metadata but before the first content write.
        const journaled = Boolean(input.importedArtifact && !input.adoptPath && !externalPath);
        if (journaled)
          await atomicWrite(paths.creation, json({ version: 1, resource, body } satisfies PendingCreation), {
            exclusive: true
          });
        try {
          await writeFile(join(directory, "metadata.json"), json(resource), { flag: "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            if (journaled) await unlink(paths.creation);
            throw new ApplicationError("invalid_operation", `资源已存在：${resourceId}`, { resourceId });
          }
          throw error;
        }
        if (!input.adoptPath && !externalPath)
          await this.files.write({ appType, path }, body, journaled ? { exclusive: true } : undefined);
        await appendFile(join(directory, "operations.jsonl"), "", "utf8");
        if (journaled) await unlink(paths.creation);
        return { resource, snapshot: this.snapshotOf(resource, resolved) };
      },
      { recoverDeadOwner: true }
    );
  }

  async readResource(
    appType: string,
    resourceId: string,
    options: { afterRevision?: number; limit?: number } = {}
  ): Promise<ResourceRead> {
    const paths = this.paths(appType, resourceId);
    // Readers use the same lock as writers, so content and revision cannot come
    // from opposite sides of a protocol transaction.
    return withFileLock(paths.metadata, async () => {
      await this.recoverLocked(appType, resourceId);
      const resource = await this.reconcileLocked(appType, resourceId);
      await this.assertSourceCurrentLocked(resource);
      const adapter = this.registry.require(resource.appType);
      const content = adapter.parse(await this.files.read(resource), resource.kind);
      const selection = await this.readJson<AppSelection>(
        paths.selection,
        "resource_not_found",
        resourceId
        // eslint-disable-next-line no-restricted-syntax -- 选区是可选的投影，缺失或损坏时 ResourceRead.selection 就是未保存状态
      ).catch(() => undefined);
      const limit = Math.max(1, Math.min(options.limit ?? RESOURCE_LIMITS.historyPage, 1_000));
      const history = await this.history(appType, resourceId).page(options.afterRevision, limit);
      return {
        resource,
        snapshot: this.snapshotOf(resource, content),
        selection,
        ...history
      };
    });
  }

  async findOperation(resourceId: string, operationId: string): Promise<AppOperationEvent | undefined> {
    const appType = await this.resolveAppType(safeIdentifier(resourceId, "resourceId"));
    return this.history(appType, resourceId).find(operationId);
  }

  /**
   * Read the named resources, skipping any that no longer resolve.
   *
   * Use the conversation's ResourceMappingStore references rather than scanning
   * a Task directory: one shared resource can appear in several conversations.
   *
   * A reference that does not resolve is skipped, not an error: it means the
   * resource was deleted elsewhere, and the caller prunes.
   */
  async listResources(
    references: Array<{ resourceId: string; appType: string }>
  ): Promise<WorkspaceResource[]> {
    const resources: WorkspaceResource[] = [];
    for (const reference of references) {
      try {
        await this.recover(reference.appType, reference.resourceId);
        resources.push(await this.reconcile(reference.appType, reference.resourceId));
        // eslint-disable-next-line no-restricted-syntax -- 引用可能指向已在别处删除的资源，跳过它由调用方裁剪引用，不能让一条坏引用隐藏其余资源
      } catch {
        /* a deleted or unreadable resource must not hide the rest */
      }
    }
    return resources.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Every resource an application holds, whoever references it. */
  async listByApplication(appType: string): Promise<WorkspaceResource[]> {
    const directory = join(this.applicationDirectory(appType), "resources");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const resources: WorkspaceResource[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await this.recover(appType, entry.name);
        resources.push(await this.reconcile(appType, entry.name));
        // eslint-disable-next-line no-restricted-syntax -- 目录里的单个资源可能刚被删除或 metadata 损坏，跳过它，其余资源仍要返回
      } catch {
        /* as above */
      }
    }
    return resources.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Find an exact import committed before its conversation reference was saved. */
  async findImportedArtifact(
    source: NonNullable<WorkspaceResource["importedArtifact"]>,
    appType?: string
  ): Promise<WorkspaceResource | undefined> {
    const applications = appType ? [appType] : this.registry.definitions().map((entry) => entry.appType);
    for (const application of applications) {
      const directory = join(this.applicationDirectory(application), "resources");
      const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
        if (missing(error)) return [];
        throw error;
      });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        let resource: WorkspaceResource;
        try {
          resource = await this.readMetadata(application, entry.name);
          // eslint-disable-next-line no-restricted-syntax -- metadata 缺失或损坏时回退到底下的创建日志，这条读取失败由内层 try 承接
        } catch {
          try {
            resource = (
              await this.readJson<PendingCreation>(
                this.paths(application, entry.name).creation,
                "resource_not_found",
                entry.name
              )
            ).resource;
            // eslint-disable-next-line no-restricted-syntax -- 已放弃或损坏的 creation 记录与本次导入无关，跳过该目录，导入继续查其余应用
          } catch {
            // An abandoned or damaged unrelated record cannot block imports.
            continue;
          }
        }
        const imported = await normalizeArtifactImportOrigin(resource.importedArtifact);
        if (
          imported?.storageRoot === source.storageRoot &&
          imported.taskId === source.taskId &&
          imported.relativePath === source.relativePath &&
          imported.sha256 === source.sha256
        )
          return this.readMetadataFor(application, resource.resourceId);
      }
    }
    return undefined;
  }

  /**
   * The single write path. Both a person's keystroke batch and an Agent's tool
   * call arrive here, which is why conflicts behave identically for both.
   */
  async applyOperation(input: OperationRequest): Promise<OperationOutcome> {
    const resourceId = safeIdentifier(input.resourceId, "resourceId");
    // Resolved from the resource, not taken from the caller. Deriving the path
    // from `input.appType` made a wrong one look up a resource that does not
    // exist — `resource_not_found` instead of the mismatch the caller actually
    // made, and the explicit check below became unreachable.
    const appType = await this.resolveAppType(resourceId);
    const operationId = safeIdentifier(input.operationId, "operationId");
    const paths = this.paths(appType, resourceId);
    return withFileLock(paths.metadata, async () => {
      await this.recoverLocked(appType, resourceId);
      // Reconcile inside the lock: an external edit that landed since the last
      // read has to be visible before a revision check means anything.
      const resource = await this.reconcileLocked(appType, resourceId);
      if (resource.status === "recovery_required") {
        throw new ApplicationError("resource_recovery_required", "资源处于待人工恢复状态，暂时只读", {
          resourceId
        });
      }
      if (input.appType !== resource.appType) {
        throw new ApplicationError(
          "invalid_operation",
          `资源属于 ${resource.appType}，不能用 ${input.appType} 修改`,
          { expected: resource.appType, received: input.appType }
        );
      }
      const adapter =
        input.operationType === "resource.batch"
          ? this.registry.require(resource.appType)
          : this.registry.requireOperation(resource.appType, input.operationType);

      // Idempotency is checked before the revision so a retry after a lost
      // response returns the original result instead of a spurious conflict.
      const previous = await this.history(appType, resourceId).find(operationId);
      if (previous) {
        const content = adapter.parse(await this.files.read(resource), resource.kind);
        await this.saveSourceLocked(resource, content, input.signal);
        return {
          event: previous,
          resource,
          snapshot: this.snapshotOf(resource, content),
          deduplicated: true
        };
      }
      await this.assertSourceCurrentLocked(resource);
      if (input.baseRevision !== resource.revision) {
        throw new ApplicationError("revision_conflict", "资源已被更新，请重新读取后再提交", {
          expectedRevision: input.baseRevision,
          currentRevision: resource.revision,
          ...(resource.externalChangeAt ? { externalChangeAt: resource.externalChangeAt } : {})
        });
      }
      if (resource.operationCount >= RESOURCE_LIMITS.operationCount) {
        throw new ApplicationError(
          "resource_too_large",
          `操作历史已达 ${RESOURCE_LIMITS.operationCount} 条上限，请复制为新资源`,
          {
            operationCount: resource.operationCount,
            limit: RESOURCE_LIMITS.operationCount
          }
        );
      }
      const content = adapter.parse(await this.files.read(resource), resource.kind);
      // Adapter code is trusted but not infallible; a thrown reducer must leave
      // the resource exactly as it was rather than half-written.
      input.signal?.throwIfAborted();
      const operations =
        input.operationType === "resource.batch"
          ? batchOperations(input.payload)
          : [{ operationType: input.operationType, payload: input.payload }];
      let draft = content;
      const results: OperationResult[] = [];
      for (const operation of operations) {
        const reducer = this.registry.requireOperation(resource.appType, operation.operationType);
        input.signal?.throwIfAborted();
        await reducer.validateOperation?.({ ...operation, content: draft, resource, signal: input.signal });
        input.signal?.throwIfAborted();
        const result = reducer.applyOperation({ ...operation, content: draft, actor: input.actor });
        draft = result.content;
        results.push(result);
      }
      // All reducers and validators complete before one durable revision is committed.
      const applied: OperationResult =
        input.operationType === "resource.batch"
          ? {
              content: draft,
              summary: results.map((result) => result.summary).join("; "),
              ...(results.every((result) => result.inverse)
                ? {
                    inverse: {
                      operationType: "resource.batch",
                      payload: {
                        operations: results.map((result) => result.inverse!).reverse()
                      }
                    }
                  }
                : {})
            }
          : results[0];
      const body = adapter.serialize(applied.content);
      assertSize(body, resourceContentLimit(adapter.definition));
      const revision = resource.revision + 1;
      const timestamp = nowIso();
      const event: AppOperationEvent = {
        eventId: newEventId(),
        operationId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        resourceId,
        appType: resource.appType,
        appInstanceId: input.appInstanceId,
        actor: input.actor,
        operationType: input.operationType,
        baseRevision: resource.revision,
        revision,
        payload: input.payload,
        summary: bounded(applied.summary, RESOURCE_LIMITS.operationSummary),
        ...(applied.inverse ? { inverse: applied.inverse } : {}),
        ...(input.undoneEventId ? { undoneEventId: input.undoneEventId } : {}),
        occurredAt: timestamp
      };
      const nextResource: WorkspaceResource = {
        ...resource,
        revision,
        contentVersion: contentVersion(body),
        operationCount: resource.operationCount + 1,
        updatedBy: input.actor,
        updatedAt: timestamp,
        // The write reconciles whatever external change was pending.
        externalChangeAt: undefined
      };
      await this.commit(appType, resourceId, {
        version: 1,
        resourceId,
        targetRevision: revision,
        event,
        resource: nextResource,
        body
      });
      await this.saveSourceLocked(nextResource, applied.content, input.signal);
      return {
        event,
        resource: nextResource,
        snapshot: this.snapshotOf(nextResource, applied.content),
        deduplicated: false
      };
    });
  }

  async saveSourceFile(resourceId: string, expectedRevision?: number): Promise<WorkspaceResource> {
    const appType = await this.resolveAppType(resourceId);
    return withFileLock(this.paths(appType, resourceId).metadata, async () => {
      await this.recoverLocked(appType, resourceId);
      const resource = await this.reconcileLocked(appType, resourceId);
      if (resource.status === "recovery_required")
        throw new ApplicationError("resource_recovery_required", "资源处于待人工恢复状态，暂时只读", {
          resourceId
        });
      if (expectedRevision !== undefined && resource.revision !== expectedRevision)
        throw new ApplicationError("revision_conflict", "文档已更新，请重读后再保存", {});
      const content = this.registry.require(appType).parse(await this.files.read(resource), resource.kind);
      await this.saveSourceLocked(resource, content);
      return resource;
    });
  }

  private async assertSourceCurrentLocked(resource: WorkspaceResource): Promise<void> {
    const source = resource.sourceFile;
    if (!source) return;
    const bytes = await this.files.readBytes({
      appType: resource.appType,
      path: "",
      externalPath: source.path
    });
    const version = sourceVersion(bytes);
    // Finish a write acknowledged by the filesystem but interrupted before its checkpoint.
    if (source.pending && version === source.pending.contentVersion) {
      resource.sourceFile = {
        ...source,
        contentVersion: version,
        savedRevision: source.pending.revision,
        pending: undefined
      };
      await atomicWrite(this.paths(resource.appType, resource.resourceId).metadata, json(resource));
    } else if (version !== source.contentVersion) {
      throw new ApplicationError(
        "source_file_conflict",
        "原文件已被其他软件修改，请重新打开文件；当前修改已保留",
        { path: source.path }
      );
    }
  }

  private async saveSourceLocked(
    resource: WorkspaceResource,
    content: unknown,
    signal?: AbortSignal
  ): Promise<void> {
    if (!resource.sourceFile) return;
    try {
      await this.assertSourceCurrentLocked(resource);
      const source = resource.sourceFile;
      if (source.savedRevision === resource.revision) return;
      const adapter = this.registry.require(resource.appType);
      const body =
        source.format === "resource"
          ? adapter.serialize(content)
          : (await adapter.exportResource({ resource, content, format: source.format, signal })).body;
      signal?.throwIfAborted();
      resource.sourceFile = {
        ...source,
        pending: { contentVersion: sourceVersion(body), revision: resource.revision }
      };
      const metadata = this.paths(resource.appType, resource.resourceId).metadata;
      await atomicWrite(metadata, json(resource));
      await this.files.writeBytes(
        { appType: resource.appType, path: "", externalPath: source.path },
        body,
        source.contentVersion
      );
      resource.sourceFile = {
        ...source,
        contentVersion: sourceVersion(body),
        savedRevision: resource.revision,
        pending: undefined
      };
      await atomicWrite(metadata, json(resource));
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        "source_file_write_failed",
        `保存原文件失败：${error instanceof Error ? error.message : String(error)}；修改已保留，请重试`,
        { path: resource.sourceFile.path }
      );
    }
  }

  /**
   * Undo by applying the Adapter's inverse as a new operation.
   *
   * History is append-only: undoing revision 8 produces revision 9 recording
   * that the reversal happened, rather than rewriting what was already durable
   * and possibly already read by the Agent.
   */
  async undo(input: {
    taskId?: string;
    resourceId: string;
    actor: Actor;
    appInstanceId?: string;
    baseRevision?: number;
    eventId?: string;
  }): Promise<OperationOutcome> {
    const appType = await this.resolveAppType(input.resourceId);
    await this.recover(appType, input.resourceId);
    const operations = this.history(appType, input.resourceId);
    const history = await operations.entries();
    // Walk back over what has already been undone. An undo is itself an
    // invertible operation, so taking "the last event with an inverse" made
    // undo a two-state toggle: the second press redid the first and the user
    // could never reach an earlier state.
    const undone = new Set(
      history.flatMap(({ event }) => (event.undoneEventId ? [event.undoneEventId] : []))
    );
    const entry = input.eventId
      ? history.at(-1)
      : [...history]
          .reverse()
          .find(({ event }) => event.inverse && !undone.has(event.eventId) && !event.undoneEventId);
    const last = entry ? await operations.hydrate(entry) : undefined;
    if (!last?.inverse) {
      throw new ApplicationError("invalid_operation", "没有可撤销的操作", { resourceId: input.resourceId });
    }
    const resource = await this.reconcile(appType, input.resourceId);
    if (
      (input.baseRevision !== undefined && resource.revision !== input.baseRevision) ||
      (input.eventId !== undefined && last.eventId !== input.eventId)
    ) {
      throw new ApplicationError("revision_conflict", "文档已更新，请重新查看修改对比", {
        currentRevision: resource.revision
      });
    }
    return this.applyOperation({
      ...(input.taskId ? { taskId: input.taskId } : {}),
      resourceId: input.resourceId,
      operationId: `undo-${last.eventId}`.slice(0, 64),
      appType: resource.appType,
      operationType: last.inverse.operationType,
      baseRevision: resource.revision,
      payload: last.inverse.payload,
      actor: input.actor,
      appInstanceId: input.appInstanceId,
      undoneEventId: last.eventId
    });
  }

  /**
   * Save the latest selection projection.
   *
   * Selection is not a revision: a cursor moving is not an edit, and putting it
   * in the operation log would fill history with noise and break the Agent's
   * "what changed since I last looked" cursor.
   */
  async saveSelection(input: {
    taskId?: string;
    resourceId: string;
    schema: string;
    data: unknown;
    appInstanceId?: string;
    actor: Actor;
  }): Promise<AppSelection> {
    const appType = await this.resolveAppType(input.resourceId);
    await this.recover(appType, input.resourceId);
    const paths = this.paths(appType, input.resourceId);
    const resource = await this.readMetadata(appType, input.resourceId);
    const adapter = this.registry.require(resource.appType);
    const content = adapter.parse(await this.files.read(resource), resource.kind);
    if (typeof input.schema !== "string" || !input.schema.trim()) {
      throw new ApplicationError("invalid_operation", "selection 需要 schema", {});
    }
    // An Adapter that declares its schemas gets them enforced here. Without
    // this, an unknown schema reached `summarizeSelection`, which read fields
    // that were not there and produced a confident but wrong summary — and that
    // summary travels into the Agent's prompt.
    const declared = adapter.definition.selectionSchemas;
    if (declared && !declared.includes(input.schema)) {
      throw new ApplicationError(
        "invalid_operation",
        `${resource.appType} 不支持选区 schema ${input.schema}`,
        {
          schema: input.schema,
          supported: declared
        }
      );
    }
    const summary = bounded(
      adapter.summarizeSelection({ selection: { schema: input.schema, data: input.data }, content }),
      RESOURCE_LIMITS.selectionSummary
    );
    const selection: AppSelection = {
      schema: input.schema,
      data: input.data,
      summary,
      appInstanceId: input.appInstanceId,
      updatedBy: input.actor,
      updatedAt: nowIso()
    };
    await atomicWrite(paths.selection, json(selection));
    return selection;
  }

  async readSelection(appType: string, resourceId: string): Promise<AppSelection | undefined> {
    return this.readJson<AppSelection>(
      this.paths(appType, resourceId).selection,
      "resource_not_found",
      resourceId
      // eslint-disable-next-line no-restricted-syntax -- 选区文件缺失或损坏等价于没有选区，调用方把 undefined 当作未保存选区
    ).catch(() => undefined);
  }

  /** Changes made after `afterRevision`, as the summaries an Adapter produced. */
  async changesSince(
    appType: string,
    resourceId: string,
    afterRevision: number,
    options: { excludeActor?: ActorFilter } = {}
  ): Promise<ResourceChangeSummary[]> {
    const changes: ResourceChangeSummary[] = [];
    for await (const { event } of this.history(appType, resourceId).scan()) {
      if (event.revision <= afterRevision || options.excludeActor?.(event.actor)) continue;
      changes.push({
        revision: event.revision,
        actor: event.actor,
        operationType: event.operationType,
        summary: event.summary,
        occurredAt: event.occurredAt
      });
    }
    return changes;
  }

  /**
   * Rename the workspace file along with the title.
   *
   * The file is what the user and Main both see, so a rename that left the file
   * named `未命名.md` would make the two views disagree about what this is.
   */
  async rename(appType: string, resourceId: string, title: string): Promise<WorkspaceResource> {
    const paths = this.paths(appType, resourceId);
    return withFileLock(paths.metadata, async () => {
      // Recover interrupted writes before renaming so pending transactions
      // cannot recreate the document at its former path.
      await this.recoverLocked(appType, resourceId);
      const resource = await this.reconcileLocked(appType, resourceId);
      if (resource.status === "recovery_required") {
        throw new ApplicationError("resource_recovery_required", "资源处于待人工恢复状态，暂时只读", {
          resourceId
        });
      }
      const nextTitle = normalizeTitle(title);
      const adapter = this.registry.require(resource.appType);
      const desired = deriveFileName(adapter.definition, resource.kind, nextTitle);
      // Filename reservation shares the creation lock, so two renames cannot
      // choose the same unused name. Metadata remains locked for the transaction.
      return withFileLock(join(this.applicationDirectory(appType), "resources.lock"), async () => {
        const file = await this.files.rename(resource, desired, async (target) => {
          const pending: PendingRename = {
            version: 1,
            resourceId,
            appType,
            source: resource,
            resource: { ...resource, ...target, title: nextTitle, updatedAt: nowIso() },
            expectedContentVersion: resource.contentVersion,
            sourceIdentity: await this.files.identity(resource)
          };
          await atomicWrite(paths.rename, json(pending));
        });
        const next: WorkspaceResource = { ...resource, ...file, title: nextTitle, updatedAt: nowIso() };
        await atomicWrite(paths.metadata, json(next));
        await unlink(paths.rename).catch((error) => {
          if (!missing(error)) throw error;
        });
        return next;
      });
    });
  }

  /** Export a revision under its CAS lock; repeated saves update only our verified copy. */
  async saveCopy(input: {
    resourceId: string;
    directory: string;
    format: string;
    revision: number;
    project?: ApplicationProject | null;
  }): Promise<{ resource: WorkspaceResource; path: string }> {
    const appType = await this.appTypeOf(input.resourceId);
    const paths = this.paths(appType, input.resourceId);
    return withFileLock(paths.metadata, async () => {
      await this.recoverLocked(appType, input.resourceId);
      const resource = await this.reconcileLocked(appType, input.resourceId);
      if (resource.revision !== input.revision)
        throw new ApplicationError("revision_conflict", "文档已变化，请重新保存", {
          currentRevision: resource.revision
        });
      const adapter = this.registry.require(appType);
      const content = adapter.parse(await this.files.read(resource), resource.kind);
      const exported = await adapter.exportResource({ resource, content, format: input.format });
      const destination = join(await realpath(input.directory), exported.fileName);
      const previous = resource.savedCopies?.find((copy) => copy.path === destination);
      const path = await this.files.saveCopy(
        input.directory,
        exported.fileName,
        exported.body,
        previous?.contentVersion
      );
      const copy = {
        path,
        format: input.format,
        revision: resource.revision,
        contentVersion: sourceVersion(exported.body),
        ...(input.project !== undefined ? { project: input.project } : {})
      };
      const next = {
        ...resource,
        ...(input.project && !resource.project
          ? { project: input.project, projectId: input.project.projectId }
          : {}),
        savedCopies: [...(resource.savedCopies ?? []).filter((entry) => entry.path !== path), copy]
      };
      await atomicWrite(paths.metadata, json(next));
      return { resource: next, path };
    });
  }

  /** Absolute path of a resource's file, for tools that need to read or write it. */
  absolutePath(resource: WorkspaceResource): string {
    return this.files.absolutePath(resource);
  }

  /**
   * Where an application keeps the files of its resources.
   *
   * Under the application, not under a Task. A resource belongs to no
   * conversation: conversations *reference* it, several at once, through their
   * own mapping. The previous layout put the file under `<taskId>/resources/`
   * while its own docstring claimed the opposite — which is why binding a
   * document from another conversation had to be implemented as a destructive
   * move, taking it away from the conversation that already had it.
   */
  resourceFileDirectory(appType: string): string {
    return this.files.directory(appType);
  }

  resourceDirectory(appType: string, resourceId: string): string {
    const base = join(
      this.applicationDirectory(appType),
      "resources",
      safeIdentifier(resourceId, "resourceId")
    );
    const root = resolve(this.workspaceRoot);
    const target = resolve(base);
    // Ids are already single safe segments; this is the second, cheap check that
    // a future caller cannot turn a resource id into a path outside the root.
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new ApplicationError("unsafe_path", "资源路径越出工作空间", { resourceId });
    }
    return target;
  }

  private applicationDirectory(appType: string): string {
    return join(resolve(this.workspaceRoot), "applications", safeIdentifier(appType, "appType"));
  }

  /**
   * Where an interrupted write records what it was attempting.
   *
   * Workspace-wide rather than per-Task, because the resource it describes is no
   * longer a Task's. Keyed by resource id, which is what recovery looks up.
   */
  private runtimeDirectory(): string {
    return join(resolve(this.workspaceRoot), ".runtime", "applications");
  }

  private paths(appType: string, resourceId: string) {
    const directory = this.resourceDirectory(appType, resourceId);
    return {
      directory,
      metadata: join(directory, "metadata.json"),
      operations: join(directory, "operations.jsonl"),
      selection: join(directory, "selection.json"),
      creation: join(directory, "creation.json"),
      pending: join(
        this.runtimeDirectory(),
        "transactions",
        `${safeIdentifier(resourceId, "resourceId")}.json`
      ),
      rename: join(this.runtimeDirectory(), "renames", `${safeIdentifier(resourceId, "resourceId")}.json`)
    };
  }

  /**
   * Find which application owns a resource, given only its id.
   *
   * Callers that hold a bare `resourceId` — an agent tool, an HTTP route keyed
   * only by resource — need the owning application before any path can be
   * derived. Resolved by looking, and cached for the life of the store: an
   * application never gives a resource up.
   */
  /** Resolve the owning application for callers that hold a bare resource id. */
  async appTypeOf(resourceId: string): Promise<string> {
    return this.resolveAppType(resourceId);
  }

  private async resolveAppType(resourceId: string): Promise<string> {
    const id = safeIdentifier(resourceId, "resourceId");
    const cached = this.appTypeById.get(id);
    if (cached) return cached;
    for (const definition of this.registry.definitions()) {
      try {
        await stat(join(this.resourceDirectory(definition.appType, id), "metadata.json"));
        this.appTypeById.set(id, definition.appType);
        return definition.appType;
        // eslint-disable-next-line no-restricted-syntax -- stat 失败表示该应用下没有这个资源，继续探测下一个应用，全部探测完才抛 resource_not_found
      } catch {
        /* not this application's */
      }
    }
    throw new ApplicationError("resource_not_found", `资源不存在：${resourceId}`, { resourceId });
  }

  private snapshotOf(resource: WorkspaceResource, content: unknown): ResourceSnapshot {
    return {
      resourceId: resource.resourceId,
      revision: resource.revision,
      contentVersion: resource.contentVersion,
      content,
      updatedAt: resource.updatedAt
    };
  }

  /**
   * A resource's record, reconciled against the file on disk.
   *
   * Public because a caller that only wants to reference a resource — not read
   * its content — still has to prove it exists first.
   */
  async readMetadataFor(appType: string, resourceId: string): Promise<WorkspaceResource> {
    await this.recover(appType, resourceId);
    return this.reconcile(appType, resourceId);
  }

  /**
   * A resource's record, from its id alone.
   *
   * For callers that hold only a resource — the tab strip, whose document tabs
   * name no conversation and no application — and would otherwise have to
   * resolve the owning application before they could ask anything.
   */
  async readMetadataById(resourceId: string): Promise<WorkspaceResource> {
    return this.readMetadataFor(await this.resolveAppType(resourceId), resourceId);
  }

  /** Lightweight invalidation state; never expose an unfinished transaction or hash large content. */
  async readCommittedMetadataById(resourceId: string): Promise<WorkspaceResource | undefined> {
    const appType = await this.resolveAppType(safeIdentifier(resourceId, "resourceId"));
    const paths = this.paths(appType, resourceId);
    const transactionPending = async (): Promise<boolean> => {
      for (const pending of [paths.creation, paths.rename, paths.pending]) {
        try {
          await lstat(pending);
          return true;
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
      }
      return false;
    };
    if (await transactionPending()) return undefined;
    const resource = await this.readMetadata(appType, resourceId);
    // A writer may have started between the first check and the metadata read.
    return (await transactionPending()) ? undefined : resource;
  }

  private async readMetadata(appType: string, resourceId: string): Promise<WorkspaceResource> {
    const resource = await this.readJson<WorkspaceResource>(
      this.paths(appType, resourceId).metadata,
      "resource_not_found",
      resourceId
    );
    const importedArtifact = await normalizeArtifactImportOrigin(resource.importedArtifact);
    if (importedArtifact) resource.importedArtifact = importedArtifact;
    if (
      resource.savedCopies !== undefined &&
      (!Array.isArray(resource.savedCopies) ||
        resource.savedCopies.some(
          (copy) =>
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- savedCopies 来自 metadata.json 的 JSON.parse，旧文件里可能是不带 path 的 null 元素
            !copy ||
            typeof copy.path !== "string" ||
            !isAbsolute(copy.path) ||
            /[\u0000-\u001f]/.test(copy.path) ||
            typeof copy.format !== "string" ||
            !/^[a-f0-9]{64}$/.test(copy.contentVersion) ||
            !Number.isInteger(copy.revision) ||
            copy.revision < 0
        ))
    )
      throw new ApplicationError("invalid_operation", "保存目标记录无效", { resourceId });
    return resource;
  }

  /**
   * Notice a change the protocol did not make.
   *
   * The file being real is what makes it useful and also what allows this: Main
   * can `write` it, a person can open it in vim. Such an edit cannot be
   * expressed as a revision, so it is recorded as an external change and the
   * content hash is brought up to date — which makes the next editor save a
   * `revision_conflict` rather than a silent overwrite of that work.
   */
  private async reconcile(appType: string, resourceId: string): Promise<WorkspaceResource> {
    const resource = await this.readMetadata(appType, resourceId);
    const body = await this.files.readIfPresent(resource);
    if (body === undefined || contentVersion(body) === resource.contentVersion) return resource;
    return withFileLock(this.paths(appType, resourceId).metadata, () =>
      this.reconcileLocked(appType, resourceId)
    );
  }

  private async reconcileLocked(appType: string, resourceId: string): Promise<WorkspaceResource> {
    const paths = this.paths(appType, resourceId);
    const resource = await this.readMetadata(appType, resourceId);
    const body = await this.files.read(resource);
    const version = contentVersion(body);
    if (version === resource.contentVersion) return resource;
    const timestamp = nowIso();
    const next: WorkspaceResource = {
      ...resource,
      // The revision advances so a client holding the old one is told to
      // re-read rather than being allowed to overwrite the external edit.
      revision: resource.revision + 1,
      contentVersion: version,
      updatedBy: { type: "system", id: "filesystem" },
      updatedAt: timestamp,
      externalChangeAt: timestamp
    };
    await atomicWrite(paths.metadata, json(next));
    await appendLine(
      paths.operations,
      jsonLine({
        eventId: newEventId(),
        operationId: `external-${next.revision}`,
        resourceId,
        appType: resource.appType,
        actor: next.updatedBy,
        operationType: "workspace.external_change",
        baseRevision: resource.revision,
        revision: next.revision,
        payload: { path: resource.path },
        summary: `${resource.path} 在工作区中被直接修改`,
        occurredAt: timestamp
      } satisfies AppOperationEvent)
    );
    return next;
  }

  private async readJson<T>(path: string, code: "resource_not_found", resourceId: string): Promise<T> {
    try {
      const details = await lstat(path);
      // A symlink here would let a crafted workspace redirect a resource read
      // outside the Task; refuse rather than follow it.
      if (details.isSymbolicLink() || !details.isFile())
        throw new ApplicationError("unsafe_path", "资源文件不是普通文件", { resourceId });
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      if (missing(error)) throw new ApplicationError(code, `资源不存在：${resourceId}`, { resourceId });
      throw error;
    }
  }

  private history(appType: string, resourceId: string): OperationHistory {
    return new OperationHistory(this.resourceDirectory(appType, resourceId));
  }

  private async commit(appType: string, resourceId: string, transaction: PendingTransaction): Promise<void> {
    const paths = this.paths(appType, resourceId);
    const history = this.history(appType, resourceId);
    // Validate the bounded event and flush any external payloads before changing
    // the resource. Recovery can always reconstruct the same receipt from pending.
    const record = await history.prepare(transaction.event);
    await mkdir(join(this.runtimeDirectory(), "transactions"), { recursive: true });
    await atomicWrite(paths.pending, json(transaction));
    await this.files.write(transaction.resource, transaction.body);
    await atomicWrite(paths.metadata, json(transaction.resource));
    await history.appendPrepared(record);
    await unlink(paths.pending).catch((error) => {
      if (!missing(error)) throw error;
    });
  }

  /** Public recovery entry point; takes the lock itself. */
  async recover(appType: string, resourceId: string): Promise<void> {
    const paths = this.paths(appType, resourceId);
    for (const pending of [paths.creation, paths.rename, paths.pending]) {
      try {
        const details = await lstat(pending);
        if (!details.isFile()) continue;
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      await withFileLock(paths.metadata, () => this.recoverLocked(appType, resourceId), {
        recoverDeadOwner: true
      });
      return;
    }
  }

  private async recoverCreationLocked(appType: string, resourceId: string): Promise<void> {
    const paths = this.paths(appType, resourceId);
    let pending: PendingCreation;
    try {
      pending = await this.readJson<PendingCreation>(paths.creation, "resource_not_found", resourceId);
    } catch (error) {
      if (error instanceof ApplicationError && error.code === "resource_not_found") return;
      throw error;
    }
    const refuse = async (reason: string): Promise<never> => {
      await this.markRecoveryRequired(appType, resourceId, reason);
      throw new ApplicationError("resource_recovery_required", "导入创建中断状态无法确认，已保留原有文件", {
        resourceId,
        reason
      });
    };
    if (
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- creation 日志用 JSON.parse 从磁盘读取，整个文件可能是 null
      !pending ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- creation 日志可能是另版本的布局，版本字段不匹配就按不可判定处理
      pending.version !== 1 ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 同一条磁盘日志里 resource 字段可能缺失，读 resourceId 前要先判空
      pending.resource?.resourceId !== resourceId ||
      pending.resource.appType !== appType ||
      !pending.resource.importedArtifact ||
      pending.resource.externalPath ||
      pending.resource.revision !== 0 ||
      pending.resource.operationCount !== 0 ||
      typeof pending.body !== "string" ||
      contentVersion(pending.body) !== pending.resource.contentVersion
    )
      return refuse("创建意图与资源身份或内容不一致");
    const importedArtifact = await normalizeArtifactImportOrigin(pending.resource.importedArtifact);
    if (!importedArtifact) return refuse("创建意图的来源身份无效");
    pending.resource.importedArtifact = importedArtifact;
    assertSize(pending.body, resourceContentLimit(this.registry.require(appType).definition));
    await withFileLock(
      join(this.applicationDirectory(appType), "resources.lock"),
      async () => {
        const current = await this.readMetadata(appType, resourceId).catch((error) => {
          if (error instanceof ApplicationError && error.code === "resource_not_found") return undefined;
          throw error;
        });
        if (
          current &&
          (current.resourceId !== resourceId ||
            current.appType !== appType ||
            current.path !== pending.resource.path ||
            current.externalPath ||
            current.revision !== 0 ||
            current.operationCount !== 0 ||
            current.contentVersion !== pending.resource.contentVersion ||
            current.importedArtifact?.storageRoot !== importedArtifact.storageRoot ||
            current.importedArtifact.taskId !== importedArtifact.taskId ||
            current.importedArtifact.relativePath !== importedArtifact.relativePath ||
            current.importedArtifact.sha256 !== importedArtifact.sha256)
        )
          return refuse("资源已在创建中断后改变");
        const body = await this.files.readIfPresent(pending.resource);
        if (body !== undefined && contentVersion(body) !== pending.resource.contentVersion)
          return refuse("创建目标文件已被独立修改");
        if (body === undefined) {
          try {
            await this.files.write(pending.resource, pending.body, { exclusive: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") return refuse("创建目标已被其他文件占用");
            throw error;
          }
        }
        if (!current) await atomicWrite(paths.metadata, json(pending.resource), { exclusive: true });
        await appendFile(paths.operations, "", "utf8");
        await unlink(paths.creation);
      },
      { recoverDeadOwner: true }
    );
  }

  private async recoverRenameLocked(appType: string, resourceId: string): Promise<void> {
    const paths = this.paths(appType, resourceId);
    let pending: PendingRename;
    const refuse = async (reason: string): Promise<never> => {
      await this.markRecoveryRequired(appType, resourceId, reason);
      throw new ApplicationError("resource_recovery_required", "重命名中断状态无法确认，请恢复文档备份", {
        resourceId,
        reason
      });
    };
    try {
      const details = await lstat(paths.rename);
      if (!details.isFile() || details.isSymbolicLink()) return refuse("重命名意图不是普通文件");
      pending = JSON.parse(await readFile(paths.rename, "utf8")) as PendingRename;
    } catch (error) {
      if (missing(error)) return;
      if (error instanceof ApplicationError) throw error;
      return refuse("重命名意图无法解析");
    }
    if (
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 重命名意图用 JSON.parse 从磁盘读取，整个文件可能是 null
      !pending ||
      typeof pending !== "object" ||
      Array.isArray(pending) ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 重命名意图可能来自另版本布局，版本字段不匹配就拒绝恢复
      pending.version !== 1 ||
      pending.resourceId !== resourceId ||
      pending.appType !== appType ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 日志里 source 字段可能缺失，取 source.resourceId 前要先判空
      pending.source?.resourceId !== resourceId ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 同上，source.appType 也可能缺失
      pending.source?.appType !== appType ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 日志里 resource 字段可能缺失，取 resourceId 前要先判空
      pending.resource?.resourceId !== resourceId ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 同上，resource.appType 也可能缺失
      pending.resource?.appType !== appType ||
      pending.resource.revision !== pending.source.revision ||
      pending.expectedContentVersion !== pending.source.contentVersion ||
      pending.expectedContentVersion !== pending.resource.contentVersion ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 文件身份来自旧日志，sourceIdentity 可能整体缺失，缺失即无法核对 inode
      !Number.isSafeInteger(pending.sourceIdentity?.dev) ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 同上，sourceIdentity 缺失时 ino 也读不到
      !Number.isSafeInteger(pending.sourceIdentity?.ino)
    )
      return refuse("重命名意图与资源身份不一致");
    const current = await this.readJson<WorkspaceResource>(paths.metadata, "resource_not_found", resourceId);
    const sameLocation = (
      left: Pick<WorkspaceResource, "path" | "externalPath">,
      right: Pick<WorkspaceResource, "path" | "externalPath">
    ) => left.path === right.path && left.externalPath === right.externalPath;
    const sameIdentity = async (file: WorkspaceResource) => {
      const identity = await this.files.identity(file);
      return identity.dev === pending.sourceIdentity.dev && identity.ino === pending.sourceIdentity.ino;
    };
    if (current.resourceId !== resourceId || current.appType !== appType)
      return refuse("重命名元数据与资源身份不一致");
    // Metadata is committed after the move, so subsequent direct edits at the
    // new location belong to this resource and will be reconciled normally.
    if (sameLocation(current, pending.resource) && current.revision >= pending.resource.revision) {
      await unlink(paths.rename);
      return;
    }
    if (
      !sameLocation(current, pending.source) ||
      current.revision !== pending.source.revision ||
      current.contentVersion !== pending.expectedContentVersion
    )
      return refuse("重命名的原资源版本已改变");
    await withFileLock(join(this.applicationDirectory(appType), "resources.lock"), async () => {
      const targetBody = await this.files.readIfPresent(pending.resource);
      if (targetBody !== undefined) {
        if (
          contentVersion(targetBody) !== pending.expectedContentVersion ||
          !(await sameIdentity(pending.resource))
        )
          return refuse("重命名目标文件已被独立修改");
      } else {
        const sourceBody = await this.files.readIfPresent(pending.source);
        if (
          sourceBody === undefined ||
          contentVersion(sourceBody) !== pending.expectedContentVersion ||
          !(await sameIdentity(pending.source))
        )
          return refuse("重命名原文件缺失或已被其他文件替代");
        await this.files.rename(pending.source, pending.resource.path, async (target) => {
          if (!sameLocation(target, pending.resource)) return refuse("重命名目标已被其他文件占用");
        });
      }
      // The old filename may already be reused by a different resource. Never
      // read it as the original once the intended target has been verified.
      await atomicWrite(paths.metadata, json(pending.resource));
      await unlink(paths.rename);
    });
  }

  /**
   * Finish or redo an interrupted transaction, or refuse to guess.
   *
   * Three states are decidable. The metadata already carries the target
   * revision and the file already holds the target bytes, so only the log line
   * is missing and it is appended. Or nothing reached the target revision, so
   * the whole transaction is redone. Anything else means the durable state
   * disagrees in a way no rule can resolve, and silently picking one would
   * destroy a user's work; that resource is marked read-only for a person.
   */
  private async recoverLocked(appType: string, resourceId: string): Promise<void> {
    await this.recoverCreationLocked(appType, resourceId);
    await this.recoverRenameLocked(appType, resourceId);
    const paths = this.paths(appType, resourceId);
    let pending: PendingTransaction;
    try {
      pending = JSON.parse(await readFile(paths.pending, "utf8")) as PendingTransaction;
    } catch (error) {
      if (missing(error)) return;
      // An unparseable pending file is itself undecidable: it may describe a
      // half-applied write. Mark the resource rather than dropping the file.
      await this.markRecoveryRequired(appType, resourceId, "pending transaction 无法解析");
      // eslint-disable-next-line no-restricted-syntax -- 资源已标记为 recovery_required，删掉这个无法判定的日志失败也不改变该状态，下次恢复仍拒绝重放
      await unlink(paths.pending).catch(() => {});
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- pending 事务用 JSON.parse 从磁盘读取，version/resourceId 可能来自另版本或损坏的文件
    if (pending.version !== 1 || pending.resourceId !== resourceId) {
      // eslint-disable-next-line no-restricted-syntax -- 版本不符的日志无法重放，删除失败时下次恢复会再走到同一分支并原样丢弃
      await unlink(paths.pending).catch(() => {});
      return;
    }
    const resource = await this.readJson<WorkspaceResource>(
      paths.metadata,
      "resource_not_found",
      resourceId
      // eslint-disable-next-line no-restricted-syntax -- metadata 缺失或被破坏时无法判定中断事务，下面的分支会标记 recovery_required 并记录原因
    ).catch(() => undefined);
    if (!resource) {
      await this.markRecoveryRequired(appType, resourceId, "资源元数据缺失，无法判定中断事务");
      return;
    }
    const body = await this.files.readIfPresent(pending.resource);
    const fileMatchesTarget = body !== undefined && contentVersion(body) === pending.resource.contentVersion;
    const history = this.history(appType, resourceId);
    const logged = await history.contains(pending.event.operationId);
    const target = pending.targetRevision;

    if (resource.revision === target && fileMatchesTarget) {
      if (!logged) await history.append(pending.event);
      // eslint-disable-next-line no-restricted-syntax -- metadata 与操作日志都已落盘，删除 pending 只是收尾；删不掉时下次恢复命中同一已提交分支，不会重复追加
      await unlink(paths.pending).catch(() => {});
      return;
    }
    if (resource.revision === target - 1 && !logged) {
      // The content rename can land before the metadata checkpoint. Matching
      // the pending bytes proves this is the attempted operation, so finish its
      // metadata and log without rewriting the file. Calling it an external
      // change here would discard the operation id, inverse and retry receipt.
      if (fileMatchesTarget) {
        await atomicWrite(paths.metadata, json(pending.resource));
        await history.append(pending.event);
        // eslint-disable-next-line no-restricted-syntax -- 事务到这里已完整提交，pending 只是收尾；删除失败留给下次恢复重试，不会写第二遍
        await unlink(paths.pending).catch(() => {});
        return;
      }
      // Finishing forward overwrites the file, so it is only safe while the
      // file still holds what this transaction was applied to. If someone
      // edited it after the crash — which the file being real makes possible —
      // replaying would destroy that work, so the external change is recorded
      // instead and the interrupted operation is abandoned.
      const untouched = body !== undefined && contentVersion(body) === resource.contentVersion;
      if (untouched || body === undefined) {
        await this.commit(appType, resourceId, pending);
        return;
      }
      // eslint-disable-next-line no-restricted-syntax -- 文件已被外部修改，事务就此放弃；删除日志失败时下次恢复走到无法判定分支并标记 recovery_required，不会重放覆盖用户修改
      await unlink(paths.pending).catch(() => {});
      await this.reconcileLocked(appType, resourceId);
      return;
    }
    await this.markRecoveryRequired(
      appType,
      resourceId,
      `中断事务状态无法判定：metadata=${resource.revision} target=${target} fileMatches=${fileMatchesTarget} logged=${logged}`
    );
  }

  private async markRecoveryRequired(appType: string, resourceId: string, reason: string): Promise<void> {
    const paths = this.paths(appType, resourceId);
    const resource = await this.readJson<WorkspaceResource>(
      paths.metadata,
      "resource_not_found",
      resourceId
      // eslint-disable-next-line no-restricted-syntax -- metadata 读不出来就没有可标记的记录，调用方抛出的错误本身已带上 reason
    ).catch(() => undefined);
    if (!resource) return;
    await atomicWrite(
      paths.metadata,
      json({ ...resource, status: "recovery_required", recoveryReason: reason, updatedAt: nowIso() })
    );
  }
}

export type ActorFilter = (actor: Actor) => boolean;

function normalizeTitle(value: unknown): string {
  const title = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!title) throw new ApplicationError("invalid_operation", "资源标题不能为空", {});
  return title.slice(0, 200);
}

function assertSize(body: string, limit: number): string {
  if (Buffer.byteLength(body, "utf8") > limit) {
    throw new ApplicationError("resource_too_large", `资源超过 ${limit / (1024 * 1024)} MiB 上限`, { limit });
  }
  return body;
}

/** Bounded, non-nested batch, committed by the same lock/CAS/journal as one operation. */
export function batchOperations(payload: unknown): Array<{ operationType: string; payload: unknown }> {
  const entries = (payload as { operations?: unknown } | null)?.operations;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 256)
    throw new ApplicationError("invalid_operation", "操作批次需要 1–256 个操作", {});
  return entries.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.operationType !== "string" ||
      entry.operationType === "resource.batch"
    )
      throw new ApplicationError("invalid_operation", "无效或嵌套的操作批次", {});
    return { operationType: entry.operationType, payload: entry.payload };
  });
}
