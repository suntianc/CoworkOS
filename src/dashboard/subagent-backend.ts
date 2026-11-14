import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CoworkConfig } from "../runtime/config.js";
import type { CapabilityGrant } from "../runtime/capability-provider.js";
import type {
  DelegatedModelRequest,
  ModelRoleRequest,
  ModelRoleSnapshot,
  ResolvedModelRole
} from "../runtime/role-models.js";
import type { PiThinkingLevel } from "../runtime/runtime-settings.js";
import { modelRoleSnapshot, resolveDelegatedModelRole, roleConnectionEnv } from "../runtime/role-models.js";
import { hasUnfinishedSubagentWork } from "../runtime/subagent-work.js";
import {
  SubagentDispatchService,
  type SubagentCancelAccepted,
  type SubagentCancelRequest,
  type SubagentDispatchAccepted,
  type SubagentDispatchRequest
} from "../runtime/subagent-dispatch.js";
import {
  claimSubagentOwnership,
  readLiveSubagentOwner,
  releaseSubagentOwnership,
  type SubagentOwnerKind,
  type SubagentOwnership
} from "../runtime/subagent-owner.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import type { TaskLocation } from "./workspace-directory.js";

/**
 * The serving backend for delegated agent processes.
 *
 * One Dashboard owns delegated execution for every workspace root it serves:
 * it registers work items, launches the processes the queue says are runnable,
 * renews their leases, takes over the ones a previous backend left running, and
 * projects their exits. A CLI worker yields to it, so the same work item can
 * never be started or settled twice.
 */
export interface SubagentBackendPorts {
  projectRoot: string;
  dashboardUrl: string;
  /**
   * Who this process is in the workspace's single-owner record.
   *
   * The Dashboard is the product backend and may replace a CLI host's claim. A
   * CLI host claims as a worker, so a Dashboard that starts later takes over.
   */
  ownerKind?: SubagentOwnerKind;
  locateTask(taskId: string): Promise<TaskLocation>;
  workspaceRoots(): Promise<string[]>;
  /** This host's saved configuration; read again at every start boundary. */
  config(): CoworkConfig;
  resolveMainModel(request: ModelRoleRequest): ResolvedModelRole;
  /** The requirement checkout a bound work item forks from. */
  development(input: { taskId: string; developmentId: string }): Promise<{ directory: string } | undefined>;
  /** The candidate frozen for the requirement's open review. */
  frozenCandidate(input: {
    taskId: string;
    developmentId: string;
  }): Promise<{ repository: string; commit: string } | undefined>;
  /** Grants for the upload IDs Main named. */
  grants(input: { taskId: string; attachments: unknown }): Promise<CapabilityGrant[]>;
  /** The experiment-ledger row a delegation records, when an open program absorbs it. */
  experiment?(input: {
    taskId: string;
    callId: string;
    agentId: string;
    objective: string;
  }): Promise<{ experimentId: string; experimentRunId: string } | undefined>;
  /** Where this host keeps its configuration file and Pi profile. */
  configPath?(): string | undefined;
  piAgentDir?(): string | undefined;
  pollMs?: number;
  leaseMs?: number;
  /** How often the whole workspace is re-scanned for work nobody is watching. */
  sweepMs?: number;
  /** How long a refused ownership claim is trusted before it is re-examined. */
  refusalRecheckMs?: number;
}

export interface SubagentBackend {
  /** Take ownership and adopt what a previous backend left behind. */
  start(): Promise<void>;
  dispatch(request: SubagentDispatchRequest): Promise<SubagentDispatchAccepted>;
  cancel(request: SubagentCancelRequest): Promise<SubagentCancelAccepted>;
  running(input: { taskId: string; runId: string }): Promise<boolean>;
  /** Whether this Run still has delegated work in flight or undelivered. */
  unfinishedWork(input: { taskId: string; runId: string }): Promise<boolean>;
  ownership(workspaceRoot: string): SubagentOwnership | undefined;
  stop(): Promise<void>;
}

interface TrackedRun {
  workspaceRoot: string;
  taskId: string;
  runId: string;
}

const key = (input: TrackedRun) => `${input.workspaceRoot}\0${input.taskId}\0${input.runId}`;

export function createSubagentBackend(ports: SubagentBackendPorts): SubagentBackend {
  const services = new Map<string, SubagentDispatchService>();
  const tracked = new Map<string, TrackedRun>();
  const ownership = new Map<string, SubagentOwnership>();
  // A refusal is re-examined on this cadence: the owner it lost to can die, and
  // a backend that refused once must then take the root rather than serve it
  // half-owned until a restart.
  const refusalCheckedAt = new Map<string, number>();
  const refusalRecheckMs = Math.max(0, ports.refusalRecheckMs ?? 5_000);
  let timer: ReturnType<typeof setInterval> | undefined;
  let sweeping = false;
  let stopping = false;
  /** Read through a function so a callback body does not narrow the flag to false. */
  const isStopping = (): boolean => stopping;

  const serviceFor = (workspaceRoot: string): SubagentDispatchService => {
    const existing = services.get(workspaceRoot);
    if (existing) return existing;
    const service = new SubagentDispatchService({
      workspaceRoot,
      harnessRoot: ports.projectRoot,
      ...(ports.pollMs === undefined ? {} : { pollMs: ports.pollMs }),
      ...(ports.leaseMs === undefined ? {} : { leaseMs: ports.leaseMs }),
      development: (input) => ports.development(input),
      frozenCandidate: (input) => ports.frozenCandidate(input),
      grants: (input) => ports.grants(input),
      ...(ports.experiment ? { experiment: (input) => ports.experiment!(input) } : {}),
      // A settled item can be the prerequisite that unblocks another one.
      // Waiting for the next sweep would delay that start by a full cycle, so
      // the run is re-evaluated as soon as its queue row is terminal.
      onSettled: (result) => {
        void followSettled(workspaceRoot, result.taskId, result.runId).catch((error) =>
          console.error(
            `[cowork] starting dependent subagent work failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
      },
      env: (input) =>
        delegatedEnv({
          ...input,
          config: ports.config(),
          resolveMainModel: ports.resolveMainModel,
          projectRoot: ports.projectRoot,
          configPath: ports.configPath?.(),
          piAgentDir: ports.piAgentDir?.()
        })
    });
    services.set(workspaceRoot, service);
    return service;
  };

  async function claim(workspaceRoot: string): Promise<boolean> {
    const cached = ownership.get(workspaceRoot);
    if (cached?.owned) return true;
    if (cached) {
      if (Date.now() - (refusalCheckedAt.get(workspaceRoot) ?? 0) < refusalRecheckMs) return false;
      // Still the same live owner: keep refusing without claiming each cycle.
      const live = await readLiveSubagentOwner(workspaceRoot);
      if (live && live.pid === cached.owner?.pid) {
        refusalCheckedAt.set(workspaceRoot, Date.now());
        return false;
      }
    }
    const claimed = await claimSubagentOwnership(workspaceRoot, ports.ownerKind ?? "dashboard");
    ownership.set(workspaceRoot, claimed);
    if (claimed.owned) refusalCheckedAt.delete(workspaceRoot);
    else refusalCheckedAt.set(workspaceRoot, Date.now());
    return claimed.owned;
  }

  /** Re-evaluate one Run after one of its items settled. */
  async function followSettled(workspaceRoot: string, taskId: string, runId: string): Promise<void> {
    if (stopping) return;
    const run = { workspaceRoot, taskId, runId };
    if (!(await claim(workspaceRoot))) return;
    tracked.set(key(run), run);
    await serviceFor(workspaceRoot).maintain({ taskId, runId });
  }

  async function track(workspaceRoot: string, taskId: string, runId: string): Promise<void> {
    const run = { workspaceRoot, taskId, runId };
    if (!(await claim(workspaceRoot))) return;
    tracked.set(key(run), run);
  }

  /**
   * Adopt and start everything this workspace's own records say is runnable.
   *
   * A record left by a backend that is gone (or by one that started a process
   * the instant before it stopped) has no owner watching it; this pass is what
   * turns such a record back into an observed process instead of a work item
   * Main waits for forever. Only runs with unfinished work are tracked.
   */
  async function discover(workspaceRoot: string): Promise<void> {
    if (isStopping() || !(await claim(workspaceRoot))) return;
    // eslint-disable-next-line no-restricted-syntax -- 任务目录读不出来时这一轮没有可接管的 Run；下一次扫描会重试，不能中断其余工作区
    const tasks = await new LocalWorkspaceStore(workspaceRoot).listTasks().catch(() => []);
    for (const task of tasks) {
      const runs = await readdir(join(workspaceRoot, task.taskId, "runs"), { withFileTypes: true })
        // eslint-disable-next-line no-restricted-syntax -- 没有 runs 目录的 Task 只是没有运行记录，扫描继续看下一个
        .catch(() => []);
      for (const entry of runs) {
        if (!entry.isDirectory()) continue;
        const run = { workspaceRoot, taskId: task.taskId, runId: entry.name };
        if (tracked.has(key(run))) continue;
        const pending = await hasUnfinishedWork(run);
        if (!pending) continue;
        await serviceFor(workspaceRoot).adopt({ taskId: run.taskId, runId: run.runId });
        tracked.set(key(run), run);
      }
    }
  }

  async function sweep(): Promise<void> {
    if (sweeping || stopping) return;
    sweeping = true;
    try {
      for (const run of [...tracked.values()]) {
        const service = serviceFor(run.workspaceRoot);
        try {
          await service.maintain({ taskId: run.taskId, runId: run.runId });
          if (!(await hasUnfinishedWork(run)) && !(await service.running(run))) tracked.delete(key(run));
        } catch (error) {
          console.error(
            `[cowork] subagent maintenance failed for ${run.taskId}/${run.runId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    } finally {
      sweeping = false;
    }
  }

  async function hasUnfinishedWork(run: TrackedRun): Promise<boolean> {
    return hasUnfinishedSubagentWork(run);
  }

  return {
    async start() {
      if (!stopping) {
        // A startup scan that fails (a workspace root removed underneath it) is
        // reported and retried by the periodic pass; it must not surface as an
        // unhandled rejection in a fire-and-forget startup hook.
        await Promise.all(
          (
            await ports
              .workspaceRoots()
              // eslint-disable-next-line no-restricted-syntax -- 工作区列表读不出来时这次启动跳过扫描，后续周期性扫描仍会接管
              .catch(() => [])
          ).map((root) =>
            discover(root).catch((error) =>
              console.error(
                `[cowork] subagent discovery failed for ${root}: ${
                  error instanceof Error ? error.message : String(error)
                }`
              )
            )
          )
        );
      }
      const interval = Math.max(100, ports.pollMs ?? 1_000);
      const sweepEvery = Math.max(1, Math.round((ports.sweepMs ?? 5_000) / interval));
      let cycles = 0;
      timer = setInterval(() => {
        if (isStopping()) return;
        cycles += 1;
        void sweep();
        if (cycles % sweepEvery === 0)
          void (async () => {
            for (const root of await ports
              .workspaceRoots()
              // eslint-disable-next-line no-restricted-syntax -- 这一轮扫描跳过即可，下一次周期性扫描会重新读取工作区列表
              .catch(() => [])) {
              if (isStopping()) return;
              await discover(root);
            }
          })().catch((error) =>
            console.error(
              `[cowork] subagent discovery failed: ${error instanceof Error ? error.message : String(error)}`
            )
          );
      }, interval);
      timer.unref();
    },

    async dispatch(request) {
      const location = await ports.locateTask(request.taskId);
      const runId = request.runId?.trim() || location.task.activeRunId;
      if (!runId) throw new Error("当前对话没有可派单的运行");
      await track(location.workspaceRoot, request.taskId, runId);
      const accepted = await serviceFor(location.workspaceRoot).dispatch({ ...request, runId });
      tracked.set(key({ workspaceRoot: location.workspaceRoot, taskId: request.taskId, runId }), {
        workspaceRoot: location.workspaceRoot,
        taskId: request.taskId,
        runId
      });
      return accepted;
    },

    async cancel(request) {
      const location = await ports.locateTask(request.taskId);
      const runId = request.runId?.trim() || location.task.activeRunId;
      if (runId) await track(location.workspaceRoot, request.taskId, runId);
      return await serviceFor(location.workspaceRoot).cancel({ ...request, ...(runId ? { runId } : {}) });
    },

    async running(input) {
      const location = await ports.locateTask(input.taskId);
      return await serviceFor(location.workspaceRoot).running(input);
    },

    async unfinishedWork(input) {
      const location = await ports.locateTask(input.taskId);
      return hasUnfinishedSubagentWork({
        workspaceRoot: location.workspaceRoot,
        taskId: input.taskId,
        runId: input.runId
      });
    },

    ownership(workspaceRoot) {
      return ownership.get(workspaceRoot);
    },

    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      for (const workspaceRoot of services.keys())
        await releaseSubagentOwnership(workspaceRoot)
          // eslint-disable-next-line no-restricted-syntax -- 后端正在退出：释放属主失败时记录里的 pid 已不存在，下一个后端会按身份接管
          .catch(() => undefined);
      for (const service of services.values()) service.close();
      services.clear();
      tracked.clear();
    }
  };
}

/**
 * The environment one delegated item launches with.
 *
 * The binding is read at this start boundary; an ordinary item with no binding
 * keeps the connection its Main Run was admitted with. Nothing secret is
 * written into the durable queue: only the non-sensitive snapshot is recorded
 * so the interface can label the model this launch chose.
 */
export function delegatedEnv(input: {
  taskId: string;
  runId: string;
  callId: string;
  agentId: string;
  role: "executor" | "reviewer";
  delegation: DelegatedModelRequest;
  grants: CapabilityGrant[];
  thinkingLevel?: PiThinkingLevel;
  projectDirectory?: string;
  config: CoworkConfig;
  resolveMainModel(request: ModelRoleRequest): ResolvedModelRole;
  projectRoot: string;
  configPath?: string;
  piAgentDir?: string;
}): { env: NodeJS.ProcessEnv; snapshot?: ModelRoleSnapshot } {
  const bound = resolveDelegatedModelRole(input.config, input.delegation, {});
  const fallback = bound
    ? undefined
    : input.resolveMainModel({
        ...(input.delegation.projectId ? { projectId: input.delegation.projectId } : {}),
        ...(input.delegation.model ? { model: input.delegation.model } : {}),
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {})
      });
  const selection = bound ?? fallback!;
  return {
    env: {
      ...roleConnectionEnv(selection),
      COWORK_WORKSPACE: join(input.projectRoot, input.taskId),
      COWORK_TASK_ID: input.taskId,
      COWORK_RUN_ID: input.runId,
      ...(input.projectDirectory ? { COWORK_PROJECT_DIR: input.projectDirectory } : {}),
      ...(input.configPath
        ? { COWORK_CONFIG: input.configPath, COWORK_CONFIG_ROOT: dirname(input.configPath) }
        : {}),
      ...(input.piAgentDir ? { PI_CODING_AGENT_DIR: input.piAgentDir } : {}),
      ...(input.grants.length > 0 ? { COWORK_AGENT_GRANTS: JSON.stringify(input.grants) } : {})
    },
    // The label is recorded for every launch, not only a role-bound one: the
    // status view names the model a work item actually ran on.
    snapshot: { ...modelRoleSnapshot(selection), role: input.role }
  };
}
