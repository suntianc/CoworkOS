import { join } from "node:path";
import {
  DevelopmentExistsError,
  developmentIdentifier,
  mergeExecutionBackendId,
  mergeRepository,
  mergeTargetBranch,
  type DevelopmentRecord,
  type MergeConfig
} from "../domain/project-development.js";
import { ProjectDataConflictError, ProjectDataNotFoundError } from "../domain/project-ledger.js";
import { id } from "../domain/types.js";
import type {
  DevelopmentCreate,
  DevelopmentUpdate,
  MergeConfigInput,
  ProjectDataRuntime
} from "../workspace/project-data-service.js";
import {
  developmentWorkspaceIsIntact,
  prepareDevelopmentWorkspace,
  resolveDevelopmentBaseline
} from "../workspace/development-workspace.js";

export interface DevelopmentProject {
  projectId: string;
  projectName: string;
  projectDirectory: string;
}

export interface ProjectDevelopmentPorts {
  runtime: Pick<ProjectDataRuntime, "service">;
  /** The serving backend: it owns the checkouts it prepares and can read them back. */
  backendId: string;
  /** Where isolated checkouts live, outside every user working copy. */
  developmentRoot: string;
  project(projectId: string): Promise<DevelopmentProject | undefined>;
  taskProject(taskId: string): Promise<DevelopmentProject | undefined>;
}

/**
 * The development-record service: shared goal, criteria, route and baseline,
 * plus this backend's isolated Git checkout.
 *
 * The shared record is written through the unified project-data gateway, so
 * SQLite and PostgreSQL behave the same; the repository check and the
 * `git worktree` are host facts and stay in this backend. A failed checkout is
 * recorded and returned rather than thrown away, so the requirement and the
 * workspace it names remain findable.
 */
export function createProjectDevelopmentService(ports: ProjectDevelopmentPorts) {
  const gateway = () => ports.runtime.service();

  async function bind(project: DevelopmentProject) {
    if (!project.projectDirectory) return;
    const service = await gateway();
    await service.ensureProject({
      projectId: project.projectId,
      projectName: project.projectName,
      projectDirectory: project.projectDirectory,
      backendId: ports.backendId
    });
  }

  async function project(projectId: string): Promise<DevelopmentProject> {
    const found = await ports.project(projectId);
    if (found) {
      await bind(found);
      return found;
    }
    // A secondary backend's project is not in this catalog. The shared
    // identity must exist; its directory stays that other backend's fact.
    const service = await gateway();
    const shared = await service.projects();
    if (!shared.some((entry) => entry.projectId === projectId))
      throw new ProjectDataNotFoundError("项目不存在");
    return { projectId, projectName: projectId, projectDirectory: "" };
  }

  async function taskProject(taskId: string): Promise<DevelopmentProject> {
    const found = await ports.taskProject(taskId);
    if (!found) throw new ProjectDataNotFoundError("会话不属于任何项目");
    await bind(found);
    return found;
  }

  const workspaceDirectory = (developmentId: string) => join(ports.developmentRoot, developmentId);
  const workspaceBranch = (developmentId: string) => `coworkos/development/${developmentId}`;

  async function requiredMergeConfig(projectId: string): Promise<MergeConfig> {
    const config = await (await gateway()).mergeConfig(projectId);
    if (!config)
      throw new ProjectDataConflictError(
        "项目合入配置缺失：请先设置 repository、targetBranch 与 executionBackendId",
        undefined,
        "project_git_missing"
      );
    if (config.executionBackendId !== ports.backendId)
      throw new ProjectDataConflictError(
        `该项目的合入配置归属后端 ${config.executionBackendId}，当前后端不能准备需求现场`,
        undefined,
        "project_git_owner_mismatch"
      );
    return config;
  }

  async function markFailed(
    projectId: string,
    record: DevelopmentRecord,
    directory: string,
    branch: string,
    error: string
  ): Promise<DevelopmentRecord> {
    return (await gateway()).recordDevelopmentWorkspace(projectId, record.developmentId, {
      workspaceId: record.workspace?.workspaceId ?? id("workspace"),
      backendId: ports.backendId,
      directory: record.workspace?.directory ?? directory,
      branch: record.workspace?.branch ?? branch,
      baseCommit: record.workspace?.baseCommit ?? record.baseline.commit,
      state: "failed",
      error
    });
  }

  async function prepare(
    projectId: string,
    record: DevelopmentRecord,
    repository: string
  ): Promise<DevelopmentRecord> {
    const directory = record.workspace?.directory ?? workspaceDirectory(record.developmentId);
    const branch = record.workspace?.branch ?? workspaceBranch(record.developmentId);
    try {
      await prepareDevelopmentWorkspace({
        repository,
        branch,
        commit: record.baseline.commit,
        directory
      });
      return (await gateway()).recordDevelopmentWorkspace(projectId, record.developmentId, {
        workspaceId: record.workspace?.workspaceId ?? id("workspace"),
        backendId: ports.backendId,
        directory,
        branch,
        baseCommit: record.baseline.commit,
        state: "ready"
      });
    } catch (error) {
      return markFailed(
        projectId,
        record,
        directory,
        branch,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async function create(
    projectId: string,
    input: DevelopmentCreate,
    taskId?: string
  ): Promise<DevelopmentRecord> {
    await project(projectId);
    const service = await gateway();
    const requirementId = developmentIdentifier(input.requirementId, "需求 ID");
    // Resolve the requirement before any record or checkout exists.
    await service.getRequirement(projectId, requirementId);
    const existing = await service.findDevelopmentByRequirement(projectId, requirementId, ports.backendId);
    if (existing)
      throw new DevelopmentExistsError(
        `该需求已有开发记录（${existing.developmentId}）；请读取后更新，不要重复创建`,
        existing.developmentId
      );
    let sessionId = input.sessionId;
    if (taskId) {
      const session = await service.findMainSessionByTask(projectId, ports.backendId, taskId);
      sessionId = session?.session.sessionId;
    } else if (sessionId) await service.getMainSession(projectId, sessionId);
    const config = await requiredMergeConfig(projectId);
    // The baseline is the configured target branch as it exists right now.
    const baseline = await resolveDevelopmentBaseline({
      repository: config.repository,
      branch: config.targetBranch
    });
    const record = await service.createDevelopment(projectId, {
      requirementId,
      goal: input.goal,
      completionCriteria: input.completionCriteria,
      route: input.route,
      baseline,
      sessionId,
      taskId
    });
    return prepare(projectId, record, config.repository);
  }

  async function ensureWorkspace(projectId: string, developmentId: string): Promise<DevelopmentRecord> {
    await project(projectId);
    const service = await gateway();
    const record = await service.getDevelopment(projectId, developmentId, ports.backendId);
    const directory = record.workspace?.directory ?? workspaceDirectory(record.developmentId);
    const branch = record.workspace?.branch ?? workspaceBranch(record.developmentId);
    const config = await service.mergeConfig(projectId);
    if (!config)
      return markFailed(
        projectId,
        record,
        directory,
        branch,
        "项目合入配置缺失：请先设置 repository、targetBranch 与 executionBackendId"
      );
    if (config.executionBackendId !== ports.backendId)
      return markFailed(
        projectId,
        record,
        directory,
        branch,
        `该项目的合入配置归属后端 ${config.executionBackendId}，当前后端不能继续需求现场`
      );
    if (
      record.workspace?.state === "ready" &&
      (await developmentWorkspaceIsIntact({
        repository: config.repository,
        directory: record.workspace.directory,
        branch: record.workspace.branch
      }))
    )
      return record;
    return prepare(projectId, record, config.repository);
  }

  return {
    async mergeConfig(projectId: string) {
      await project(projectId);
      return (await gateway()).mergeConfig(projectId);
    },

    async setMergeConfig(projectId: string, input: MergeConfigInput) {
      await project(projectId);
      const repository = mergeRepository(input.repository);
      const targetBranch = mergeTargetBranch(input.targetBranch);
      const executionBackendId =
        input.executionBackendId === undefined
          ? undefined
          : mergeExecutionBackendId(input.executionBackendId);
      await resolveDevelopmentBaseline({ repository, branch: targetBranch });
      return (await gateway()).setMergeConfig(
        projectId,
        { repository, targetBranch, executionBackendId },
        ports.backendId
      );
    },

    async list(projectId: string, backendId = ports.backendId) {
      await project(projectId);
      return (await gateway()).queryDevelopments(projectId, backendId);
    },

    async listForTask(taskId: string, backendId = ports.backendId) {
      const found = await taskProject(taskId);
      return (await gateway()).queryDevelopments(found.projectId, backendId);
    },

    async get(projectId: string, developmentId: string, backendId = ports.backendId) {
      await project(projectId);
      return (await gateway()).getDevelopment(projectId, developmentId, backendId);
    },

    async getForTask(taskId: string, developmentId: string, backendId = ports.backendId) {
      const found = await taskProject(taskId);
      return (await gateway()).getDevelopment(found.projectId, developmentId, backendId);
    },

    async find(projectId: string, requirementId: unknown, backendId = ports.backendId) {
      await project(projectId);
      return (await gateway()).findDevelopmentByRequirement(projectId, requirementId, backendId);
    },

    async findForTask(taskId: string, requirementId: unknown, backendId = ports.backendId) {
      const found = await taskProject(taskId);
      return (await gateway()).findDevelopmentByRequirement(found.projectId, requirementId, backendId);
    },

    async recordWorkspace(projectId: string, developmentId: string, workspace: unknown) {
      await project(projectId);
      return (await gateway()).recordDevelopmentWorkspace(projectId, developmentId, workspace);
    },

    async create(projectId: string, input: DevelopmentCreate) {
      return create(projectId, input);
    },

    async createForTask(taskId: string, input: DevelopmentCreate) {
      const found = await taskProject(taskId);
      return create(found.projectId, input, taskId);
    },

    update(projectId: string, developmentId: string, input: DevelopmentUpdate) {
      return gateway().then((service) =>
        service.updateDevelopment(projectId, developmentId, input, ports.backendId)
      );
    },

    async updateForTask(taskId: string, developmentId: string, input: DevelopmentUpdate) {
      const found = await taskProject(taskId);
      return (await gateway()).updateDevelopment(found.projectId, developmentId, input, ports.backendId);
    },

    /**
     * Continue an existing workspace: return it when it is still the recorded
     * checkout, otherwise prepare it again at the recorded baseline. A failure
     * is written to the record instead of replacing what was there.
     */
    async ensureWorkspace(projectId: string, developmentId: string) {
      return ensureWorkspace(projectId, developmentId);
    },

    async ensureWorkspaceForTask(taskId: string, developmentId: string) {
      const found = await taskProject(taskId);
      return ensureWorkspace(found.projectId, developmentId);
    }
  };
}

export type ProjectDevelopmentService = ReturnType<typeof createProjectDevelopmentService>;
