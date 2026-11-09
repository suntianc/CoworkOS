import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  mainSessionEntryKind,
  mainSessionKind,
  mainSessionTitleFromGoal,
  type MainSession,
  type MainSessionEntryKind,
  type MainSessionKind,
  type MainSessionRun,
  type MainSessionRunState
} from "../domain/main-session.js";
import {
  ProjectDataConflictError,
  ProjectDataInvalidError,
  ProjectDataNotFoundError
} from "../domain/project-ledger.js";
import type { MainSessionRecord, ProjectDataRuntime } from "../workspace/project-data-service.js";

export interface MainSessionProject {
  projectId: string;
  projectName: string;
  projectDirectory: string;
}

export interface MainSessionTask {
  taskId: string;
  goal?: string;
  title?: string;
  status: string;
  activeRunId?: string;
}

/**
 * What the page and the tool see for one session.
 *
 * Everything shared comes from the authoritative service; the local execution
 * facts (`activeRunId`, `status`, `projectDirectory`) are read from this
 * backend's own catalog, so a session that belongs to another backend is shown
 * as remote instead of being run against a path this machine does not own.
 */
export interface MainSessionView extends MainSession {
  currentRequirementTitle?: string;
  projectDirectory: string;
  local: boolean;
  activeRunId: string | null;
  status?: string;
  runs: MainSessionRun[];
}

export interface MainSessionServicePorts {
  runtime: Pick<ProjectDataRuntime, "service">;
  /** The serving backend: it owns the Pi history of the sessions it created. */
  backendId: string;
  /**
   * The external Main budget this backend applies.
   *
   * A saved external regular session counts toward its project's session limit,
   * so a third saved session cannot appear behind a two-slot service; only a
   * running Main, not a saved conversation, occupies a running slot.
   */
  capacity?: {
    settings(): { resident: number; continuation: number } | undefined;
    sessionUsage(projectId: string): Promise<{ regular: number; continuation: number } | undefined>;
    noteSession(record: MainSessionRecord): Promise<void>;
    /**
     * Serialize an external session's limit check and its creation. Two pages
     * saving at once must not each pass the last free place.
     */
    withCreateLock?<T>(action: () => Promise<T>): Promise<T>;
  };
  project(projectId: string): Promise<MainSessionProject | undefined>;
  projectTasks(projectId: string): Promise<MainSessionTask[]>;
  createProjectTask(taskId: string, projectId: string, metadata: { goal: string }): Promise<unknown>;
}

/**
 * The project's persistent Main sessions over the shared ledger service.
 *
 * A session names one Task as its local history container, so creating a
 * session creates the conversation that will hold its Pi transcript; adopting
 * an older conversation records the identity without touching the files.
 */
export function createMainSessionService(ports: MainSessionServicePorts) {
  async function resolvedProject(projectId: string): Promise<MainSessionProject> {
    const project = await ports.project(projectId);
    if (!project) throw new ProjectDataNotFoundError("项目不存在");
    return project;
  }

  async function bindProject(projectId: string): Promise<MainSessionProject> {
    const project = await resolvedProject(projectId);
    const service = await ports.runtime.service();
    await service.ensureProject({
      projectId: project.projectId,
      projectName: project.projectName,
      projectDirectory: project.projectDirectory,
      backendId: ports.backendId
    });
    return project;
  }

  function view(
    record: MainSessionRecord,
    project: MainSessionProject,
    tasks: ReadonlyMap<string, MainSessionTask>
  ): MainSessionView {
    const task = record.session.backendId === ports.backendId ? tasks.get(record.session.taskId) : undefined;
    return {
      ...record.session,
      ...(record.currentRequirementTitle ? { currentRequirementTitle: record.currentRequirementTitle } : {}),
      projectDirectory: project.projectDirectory,
      local: Boolean(task),
      // A finished Run is history; only an unfinished one is still owned now.
      activeRunId: task && ["running", "waiting"].includes(task.status) ? (task.activeRunId ?? null) : null,
      ...(task ? { status: task.status } : {}),
      runs: record.runs
    };
  }

  async function listed(projectId: string): Promise<MainSessionView[]> {
    const project = await bindProject(projectId);
    const service = await ports.runtime.service();
    const tasks = await ports.projectTasks(projectId);
    const byTask = new Map(tasks.map((task) => [task.taskId, task]));
    let records = await service.listMainSessions(projectId);
    // Conversations that predate sessions join the list once, keeping their
    // account and their Pi directory where they already are.
    const known = new Set(
      records
        .filter((record) => record.session.backendId === ports.backendId)
        .map((record) => record.session.taskId)
    );
    const missing = tasks.filter((task) => !known.has(task.taskId));
    if (missing.length) {
      await service.adoptMainSessionTasks(
        projectId,
        ports.backendId,
        missing.map((task) => ({ taskId: task.taskId, goal: task.goal, title: task.title }))
      );
      records = await service.listMainSessions(projectId);
    }
    return records.map((record) => view(record, project, byTask));
  }

  /**
   * Which session would run this Task, without recording anything.
   *
   * Capacity admission needs the session's entry kind before a Run exists. An
   * unknown Task is an internal conversation that `beginRun` will create.
   */
  async function resolve(
    location: {
      projectId: string;
      task: { taskId: string };
    },
    input: { mainSessionId?: unknown }
  ): Promise<{ sessionId: string; entryKind: MainSessionEntryKind; kind: MainSessionKind } | undefined> {
    if (!location.projectId) return undefined;
    const project = await bindProject(location.projectId);
    const service = await ports.runtime.service();
    const identity = (record: MainSessionRecord) => ({
      sessionId: record.session.sessionId,
      entryKind: record.session.entryKind,
      kind: record.session.kind
    });
    if (input.mainSessionId !== undefined && input.mainSessionId !== null) {
      const record = await service.getMainSession(project.projectId, input.mainSessionId);
      if (record.session.backendId !== ports.backendId)
        throw new ProjectDataConflictError(
          "该会话由另一台后端执行，不能在此发送",
          undefined,
          "remote_session"
        );
      if (record.session.taskId !== location.task.taskId)
        throw new ProjectDataConflictError(
          "该消息不属于当前会话，请刷新页面后重新发送",
          undefined,
          "session_task_mismatch"
        );
      return identity(record);
    }
    const record = await service.findMainSessionByTask(
      project.projectId,
      ports.backendId,
      location.task.taskId
    );
    return record ? identity(record) : undefined;
  }

  return {
    resolve,

    list(projectId: string): Promise<MainSessionView[]> {
      return listed(projectId);
    },

    async create(
      projectId: string,
      input: {
        title?: unknown;
        entryKind?: unknown;
        kind?: unknown;
        requirementId?: unknown;
      }
    ): Promise<MainSessionView> {
      if (input.title !== undefined && typeof input.title !== "string")
        throw new ProjectDataInvalidError("会话名称必须是字符串");
      const project = await bindProject(projectId);
      const service = await ports.runtime.service();
      const entryKind: MainSessionEntryKind = mainSessionEntryKind(input.entryKind);
      const kind: MainSessionKind = mainSessionKind(input.kind);
      const requirementId =
        input.requirementId === undefined || input.requirementId === null
          ? undefined
          : typeof input.requirementId === "string"
            ? input.requirementId
            : undefined;
      if (input.requirementId !== undefined && input.requirementId !== null && !requirementId)
        throw new ProjectDataInvalidError("需求 ID 必须是字符串");
      const create = async (): Promise<MainSessionView> => {
        // The check and the creation of one external session are one step: a
        // concurrent save of the last free place must see this count.
        if (entryKind === "external") {
          const settings = ports.capacity?.settings();
          if (!settings)
            throw new ProjectDataConflictError(
              "外部 Main 尚未启用：请先在外部服务配置 resident 与 continuation",
              undefined,
              "main_capacity_unconfigured"
            );
          if (kind === "regular") {
            const usage = await ports.capacity?.sessionUsage(project.projectId);
            if ((usage?.regular ?? 0) >= settings.resident)
              throw new ProjectDataConflictError(
                `项目外部常规会话已达上限（resident=${settings.resident}）；接续会话不计入项目上限`,
                undefined,
                "main_session_limit"
              );
          }
        }
        const requirementTitle = requirementId
          ? (await service.getRequirement(projectId, requirementId)).title
          : undefined;
        const title =
          typeof input.title === "string" && input.title.trim()
            ? input.title.trim()
            : (requirementTitle ?? "新会话");
        const taskId = `task-${randomUUID()}`;
        await ports.createProjectTask(taskId, projectId, { goal: title });
        const record = await service.createMainSession(projectId, {
          title,
          entryKind,
          kind,
          backendId: ports.backendId,
          taskId,
          ...(requirementId ? { requirementId } : {})
        });
        // The CLI and worker find this backend's external Mains through this
        // local index, so it is written with the session before it is listed.
        await ports.capacity
          ?.noteSession(record)
          .catch((error) =>
            console.error(
              `[cowork] external session index failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
          );
        return view(record, project, new Map([[taskId, { taskId, status: "created" }]]));
      };
      return entryKind === "external" && ports.capacity?.withCreateLock
        ? ports.capacity.withCreateLock(create)
        : create();
    },

    async selectRequirement(
      projectId: string,
      sessionId: string,
      requirementId: unknown
    ): Promise<MainSessionView> {
      const project = await bindProject(projectId);
      const service = await ports.runtime.service();
      const record = await service.setMainSessionRequirement(projectId, sessionId, requirementId);
      const tasks = await ports.projectTasks(projectId);
      return view(record, project, new Map(tasks.map((task) => [task.taskId, task])));
    },

    /**
     * Bind a Run to the session that owns the Task before the process starts.
     *
     * An explicit session is checked against the Task so a stale page cannot
     * post one conversation's input into another; without one, the Task's own
     * session is used, adopting a conversation that predates sessions.
     */
    async beginRun(
      location: {
        workspaceRoot: string;
        projectId: string;
        projectName: string;
        projectDirectory: string;
        task: { taskId: string; goal?: string; title?: string };
      },
      input: { runId: string; mainSessionId?: unknown; requirementId?: unknown }
    ): Promise<MainSessionView | undefined> {
      if (!location.projectId) return undefined;
      const project = await resolvedProject(location.projectId);
      const service = await ports.runtime.service();
      await service.ensureProject({
        projectId: project.projectId,
        projectName: project.projectName,
        projectDirectory: project.projectDirectory,
        backendId: ports.backendId
      });
      let record: MainSessionRecord;
      if (input.mainSessionId !== undefined && input.mainSessionId !== null) {
        const resolved = (await resolve(location, input))!;
        record = await service.getMainSession(project.projectId, resolved.sessionId);
      } else {
        record =
          (await service.findMainSessionByTask(project.projectId, ports.backendId, location.task.taskId)) ??
          (await service.createMainSession(project.projectId, {
            title: mainSessionTitleFromGoal(location.task.title ?? location.task.goal, location.task.taskId),
            backendId: ports.backendId,
            taskId: location.task.taskId
          }));
      }
      await service.recordMainSessionRun(project.projectId, record.session.sessionId, {
        runId: input.runId,
        taskId: location.task.taskId,
        ...(input.requirementId === undefined || input.requirementId === null
          ? {}
          : { requirementId: input.requirementId })
      });
      return view(
        await service.getMainSession(project.projectId, record.session.sessionId),
        project,
        new Map([
          [
            location.task.taskId,
            {
              taskId: location.task.taskId,
              goal: location.task.goal,
              status: "running",
              activeRunId: input.runId
            }
          ]
        ])
      );
    },

    /**
     * Whether this Task already has Pi history to continue.
     *
     * A session is one continuing conversation: when its directory already
     * holds a transcript the launcher resumes it even if the Task snapshot no
     * longer names a Run, which is how old conversations keep their thread.
     */
    async hasHistory(location: { workspaceRoot: string; task: { taskId: string } }): Promise<boolean> {
      const files = await readdir(
        join(location.workspaceRoot, location.task.taskId, "sessions", "main", "pi")
        // eslint-disable-next-line no-restricted-syntax -- 会话目录在首次 Main 启动前尚未创建，读取失败就意味着没有历史可接续，启动器按全新会话处理
      ).catch(() => []);
      return files.some((name) => name.endsWith(".jsonl"));
    },

    /** A settled or cancelled Run keeps its session; a legacy Run has no row. */
    settle(projectId: string, taskId: string, runId: string, state: MainSessionRunState): Promise<number> {
      return ports.runtime
        .service()
        .then((service) => service.settleMainSessionRun(projectId, taskId, runId, state));
    }
  };
}

export type MainSessionService = ReturnType<typeof createMainSessionService>;
