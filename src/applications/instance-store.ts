import { mkdir, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { withFileLock } from "../storage/file-lock.js";
import { atomicWrite, json, missing } from "./fs-utils.js";
import {
  ApplicationError,
  RESOURCE_LIMITS,
  newInstanceId,
  nowIso,
  safeIdentifier,
  type AppInstance,
  type ApplicationProject,
  type AppInstanceStatus
} from "./types.js";

export interface TaskManifest {
  version: 3;
  loadedInstanceId?: string;
  instanceHistory: string[];
  /** Compatibility projection; never persisted as a second source of truth. */
  boundResourceId?: string;
  tabOrder: string[];
  updatedAt: string;
  /** Location of the loaded window; the manifest itself stays with the Task. */
  workspaceRoot?: string;
}
interface InstanceIndex {
  version: 1;
  instances: AppInstance[];
  /** Legacy duplicates resolve to the surviving instance. Original files remain untouched. */
  aliases: Record<string, string>;
}

/** One disk read for callers resolving several windows in a single request. */
export interface InstanceSnapshot {
  get(appInstanceId: string): AppInstance | undefined;
  findByResource(resourceId: string): AppInstance | undefined;
}

/** Instances belong to the workspace. Only conversations store loading relationships. */
export class InstanceStore {
  constructor(
    private readonly workspaceRoot: string,
    private readonly taskStorageRoot: string = workspaceRoot
  ) {}
  private get indexPath() {
    return join(resolve(this.workspaceRoot), "applications", "instances", "index.json");
  }

  /** Discovery must not initialize indexes in every empty project or stale directory. */
  async hasInstanceData(): Promise<boolean> {
    try {
      await readFile(this.indexPath, "utf8");
      return true;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    for (const task of await readdir(this.workspaceRoot, { withFileTypes: true }).catch((error) => {
      if (missing(error)) return [];
      throw error;
    })) {
      if (!task.isDirectory() || task.name === "applications") continue;
      const files = await readdir(join(this.workspaceRoot, task.name, "applications", "instances")).catch(
        (error) => {
          if (missing(error)) return [];
          throw error;
        }
      );
      if (files.some((file) => file.endsWith(".json"))) return true;
    }
    return false;
  }

  private async index(): Promise<InstanceIndex> {
    try {
      return JSON.parse(await readFile(this.indexPath, "utf8")) as InstanceIndex;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await mkdir(join(this.indexPath, ".."), { recursive: true });
    return withFileLock(this.indexPath, async () => {
      try {
        return JSON.parse(await readFile(this.indexPath, "utf8")) as InstanceIndex;
      } catch (error) {
        if (!missing(error)) throw error;
      }
      const legacy: AppInstance[] = [];
      for (const task of await readdir(this.workspaceRoot, { withFileTypes: true })) {
        if (!task.isDirectory() || task.name === "applications") continue;
        const directory = join(this.workspaceRoot, task.name, "applications", "instances");
        for (const file of await readdir(directory).catch((error) => {
          if (missing(error)) return [];
          throw error;
        })) {
          if (!file.endsWith(".json")) continue;
          const raw = JSON.parse(await readFile(join(directory, file), "utf8"));
          safeIdentifier(raw.appInstanceId, "appInstanceId");
          legacy.push({
            appInstanceId: raw.appInstanceId,
            appType: raw.appType,
            resourceIds: raw.resourceIds ?? [],
            status: raw.status,
            title: raw.title,
            uiState: raw.uiState,
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt
          });
        }
      }
      const index: InstanceIndex = { version: 1, instances: [], aliases: {} };
      // The oldest identity survives; the most recently saved UI state survives too.
      for (const instance of legacy.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        const same = instance.resourceIds.length
          ? index.instances.find(
              (other) =>
                other.appType === instance.appType &&
                JSON.stringify([...other.resourceIds].sort()) ===
                  JSON.stringify([...instance.resourceIds].sort())
            )
          : undefined;
        if (!same) {
          index.instances.push(instance);
          continue;
        }
        index.aliases[instance.appInstanceId] = same.appInstanceId;
        if (instance.updatedAt > same.updatedAt) {
          same.uiState = instance.uiState ?? same.uiState;
          same.title = instance.title;
          same.updatedAt = instance.updatedAt;
        }
        if (instance.status !== "closed") same.status = "open";
      }
      await atomicWrite(this.indexPath, json(index));
      return index;
    });
  }

  private async update<T>(change: (index: InstanceIndex) => T): Promise<T> {
    await this.index();
    return withFileLock(this.indexPath, async () => {
      const index = JSON.parse(await readFile(this.indexPath, "utf8")) as InstanceIndex;
      const result = change(index);
      await atomicWrite(this.indexPath, json(index));
      return result;
    });
  }

  async createInstance(input: {
    project?: ApplicationProject | null;
    taskId?: string;
    appType: string;
    title: string;
    resourceIds?: string[];
    uiState?: Record<string, unknown>;
  }): Promise<AppInstance> {
    const timestamp = nowIso();
    const instance: AppInstance = {
      ...(input.project !== undefined ? { project: input.project } : {}),
      appInstanceId: newInstanceId(),
      appType: safeIdentifier(input.appType, "appType"),
      resourceIds: (input.resourceIds ?? []).map((id) => safeIdentifier(id, "resourceId")),
      status: "open",
      title: normalizeTitle(input.title),
      ...(input.uiState ? { uiState: boundUiState(input.uiState) } : {}),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    return this.update((index) => {
      const existing = instance.resourceIds.length
        ? index.instances.find(
            (entry) =>
              entry.status !== "closed" &&
              entry.appType === instance.appType &&
              JSON.stringify(entry.resourceIds) === JSON.stringify(instance.resourceIds)
          )
        : undefined;
      if (existing) return existing;
      index.instances.push(instance);
      return instance;
    });
  }

  /** The optional first task argument is accepted only for older API callers. */
  async readInstance(id: string, legacyId?: string): Promise<AppInstance> {
    const asked = safeIdentifier(legacyId ?? id, "appInstanceId");
    const instance = (await this.readSnapshot()).get(asked);
    if (!instance)
      throw new ApplicationError("instance_not_found", `应用实例不存在：${asked}`, { appInstanceId: asked });
    return instance;
  }

  async readSnapshot(): Promise<InstanceSnapshot> {
    const index = await this.index();
    const instances = new Map(index.instances.map((instance) => [instance.appInstanceId, instance]));
    return {
      get(id) {
        const asked = safeIdentifier(id, "appInstanceId");
        return instances.get(index.aliases[asked] ?? asked);
      },
      findByResource(id) {
        return index.instances.find(
          (instance) => instance.status !== "closed" && instance.resourceIds.includes(id)
        );
      }
    };
  }

  async listInstances(_legacyTaskId?: string): Promise<AppInstance[]> {
    return (await this.index()).instances;
  }

  async findByResource(id: string, legacyResourceId?: string): Promise<AppInstance | undefined> {
    return (await this.listInstances()).find(
      (instance) => instance.status !== "closed" && instance.resourceIds.includes(legacyResourceId ?? id)
    );
  }

  async updateInstance(
    id: string,
    patchOrId:
      | string
      | {
          status?: AppInstanceStatus;
          resourceIds?: string[];
          uiState?: Record<string, unknown>;
          title?: string;
        },
    legacyPatch?: {
      status?: AppInstanceStatus;
      resourceIds?: string[];
      uiState?: Record<string, unknown>;
      title?: string;
    }
  ): Promise<AppInstance> {
    const found = await this.readInstance(typeof patchOrId === "string" ? patchOrId : id);
    const patch = typeof patchOrId === "string" ? legacyPatch! : patchOrId;
    return this.update((index) => {
      const current = index.instances.find((entry) => entry.appInstanceId === found.appInstanceId)!;
      Object.assign(current, {
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.resourceIds
          ? { resourceIds: patch.resourceIds.map((resourceId) => safeIdentifier(resourceId, "resourceId")) }
          : {}),
        ...(patch.uiState ? { uiState: boundUiState(patch.uiState) } : {}),
        ...(patch.title ? { title: normalizeTitle(patch.title) } : {}),
        updatedAt: nowIso()
      });
      return current;
    });
  }

  async readManifest(
    taskId: string,
    snapshot?: () => Promise<InstanceSnapshot | undefined>
  ): Promise<TaskManifest> {
    let pendingSnapshot: Promise<InstanceSnapshot> | undefined;
    // Empty manifests need no index, and historical window lookup failures retain
    // their original per-field recovery boundaries below.
    const readSnapshot = async () => (await snapshot?.()) ?? this.readSnapshot();
    const instances = () => (pendingSnapshot ??= readSnapshot());
    const readInstance = async (id: string) => (await instances()).get(id);
    let value: {
      version?: number;
      loadedInstanceId?: string;
      boundResourceId?: string;
      activeInstanceId?: string;
      instanceHistory?: string[];
      tabOrder?: string[];
      updatedAt?: string;
      workspaceRoot?: string;
    };
    try {
      value = JSON.parse(await readFile(this.manifestPath(taskId), "utf8"));
    } catch (error) {
      if (missing(error)) value = {};
      else throw error;
    }
    const workspaceRoot =
      typeof value.workspaceRoot === "string" && isAbsolute(value.workspaceRoot)
        ? resolve(value.workspaceRoot)
        : resolve(this.taskStorageRoot);
    const belongsHere = workspaceRoot === resolve(this.workspaceRoot);
    let instance =
      value.loadedInstanceId && belongsHere
        ? // eslint-disable-next-line no-restricted-syntax -- 清单里的旧实例可能已不存在，按没有加载实例恢复
          await readInstance(value.loadedInstanceId).catch(() => undefined)
        : undefined;
    if (value.version !== 3 && belongsHere) {
      if (value.boundResourceId) instance = (await instances()).findByResource(value.boundResourceId);
      else if (value.activeInstanceId)
        // eslint-disable-next-line no-restricted-syntax -- 旧版清单记录的活动实例可能已删除，回退为未加载状态
        instance = await readInstance(value.activeInstanceId).catch(() => undefined);
    }
    return {
      instanceHistory: [
        ...new Set([
          ...(
            await Promise.all(
              (value.instanceHistory ?? []).map(async (id) => {
                try {
                  safeIdentifier(id, "appInstanceId");
                  // eslint-disable-next-line no-restricted-syntax -- 历史实例找不到时保留原始 id，窗口列表不能因此丢失
                  return (await readInstance(id).catch(() => undefined))?.appInstanceId ?? id;
                  // eslint-disable-next-line no-restricted-syntax -- 非法实例 id 是清单里的坏数据，跳过它而不是让整个清单读取失败
                } catch {
                  return undefined;
                }
              })
            )
          ).filter((id): id is string => !!id),
          ...(instance ? [instance.appInstanceId] : [])
        ])
      ],
      version: 3,
      loadedInstanceId: instance?.status !== "closed" ? instance?.appInstanceId : undefined,
      boundResourceId: instance?.status !== "closed" ? instance?.resourceIds[0] : undefined,
      tabOrder: value.tabOrder ?? [],
      updatedAt: value.updatedAt ?? nowIso(),
      ...(value.workspaceRoot ? { workspaceRoot } : {})
    };
  }

  async setLoadedInstance(taskId: string, appInstanceId: string | undefined): Promise<TaskManifest> {
    const instance = appInstanceId ? await this.readInstance(appInstanceId) : undefined;
    if (instance?.status === "closed") throw new ApplicationError("instance_not_found", "应用实例已关闭", {});
    const path = this.manifestPath(taskId);
    await mkdir(join(path, ".."), { recursive: true });
    await withFileLock(path, async () => {
      const previous = await this.readManifest(taskId);
      await atomicWrite(
        path,
        json({
          version: 3,
          loadedInstanceId: instance?.appInstanceId,
          ...(instance && resolve(this.workspaceRoot) !== resolve(this.taskStorageRoot)
            ? { workspaceRoot: resolve(this.workspaceRoot) }
            : {}),
          instanceHistory: [
            ...new Set([...previous.instanceHistory, ...(instance ? [instance.appInstanceId] : [])])
          ],
          updatedAt: nowIso()
        })
      );
    });
    return this.readManifest(taskId);
  }

  async setBoundResource(taskId: string, resourceId: string | undefined): Promise<TaskManifest> {
    const instance = resourceId ? await this.findByResource(resourceId) : undefined;
    if (resourceId && !instance) throw new ApplicationError("instance_not_found", "文档尚未在应用中打开", {});
    return this.setLoadedInstance(taskId, instance?.appInstanceId);
  }

  async withInstanceLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const instance = await this.readInstance(id);
    return withFileLock(join(this.indexPath, "..", instance.appInstanceId), action);
  }

  async loadingTasks(appInstanceId: string): Promise<string[]> {
    const id = (await this.readInstance(appInstanceId)).appInstanceId;
    const tasks: string[] = [];
    for (const entry of await readdir(this.taskStorageRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "applications") continue;
      try {
        safeIdentifier(entry.name, "taskId");
        // eslint-disable-next-line no-restricted-syntax -- 任务目录名不合法就跳过，它不是本应用的存储目录
      } catch {
        continue;
      }
      if ((await this.readManifest(entry.name)).loadedInstanceId === id) tasks.push(entry.name);
    }
    return tasks;
  }
  private manifestPath(taskId: string) {
    return join(
      resolve(this.taskStorageRoot),
      safeIdentifier(taskId, "taskId"),
      "applications",
      "manifest.json"
    );
  }
}
function normalizeTitle(value: unknown): string {
  return (
    String(value ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 200) || "未命名"
  );
}
function boundUiState(value: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > RESOURCE_LIMITS.uiStateBytes)
    throw new ApplicationError("resource_too_large", "uiState 超过限制", {});
  return JSON.parse(serialized) as Record<string, unknown>;
}
