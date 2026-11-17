import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CallMode } from "../domain/types.js";
import { id, now, transitionCall, type Call } from "../domain/types.js";
import { JsonlEventStore } from "../storage/event-store.js";
import { git } from "../workspace/development-workspace.js";
import type { WorkItemSite } from "../workspace/work-item-workspace.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { agentDisplayName, reserveSubagentIdentity } from "./agent-identity.js";
import { agentProcessDirectory } from "./agent-process.js";
import type { CapabilityGrant } from "./capability-provider.js";
import type { DelegatedModelRequest, ModelRoleSnapshot } from "./role-models.js";
import type { PiThinkingLevel } from "./runtime-settings.js";
import { DurableScheduler, type WorkItem } from "./scheduler.js";
import { SubagentProcessService, type SubagentProcessResult } from "./subagent-processes.js";
import { resolveCapabilities } from "./task-capabilities.js";
import { settleDelegatedExperiment, type DelegatedExperimentRef } from "./experiment-settlement.js";

/**
 * The backend's half of delegation.
 *
 * Main asks for a work item; this service registers it in the Run's durable
 * queue — the one record a status read, a wait, a restart and a reviewer all
 * agree on — and then answers with the identity the requester needs. Launching
 * is the process service's job, so a queued item is the same durable fact
 * whether it is started now, after its prerequisites finish, or by a backend
 * that adopted this workspace.
 */

/** What Main's `call_subagent` request contributes. Nothing here is trusted as a path or identity. */
export interface SubagentDispatchRequest {
  taskId: string;
  /** The Run the item belongs to; refused when it is no longer the Task's own Run. */
  runId?: string;
  task: string;
  mode: CallMode;
  role: "executor" | "reviewer";
  dependsOn?: string[];
  developmentId?: string;
  continueCallId?: string;
  reviewId?: string;
  /** Explicit upload IDs this work item may inspect. */
  attachments?: unknown;
  /** One-off connection choice, resolved on this host when the item starts. */
  profileId?: string;
  model?: string;
  /** The reasoning level the launching Run used; only an unbound item inherits it. */
  thinkingLevel?: PiThinkingLevel;
}

export interface SubagentDispatchAccepted {
  callId: string;
  taskId: string;
  runId: string;
  agentId: string;
  name: string;
  role: "executor" | "reviewer";
  mode: CallMode;
  developmentId?: string;
  workspace?: string;
  continuedFrom?: string;
  dependsOn?: string[];
}

export interface SubagentDispatchPorts {
  workspaceRoot: string;
  harnessRoot: string;
  /** Lease a launched item holds; renewed by every maintenance cycle. */
  leaseMs?: number;
  pollMs?: number;
  /** The requirement checkout a bound item forks from. */
  development?(input: { taskId: string; developmentId: string }): Promise<{ directory: string } | undefined>;
  /**
   * The frozen candidate a Reviewer must examine.
   *
   * A Reviewer never reads the start-time HEAD: the candidate commit is fixed
   * when the review is frozen, so a later commit in the Executor's checkout
   * cannot move the site under it.
   */
  frozenCandidate?(input: {
    taskId: string;
    developmentId: string;
  }): Promise<{ repository: string; commit: string } | undefined>;
  /** Grants for the upload IDs Main named; refused here, before any work item exists. */
  grants?(input: { taskId: string; attachments: unknown }): Promise<CapabilityGrant[]>;
  /**
   * The experiment-ledger row this delegation records, when an open program
   * absorbs it. Opened here because only the backend knows the call id.
   */
  experiment?(input: {
    taskId: string;
    callId: string;
    agentId: string;
    objective: string;
  }): Promise<DelegatedExperimentRef | undefined>;
  /**
   * The environment one item launches with, resolved when it actually starts.
   *
   * The returned snapshot is non-sensitive and only labels the model this
   * launch chose; the connection itself stays in the environment.
   */
  env?(input: {
    taskId: string;
    runId: string;
    callId: string;
    agentId: string;
    role: "executor" | "reviewer";
    delegation: DelegatedModelRequest;
    grants: CapabilityGrant[];
    thinkingLevel?: PiThinkingLevel;
  }):
    | { env: NodeJS.ProcessEnv; snapshot?: ModelRoleSnapshot }
    | Promise<{ env: NodeJS.ProcessEnv; snapshot?: ModelRoleSnapshot }>;
  onSettled?(result: SubagentProcessResult): void | Promise<void>;
}

export interface SubagentCancelRequest {
  taskId: string;
  runId?: string;
  callId: string;
  reason?: string;
}

export interface SubagentCancelAccepted {
  callId: string;
  agentId: string;
  status: "cancelled" | "already_terminal";
  previousStatus: string;
}

interface StoredContinuation {
  fromCallId: string;
  reviewId?: string;
  /**
   * The call whose Pi session this turn continues.
   *
   * A rework of a rework still appends to the first session, so the transcript
   * and the agent identity stay the same across every round.
   */
  sessionCallId?: string;
}

interface StoredPayload {
  task?: string;
  projectDirectory?: string;
  workItemSite?: WorkItemSite;
  reviewSite?: { repository: string; commit: string; directory: string };
  developmentId?: string;
  continuation?: StoredContinuation;
  dependsOn?: string[];
  delegation?: DelegatedModelRequest;
  mode?: CallMode;
  thinkingLevel?: PiThinkingLevel;
  capabilityGrants?: CapabilityGrant[];
  experimentRef?: DelegatedExperimentRef;
}

export class SubagentDispatchService {
  private readonly processes: SubagentProcessService;

  constructor(private readonly ports: SubagentDispatchPorts) {
    this.processes = new SubagentProcessService({
      workspaceRoot: ports.workspaceRoot,
      harnessRoot: ports.harnessRoot,
      env: {},
      ...(ports.pollMs === undefined ? {} : { pollMs: ports.pollMs }),
      ...(ports.leaseMs === undefined ? {} : { leaseMs: ports.leaseMs }),
      envFor: async (item) => await this.envFor(item),
      onSettled: (result) => this.ports.onSettled?.(result)
    });
  }

  /** Whether this Run still has a delegated process in flight. */
  async running(input: { taskId: string; runId: string }): Promise<boolean> {
    return this.processes.running(input);
  }

  /** Take over the processes a previous backend left running for this Run. */
  async adopt(input: { taskId: string; runId: string }): Promise<void> {
    await this.processes.adopt(input);
  }

  /** Start anything that became runnable and keep the running leases alive. */
  async maintain(input: { taskId: string; runId: string }): Promise<void> {
    await this.processes.maintain(input);
    await this.processes.startQueued(input);
  }

  /**
   * Register one work item and start it when its prerequisites allow.
   *
   * Everything that can be refused is refused before the first durable write,
   * so a rejected request leaves no work item Main would later have to
   * reconcile. Once the item is queued, a start failure is that item's own
   * outcome — with its own callback — instead of an error the model interprets.
   */
  async dispatch(request: SubagentDispatchRequest): Promise<SubagentDispatchAccepted> {
    const taskId = request.taskId;
    if (!/^[A-Za-z0-9._-]+$/.test(taskId)) throw new Error("派单的任务 ID 不合法");
    const role = request.role;
    if (request.mode !== "sync" && request.mode !== "async")
      throw new Error("call_subagent mode must be sync or async");
    const taskWorkspace = join(this.ports.workspaceRoot, taskId);
    const task = await new LocalWorkspaceStore(this.ports.workspaceRoot).readTask(taskId);
    const runId = request.runId?.trim() || task.activeRunId;
    if (!runId) throw new Error("当前对话没有可派单的运行");
    if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error("派单的运行 ID 不合法");
    if (task.activeRunId && task.activeRunId !== runId)
      throw new Error("派单的运行已经结束或已更换；不要在旧运行里继续派单");
    const runPath = join(this.ports.workspaceRoot, taskId, "runs", runId);
    const scheduler = new DurableScheduler(join(runPath, "queue.json"));
    const events = new JsonlEventStore(join(runPath, "run_events.jsonl"));
    const items = await scheduler.list();
    const terminal = (status: string) =>
      status === "completed" || status === "failed" || status === "cancelled";
    const dependsOn = [
      ...new Set(
        (request.dependsOn ?? []).filter(
          (stepId): stepId is string => typeof stepId === "string" && stepId.trim().length > 0
        )
      )
    ];
    if (dependsOn.length > 0) {
      const known = new Set(items.map((item) => item.stepId));
      const unknown = dependsOn.filter((stepId) => !known.has(stepId));
      if (unknown.length > 0)
        throw new Error(
          `dependsOn 引用了本 Run 中不存在的工作项：${unknown.join("、")}；只能依赖已委派的 callId`
        );
    }
    const continued = request.continueCallId
      ? await this.continuation(items, request.continueCallId, taskWorkspace, terminal)
      : undefined;
    if (continued && role !== "executor")
      throw new Error("continueCallId 只能续接 Executor 工作项，Reviewer 不能以原上下文返修");
    const requestedDevelopment = request.developmentId?.trim() || undefined;
    if (continued && requestedDevelopment && continued.developmentId !== requestedDevelopment)
      throw new Error(`工作项 ${request.continueCallId} 不属于需求 ${requestedDevelopment}`);
    const developmentId = continued?.developmentId ?? requestedDevelopment;
    const development = developmentId ? await this.ports.development?.({ taskId, developmentId }) : undefined;
    if (developmentId && !development?.directory)
      throw new Error(`需求 ${developmentId} 没有本机就绪的现场；先 ensure_workspace 再派单`);
    const callId = `call-${randomUUID()}`;
    const boundWorkspace = development
      ? {
          developmentDirectory: resolve(development.directory),
          directory: join(resolve(development.directory), "..", "work-items", callId),
          branch: `coworkos/work/${callId}`
        }
      : undefined;
    const workItemSite = continued?.workItemSite ?? boundWorkspace;
    const projectDirectory = workItemSite?.directory ?? task.projectDirectory;
    if (!projectDirectory) throw new Error("这个对话没有项目目录，也没有需求现场；无法为工作项确定运行位置");
    // The identity and the site are decided together: a Reviewer's checkout is
    // its own process directory, and its candidate is frozen before it exists.
    const { agentId } = continued
      ? { agentId: continued.agentId }
      : await reserveSubagentIdentity(taskWorkspace);
    const reviewSite =
      role === "reviewer"
        ? await this.reviewSite({
            taskId,
            runId,
            agentId,
            developmentId,
            development,
            workItemSite,
            projectDirectory
          })
        : undefined;
    const capabilityGrants =
      request.attachments === undefined ? [] : await this.grants(taskId, request.attachments);
    // Ledger bookkeeping is a side record: a failure to open it must not stop
    // the delegation, and the same rule lets a host without the ledger run.
    const experimentRef = this.ports.experiment
      ? await this.ports
          .experiment({ taskId, callId, agentId, objective: request.task })
          // eslint-disable-next-line no-restricted-syntax -- 实验台账是旁路记录，打开失败时本次派单照常进行，只是不记指标
          .catch(() => undefined)
      : undefined;
    const delegation: DelegatedModelRequest = {
      role,
      ...(request.profileId?.trim() ? { profileId: request.profileId.trim() } : {}),
      ...(request.model?.trim() ? { model: request.model.trim() } : {})
    };
    const call: Call = {
      callId,
      callerAgentId: "main",
      calleeAgentId: agentId,
      mode: request.mode,
      resolvedMode: request.mode,
      importance: "normal",
      dependency: request.mode === "sync" ? "required" : "independent",
      callbackPolicy: "on_complete",
      interruptOnCallback: false,
      state: "created",
      createdAt: now(),
      updatedAt: now()
    };
    // The item is durably visible from here on: wait/status tools and a backend
    // that adopts this Run read this row, not a notification from this process.
    try {
      await scheduler.enqueue({
        stepId: callId,
        taskId,
        runId,
        agentId,
        importance: "normal",
        payload: {
          task: request.task,
          mode: request.mode,
          projectDirectory,
          ...(workItemSite ? { workItemSite } : {}),
          ...(reviewSite ? { reviewSite } : {}),
          ...(developmentId ? { developmentId } : {}),
          ...(continued
            ? {
                continuation: {
                  fromCallId: request.continueCallId!,
                  ...(request.reviewId?.trim() ? { reviewId: request.reviewId.trim() } : {}),
                  ...(continued.sessionCallId !== request.continueCallId
                    ? { sessionCallId: continued.sessionCallId }
                    : {})
                }
              }
            : {}),
          ...(dependsOn.length > 0 ? { dependsOn } : {}),
          ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
          ...(experimentRef ? { experimentRef } : {}),
          delegation,
          capabilityGrants
        },
        maxAttempts:
          // A synchronous call holds the requesting turn: one attempt keeps a
          // diverged run as evidence instead of repeating it under that turn.
          request.mode === "sync" ? 1 : resolveCapabilities(task.capabilities).maxAttempts
      });
    } catch (error) {
      // The item never existed, so its ledger row must not stay open as a run
      // nothing will ever settle.
      await settleDelegatedExperiment({
        workspaceRoot: this.ports.workspaceRoot,
        taskId,
        runId,
        callId,
        agentId,
        ref: experimentRef,
        status: "failed",
        workingDirectory: projectDirectory,
        summary: "",
        outputFiles: [],
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
    await events.append(
      event({ taskId, runId }, callId, "call.accepted", "coordinator", {
        call: transitionCall(call, "accepted")
      })
    );
    await events.append(event({ taskId, runId }, callId, "step.queued", "coordinator", { callId, agentId }));
    if (continued)
      await events.append(
        event({ taskId, runId }, callId, "call.continued", agentId, {
          callId,
          fromCallId: request.continueCallId,
          ...(request.reviewId?.trim() ? { reviewId: request.reviewId.trim() } : {}),
          agentId
        })
      );
    await this.processes.startQueued({ taskId, runId });
    return {
      callId,
      taskId,
      runId,
      agentId,
      name: agentDisplayName(agentId),
      role,
      mode: request.mode,
      ...(developmentId ? { developmentId } : {}),
      ...(workItemSite ? { workspace: workItemSite.directory } : {}),
      ...(request.continueCallId ? { continuedFrom: request.continueCallId } : {}),
      ...(dependsOn.length > 0 ? { dependsOn } : {})
    };
  }

  /** Stop one delegated process group; the durable queue keeps the terminal outcome. */
  async cancel(request: SubagentCancelRequest): Promise<SubagentCancelAccepted> {
    const runId = request.runId?.trim() || (await this.runFor(request.taskId));
    const scheduler = new DurableScheduler(
      join(this.ports.workspaceRoot, request.taskId, "runs", runId, "queue.json")
    );
    const item = (await scheduler.list()).find((candidate) => candidate.stepId === request.callId);
    if (!item) throw new Error(`unknown subagent call: ${request.callId}`);
    if (["completed", "failed", "cancelled"].includes(item.status))
      return {
        callId: item.stepId,
        agentId: item.agentId,
        status: "already_terminal",
        previousStatus: item.status
      };
    await this.processes.stop({
      taskId: request.taskId,
      runId: item.runId,
      callId: request.callId
    });
    // A queued item whose prerequisites never finished has no process to stop;
    // its terminal outcome is the queue row.
    const after = (await scheduler.list()).find((candidate) => candidate.stepId === request.callId);
    if (after && !["completed", "failed", "cancelled"].includes(after.status))
      await scheduler.cancel(request.callId);
    return {
      callId: item.stepId,
      agentId: item.agentId,
      status: "cancelled",
      previousStatus: item.status
    };
  }

  close(): void {
    this.processes.close();
  }

  /** The Run that owns a call, for a cancel request that did not name one. */
  private async runFor(taskId: string): Promise<string> {
    const task = await new LocalWorkspaceStore(this.ports.workspaceRoot).readTask(taskId);
    const runId = task.activeRunId;
    if (!runId) throw new Error("这个对话没有正在运行的子代理");
    return runId;
  }

  /**
   * Validate a rework that must continue an existing Executor session.
   *
   * The earlier call stays terminal: this appends one turn to the same
   * transcript and checkout instead of running a fresh Agent that merely
   * carries the same name.
   */
  private async continuation(
    items: WorkItem[],
    fromCallId: string,
    taskWorkspace: string,
    terminal: (status: string) => boolean
  ): Promise<{ agentId: string; workItemSite: WorkItemSite; developmentId: string; sessionCallId: string }> {
    const original = items.find((item) => item.stepId === fromCallId);
    if (!original) throw new Error(`continueCallId 引用了本 Run 中不存在的工作项：${fromCallId}`);
    const payload = (original.payload ?? {}) as StoredPayload;
    if ((payload.delegation?.role ?? "executor") !== "executor")
      throw new Error(`工作项 ${fromCallId} 不是 Executor，不能以原上下文返修`);
    if (!terminal(original.status))
      throw new Error(`工作项 ${fromCallId} 还没有结束（${original.status}）；不能重复执行正在运行的工作项`);
    const inFlight = items.find(
      (item) =>
        ((item.payload ?? {}) as StoredPayload).continuation?.fromCallId === fromCallId &&
        !terminal(item.status)
    );
    if (inFlight) throw new Error(`工作项 ${fromCallId} 已有一个续接工作项在运行（${inFlight.stepId}）`);
    if (!payload.workItemSite?.directory || !payload.workItemSite.branch || !payload.developmentId)
      throw new Error(`工作项 ${fromCallId} 没有可续接的独立需求现场`);
    const sessionCallId = sessionRoot(items, fromCallId);
    const sessionDirectory = join(taskWorkspace, "sessions", original.agentId, "pi", sessionCallId);
    const files = await readdir(sessionDirectory)
      // eslint-disable-next-line no-restricted-syntax -- 会话目录不存在就是没有可续接的记录，下面的报错是给调用方的结论
      .catch(() => [] as string[]);
    if (!files.some((file) => file.endsWith(".jsonl")))
      throw new Error(`工作项 ${fromCallId} 没有可续接的会话记录；不能新建 Agent 冒充原上下文`);
    return {
      agentId: original.agentId,
      workItemSite: payload.workItemSite,
      developmentId: payload.developmentId,
      sessionCallId
    };
  }

  /**
   * The Reviewer's checkout of one frozen candidate.
   *
   * A requirement-bound review pins the candidate recorded by the frozen
   * review, never the checkout's current HEAD, so advancing the Executor's
   * branch between dispatch and start cannot move the site under the Reviewer.
   */
  private async reviewSite(input: {
    taskId: string;
    runId: string;
    agentId: string;
    developmentId?: string;
    development?: { directory: string };
    workItemSite?: WorkItemSite;
    projectDirectory: string;
  }): Promise<{ repository: string; commit: string; directory: string }> {
    if (input.developmentId && input.development) {
      const frozen = await this.ports.frozenCandidate?.({
        taskId: input.taskId,
        developmentId: input.developmentId
      });
      // A frozen review names the commit exactly. Without one the candidate is
      // still pinned here, at dispatch, so the Reviewer's site cannot follow a
      // later commit in the Executor's checkout while it waits to start.
      return {
        repository: resolve(frozen?.repository ?? input.development.directory),
        commit: frozen?.commit ?? (await headCommit(input.development.directory)),
        directory: input.workItemSite
          ? resolve(input.workItemSite.directory)
          : join(
              agentProcessDirectory(
                this.ports.workspaceRoot,
                input.taskId,
                input.runId,
                "reviewer",
                input.agentId
              ),
              "review-site"
            )
      };
    }
    const repository = resolve(input.projectDirectory);
    return {
      repository,
      commit: await headCommit(repository),
      directory: join(
        agentProcessDirectory(this.ports.workspaceRoot, input.taskId, input.runId, "reviewer", input.agentId),
        "review-site"
      )
    };
  }

  private async grants(taskId: string, attachments: unknown): Promise<CapabilityGrant[]> {
    if (!this.ports.grants) throw new Error("本次运行无法授予附件能力");
    return await this.ports.grants({ taskId, attachments });
  }

  /**
   * The environment one launched item runs with.
   *
   * Resolved at start, so a changed role binding applies to the next start
   * instead of a connection fact copied into shared data when it was queued.
   */
  private async envFor(item: WorkItem): Promise<NodeJS.ProcessEnv> {
    const payload = (item.payload ?? {}) as StoredPayload;
    const role = payload.delegation?.role === "reviewer" ? "reviewer" : "executor";
    const delegation: DelegatedModelRequest = payload.delegation ?? { role };
    const resolved = this.ports.env
      ? await this.ports.env({
          taskId: item.taskId,
          runId: item.runId,
          callId: item.stepId,
          agentId: item.agentId,
          role,
          delegation,
          grants: payload.capabilityGrants ?? [],
          ...(payload.thinkingLevel ? { thinkingLevel: payload.thinkingLevel } : {})
        })
      : { env: {} };
    if (resolved.snapshot)
      await new JsonlEventStore(
        join(this.ports.workspaceRoot, item.taskId, "runs", item.runId, "run_events.jsonl")
      ).append(
        event({ taskId: item.taskId, runId: item.runId }, item.stepId, "call.model_selected", item.agentId, {
          callId: item.stepId,
          modelSelection: resolved.snapshot
        })
      );
    return resolved.env;
  }
}

/** The call whose Pi session a continuation appends to. */
function sessionRoot(items: WorkItem[], callId: string): string {
  let current = callId;
  for (;;) {
    const item = items.find((candidate) => candidate.stepId === current);
    const from = ((item?.payload ?? {}) as StoredPayload).continuation;
    if (!from) return current;
    current = from.sessionCallId ?? from.fromCallId;
  }
}

async function headCommit(directory: string): Promise<string> {
  try {
    return await git(directory, ["rev-parse", "--verify", "HEAD^{commit}"]);
  } catch {
    throw new Error(
      `Reviewer 工作项没有可审查的候选：${directory} 不是可读提交的 Git 仓库；在需求下派单或先提交候选`
    );
  }
}

function event(
  input: { taskId: string; runId: string },
  callId: string,
  type: string,
  agentId: string,
  payload: unknown
) {
  return {
    eventId: id("event"),
    type,
    taskId: input.taskId,
    runId: input.runId,
    agentId,
    callId,
    occurredAt: now(),
    payload
  };
}
