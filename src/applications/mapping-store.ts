import { mkdir, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { withFileLock } from "../storage/file-lock.js";
import { atomicWrite, json } from "./fs-utils.js";
import { ApplicationError, nowIso, safeIdentifier } from "./types.js";

/** One resource a conversation has chosen to work with. */
export interface ResourceReference {
  resourceId: string;
  appType: string;
  addedAt: string;
  /** Absent on legacy references whose resources share the Task storage root. */
  workspaceRoot?: string;
}

interface MappingFile {
  version: 1;
  resources: ResourceReference[];
}

/**
 * Which resources a conversation references.
 *
 * This is what replaced ownership. A resource belongs to no Task: it lives
 * under its application, and any number of conversations may reference it at
 * once. Binding is adding a line here; unbinding removes the line and touches
 * nothing else.
 *
 * The distinction matters because the previous model had to *move* a resource to
 * bind it somewhere new — which took the document away from the conversation
 * that already had it, and made "several agents working on one document"
 * impossible to express. A reference is cheap and non-exclusive, so it is.
 *
 * Deliberately not a list of what exists: a reference can outlive the resource
 * it names (deleted elsewhere, or the workspace moved). Resolution is the
 * caller's job, and a dangling reference is dropped on read rather than treated
 * as an error — the same way the tab strip prunes a tab whose window is gone.
 */
export class ResourceMappingStore {
  constructor(
    private readonly workspaceRoot: string,
    private readonly resourceWorkspaceRoot: string = workspaceRoot
  ) {}

  async list(taskId: string): Promise<ResourceReference[]> {
    const file = await this.read(taskId);
    return file.resources;
  }

  /**
   * Reference a resource from this conversation.
   *
   * Idempotent: referencing what is already referenced is not an error, because
   * two agents deciding to work on the same document is the normal case rather
   * than a mistake.
   */
  async add(
    taskId: string,
    reference: { resourceId: string; appType: string }
  ): Promise<ResourceReference[]> {
    const resourceId = safeIdentifier(reference.resourceId, "resourceId");
    const appType = safeIdentifier(reference.appType, "appType");
    // Existing references are a read, including while another process owns the
    // writer lock. A genuinely new reference is checked again under that lock.
    const existing = await this.list(taskId);
    if (existing.some((entry) => entry.resourceId === resourceId)) return existing;
    return this.update(taskId, (current) => {
      if (current.some((entry) => entry.resourceId === resourceId)) return current;
      return [
        ...current,
        {
          resourceId,
          appType,
          addedAt: nowIso(),
          ...(resolve(this.resourceWorkspaceRoot) !== resolve(this.workspaceRoot)
            ? { workspaceRoot: resolve(this.resourceWorkspaceRoot) }
            : {})
        }
      ];
    });
  }

  /** Stop referencing a resource. The resource, and every other reference, stay. */
  async remove(taskId: string, resourceId: string): Promise<ResourceReference[]> {
    const id = safeIdentifier(resourceId, "resourceId");
    return this.update(taskId, (current) => current.filter((entry) => entry.resourceId !== id));
  }

  /** Whether this conversation references a resource, for an access check. */
  async references(taskId: string, resourceId: string): Promise<boolean> {
    return (await this.list(taskId)).some((entry) => entry.resourceId === resourceId);
  }

  /**
   * Which conversations reference a resource.
   *
   * The reverse of every other method here, and the only way to answer a
   * question a shared document raises: an edit has to reach each conversation
   * that is working on it, and the document itself records none of them. Read
   * by scanning the workspace's conversations, because the references live with
   * the conversations that made them — which is what lets a conversation drop
   * its reference without touching the document or anyone else's.
   */
  async tasksFor(resourceId: string): Promise<string[]> {
    const root = resolve(this.workspaceRoot);
    const owners: string[] = [];
    // eslint-disable-next-line no-restricted-syntax -- 工作区根目录可能还没创建，此时没有任何会话引用该资源
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      // eslint-disable-next-line no-restricted-syntax -- 某个会话的映射文件读不出来就当作没有引用它，与 read() 的空映射回退一致
      if (await this.references(entry.name, resourceId).catch(() => false)) owners.push(entry.name);
    }
    return owners;
  }

  /**
   * Drop references whose resource no longer resolves.
   *
   * Called with a predicate rather than resolving here, so the store stays
   * ignorant of where a resource lives and who decides it exists.
   */
  async prune(
    taskId: string,
    alive: (reference: ResourceReference) => boolean
  ): Promise<ResourceReference[]> {
    return this.update(taskId, (current) => current.filter(alive));
  }

  private async update(
    taskId: string,
    change: (current: ResourceReference[]) => ResourceReference[]
  ): Promise<ResourceReference[]> {
    const path = this.path(taskId);
    await mkdir(join(resolve(this.workspaceRoot), safeIdentifier(taskId, "taskId"), "applications"), {
      recursive: true
    });
    return withFileLock(path, async () => {
      const file = await this.read(taskId);
      const resources = change(file.resources);
      if (
        resources.length === file.resources.length &&
        resources.every((entry, index) => entry === file.resources[index])
      )
        return resources;
      await atomicWrite(path, json({ version: 1 as const, resources, updatedAt: nowIso() }));
      return resources;
    });
  }

  private async read(taskId: string): Promise<MappingFile> {
    try {
      const value = JSON.parse(await readFile(this.path(taskId), "utf8")) as Partial<MappingFile> | null;
      if (value?.version !== 1 || !Array.isArray(value.resources)) return { version: 1, resources: [] };
      // Each entry is validated on the way out: a hand-edited file must not be
      // able to turn a reference into a path.
      const resources = value.resources.flatMap((entry) => {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mapping.json 可被手工编辑，条目可能不是对象
        if (!entry || typeof entry.resourceId !== "string" || typeof entry.appType !== "string") return [];
        try {
          return [
            {
              resourceId: safeIdentifier(entry.resourceId, "resourceId"),
              appType: safeIdentifier(entry.appType, "appType"),
              addedAt: typeof entry.addedAt === "string" ? entry.addedAt : nowIso(),
              ...(typeof entry.workspaceRoot === "string" && isAbsolute(entry.workspaceRoot)
                ? { workspaceRoot: resolve(entry.workspaceRoot) }
                : {})
            }
          ];
          // eslint-disable-next-line no-restricted-syntax -- 非法 id 的引用条目直接丢弃，不能让它变成可用的路径
        } catch {
          return [];
        }
      });
      return { version: 1, resources };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, resources: [] };
      // An unreadable mapping is an empty one: a conversation that references
      // nothing still works, and failing the page load would be worse.
      if (error instanceof ApplicationError) throw error;
      return { version: 1, resources: [] };
    }
  }

  private path(taskId: string): string {
    return join(
      resolve(this.workspaceRoot),
      safeIdentifier(taskId, "taskId"),
      "applications",
      "mapping.json"
    );
  }
}
