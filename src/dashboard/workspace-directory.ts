import { recoverMessageEditTransaction } from "../runtime/main-message-edit-transaction.js";
import { withFileLock } from "../storage/file-lock.js";
export interface TaskListItem {
  taskId: string;
  status: string;
  goal?: string;
  model?: string;
  constraints?: string[];
  successCriteria?: string[];
  activeRunId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  version: number;
  workspaceRoot: string;
  storageRoot: string;
  projectId: string | null;
  projectName: string;
  projectDirectory: string;
}

export interface ProjectListItem {
  projectId: string;
  projectName: string;
  workspaceRoot: string;
  projectDirectory: string;
  createdAt: string;
  updatedAt: string;
  legacy?: boolean;
  hasApplications?: boolean;
  tasks: TaskListItem[];
}

export interface TaskLocation {
  workspaceRoot: string;
  store: LocalWorkspaceStore;
  task: Awaited<ReturnType<LocalWorkspaceStore["readTask"]>>;
  projectId: string;
  projectName: string;
  projectDirectory: string;
}

import { dirname, isAbsolute, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { TemporaryWorkspaceStore } from "../workspace/temporary-workspaces.js";
import { ResourceMappingStore } from "../applications/mapping-store.js";
import { GlobalWorkspaceCatalog } from "../workspace/global-catalog.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import {
  GlobalProjectCatalog,
  ProjectCatalogError,
  type ProjectRecord,
  type ProjectTaskReference
} from "../workspace/project-catalog.js";
import type { TaskMetadata } from "../workspace/workspace-store.js";
import { readProjectAssignment } from "../workspace/project-assignment.js";
import { inferLegacyProjectDirectory, applicationProjectEvidence } from "../workspace/project-history.js";

/** Owns the workspace catalog and cross-workspace lookup, independently of HTTP/Run state. */
export function createWorkspaceDirectory(
  initialRoot: string,
  globalIndexPath: string,
  runtimeValue: (name: "COWORK_MODEL") => string | undefined
) {
  let workspaceRoot = initialRoot;
  const temporaryWorkspaces = new TemporaryWorkspaceStore(dirname(globalIndexPath));
  const globalCatalog = new GlobalWorkspaceCatalog(globalIndexPath);
  const projectCatalog = new GlobalProjectCatalog(join(dirname(globalIndexPath), "projects.json"));
  const catalogReady = Promise.all([globalCatalog.register(workspaceRoot), projectCatalog.recover()]);

  async function knownWorkspaceRoots(): Promise<string[]> {
    await catalogReady;
    const roots = await globalCatalog.list();
    if (!roots.includes(workspaceRoot)) {
      await globalCatalog.register(workspaceRoot);
      roots.push(workspaceRoot);
    }
    return [...new Set(roots)];
  }

  // Resource discovery includes current project homes and persisted older roots.
  // It does not promote those homes into Task storage or create directory projects.
  async function applicationWorkspaceRoots(): Promise<string[]> {
    const roots = await knownWorkspaceRoots();
    const locations = [];
    for (const root of roots)
      for (const task of await new LocalWorkspaceStore(root).listTasks(true))
        locations.push({ workspaceRoot: root, task });
    return applicationRoots(roots, locations, await projectCatalog.list());
  }

  async function applicationRoots(
    roots: string[],
    locations: Array<{ workspaceRoot: string; task: TaskLocation["task"] }>,
    projects: ProjectRecord[]
  ): Promise<string[]> {
    const applications = new Set(
      [...roots, ...(await temporaryWorkspaces.roots())].map((root) => resolve(root))
    );
    for (const project of projects) applications.add(resolve(project.projectDirectory));
    for (const { workspaceRoot: root, task } of locations) {
      for (const reference of await new ResourceMappingStore(root).list(task.taskId))
        if (reference.workspaceRoot) applications.add(resolve(reference.workspaceRoot));
      const manifest = await readFile(join(root, task.taskId, "applications", "manifest.json"), "utf8")
        .then((body) => JSON.parse(body) as { workspaceRoot?: unknown })
        .catch(() => {
          // A discovery hint may be damaged or unreadable. Keep the original
          // bytes and discover other roots through catalogs, mappings and valid Tasks.
          return undefined;
        });
      if (typeof manifest?.workspaceRoot === "string" && isAbsolute(manifest.workspaceRoot))
        applications.add(resolve(manifest.workspaceRoot));
    }
    return [...applications];
  }

  async function listGlobalProjects(): Promise<{ tasks: TaskListItem[]; projects: ProjectListItem[] }> {
    const roots = await knownWorkspaceRoots();
    const stored = await storedTasks(true, roots);
    const locations = stored.filter((location) => location.task.kind !== "workspace");
    const records = await projectRecords(locations);
    const grouped = new Map(
      records.map((project) => [
        project.projectId,
        { ...project, workspaceRoot: project.projectDirectory, tasks: [] as TaskListItem[] }
      ])
    );
    const temporaryTasks = locations
      .filter((location) => location.task.temporaryWorkspaceRoot)
      .map((location) =>
        taskListItem({
          ...location,
          projectId: "",
          projectName: "",
          projectDirectory: location.task.temporaryWorkspaceRoot!
        })
      );
    for (const location of locations.filter((location) => !location.task.temporaryWorkspaceRoot)) {
      const project = resolveProject(location.task, location.workspaceRoot, records);
      grouped.get(project.projectId)!.tasks.push(
        taskListItem({
          ...location,
          projectId: project.projectId,
          projectName: project.projectName,
          projectDirectory: project.projectDirectory
        })
      );
    }
    const evidence = records.some((project) => project.legacy)
      ? await applicationProjectEvidence(await applicationRoots(roots, stored, records), records, initialRoot)
      : new Set<string>();
    const projects = [...grouped.values()]
      .map((project) => ({
        ...project,
        ...(project.legacy ? { hasApplications: evidence.has(project.projectId) } : {})
      }))
      .filter((project) => !project.legacy || project.tasks.length > 0 || project.hasApplications);
    for (const project of projects) project.tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    projects.sort((a, b) => {
      const aUpdated = a.tasks[0]?.updatedAt ?? a.updatedAt;
      const bUpdated = b.tasks[0]?.updatedAt ?? b.updatedAt;
      return bUpdated.localeCompare(aUpdated) || a.projectName.localeCompare(b.projectName);
    });
    const tasks = [...temporaryTasks, ...projects.flatMap((project) => project.tasks)].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
    return { tasks, projects };
  }

  async function storedTasks(includeWorkspaces = false, roots?: string[]) {
    const locations: Array<{
      workspaceRoot: string;
      store: LocalWorkspaceStore;
      task: TaskLocation["task"];
    }> = [];
    for (const root of roots ?? (await knownWorkspaceRoots())) {
      const store = new LocalWorkspaceStore(root);
      const tasks = await store.listTasks(includeWorkspaces).catch(() => []);
      for (let task of tasks) {
        if (task.kind !== "workspace") {
          if (await recoverMessageEditTransaction(root, task.taskId))
            task = await store.readTask(task.taskId);
          if (!task.projectDirectory)
            task.projectDirectory = await inferLegacyProjectDirectory(root, task.taskId);
        }
        locations.push({ workspaceRoot: root, store, task });
      }
    }
    return locations;
  }
  async function projectRecords(
    locations: Array<{ workspaceRoot: string; task: TaskLocation["task"] }>
  ): Promise<ProjectRecord[]> {
    locations = locations.filter(({ task }) => !task.temporaryWorkspaceRoot);
    let records = await projectCatalog.list();
    const imported: ProjectRecord[] = [];
    for (const { task } of locations) {
      if (
        !task.projectId ||
        !task.projectCatalogPath ||
        task.projectCatalogPath === projectCatalog.filePath ||
        records.some((project) => project.projectId === task.projectId)
      )
        continue;
      const project = await readProjectAssignment(task.projectCatalogPath, task.projectId);
      if (project) imported.push(project);
    }
    if (imported.length) {
      await projectCatalog.importRecords(imported);
      records = await projectCatalog.list();
    }
    const missing = locations.filter(
      ({ task, workspaceRoot: root }) =>
        !records.some(
          (project) =>
            project.projectId === task.projectId ||
            project.projectDirectory === (task.projectDirectory || root)
        )
    );
    if (missing.length) {
      await projectCatalog.ensureLegacy(
        missing.map(({ task, workspaceRoot: root }) => task.projectDirectory || root)
      );
      records = await projectCatalog.list();
    }
    for (const { task, workspaceRoot: root } of locations) {
      const project = resolveProject(task, root, records);
      if (task.projectId === project.projectId && task.projectCatalogPath === projectCatalog.filePath)
        continue;
      await projectCatalog.withProjectLock(project.projectId, async (currentProject) => {
        const store = new LocalWorkspaceStore(root);
        const current = await store.readTask(task.taskId);
        if (
          current.projectId === currentProject.projectId &&
          current.projectCatalogPath === projectCatalog.filePath
        )
          return;
        await store.updateTask(
          task.taskId,
          {
            projectId: currentProject.projectId,
            projectCatalogPath: projectCatalog.filePath,
            projectDirectory: currentProject.projectDirectory
          },
          { preserveUpdatedAt: true, recoverDeadOwner: true }
        );
      });
    }
    return records;
  }
  function resolveProject(task: TaskLocation["task"], root: string, records: ProjectRecord[]): ProjectRecord {
    const project =
      records.find((record) => record.projectId === task.projectId) ??
      records.find((record) => record.projectDirectory === (task.projectDirectory || root));
    if (!project) throw new Error("找不到会话所属项目");
    return project;
  }

  async function globalTaskPayload(): Promise<{
    workspaceRoot: string;
    currentWorkspaceRoot: string;
    model: string | undefined;
    tasks: TaskListItem[];
    projects: ProjectListItem[];
  }> {
    const grouped = await listGlobalProjects();
    return {
      workspaceRoot,
      currentWorkspaceRoot: workspaceRoot,
      model: runtimeValue("COWORK_MODEL"),
      ...grouped
    };
  }

  async function locateTask(taskId: string): Promise<TaskLocation> {
    for (const root of await knownWorkspaceRoots()) {
      const taskStore = new LocalWorkspaceStore(root);
      try {
        await recoverMessageEditTransaction(root, taskId);
        const task = await taskStore.readTask(taskId);
        // Holding Tasks provide editor access, not a user project. Looking one
        // up must not run legacy directory adoption or rewrite its assignment.
        if (task.kind === "workspace" || task.temporaryWorkspaceRoot)
          return {
            workspaceRoot: root,
            store: taskStore,
            task,
            projectId: "",
            projectName: "",
            projectDirectory: task.temporaryWorkspaceRoot ?? root
          };
        if (!task.projectDirectory) task.projectDirectory = await inferLegacyProjectDirectory(root, taskId);
        const project = resolveProject(task, root, await projectRecords([{ task, workspaceRoot: root }]));
        return {
          workspaceRoot: root,
          store: taskStore,
          task: await taskStore.readTask(taskId),
          projectId: project.projectId,
          projectName: project.projectName,
          projectDirectory: project.projectDirectory
        };
      } catch {
        /* task belongs to another registered workspace */
      }
    }
    throw new Error(`unknown task: ${taskId}`);
  }

  function taskListItem(location: TaskLocation): TaskListItem {
    return {
      ...location.task,
      workspaceRoot: location.projectDirectory,
      storageRoot: location.workspaceRoot,
      projectId: location.task.temporaryWorkspaceRoot ? null : location.projectId,
      projectName: location.projectName,
      projectDirectory: location.projectDirectory
    };
  }

  return {
    knownWorkspaceRoots,
    applicationWorkspaceRoots,
    createTemporaryWorkspace: () => temporaryWorkspaces.create(workspaceRoot),
    async createTemporaryTask(taskId: string, metadata: TaskMetadata, existingRoot?: unknown) {
      await catalogReady;
      return withFileLock(join(dirname(globalIndexPath), "task-creation.lock"), async () => {
        for (const root of await knownWorkspaceRoots()) {
          const existing = await new LocalWorkspaceStore(root).readTask(taskId).catch((error: Error) => {
            if (error.message === `unknown task: ${taskId}`) return undefined;
            throw error;
          });
          if (existing) throw new ProjectCatalogError("会话 ID 已存在", 409);
        }
        let root: string;
        if (existingRoot !== undefined) {
          if (typeof existingRoot !== "string" || !(await temporaryWorkspaces.roots()).includes(existingRoot))
            throw new ProjectCatalogError("临时工作区不存在", 400);
          root = existingRoot;
        } else root = (await temporaryWorkspaces.create(workspaceRoot)).root;
        await new LocalWorkspaceStore(workspaceRoot).createTask(taskId, {
          ...metadata,
          temporaryWorkspaceRoot: root,
          projectDirectory: root
        });
        return taskListItem(await locateTask(taskId));
      });
    },
    async applicationProjectForRoot(root: string) {
      await catalogReady;
      // Hidden migration remnants cannot be resurrected by opening another
      // unassigned editor in the same internal/test directory.
      const project = (await listGlobalProjects()).projects.find(
        (entry) => resolve(entry.projectDirectory) === resolve(root)
      );
      return project
        ? {
            projectId: project.projectId,
            projectName: project.projectName,
            projectDirectory: project.projectDirectory,
            projectCatalogPath: projectCatalog.filePath
          }
        : null;
    },
    async applicationProjectForId(projectId: string) {
      await catalogReady;
      const project = (await projectCatalog.list()).find((entry) => entry.projectId === projectId);
      return project ? { ...project, projectCatalogPath: projectCatalog.filePath } : null;
    },
    register: (root: string) => globalCatalog.register(root),
    locateTask,
    taskListItem,
    globalTaskPayload,
    projectCatalog,
    async withApplicationProjectLock<T>(
      projectId: string,
      action: (project: import("../applications/types.js").ApplicationProject) => Promise<T>
    ) {
      return projectCatalog.withProjectLock(projectId, (project) =>
        action({ ...project, projectCatalogPath: projectCatalog.filePath })
      );
    },
    async createProject(input: { projectName: unknown; projectDirectory: unknown; projectId?: unknown }) {
      await catalogReady;
      await projectRecords(await storedTasks());
      const visible = (await listGlobalProjects()).projects;
      const hiddenLegacy = (await projectCatalog.list()).some(
        (project) =>
          project.legacy &&
          typeof input.projectDirectory === "string" &&
          project.projectDirectory === resolve(input.projectDirectory) &&
          !visible.some((entry) => entry.projectId === project.projectId)
      );
      const project = await projectCatalog.create(
        { projectName: input.projectName, projectDirectory: input.projectDirectory },
        {
          adoptLegacy: hiddenLegacy,
          ...(input.projectId === undefined ? {} : { projectId: input.projectId })
        }
      );
      return { ...project, workspaceRoot: project.projectDirectory, tasks: [] };
    },
    async createProjectTask(taskId: string, projectId: string, metadata: TaskMetadata) {
      await catalogReady;
      await withFileLock(join(dirname(globalIndexPath), "task-creation.lock"), () =>
        projectCatalog.withProjectLock(projectId, async (project) => {
          for (const root of await knownWorkspaceRoots()) {
            const existing = await new LocalWorkspaceStore(root).readTask(taskId).catch((error: Error) => {
              if (error.message === `unknown task: ${taskId}`) return undefined;
              throw error;
            });
            if (existing) throw new ProjectCatalogError("会话 ID 已存在，请创建新的会话", 409);
          }
          await new LocalWorkspaceStore(workspaceRoot).createTask(taskId, {
            ...metadata,
            projectId,
            projectCatalogPath: projectCatalog.filePath,
            projectDirectory: project.projectDirectory
          });
        })
      );
      return taskListItem(await locateTask(taskId));
    },
    async updateProject(
      projectId: string,
      input: { projectName?: unknown; projectDirectory?: unknown },
      guard: <T>(taskIds: string[], action: () => Promise<T>) => Promise<T>
    ) {
      await catalogReady;
      await projectRecords(await storedTasks());
      const project = await projectCatalog.update(projectId, input, async (previous, _next, commit) => {
        const records = await projectCatalog.list();
        const members = (await storedTasks()).filter(
          ({ task, workspaceRoot: root }) =>
            !task.temporaryWorkspaceRoot &&
            resolveProject(task, root, records).projectId === previous.projectId
        );
        const references: ProjectTaskReference[] = members.map(({ task, workspaceRoot: storageRoot }) => ({
          taskId: task.taskId,
          storageRoot
        }));
        return guard(
          references.map((member) => member.taskId),
          () => commit(references)
        );
      });
      return {
        ...project,
        workspaceRoot: project.projectDirectory,
        tasks:
          (await listGlobalProjects()).projects.find((record) => record.projectId === projectId)?.tasks ?? []
      };
    },
    async withTaskProjectLock<T>(taskId: string, action: () => Promise<T>): Promise<T> {
      const location = await locateTask(taskId);
      return location.task.temporaryWorkspaceRoot || location.task.kind === "workspace"
        ? action()
        : projectCatalog.withProjectLock(location.projectId, action);
    },
    get root() {
      return workspaceRoot;
    },
    async switchRoot(root: string) {
      await globalCatalog.register(root);
      workspaceRoot = root;
    }
  };
}
