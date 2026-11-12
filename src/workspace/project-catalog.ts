import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { id, now } from "../domain/types.js";
import { withFileLock } from "../storage/file-lock.js";
import { LocalWorkspaceStore } from "./workspace-store.js";
import type { ProjectRecord } from "./project-assignment.js";

export type { ProjectRecord } from "./project-assignment.js";
export interface ProjectTaskReference {
  storageRoot: string;
  taskId: string;
}
interface ProjectTransaction {
  projectId: string;
  next: ProjectRecord;
  tasks: ProjectTaskReference[];
}
interface ProjectDocument {
  version: 1;
  projects: ProjectRecord[];
  pending?: ProjectTransaction;
}

export class ProjectCatalogError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

function projectName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120 || /[\0-\x1f\x7f]/.test(value))
    throw new ProjectCatalogError("项目名称须为 1–120 个字符");
  return value.trim();
}
function legacyName(directory: string): string {
  const leaf = basename(directory) || directory;
  return leaf === ".tmp" || leaf === ".cowork" ? basename(resolve(directory, "..")) || leaf : leaf;
}
async function projectDirectory(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || !isAbsolute(value))
    throw new ProjectCatalogError("projectDirectory 必须是本机绝对路径");
  const directory = resolve(value);
  try {
    if (!(await stat(directory)).isDirectory()) throw new Error("not directory");
  } catch {
    throw new ProjectCatalogError("项目文件夹不存在或无法访问");
  }
  return directory;
}
/**
 * A shared project keeps the same id on every backend. It is an opaque
 * identity, never a directory or Task id.
 */
function sharedId(value: unknown): string {
  // New shared identities are opaque `project_<uuid>` values. A legacy
  // absolute-directory id is history, not something another host may adopt.
  if (typeof value !== "string" || !/^project_[a-f0-9-]+$/.test(value))
    throw new ProjectCatalogError("共享项目 ID 格式不合法");
  return value;
}

function validRecord(value: unknown): value is ProjectRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as ProjectRecord;
  return (
    typeof record.projectId === "string" &&
    (isAbsolute(record.projectId) || /^project_[a-f0-9-]+$/.test(record.projectId)) &&
    typeof record.projectName === "string" &&
    Boolean(record.projectName.trim()) &&
    typeof record.projectDirectory === "string" &&
    isAbsolute(record.projectDirectory) &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    (record.removedAt === undefined || typeof record.removedAt === "string")
  );
}

/** Stable project identities, independently of task history locations and run state. */
export class GlobalProjectCatalog {
  readonly filePath: string;
  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async list(): Promise<ProjectRecord[]> {
    return (await this.readDocument()).projects;
  }
  async get(projectId: string): Promise<ProjectRecord> {
    const record = (await this.list()).find((project) => project.projectId === projectId);
    if (!record) throw new ProjectCatalogError("找不到项目，请刷新项目列表", 404);
    return record;
  }
  /** App, CLI and supervisor launches share this cross-process ordering boundary. */
  withProjectLock<T>(projectId: string, action: (project: ProjectRecord) => Promise<T>): Promise<T> {
    return this.withOperation(async () => action(await this.get(projectId)));
  }
  recover(): Promise<void> {
    return this.withOperation(async () => {});
  }

  async create(
    input: { projectName: unknown; projectDirectory: unknown },
    {
      adoptLegacy = false,
      projectId: requestedProjectId
    }: { adoptLegacy?: boolean; projectId?: unknown } = {}
  ): Promise<ProjectRecord> {
    const name = projectName(input.projectName);
    const directory = await projectDirectory(input.projectDirectory);
    const sharedProjectId = requestedProjectId === undefined ? undefined : sharedId(requestedProjectId);
    return this.withOperation(async () => {
      const document = await this.readDocument();
      if (sharedProjectId && document.projects.some((project) => project.projectId === sharedProjectId))
        throw new ProjectCatalogError("该共享项目已在此后端映射，请刷新项目列表", 409);
      const existing = document.projects.find((project) => project.projectDirectory === directory);
      // A removed project comes back with its identity, so its conversations return with it.
      if (existing?.removedAt && (!sharedProjectId || sharedProjectId === existing.projectId)) {
        const restored: ProjectRecord = {
          ...existing,
          ...(existing.legacy ? { legacy: false } : {}),
          projectName: name,
          updatedAt: now()
        };
        delete restored.removedAt;
        document.projects = document.projects.map((project) =>
          project.projectId === existing.projectId ? restored : project
        );
        await this.writeDocument(document);
        return restored;
      }
      if (existing?.legacy && adoptLegacy) {
        const adopted = { ...existing, projectName: name, legacy: false, updatedAt: now() };
        document.projects = document.projects.map((project) =>
          project.projectId === existing.projectId ? adopted : project
        );
        await this.writeDocument(document);
        return adopted;
      }
      this.checkDuplicate(document, directory);
      const timestamp = now();
      const record: ProjectRecord = {
        projectId: sharedProjectId ?? id("project"),
        projectName: name,
        projectDirectory: directory,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      document.projects.push(record);
      await this.writeDocument(document);
      return record;
    });
  }

  /** Historic directory groups keep their old ids. Missing folders still have visible history. */
  async ensureLegacy(directories: string[]): Promise<void> {
    if (!directories.length) return;
    await this.withOperation(async () => {
      const document = await this.readDocument();
      let changed = false;
      for (const value of directories) {
        const directory = resolve(value);
        if (document.projects.some((project) => project.projectDirectory === directory)) continue;
        const timestamp = now();
        document.projects.push({
          projectId: directory,
          projectName: legacyName(directory),
          projectDirectory: directory,
          createdAt: timestamp,
          updatedAt: timestamp,
          legacy: true
        });
        changed = true;
      }
      if (changed) await this.writeDocument(document);
    });
  }

  /** Referenced imported histories retain their existing identity and label. */
  async importRecords(records: ProjectRecord[]): Promise<void> {
    if (!records.length) return;
    await this.withOperation(async () => {
      const document = await this.readDocument();
      let changed = false;
      for (const record of records) {
        if (!validRecord(record)) throw new ProjectCatalogError("导入的项目记录损坏", 409);
        const existing = document.projects.find((project) => project.projectId === record.projectId);
        if (existing) {
          if (existing.projectDirectory !== record.projectDirectory)
            throw new ProjectCatalogError("导入项目身份与现有目录冲突，已保留原始目录", 409);
          continue;
        }
        document.projects.push(record);
        changed = true;
      }
      if (changed) await this.writeDocument(document);
    });
  }

  async update(
    projectId: string,
    input: { projectName?: unknown; projectDirectory?: unknown },
    prepare: (
      previous: ProjectRecord,
      next: ProjectRecord,
      commit: (tasks: ProjectTaskReference[]) => Promise<ProjectRecord>
    ) => Promise<ProjectRecord>
  ): Promise<ProjectRecord> {
    if (input.projectName === undefined && input.projectDirectory === undefined)
      throw new ProjectCatalogError("请提供项目名称或文件夹");
    const name = input.projectName === undefined ? undefined : projectName(input.projectName);
    const directory =
      input.projectDirectory === undefined ? undefined : await projectDirectory(input.projectDirectory);
    return this.withProjectLock(projectId, async (previous) => {
      if (previous.removedAt) throw new ProjectCatalogError("找不到项目，请刷新项目列表", 404);
      const document = await this.readDocument();
      const next: ProjectRecord = {
        ...previous,
        ...(previous.legacy ? { legacy: false } : {}),
        projectName: name ?? previous.projectName,
        projectDirectory: directory ?? previous.projectDirectory,
        updatedAt: now()
      };
      if (next.projectDirectory === previous.projectDirectory) {
        document.projects = document.projects.map((project) =>
          project.projectId === projectId ? next : project
        );
        await this.writeDocument(document);
        return next;
      }
      this.checkDuplicate(document, next.projectDirectory, projectId);
      return prepare(previous, next, async (tasks) => {
        // Publish the intent first. Task readers keep seeing the committed old
        // project record until every snapshot has been updated. A restart can
        // finish this idempotently instead of silently keeping half a change.
        document.pending = { projectId, next, tasks };
        await this.writeDocument(document);
        await this.finishPending(document);
        return next;
      });
    });
  }

  /**
   * Take a project off the list. Nothing on disk is deleted: the record keeps
   * its id and folder, and `prepare` checks the project is idle before `commit`.
   */
  async remove(
    projectId: string,
    prepare: (project: ProjectRecord, commit: () => Promise<ProjectRecord>) => Promise<ProjectRecord>
  ): Promise<ProjectRecord> {
    return this.withProjectLock(projectId, async (project) => {
      if (project.removedAt) throw new ProjectCatalogError("找不到项目，请刷新项目列表", 404);
      return prepare(project, async () => {
        const document = await this.readDocument();
        const timestamp = now();
        const removed = { ...project, removedAt: timestamp, updatedAt: timestamp };
        document.projects = document.projects.map((entry) =>
          entry.projectId === projectId ? removed : entry
        );
        await this.writeDocument(document);
        return removed;
      });
    });
  }

  private checkDuplicate(document: ProjectDocument, directory: string, except?: string) {
    if (
      document.projects.some(
        (project) => project.projectId !== except && project.projectDirectory === directory
      )
    )
      throw new ProjectCatalogError("此文件夹已有项目，请使用现有项目", 409);
  }
  private withOperation<T>(action: () => Promise<T>): Promise<T> {
    return withFileLock(
      `${this.filePath}.operation`,
      async () => {
        const document = await this.readDocument();
        if (document.pending) await this.finishPending(document);
        return action();
      },
      { recoverDeadOwner: true }
    );
  }
  private async finishPending(document: ProjectDocument): Promise<void> {
    const transaction = document.pending;
    if (!transaction) return;
    const previous = document.projects.find((project) => project.projectId === transaction.projectId)!;
    for (const { storageRoot, taskId } of transaction.tasks) {
      const store = new LocalWorkspaceStore(storageRoot);
      const raw = JSON.parse(await readFile(resolve(storageRoot, taskId, "task.json"), "utf8")) as {
        projectId?: string;
        projectCatalogPath?: string;
        projectDirectory?: string;
      };
      if (
        raw.projectId
          ? raw.projectId !== transaction.projectId || raw.projectCatalogPath !== this.filePath
          : resolve(raw.projectDirectory || storageRoot) !== previous.projectDirectory
      )
        throw new ProjectCatalogError("待完成更新中的会话归属不匹配，已保留索引与原文件", 409);
      if (
        raw.projectId === transaction.projectId &&
        raw.projectCatalogPath === this.filePath &&
        raw.projectDirectory === transaction.next.projectDirectory
      )
        continue;
      await store.updateTask(
        taskId,
        {
          projectId: transaction.projectId,
          projectCatalogPath: this.filePath,
          projectDirectory: transaction.next.projectDirectory
        },
        { recoverDeadOwner: true }
      );
    }
    document.projects = document.projects.map((project) =>
      project.projectId === transaction.projectId ? transaction.next : project
    );
    delete document.pending;
    await this.writeDocument(document);
  }
  private async readDocument(): Promise<ProjectDocument> {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as ProjectDocument;
      if (
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 索引文件来自磁盘 JSON，旧文件或损坏文件的 version 可能不是 1
        value.version !== 1 ||
        !Array.isArray(value.projects) ||
        !value.projects.every(validRecord) ||
        new Set(value.projects.map((project) => project.projectId)).size !== value.projects.length
      )
        throw new Error("invalid projects");
      if (value.pending) {
        const pending = value.pending;
        if (
          !validRecord(pending.next) ||
          pending.next.projectId !== pending.projectId ||
          !value.projects.some((project) => project.projectId === pending.projectId) ||
          !Array.isArray(pending.tasks) ||
          !pending.tasks.every(
            (task) =>
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 待完成更新来自磁盘 JSON，tasks 数组元素可能是 null
              task &&
              typeof task.storageRoot === "string" &&
              isAbsolute(task.storageRoot) &&
              typeof task.taskId === "string" &&
              /^[a-zA-Z0-9._-]+$/.test(task.taskId) &&
              task.taskId !== "." &&
              task.taskId !== ".."
          )
        )
          throw new Error("invalid pending project update");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, projects: [] };
      throw new ProjectCatalogError("项目索引或待完成更新已损坏，请保留文件后恢复备份", 409);
    }
  }
  private async writeDocument(document: ProjectDocument): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp-${id("write")}`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
