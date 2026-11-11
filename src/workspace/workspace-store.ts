import { readTemporaryWorkspace } from "./temporary-workspaces.js";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { withFileLock } from "../storage/file-lock.js";
import {
  id,
  now,
  transitionTask,
  type RunPause,
  type TaskCapabilities,
  type TaskCompletion,
  type TaskRecord,
  type TaskStatus
} from "../domain/types.js";
import { publishTaskArtifact, type Artifact } from "./artifact-store.js";
import { createProjectAssignmentReader, readProjectAssignment } from "./project-assignment.js";

export type { Artifact } from "./artifact-store.js";

export type TaskMetadata = Pick<
  TaskRecord,
  | "goal"
  | "model"
  | "constraints"
  | "successCriteria"
  | "kind"
  | "projectId"
  | "temporaryWorkspaceRoot"
  | "projectDirectory"
  | "projectCatalogPath"
> & {
  completion?: Partial<TaskCompletion>;
};
export type TaskPatch = Partial<
  Pick<
    TaskRecord,
    | "goal"
    | "title"
    | "pinned"
    | "archived"
    | "model"
    | "temporaryWorkspaceRoot"
    | "projectDirectory"
    | "projectId"
    | "projectCatalogPath"
    | "constraints"
    | "successCriteria"
    | "capabilities"
    | "activeRunId"
    | "pause"
    | "kind"
    | "monitoring"
    | "watchRecovery"
  >
> & { completion?: Partial<TaskCompletion> };

export interface TaskUpdateOptions {
  preserveUpdatedAt?: boolean;
  /** Project metadata transactions can resume after a verified local writer exits. */
  recoverDeadOwner?: boolean;
}

export interface TaskReadOptions {
  readProjectAssignment?: typeof readProjectAssignment;
}

export interface WorkspaceStore {
  createTask(taskId: string, metadata?: TaskMetadata): Promise<string>;
  createRun(taskId: string, runId: string): Promise<string>;
  readTask(taskId: string): Promise<TaskRecord>;
  listTasks(): Promise<TaskRecord[]>;
  deleteTask(taskId: string): Promise<void>;
  updateTask(taskId: string, patch: TaskPatch, options?: TaskUpdateOptions): Promise<TaskRecord>;
  transitionTask(
    taskId: string,
    status: TaskStatus,
    details?: { runId?: string; error?: string; reason?: string; completion?: Partial<TaskCompletion> }
  ): Promise<TaskRecord>;
  agentWorkDir(taskId: string, runId: string, agentId: string): string;
  sessionPath(taskId: string, runId: string, agentId: string, suffix?: string): string;
  prepareAgentWorkDir(taskId: string, runId: string, agentId: string): Promise<string>;
  publishArtifact(
    input: Omit<Artifact, "artifactId" | "sha256" | "size" | "createdAt"> & {
      content: string | Uint8Array;
      sourceResourceId?: string;
    }
  ): Promise<Artifact>;
  publishArtifactFile(
    input: Omit<Artifact, "artifactId" | "sha256" | "size" | "createdAt">,
    sourcePath: string
  ): Promise<Artifact>;
}

function segment(value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`unsafe workspace segment: ${value}`);
  return value;
}

async function validateTemporaryRoot(
  value: Pick<TaskRecord, "temporaryWorkspaceRoot" | "projectDirectory" | "projectId" | "projectCatalogPath">
) {
  if (value.temporaryWorkspaceRoot === undefined) return;
  if (
    typeof value.temporaryWorkspaceRoot !== "string" ||
    !isAbsolute(value.temporaryWorkspaceRoot) ||
    value.temporaryWorkspaceRoot.includes("\0")
  )
    throw new Error("invalid temporary workspace root");
  if (!(await readTemporaryWorkspace(value.temporaryWorkspaceRoot)))
    throw new Error("missing temporary workspace record");
  if (
    value.projectId ||
    value.projectCatalogPath ||
    (value.projectDirectory && resolve(value.projectDirectory) !== resolve(value.temporaryWorkspaceRoot))
  )
    throw new Error("temporary workspace cannot override project assignment");
}

export class LocalWorkspaceStore implements WorkspaceStore {
  constructor(private readonly root: string) {}

  async createTask(taskId: string, metadata: TaskMetadata = {}): Promise<string> {
    await validateTemporaryRoot(metadata);
    const path = this.taskPath(taskId);
    await mkdir(join(path, "artifacts"), { recursive: true });
    await mkdir(join(path, "agents", "main", "work"), { recursive: true });
    await mkdir(join(path, "agents", "main", "context"), { recursive: true });
    await mkdir(join(path, "agents", "coordinator"), { recursive: true });
    await mkdir(join(path, "agents", "subagents"), { recursive: true });
    await mkdir(join(path, "sessions"), { recursive: true });
    await mkdir(join(path, "runs"), { recursive: true });
    // Long-running Watch Programs live under the Task workspace. The
    // directories are created with the Task so a fresh workspace has a stable
    // layout even before Main creates its first monitor.
    await mkdir(join(path, "watch", "programs"), { recursive: true });
    // Iterative training/evaluation work uses the same task-scoped control
    // plane, even before the first Experiment ledger is created.
    await mkdir(join(path, "experiments"), { recursive: true });
    // Generic Virtual Agent projections share this task-level control plane;
    // Watch and Experiment stores remain specialized adapters over it.
    await mkdir(join(path, "virtual-agents"), { recursive: true });
    try {
      await writeFile(join(path, "agents", "main", "context", "messages.json"), "[]\n", { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      await writeFile(join(path, "agents", "main", "context", "memory.md"), "", { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      await writeFile(
        join(path, "agents", "main", "context", "state.json"),
        `${JSON.stringify({ version: 1, contextEpoch: 0, memoryVersion: 0, memorySha256: "" }, null, 2)}\n`,
        { flag: "wx" }
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let taskCreated = false;
    try {
      const createdAt = new Date().toISOString();
      await writeFile(
        join(path, "task.json"),
        `${JSON.stringify(
          {
            taskId,
            layoutVersion: 3,
            status: "created",
            version: 1,
            createdAt,
            updatedAt: createdAt,
            ...metadata,
            completion: normalizeCompletion(metadata.completion, "created")
          },
          null,
          2
        )}\n`,
        { flag: "wx" }
      );
      taskCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const taskEventsPath = join(path, "task_events.jsonl");
    if (taskCreated) {
      await appendFile(
        taskEventsPath,
        `${JSON.stringify({ eventId: id("task-event"), type: "task.created", taskId, occurredAt: now(), payload: { goal: metadata.goal, completion: normalizeCompletion(metadata.completion, "created") } })}\n`,
        "utf8"
      );
    } else {
      await appendFile(taskEventsPath, "", "utf8");
    }
    return path;
  }

  async readTask(taskId: string, options: TaskReadOptions = {}): Promise<TaskRecord> {
    const path = join(this.taskPath(taskId), "task.json");
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as Partial<TaskRecord> & { createdAt?: string };
      const createdAt = value.createdAt ?? new Date(0).toISOString();
      await validateTemporaryRoot(value);
      const projectId = typeof value.projectId === "string" ? value.projectId : undefined;
      const projectCatalogPath =
        typeof value.projectCatalogPath === "string" ? value.projectCatalogPath : undefined;
      const project =
        projectId && projectCatalogPath
          ? await (options.readProjectAssignment ?? readProjectAssignment)(projectCatalogPath, projectId)
          : undefined;
      return {
        taskId,
        layoutVersion: value.layoutVersion ?? 2,
        kind: value.kind === "workspace" ? "workspace" : "conversation",
        monitoring:
          value.monitoring?.scope === "background"
            ? {
                scope: "background",
                sourceTaskId:
                  typeof value.monitoring.sourceTaskId === "string"
                    ? value.monitoring.sourceTaskId
                    : undefined
              }
            : undefined,
        watchRecovery:
          value.watchRecovery &&
          typeof value.watchRecovery.day === "string" &&
          Number.isSafeInteger(value.watchRecovery.retries)
            ? value.watchRecovery
            : undefined,
        status: value.status ?? "created",
        goal: value.goal,
        title: typeof value.title === "string" ? value.title : undefined,
        pinned: value.pinned === true,
        archived: value.archived === true,
        model: value.model,
        temporaryWorkspaceRoot: value.temporaryWorkspaceRoot,
        projectId,
        projectCatalogPath,
        projectDirectory:
          project?.projectDirectory ??
          (typeof value.projectDirectory === "string" ? value.projectDirectory : undefined),
        constraints: value.constraints,
        successCriteria: value.successCriteria,
        capabilities: normalizeCapabilities(value.capabilities),
        activeRunId: value.activeRunId,
        pause: normalizeRunPause(value.pause),
        lastError: value.lastError,
        createdAt,
        updatedAt: value.updatedAt ?? createdAt,
        completedAt: value.completedAt,
        completion: normalizeCompletion(value.completion, value.status),
        version: value.version ?? 1
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`unknown task: ${taskId}`);
      throw error;
    }
  }

  /**
   * Conversations, for the sidebar.
   *
   * Application workspaces live in the same directory and are deliberately
   * excluded: showing one as a conversation would offer the user a chat they
   * can never hold.
   */
  async listTasks(includeWorkspaces = false): Promise<TaskRecord[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const tasks: TaskRecord[] = [];
    const readOptions = { readProjectAssignment: createProjectAssignmentReader() };
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9._-]+$/.test(entry.name)) continue;
      try {
        const task = await this.readTask(entry.name, readOptions);
        if (!includeWorkspaces && task.kind === "workspace") continue;
        tasks.push(task);
        // eslint-disable-next-line no-restricted-syntax -- 根目录下还混着非任务目录和写坏的 task.json，读不了只跳过这一项，其余会话照常列出
      } catch {
        /* ignore unrelated directories */
      }
    }
    return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async updateTask(taskId: string, patch: TaskPatch, options: TaskUpdateOptions = {}): Promise<TaskRecord> {
    const taskPath = this.taskPath(taskId);
    const taskFile = join(taskPath, "task.json");
    return withFileLock(
      taskFile,
      async () => {
        const current = await this.readTask(taskId);
        const next: TaskRecord = {
          ...current,
          ...patch,
          completion: patch.completion
            ? normalizeCompletion({ ...current.completion, ...patch.completion }, current.status)
            : current.completion,
          updatedAt: options.preserveUpdatedAt ? current.updatedAt : now(),
          version: current.version + 1
        };
        await validateTemporaryRoot(next);
        const temporary = `${taskFile}.tmp-${process.pid}-${Date.now()}`;
        await writeFile(temporary, `${JSON.stringify({ layoutVersion: 2, ...next }, null, 2)}\n`, "utf8");
        await rename(temporary, taskFile);
        await appendFile(
          join(taskPath, "task_events.jsonl"),
          `${JSON.stringify({ eventId: id("task-event"), type: "task.metadata_updated", taskId, fields: Object.keys(patch), occurredAt: now() })}\n`,
          "utf8"
        );
        return next;
      },
      { recoverDeadOwner: options.recoverDeadOwner }
    );
  }

  async deleteTask(taskId: string): Promise<void> {
    const taskPath = this.taskPath(taskId);
    await this.readTask(taskId);
    await rm(taskPath, { recursive: true, force: false });
  }

  async transitionTask(
    taskId: string,
    status: TaskStatus,
    details: { runId?: string; error?: string; reason?: string; completion?: Partial<TaskCompletion> } = {}
  ): Promise<TaskRecord> {
    const taskPath = this.taskPath(taskId);
    const taskFile = join(taskPath, "task.json");
    await mkdir(taskPath, { recursive: true });
    return withFileLock(taskFile, async () => {
      const current = await this.readTask(taskId);
      const next = transitionTask(current, status);
      if (status === "running" && !details.completion) {
        // A new Main turn or a late callback reopens the task. Never carry a
        // previous finish signal into the next execution generation.
        next.completion = { policy: current.completion?.policy ?? "natural", signal: "none" };
      } else if (details.completion) {
        next.completion = {
          ...current.completion,
          policy: current.completion?.policy ?? "natural",
          signal: current.completion?.signal ?? "none",
          ...details.completion
        };
      }
      if (details.runId) next.activeRunId = details.runId;
      if (details.error) next.lastError = details.error;
      if (status === "running") next.completedAt = undefined;
      const temporary = `${taskFile}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temporary, `${JSON.stringify({ layoutVersion: 2, ...next }, null, 2)}\n`, "utf8");
      await rename(temporary, taskFile);
      await appendFile(
        join(taskPath, "task_events.jsonl"),
        `${JSON.stringify({
          eventId: id("task-event"),
          type: "task.status_changed",
          taskId,
          status,
          previousStatus: current.status,
          runId: details.runId ?? current.activeRunId,
          reason: details.reason,
          error: details.error,
          completion: next.completion,
          occurredAt: now()
        })}\n`,
        "utf8"
      );
      return next;
    });
  }

  async createRun(taskId: string, runId: string): Promise<string> {
    await this.createTask(taskId);
    await this.transitionTask(taskId, "running", { runId, reason: "run_started" });
    return this.ensureRunDirectory(taskId, runId);
  }

  /**
   * Create a Run's directories without claiming it as the Task's active Run.
   *
   * A watcher Run is a place to file events, not a generation of Main's work.
   * Claiming it would repoint activeRunId, and every reader that resolves Main's
   * Inbox through the Task would follow it to a directory Main never opens.
   */
  async ensureRunDirectory(taskId: string, runId: string): Promise<string> {
    const taskPath = await this.createTask(taskId);
    const runPath = join(taskPath, "runs", segment(runId));
    for (const agent of ["main", "coordinator"]) {
      await mkdir(join(taskPath, "sessions", agent), { recursive: true });
      await mkdir(join(runPath, "agents", agent), { recursive: true });
      await appendFile(this.sessionPath(taskId, runId, agent), "", "utf8");
      await appendFile(join(runPath, "agents", agent, "inbox.jsonl"), "", "utf8");
    }
    await appendFile(join(runPath, "run_events.jsonl"), "", "utf8");
    try {
      await writeFile(
        join(runPath, "run.json"),
        `${JSON.stringify({ taskId, runId, createdAt: new Date().toISOString() }, null, 2)}\n`,
        { flag: "wx" }
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return runPath;
  }

  agentWorkDir(taskId: string, _runId: string, agentId: string): string {
    const safeAgent = segment(agentId);
    const base =
      safeAgent === "main" || safeAgent === "coordinator"
        ? join(this.root, segment(taskId), "agents", safeAgent)
        : join(this.root, segment(taskId), "agents", "subagents", safeAgent);
    return resolve(base);
  }

  async prepareAgentWorkDir(taskId: string, runId: string, agentId: string): Promise<string> {
    const workDir = this.agentWorkDir(taskId, runId, agentId);
    await mkdir(workDir, { recursive: true });
    return workDir;
  }

  sessionPath(taskId: string, runId: string, agentId: string, suffix = ""): string {
    const safeAgent = segment(agentId);
    const safeSuffix = suffix ? `-${segment(suffix)}` : "";
    return join(this.root, segment(taskId), "sessions", safeAgent, `${segment(runId)}${safeSuffix}.jsonl`);
  }

  /** Explicitly publish a user file at its chosen path under Task/artifacts. */
  async publishArtifact(
    input: Omit<Artifact, "artifactId" | "sha256" | "size" | "createdAt"> & {
      content: string | Uint8Array;
      sourceResourceId?: string;
    }
  ): Promise<Artifact> {
    return publishTaskArtifact({ ...input, workspaceRoot: this.root });
  }

  async publishArtifactFile(
    input: Omit<Artifact, "artifactId" | "sha256" | "size" | "createdAt">,
    sourcePath: string
  ): Promise<Artifact> {
    return publishTaskArtifact({ ...input, workspaceRoot: this.root, sourcePath });
  }

  private taskPath(taskId: string): string {
    return join(this.root, segment(taskId));
  }
}

/**
 * Read a capability grant defensively.
 *
 * A grant widens what Agents may do, so an unreadable or partially written
 * record must narrow to the safe default rather than be trusted as written.
 * Absent capabilities mean the sandbox, which is what an ungranted Task gets.
 */
function normalizeCapabilities(value: unknown): TaskCapabilities | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<TaskCapabilities>;
  const evalPaths = Array.isArray(candidate.evalPaths)
    ? candidate.evalPaths.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0
      )
    : undefined;
  const maxAttempts =
    Number.isFinite(candidate.maxAttempts) && (candidate.maxAttempts as number) > 0
      ? Math.floor(candidate.maxAttempts as number)
      : undefined;
  return {
    projectWrite: candidate.projectWrite === true,
    shell: candidate.shell === true,
    longRunning: candidate.longRunning === true,
    ...(evalPaths?.length ? { evalPaths } : {}),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    grantedBy: candidate.grantedBy === "operator" ? "operator" : "user",
    ...(typeof candidate.grantedAt === "string" ? { grantedAt: candidate.grantedAt } : {}),
    ...(typeof candidate.reason === "string" ? { reason: candidate.reason } : {})
  };
}

function normalizeRunPause(value: unknown): RunPause | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<RunPause>;
  if (typeof candidate.requestedAt !== "string") return undefined;
  return {
    requestedAt: candidate.requestedAt,
    requestedBy: "user",
    ...(typeof candidate.pausedAt === "string" ? { pausedAt: candidate.pausedAt } : {})
  };
}

function normalizeCompletion(value: unknown, status: unknown): TaskCompletion {
  const candidate = value && typeof value === "object" ? (value as Partial<TaskCompletion>) : {};
  const policy = candidate.policy === "explicit" ? "explicit" : "natural";
  const signal =
    candidate.signal === "finish_task" ||
    candidate.signal === "natural_stop" ||
    candidate.signal === "interrupted"
      ? candidate.signal
      : status === "completed"
        ? "natural_stop"
        : "none";
  const summary = typeof candidate.summary === "string" ? candidate.summary : undefined;
  const verifiedAt = typeof candidate.verifiedAt === "string" ? candidate.verifiedAt : undefined;
  return {
    policy,
    signal,
    ...(summary === undefined ? {} : { summary }),
    ...(verifiedAt === undefined ? {} : { verifiedAt })
  };
}
