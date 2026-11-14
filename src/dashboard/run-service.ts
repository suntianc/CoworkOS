import {
  readyMessageEditTransaction,
  finishMessageEditTransaction
} from "../runtime/main-message-edit-transaction.js";
import { applyEndpointLimits, type EndpointLimits } from "../runtime/model-limits.js";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import {
  latestEditableMessage,
  saveAcceptedMainMessage,
  rejectAcceptedMainMessage,
  prepareMessageEdit,
  readMessageVersions,
  alignMessageVersionSession,
  MainMessageEditConflict,
  type MessageEditRequest,
  type EditTextFile
} from "../runtime/main-message-edit.js";
import { InputStore, inputPrompt, readTaskInput } from "../workspace/input-store.js";
import { queuedUserTurn, readQueuedUserTurn } from "../runtime/queued-user-turn.js";
import { MainInboxDelivery, isMainControlType } from "../runtime/main-inbox-delivery.js";
import { mainContextPaths } from "../runtime/main-context.js";
import { mainInputPath, readMainInput, saveMainInput, type MainInput } from "../runtime/main-continuation.js";
import { appendFile, readdir, realpath } from "node:fs/promises";
import { listJobs } from "../tools/jobs.js";
import { join, resolve } from "node:path";
import { mainRunEnv } from "./main-run-env.js";
import { MainRequestConflictError, mainRequestEnvironment } from "../runtime/main-request-retry.js";
import { retiredSectionReplayRefusal, retiredSectionsWithText } from "../runtime/retired-system-sections.js";
import {
  MainRequestStore,
  MainRequestSnapshotError,
  mainRequestPath
} from "../storage/main-request-store.js";
import { assertMainRequestExecutionScope } from "../runtime/main-request-execution-scope.js";
import { CoordinatorRuntime } from "../runtime/coordinator-runtime.js";
import { humanAnswerTurn } from "../runtime/human-answer-turn.js";
import { HumanRequestStore } from "../runtime/human.js";
import {
  MainSupervisor,
  resetMainSupervisorBackoff,
  SUPERVISOR_WAKE_TURN,
  type MainSupervisorCycleResult
} from "../runtime/main-supervisor.js";
import { readSleep, clearSleep } from "../runtime/main-sleep.js";
import { AgentProcessHost, type AgentProcessRecord } from "../runtime/agent-process.js";
import { InboxStore } from "../runtime/scheduler.js";
import { SubagentQuestionStore } from "../runtime/subagent-questions.js";
import { assessTaskCompletion, isFinalAssistantMessage } from "../runtime/task-completion.js";
import { mainRunFailure, MainRunOutput } from "./main-run-outcome.js";
import { mainIsAlive, readHeartbeat } from "../runtime/main-heartbeat.js";
import { processIsAlive, verifyProcessIdentity } from "../runtime/process-identity.js";
import { hostname } from "node:os";
import { projectExecutionIsAlive } from "../workspace/project-execution.js";
import { ProjectCatalogError } from "../workspace/project-catalog.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { normalizeReasoningEffort, type PiThinkingLevel } from "../runtime/runtime-settings.js";
import type { MainCapacityDecision, MainCapacityRequest } from "../domain/main-capacity.js";
import { modelRoleSnapshot, type ModelRoleRequest, type ResolvedModelRole } from "../runtime/role-models.js";

import { now, type TaskRecord, type TaskStatus } from "../domain/types.js";
import type { TaskLocation } from "./workspace-directory.js";

/** A fresh object per Main process; runId alone can be reused after a stop. */
export interface InterjectionTarget {
  readonly runId: string;
}

/**
 * What the caller adds to one Main start beyond the prompt.
 *
 * `onRunAccepted` is the only place a caller may record ownership; it runs
 * after every refusal check, so a queued or refused request records no Run.
 */
export interface MainLaunchSubmission {
  body?: string;
  edit?: MessageEditRequest;
  attachmentIds?: string[];
  textAttachments?: EditTextFile[];
  /** Explicit one-off connection; an unknown id refuses instead of falling back. */
  profileId?: string;
  thinkingLevel?: PiThinkingLevel;
  onPrepared?: (rollback: () => Promise<void>) => void;
  onAcceptedInput?: (messageId: string) => void;
  onRunAccepted?: (location: TaskLocation, runId: string) => Promise<void>;
  source?: "composer" | "human" | "inbox";
  /** Which entry point asked, so the queue can report where a demand came from. */
  origin?: "http" | "worker" | "cli" | "internal";
  /** The persistent session this request names, when the caller knows it. */
  mainSessionId?: unknown;
  /** The requirement this Run works on, for capacity dedupe. */
  requirementId?: unknown;
  /** A person waiting on the page keeps the demand; a background retry reports it full. */
  queueWhenFull?: boolean;
  /** A slot this request already owns; the dispatch of a queued demand sets it. */
  admittedRequestId?: string;
}

/** Mutable launch facts: what admission gave this request and whether it spawned. */
export interface MainLaunchAdmission {
  requestId?: string;
  spawned: boolean;
}

export interface RunServicePorts {
  uploads?: InputStore;
  projectRoot: string;
  dashboardUrl: string;
  runCredential: string;
  coordinator: CoordinatorRuntime;
  /**
   * The backend that owns delegated processes.
   *
   * Closing a session must end the Subagents it started, and their processes
   * are not the coordinator's any more: the same owner that launched them is
   * the one that stops them.
   */
  subagents?: {
    cancel(input: { taskId: string; runId: string; callId: string; reason?: string }): Promise<unknown>;
  };
  locateTask(taskId: string): Promise<TaskLocation>;
  /**
   * Resolve the execution host's connection for one admitted Run.
   *
   * Called at the moment the launch is admitted, so a queued request that only
   * starts later reads the settings in force then. The returned snapshot is
   * fixed for the life of the process.
   */
  resolveMainModel(request: ModelRoleRequest): ResolvedModelRole;
  /** The chosen model's own limits from its connection's `/models` entry, when listed (#27). */
  endpointLimits?: (selection: ResolvedModelRole) => Promise<EndpointLimits | undefined>;
  onRunExit?: (taskId: string) => void;
  onRunFinalized?: (location: TaskLocation, runId: string) => Promise<void>;
  withTaskProjectLock?<T>(taskId: string, action: () => Promise<T>): Promise<T>;
  /**
   * Who owns a start: which persistent Main session already holds this Task.
   * Read before admission so an external demand is decided before it is recorded.
   */
  mainSessions?: {
    resolve(
      location: TaskLocation,
      input: { mainSessionId?: unknown }
    ): Promise<
      { sessionId: string; entryKind: "internal" | "external"; kind: "regular" | "continuation" } | undefined
    >;
  };
  /** The external Main budget this host applies to every entry point. */
  mainCapacity?: {
    /** Whether this host runs external Mains at all; a disabled host reads no session. */
    enabled(): boolean;
    admit(request: MainCapacityRequest): Promise<MainCapacityDecision>;
    bindProcess(requestId: string, pid: number): Promise<boolean>;
    release(requestId: string): Promise<void>;
    /** The process exists: remove the queue row but keep the slot until it exits. */
    markStarted(requestId: string): Promise<void>;
    /** A cancelled Task gives up its waiting demand, if it has one. */
    cancelTask(taskId: string): Promise<void>;
  };
  /**
   * Every workspace root whose Tasks the Main guardian inspects.
   *
   * The guardian belongs to this service: a parked Task with an unconsumed
   * callback is resumed without any other scheduler running.
   */
  mainGuardian?: {
    workspaceRoots(): Promise<string[]>;
    /**
     * Whether this host has a Main model connection.
     *
     * Read every cycle, not at startup: a connection completed later applies
     * on the next tick, while a host without one takes no launch decision.
     */
    modelConfigured(): boolean;
  };
  normalizeModel(value: unknown): string | undefined;
  appendRunEvent(
    workspace: string,
    taskId: string,
    runId: string,
    type: string,
    payload: unknown
  ): Promise<void>;
  readJsonFile<T>(path: string, fallback: T): Promise<T>;
}
/** Owns durable Run transitions and human-answer resumption; HTTP has no process ownership. */
export function createDashboardRunService({
  projectRoot,
  uploads,
  dashboardUrl,
  runCredential,
  coordinator,
  subagents,
  locateTask,
  resolveMainModel,
  endpointLimits = async () => undefined,
  onRunExit = () => {},
  onRunFinalized = async () => {},
  withTaskProjectLock = (_taskId, action) => action(),
  mainSessions,
  mainCapacity,
  mainGuardian,
  normalizeModel,
  appendRunEvent,
  readJsonFile
}: RunServicePorts) {
  /**
   * A Run keeps one resident Main process for its whole life.
   *
   * The process does not end with its turn: its Inbox wakes it for the next
   * one, and only closing the session, the idle timeout or a model request
   * that could not continue ends it. One process therefore owns one Run, and
   * a later message is delivered to it instead of starting a second one.
   */
  interface ResidentMain {
    taskId: string;
    runId: string;
    location: TaskLocation;
    host: AgentProcessHost;
    record: AgentProcessRecord;
    output: MainRunOutput;
    /**
     * Turn state from this process's own event stream.
     *
     * Only meaningful when `observed` is true; an adopted process's turns are
     * reported by the durable heartbeat instead.
     */
    turnActive: boolean;
    /** Whether this backend observes the process's own event stream. */
    observed: boolean;
    /** When this backend handed the adopted process a turn. */
    /** This exit replaces the process; it must not settle the Run. */
    replacing: boolean;
    /** The exit was already handled; a late spawn must not re-register it. */
    settled: boolean;
    requestId?: string;
  }
  const residentMains = new Map<string, ResidentMain>();
  // A turn accepted for delivery but not yet recorded by the extension. The
  // record wins as soon as it is newer than this acceptance, so the flag only
  // covers the gap between the API accepting the turn and Pi writing its
  // first boundary.
  const pendingTurns = new Map<string, number>();
  /** Spawned handles, so a stop can report the process it actually ended. */
  const activeRuns = new Map<string, ChildProcess>();
  const activeRunIds = new Map<string, string>();
  const interjectionTargets = new Map<string, InterjectionTarget>();
  let stopping = false;
  const finalizations = new Set<Promise<void>>();
  const taskFinalizations = new Map<string, Promise<void>>();
  const cancellations = new Set<string>();
  const taskOperations = new Map<string, Promise<unknown>>();
  function serialize<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const previous = taskOperations.get(taskId) ?? Promise.resolve();
    // eslint-disable-next-line no-restricted-syntax -- 上一次操作的失败已返回给它的调用方，串行队列只需让下一个动作继续执行
    const next = previous.catch(() => {}).then(action);
    taskOperations.set(taskId, next);
    void next
      .finally(() => {
        if (taskOperations.get(taskId) === next) taskOperations.delete(taskId);
      })
      // eslint-disable-next-line no-restricted-syntax -- 这条清理链只删除 taskOperations 映射，动作结果已由 next 返回给调用方
      .catch(() => {});
    return next;
  }
  const humanWakeups = new Set<string>();
  const humanResumes = new Map<string, Promise<{ status: string; error?: string }>>();

  async function prepareRunTransition(location: TaskLocation, runId: string, next: TaskStatus) {
    const { taskId } = location.task;
    let current = await location.store.readTask(taskId);
    // The durable Run identity is the ownership fact. An in-memory handle is
    // not required: a record discovered after a restart owns the same Run its
    // Task names, and that exit must still settle the Task.
    if ((activeRunIds.has(taskId) && activeRunIds.get(taskId) !== runId) || current.activeRunId !== runId)
      return;
    if (current.status === "cancelled") return;
    if (current.status === "completed" && next !== "completed") {
      // finish_task can succeed before the final provider response. Only this
      // still-owned execution may reopen its provisional completion; another
      // run's completed Task must remain untouched.
      if (current.completion?.signal !== "finish_task") return;
      current = await location.store.transitionTask(taskId, "running", {
        runId,
        reason: "dashboard_finish_task_pending_response",
        completion: { signal: "none" }
      });
    }
    return current;
  }

  const residentMain = (taskId: string): ResidentMain | undefined => residentMains.get(taskId);

  /**
   * The turn a resident process reports in its durable heartbeat.
   *
   * A backend that adopted the process cannot see its event stream, so the
   * heartbeat written at every turn boundary is the only witness to whether a
   * turn is running. It belongs to this Main only when it names the same Run
   * and this host: the record names the launcher, the heartbeat the Pi process
   * it started, so their pids differ by design.
   */
  async function mainTurnState(
    location: TaskLocation,
    taskId: string,
    runId: string
  ): Promise<{ active: boolean; alive: boolean; recordedAt: number; turnId?: string } | undefined> {
    // eslint-disable-next-line no-restricted-syntax -- 心跳只是一个提示；读不到时由调用方按没有回合处理，而不是阻断退出结算
    const beat = await readHeartbeat(location.workspaceRoot, taskId).catch(() => undefined);
    // The Run identity plus this host ties the record to this Main: the process
    // record names the launcher, the heartbeat the Pi process it started, so
    // their pids differ by design. `turnActive` outlives the process on purpose,
    // because the last value it wrote is how a crash is told from an idle stop.
    if (!beat || (beat.host && beat.host !== hostname()) || beat.runId !== runId) return undefined;
    return {
      active: beat.turnActive === true,
      alive: mainIsAlive(beat),
      recordedAt: Date.parse(beat.updatedAt),
      ...(beat.turnId ? { turnId: beat.turnId } : {})
    };
  }

  /**
   * Whether the process a durable record names is still the same process.
   *
   * A bare pid is not an identity: this host recycles numbers, and a recycled
   * pid would look like a live Main whose Inbox nobody reads. A record without
   * a readable start time (a host where `ps` failed at launch) falls back to
   * the pid, which is the most that record can support.
   */
  async function residentProcessAlive(record: AgentProcessRecord): Promise<boolean> {
    if (!record.startedAt) return processIsAlive(record.pid);
    return verifyProcessIdentity({ pid: record.pid, startedAt: record.startedAt });
  }

  /**
   * Drop interrupt commands a dead process never consumed.
   *
   * An interrupt is about the turn that was in flight. Once that process is
   * gone, the message would otherwise abort the first turn of the Main that
   * replaces it, which nobody asked for.
   */
  async function discardPendingInterrupts(
    location: TaskLocation,
    taskId: string,
    runId: string
  ): Promise<void> {
    const inbox = new InboxStore(
      join(location.workspaceRoot, taskId, "runs", runId, "agents", "main", "inbox-store.json")
    );
    // eslint-disable-next-line no-restricted-syntax -- 清理只是尽力而为；Inbox 读不到时下一条消息仍会按正常路径处理
    const messages = await inbox.list("main").catch(() => []);
    for (const message of messages) {
      if (message.state === "consumed") continue;
      if ((message.payload as { type?: unknown } | undefined)?.type !== "main.interrupt") continue;
      try {
        if (message.state === "ready")
          await inbox.leaseMessage("main", message.messageId, 60_000, "run-exit-cleanup");
        await inbox.consume(message.messageId);
      } catch (error) {
        // Another reader may have consumed it between the list and the lease.
        console.error(
          `[cowork] discarding a stale interrupt failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  /**
   * What one resident Main's exit means for its Task and Run.
   *
   * The process — not the turn — ends the Run. A replaced process leaves the
   * Task to whoever replaces it; a crashed one fails the turn it was in; one
   * that exits after a settled turn is the state-preserving stop (idle
   * timeout or a closed session), so the Task keeps the state its last turn
   * recorded and the next message starts a Main again.
   */
  function handleResidentExit(taskId: string, runId: string, record: AgentProcessRecord): Promise<void> {
    const resident = residentMains.get(taskId);
    if (resident && resident.runId !== runId) return Promise.resolve();
    const finalization = (async () => {
      const location = resident?.location ?? (await locateTask(taskId));
      const taskWorkspace = location.workspaceRoot;
      const replacing = resident?.replacing === true;
      const observed = resident?.observed === true;
      if (observed) resident.output.finish();
      await discardPendingInterrupts(location, taskId, runId);
      const settledTask = await location.store.readTask(taskId);
      if (replacing) return;
      if (cancellations.has(taskId) || settledTask.status === "cancelled") return;
      if (settledTask.activeRunId !== runId) return;
      // A process this backend spawned reports its own terminal message and
      // turn boundary. An adopted one has neither, so its exit is classified
      // by the durable turn state it wrote: a turn still marked running is a
      // mid-turn death, not an idle stop.
      const last = observed ? resident.output.message : undefined;
      const code = record.exitCode ?? null;
      const signal = (record.exitSignal as NodeJS.Signals | null) ?? null;
      const modelFailed = last?.role === "assistant" && last.stopReason === "error";
      const turn = await mainTurnState(location, taskId, runId);
      // The durable turn record is the source when it exists; a process that
      // died before writing one falls back to what its own event stream showed.
      const turnWasActive = turn ? turn.active : observed ? resident.turnActive : false;
      const turnId = turn?.turnId;
      const interrupted = last?.role === "assistant" && ["aborted", "length"].includes(last.stopReason ?? "");
      const event = (type: string, payload: unknown) =>
        appendRunEvent(taskWorkspace, taskId, runId, type, payload);
      if (stopping) {
        // The backend is going away and the process ended with it. Nothing is
        // failed; the Task is parked for the next Main.
        if (await prepareRunTransition(location, runId, "waiting"))
          await location.store.transitionTask(taskId, "waiting", { runId, reason: "desktop_shutdown" });
        return;
      }
      const settlePause = async (request: NonNullable<TaskRecord["pause"]>) => {
        if (!(await prepareRunTransition(location, runId, "paused"))) return;
        await location.store.transitionTask(taskId, "paused", { runId, reason: "ui_pause" });
        await event("main.run_paused", {
          code,
          signal,
          reason: "ui_pause",
          requestedAt: request.requestedAt
        });
        const paused = await location.store.readTask(taskId);
        if (paused.pause && !paused.pause.pausedAt)
          await location.store.updateTask(taskId, {
            pause: { ...paused.pause, pausedAt: new Date().toISOString() }
          });
      };
      // Aborting at a step boundary surfaces through Pi as an aborted
      // operation. The durable pause request identifies it, while a model
      // error that happened to overlap a pause still shows its own failure.
      const errorMessage = last?.errorMessage ?? "";
      if (settledTask.pause && modelFailed && /abort/i.test(errorMessage)) {
        await settlePause(settledTask.pause);
        return;
      }
      if (!modelFailed && !turnWasActive) {
        // Between turns: the process ends an idle Run. Its last turn already
        // recorded waiting, completed or paused, and that state is kept, so
        // the next message or callback starts a Main from it.
        await event("main.run_stopped", {
          code,
          signal,
          reason: settledTask.status === "paused" ? "paused" : "idle",
          status: settledTask.status,
          ...(turnId ? { turnId } : {})
        });
        const finalized = await location.store.readTask(taskId);
        if (finalized.activeRunId === runId && ["completed", "failed"].includes(finalized.status)) {
          // eslint-disable-next-line no-restricted-syntax -- 调用方的收尾回调失败不能跳过后面的容量释放与内存记账
          await onRunFinalized({ ...location, task: finalized }, runId).catch(() => {});
        }
        return;
      }
      if (modelFailed || (code !== 0 && !interrupted)) {
        // A model request that could not continue ends the resident process,
        // and a crash does the same: either way the Run settles as failed,
        // including the recorded request a person may replay.
        if (!(await prepareRunTransition(location, runId, "failed"))) return;
        const { error, failure } = mainRunFailure(last, code, signal);
        await event("main.run_failed", { error, code, signal, failure, ...(turnId ? { turnId } : {}) });
        try {
          await location.store.transitionTask(taskId, "failed", {
            runId,
            error,
            reason: "dashboard_main_exit"
          });
          // eslint-disable-next-line no-restricted-syntax -- 失败事件的原始错误已落盘，状态转换失败不能覆盖或中断收尾
        } catch {
          /* preserve original failure */
        }
        return;
      }
      // The process ended while a turn was in flight without reporting a
      // model error: settle that turn from what the Run recorded before exit.
      let coordination;
      try {
        coordination = await coordinator.waitForSubagents({
          taskId,
          runId,
          workspaceRoot: taskWorkspace,
          timeoutMs: 0
        });
      } catch (error) {
        if (!(await prepareRunTransition(location, runId, "waiting"))) return;
        await event("main.run_waiting", { reason: "completion_check_failed", error: String(error) });
        await location.store.transitionTask(taskId, "waiting", {
          runId,
          reason: "completion_check_failed"
        });
        return;
      }
      const assessment = assessTaskCompletion({
        pendingJobs: (
          await listJobs({
            directory: join(taskWorkspace, taskId, "runs", runId, "agents", "main", "jobs")
          })
        ).filter((job) => job.state === "running").length,
        pendingCalls: coordination.pending.length,
        pendingCallbacks: coordination.callbackPending.length,
        pendingHumanRequests: (await new HumanRequestStore(taskWorkspace).list(taskId, "pending")).length,
        pendingSubagentQuestions: (await new SubagentQuestionStore(taskWorkspace).list(taskId, "pending"))
          .length,
        // eslint-disable-next-line no-restricted-syntax -- 睡眠标记读不到时按未挂起处理，完成评估继续走正常判定
        parkedForWake: Boolean(await readSleep(taskWorkspace, taskId).catch(() => undefined)),
        hasFinalAnswer: isFinalAssistantMessage(last)
      });
      const pauseNow = assessment.ready ? undefined : (await location.store.readTask(taskId)).pause;
      if (pauseNow) {
        await settlePause(pauseNow);
        return;
      }
      const current = await prepareRunTransition(location, runId, assessment.ready ? "completed" : "waiting");
      if (!current) return;
      if (assessment.ready || (await readSleep(taskWorkspace, taskId)))
        await resetMainSupervisorBackoff(taskWorkspace, taskId);
      await event(assessment.ready ? "main.run_completed" : "main.run_waiting", {
        code,
        signal,
        coordination,
        reason: assessment.reason
      });
      try {
        await location.store.transitionTask(taskId, assessment.ready ? "completed" : "waiting", {
          runId,
          reason: assessment.ready ? "dashboard_main_exit" : assessment.reason,
          completion: {
            signal: assessment.ready
              ? current.completion?.signal === "finish_task"
                ? "finish_task"
                : "natural_stop"
              : "interrupted"
          }
        });
        // eslint-disable-next-line no-restricted-syntax -- 终态事件已经落盘，状态转换失败不能让这次 Run 收尾中断
      } catch {
        /* preserve event */
      }
      const finalized = await location.store.readTask(taskId);
      if (finalized.activeRunId === runId && ["completed", "failed"].includes(finalized.status)) {
        // eslint-disable-next-line no-restricted-syntax -- 调用方的收尾回调失败不能跳过后面的容量释放与内存记账
        await onRunFinalized({ ...location, task: finalized }, runId).catch(() => {});
      }
    })()
      .catch((error) =>
        console.error(
          `[cowork] run finalization failed: ${error instanceof Error ? error.message : String(error)}`
        )
      )
      .finally(async () => {
        finalizations.delete(finalization);
        if (taskFinalizations.get(taskId) === finalization) taskFinalizations.delete(taskId);
        if (resident) resident.settled = true;
        if (residentMains.get(taskId) === resident) {
          residentMains.delete(taskId);
          activeRuns.delete(taskId);
          pendingTurns.delete(taskId);
          interjectionTargets.delete(taskId);
          onRunExit(taskId);
        }
        if (activeRunIds.get(taskId) === runId) activeRunIds.delete(taskId);
        // The process is gone, so this Run no longer occupies an external
        // slot; the next waiting demand may start now.
        if (resident?.requestId && mainCapacity)
          await mainCapacity
            .release(resident.requestId)
            .catch((error) =>
              console.error(
                `[cowork] external capacity release failed: ${error instanceof Error ? error.message : String(error)}`
              )
            );
        // A quick reply can arrive while askhuman's process is still exiting.
        // Wait for its durable settlement before starting the resumed session.
        if (!stopping && humanWakeups.has(taskId)) void resumeHumanAnswers(taskId);
      });
    finalizations.add(finalization);
    taskFinalizations.set(taskId, finalization);
    return finalization;
  }

  /** End the resident Main serving a Task, waiting for its Run to settle. */
  async function stopResidentMain(taskId: string, options: { replacing?: boolean } = {}): Promise<void> {
    const resident =
      residentMains.get(taskId) ??
      (await residentFor(taskId).catch((error) => {
        // A close that lands before the startup sweep must still reach the
        // process; a lookup failure is reported and leaves nothing to stop.
        console.error(
          `[cowork] resolving the Main for ${taskId} failed: ${error instanceof Error ? error.message : String(error)}`
        );
        return undefined;
      }));
    if (!resident) return;
    resident.replacing = options.replacing === true;
    await resident.host
      .stop(resident.record)
      .catch((error) =>
        console.error(
          `[cowork] stopping the resident Main failed: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    await taskFinalizations.get(taskId);
  }

  /**
   * Take over a Main a previous backend left running for this Task.
   *
   * The process record carries the pid, host and OS start time it was launched
   * with, so a recycled pid is never mistaken for it. An adopted process keeps
   * running; later messages go to its Inbox and its own heartbeat reports the
   * state this backend cannot observe directly.
   */
  async function adoptResidentMain(
    taskId: string,
    location: TaskLocation
  ): Promise<ResidentMain | undefined> {
    const existing = residentMains.get(taskId);
    if (existing) return existing;
    const task = await location.store.readTask(taskId);
    if (!task.activeRunId) return undefined;
    const host = new AgentProcessHost({
      workspaceRoot: location.workspaceRoot,
      harnessRoot: projectRoot,
      onExit: (record) => handleResidentExit(taskId, record.runId, record)
    });
    // `adopt` watches a live process and settles a dead record through the one
    // deduplicated settlement path, so a record found after a restart is
    // projected exactly once.
    // This host manages Main only: a delegated process in the same run
    // directory is the subagent backend's, and settling it here would finalize
    // the Task on a Subagent's exit.
    const live = await host.adopt({ taskId, runId: task.activeRunId, roles: ["main"] });
    const record = live.find((candidate) => candidate.role === "main");
    if (!record) return undefined;
    const resident: ResidentMain = {
      taskId,
      runId: record.runId,
      location,
      host,
      record,
      output: new MainRunOutput(),
      // A process that survived a backend restart may be mid-turn, and this
      // backend cannot observe that turn; its own heartbeat carries the state.
      turnActive: false,
      observed: false,
      replacing: false,
      settled: false
    };
    residentMains.set(taskId, resident);
    activeRunIds.set(taskId, record.runId);
    interjectionTargets.set(taskId, { runId: record.runId });
    return resident;
  }

  /**
   * The resident Main for a Task, taking it over from the previous backend if
   * this one has not met it yet.
   *
   * Management actions go through here so a still-running Main is reachable
   * after a restart before any new message names it.
   */
  async function residentFor(taskId: string): Promise<ResidentMain | undefined> {
    const known = residentMains.get(taskId);
    if (known) return known;
    const location = await locateTask(taskId);
    return adoptResidentMain(taskId, location);
  }

  /**
   * Take over every Main a previous backend left running.
   *
   * Runs once when the service starts: management actions (close, pause,
   * interrupt, insertion) and status reads must see a surviving Main without
   * waiting for the next message to name it.
   */
  async function adoptExistingMains(): Promise<{ adopted: number }> {
    const result = { adopted: 0 };
    if (stopping) return result;
    const report = (taskId: string | undefined, error: unknown) => {
      console.error(
        `[cowork] main adoption failed${taskId ? ` for ${taskId}` : ""}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    };
    const roots = await mainGuardian?.workspaceRoots().catch((error) => {
      report(undefined, error);
      return [] as string[];
    });
    for (const workspaceRoot of roots ?? []) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stopping 由 stop() 在接管等待期间置位，TS 看不到这次闭包写入
      if (stopping) break;
      const tasks = await new LocalWorkspaceStore(workspaceRoot).listTasks().catch((error) => {
        report(workspaceRoot, error);
        return [];
      });
      for (const task of tasks) {
        const location = await locateTask(task.taskId).catch((error) => {
          report(task.taskId, error);
          return undefined;
        });
        if (!location) continue;
        const before = residentMains.get(task.taskId);
        try {
          const adopted = await adoptResidentMain(task.taskId, location);
          if (adopted && adopted !== before) result.adopted += 1;
        } catch (error) {
          // The failure is reported and left on the task's run log; the next
          // management call still adopts on demand.
          report(task.taskId, error);
          if (location.task.activeRunId)
            await appendRunEvent(
              location.workspaceRoot,
              task.taskId,
              location.task.activeRunId,
              "main.adoption_failed",
              { error: error instanceof Error ? error.message : String(error) }
              // eslint-disable-next-line no-restricted-syntax -- 诊断事件写失败不能中断其余会话的接管
            ).catch(() => {});
        }
      }
    }
    return result;
  }

  /**
   * Whether an Inbox already holds a turn's worth of work.
   *
   * A continuation (or an edit) needs a wake command only when nothing else is
   * queued: a queued user message or callback starts the turn itself, and a
   * second empty continuation would add a turn nobody asked for.
   */
  async function hasQueuedTurn(inbox: InboxStore): Promise<boolean> {
    const at = Date.now();
    return (await inbox.list("main")).some(
      (message) =>
        // Only work the reader can take now counts: a live lease from a dead
        // process is not deliverable until it expires, and waiting for it
        // would leave the new process idle with nothing to do.
        (message.state === "ready" ||
          (message.state === "leased" && Date.parse(message.lease?.expiresAt ?? "") <= at)) &&
        !isMainControlType((message.payload as { type?: unknown } | undefined)?.type)
    );
  }

  /**
   * Hand one turn to the Main that is already serving this Task.
   *
   * The process stays for its whole Run, so a later message is queued in its
   * own Inbox rather than starting a second process. Returning `undefined`
   * means this request needs a new process (an edit, a retry, another model,
   * or a process that is already gone); the caller starts one.
   */
  async function deliverResidentTurn(input: {
    resident: ResidentMain;
    task: TaskRecord;
    location: TaskLocation;
    prompt: string;
    continuation: boolean;
    submission?: MainLaunchSubmission;
    requestedModel?: string;
    messageId: string;
  }): Promise<
    | { taskId: string; runId: string; status: "running" | "paused"; model: string; sessionId?: string }
    | undefined
  > {
    const { resident, task, location, prompt, continuation, submission, messageId } = input;
    if (residentMain(resident.taskId) !== resident) return undefined;
    if (resident.runId !== (task.activeRunId ?? resident.runId)) return undefined;
    if (task.status === "cancelled" || task.status === "failed") return undefined;
    if (!resident.observed && !(await residentProcessAlive(resident.record))) {
      // The record names the launcher this process was started as; when that
      // identity is gone the adoption path settles the exit instead of a
      // message being queued behind a dead reader. The heartbeat is only the
      // turn state: a process that just started has not written one yet.
      return undefined;
    }
    if (input.requestedModel && normalizeModel(input.requestedModel) !== (task.model || "")) return undefined;
    if (prompt.includes("\0")) throw new Error("消息包含不支持的二进制字符，请移除附件后重试");
    if (Buffer.byteLength(prompt, "utf8") > 512 * 1024) throw new Error("消息及附件合计不能超过 512 KB");
    if (!prompt.trim() && !continuation) throw new Error("prompt must not be empty");
    const taskWorkspace = location.workspaceRoot;
    // The same gates the launch path applies before a Main may take work.
    if ((await new HumanRequestStore(taskWorkspace).listBlockingPending(resident.taskId)).length)
      throw new Error("请先回答任务中待确认的问题，再继续运行。");
    const model = task.model || "";
    // A message that arrives while the Task is paused stays queued: the pause
    // is the user's hold on new turns, so only an explicit resume clears it and
    // the API answers with the status the Task actually has.
    const staysPaused = !continuation && Boolean(task.pause);
    await location.store.updateTask(resident.taskId, {
      ...(!continuation ? { goal: task.goal || prompt.slice(0, 4_000) } : {}),
      model,
      activeRunId: resident.runId,
      ...(task.pause && !staysPaused ? { pause: undefined } : {})
    });
    const inbox = new InboxStore(
      join(taskWorkspace, resident.taskId, "runs", resident.runId, "agents", "main", "inbox-store.json")
    );
    if (continuation) {
      // An explicit resume always wakes the process: the pause it just lifted
      // stopped its turn loop, so queued work alone would wait for the next
      // file event. The queued work is steered into the turn it starts.
      const resumeId = `main-resume-${randomUUID()}`;
      await inbox.enqueue({
        messageId: resumeId,
        recipientAgentId: "main",
        kind: "human_command",
        eventId: `main-resume-event-${resumeId}`,
        priority: 100,
        state: "ready",
        payload: { type: "main.resume" },
        createdAt: now()
      });
    } else {
      const body: MainInput = {
        version: 1,
        prompt,
        submittedAt: Date.now(),
        body: submission?.body,
        taskId: resident.taskId,
        runId: resident.runId,
        attachmentIds: submission?.attachmentIds,
        textAttachments: submission?.textAttachments,
        ...(submission?.thinkingLevel
          ? { thinkingLevel: normalizeReasoningEffort(submission.thinkingLevel, "thinkingLevel") }
          : {}),
        messageId,
        source:
          submission?.source ?? (readQueuedUserTurn(prompt) ? ("inbox" as const) : ("composer" as const))
      };
      await saveMainInput(mainInputPath(taskWorkspace, resident.taskId, resident.runId), body);
      await saveAcceptedMainMessage(taskWorkspace, resident.taskId, body);
      submission?.onAcceptedInput?.(messageId);
      await inbox.enqueue({
        messageId,
        recipientAgentId: "main",
        kind: "human_command",
        eventId: `main-turn-${messageId}`,
        priority: 120,
        state: "ready",
        payload: { type: "human.message", message: prompt, delivery: "steer", initial: true },
        createdAt: now()
      });
    }
    // The message that will open this process's next turn is accepted; until
    // the extension records that boundary, this is what `runtime.active`
    // reports (paused work is not a turn starting).
    if (!staysPaused) pendingTurns.set(resident.taskId, Date.now());
    await appendRunEvent(taskWorkspace, resident.taskId, resident.runId, "main.turn_delivered", {
      prompt: prompt.slice(0, 4_000),
      continuation,
      messageId,
      ...(staysPaused ? { queuedWhilePaused: true } : {})
    });
    if (!staysPaused) {
      resident.turnActive = true;
    }
    interjectionTargets.set(resident.taskId, { runId: resident.runId });
    return {
      taskId: resident.taskId,
      runId: resident.runId,
      status: staysPaused ? "paused" : "running",
      model
    };
  }

  async function launchMainRunWithAdmission(
    taskId: string,
    prompt: string,
    requestedRunId?: string,
    resume = false,
    requestedModel?: string,
    retryRequestId?: string,
    submission?: MainLaunchSubmission,
    admission: MainLaunchAdmission = { spawned: false }
  ): Promise<{
    taskId: string;
    runId: string;
    status: "running" | "paused" | "queued" | "duplicate";
    model: string;
    sessionId?: string;
    queuePosition?: number;
  }> {
    if (stopping) throw new Error("Runtime is shutting down");
    // A dispatched demand already owns its slot; keep that identity so the
    // process record and the release below address the same claim.
    if (submission?.admittedRequestId) admission.requestId = submission.admittedRequestId;
    const location = await locateTask(taskId);
    const task = location.task;
    const taskWorkspace = location.workspaceRoot;
    // An answer can be queued while an edit replaces its Run. Validate before
    // any process decision so it cannot resume the replacement branch.
    if (submission?.source === "human" && task.activeRunId !== requestedRunId)
      throw new Error("该问题所属运行已变更，请刷新任务。");
    // A resident Main serving this Task takes the turn in the process it
    // already has. Only a request that needs a different process (an edit, a
    // retry, another model) falls through, and that one replaces it.
    let resident = await residentFor(taskId);
    if (resident && !resident.observed && !(await residentProcessAlive(resident.record))) {
      // The entry may predate a crash: its process is gone but the exit has
      // not been projected yet. Drop it and look again, so a Main the recovery
      // supervisor started for the same session is adopted instead of a
      // second process being started beside it. The process record, not the
      // heartbeat, says whether it is alive: a just-started one has no
      // heartbeat of its own yet.
      await stopResidentMain(taskId, { replacing: true });
      resident = await residentFor(taskId);
    }
    if (resident) {
      // A retry or a request for another Run while a Main still serves this
      // Task is the same duplicate the launch check always refused: the Run
      // it names has already started.
      if (retryRequestId || (requestedRunId !== undefined && requestedRunId !== resident.runId))
        throw new Error("Task already has an active Main run");
      if (!submission?.edit) {
        const delivered = await deliverResidentTurn({
          resident,
          task,
          location,
          prompt,
          continuation: resume && !prompt.trim(),
          ...(submission ? { submission } : {}),
          ...(requestedModel ? { requestedModel } : {}),
          messageId: readQueuedUserTurn(prompt)?.messageId ?? randomUUID()
        });
        if (delivered) return delivered;
      }
      // An edit, another model or a process that is already gone replaces it.
      await stopResidentMain(taskId, { replacing: true });
    }
    const existing = activeRuns.get(taskId);
    if (existing && !existing.killed) throw new Error("Task already has an active Main run");
    // Completing a request ends a run, not the conversation's Pi session.
    const continueSession = resume || Boolean(task.activeRunId);
    const continuation = resume && !prompt.trim();
    const requestStore = new MainRequestStore(mainRequestPath(taskWorkspace, taskId), taskId);
    // The connection a retry must still belong to. Resolving it here also refuses
    // an explicit profile id before this request is admitted.
    const roleRequestBase = {
      ...(location.projectId ? { projectId: location.projectId } : {}),
      ...(submission?.profileId ? { profileId: submission.profileId } : {})
    };
    const retryRequest = continuation
      ? await requestStore.inspectPending(async (snapshot) => {
          if (
            retryRequestId &&
            (["completed", "cancelled"].includes(task.status) || snapshot?.requestId !== retryRequestId)
          )
            throw new MainRequestSnapshotError(
              "要重试的原请求已变化或已取消，已有内容仍保留。请刷新后重试。"
            );
          if (!snapshot) {
            const legacy = await requestStore.legacyPending();
            if (legacy && legacy.taskId === taskId && legacy.runId === task.activeRunId)
              throw new MainRequestSnapshotError(
                "原请求缺少当前执行归属记录，无法安全重试。原请求、历史和草稿已保留，请主动发送新消息。"
              );
            return undefined;
          }
          if (snapshot.runId !== task.activeRunId)
            throw new MainRequestSnapshotError("原请求所属运行已变化，已有内容仍保留。请刷新后重试。");
          if (!snapshot.executionScope || !snapshot.endpoint)
            throw new MainRequestSnapshotError(
              "原请求缺少执行归属记录，无法安全重试。原请求、历史和草稿已保留，请主动发送新消息。"
            );
          // Refuse before spawning: an archive written before user memory and
          // project experience were removed would resend their text verbatim.
          const retired = retiredSectionsWithText(snapshot.context.messages);
          if (retired.length) throw new MainRequestConflictError(retiredSectionReplayRefusal(retired));
          if (
            (await realpath(resolve(task.projectDirectory ?? taskWorkspace))) !==
            snapshot.environment.projectDirectory
          )
            throw new MainRequestConflictError(
              "原请求的项目目录已变化，已有内容仍保留。请恢复原目录后重试，或发送新消息。"
            );
          const current = await mainRequestEnvironment(
            taskWorkspace,
            taskId,
            snapshot.environment.projectDirectory
          );
          try {
            assertMainRequestExecutionScope(snapshot.executionScope, current.executionScope!);
          } catch (error) {
            throw new MainRequestConflictError(error instanceof Error ? error.message : String(error));
          }
          const endpoint = (value: string) => value.replace(/\/+$/, "").replace(/\/v1$/, "");
          const configuredBase = resolveMainModel(roleRequestBase).baseUrl;
          if (endpoint(configuredBase) !== endpoint(snapshot.model.baseUrl))
            throw new MainRequestConflictError(
              "原请求的模型连接已变化，已有内容仍保留。请恢复原连接后重试，或发送新消息。"
            );
          return snapshot;
        })
      : undefined;
    const runId =
      requestedRunId?.trim() ||
      (retryRequestId ? retryRequest?.runId : undefined) ||
      ((task.status === "running" || task.status === "waiting" || task.status === "paused") &&
      task.activeRunId
        ? task.activeRunId
        : `main-${Date.now()}`);
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(runId)) throw new Error("unsafe run id");
    // What this request asks the role resolver for. The shape carries only the
    // user's explicit choices (profile, model, thinking level, retry snapshot);
    // a queued demand keeps this shape, never a resolved default.
    const roleRequest: ModelRoleRequest = {
      ...roleRequestBase,
      ...(retryRequest
        ? { retryModel: retryRequest.model.id }
        : requestedModel
          ? { model: normalizeModel(requestedModel) }
          : { taskModel: task.model }),
      ...(submission?.thinkingLevel
        ? { thinkingLevel: normalizeReasoningEffort(submission.thinkingLevel, "thinkingLevel") }
        : {})
    };
    // Refuse an unusable host configuration before a demand may wait for a slot.
    // This resolution is a readiness check and is not stored anywhere.
    const configuredSelection = resolveMainModel(roleRequest);
    if (!configuredSelection.baseUrl || !configuredSelection.apiKey)
      throw new Error("模型 API 未配置：请填写 config.json 或 .cowork/config.json");
    if (prompt.includes("\0")) throw new Error("消息包含不支持的二进制字符，请移除附件后重试");
    if (Buffer.byteLength(prompt, "utf8") > 512 * 1024) throw new Error("消息及附件合计不能超过 512 KB");
    if (!prompt.trim() && !continuation) throw new Error("prompt must not be empty");
    if (continuation && !task.activeRunId) throw new Error("没有可继续的请求，请先发送消息。");
    // Shutdown may begin while task/configuration validation is awaiting I/O.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stopping 只由返回的 stop() 置位，TS 看不到启动路径等待期间的闭包写入
    if (stopping) throw new Error("Runtime is shutting down");
    if (
      (task.status === "running" || task.status === "waiting" || task.status === "paused") &&
      task.activeRunId &&
      task.activeRunId !== runId &&
      !submission?.edit
    )
      throw new Error("Task already has a running Main session");
    if (submission?.edit && task.activeRunId !== submission.edit.runId)
      throw new MainMessageEditConflict("原运行已变化，编辑内容仍保留，请刷新后重试。");
    const messageId = readQueuedUserTurn(prompt)?.messageId ?? randomUUID();
    const edit = submission?.edit
      ? await prepareMessageEdit(taskWorkspace, taskId, submission.edit, prompt, runId, messageId)
      : undefined;
    if (edit?.rollback) submission?.onPrepared?.(edit.rollback);
    // Preparing an edit retires only questions from the replaced message's tail.
    // Ordinary continuation and unrelated pending decisions retain the same gate.
    // A decision left by the retired goal tool is not such a question: nobody
    // can answer it, so it must not refuse the launch.
    if ((await new HumanRequestStore(taskWorkspace).listBlockingPending(taskId)).length)
      throw new Error("请先回答任务中待确认的问题，再继续运行。");
    const savedVersions = await readMessageVersions(taskWorkspace, taskId);
    const versions = savedVersions
      ? await alignMessageVersionSession(
          taskWorkspace,
          taskId,
          task.projectDirectory ?? taskWorkspace,
          savedVersions
        )
      : undefined;
    // External capacity is decided here, with the Run id fixed and every other
    // refusal already applied. A queued demand records no Run and starts no
    // process, so "waiting for a slot" never looks like a running Main.
    let capacitySessionId: string | undefined;
    if (mainCapacity?.enabled() && mainSessions && location.projectId && !submission?.admittedRequestId) {
      const owner = await mainSessions.resolve(location, {
        ...(submission?.mainSessionId === undefined || submission.mainSessionId === null
          ? {}
          : { mainSessionId: submission.mainSessionId })
      });
      if (owner?.entryKind === "external") {
        capacitySessionId = owner.sessionId;
        const decision = await mainCapacity.admit({
          projectId: location.projectId,
          sessionId: owner.sessionId,
          taskId,
          kind: owner.kind,
          ...(typeof submission?.requirementId === "string"
            ? { requirementId: submission.requirementId }
            : {}),
          runId,
          resume: continueSession,
          // Keep only the explicit choice: a queued demand resolves the host
          // and project defaults when it actually gets a slot.
          ...(requestedModel ? { model: requestedModel } : {}),
          ...(retryRequestId ? { retryRequestId } : {}),
          prompt,
          ...(submission
            ? {
                submission: {
                  ...(submission.body === undefined ? {} : { body: submission.body }),
                  // The explicit connection and thinking level are user choices,
                  // so a queued demand keeps them across the wait.
                  ...(submission.profileId ? { profileId: submission.profileId } : {}),
                  ...(submission.thinkingLevel ? { thinkingLevel: submission.thinkingLevel } : {}),
                  ...(submission.attachmentIds ? { attachmentIds: submission.attachmentIds } : {}),
                  ...(submission.textAttachments ? { textAttachments: submission.textAttachments } : {}),
                  ...(submission.source ? { source: submission.source } : {})
                }
              }
            : {}),
          origin: submission?.origin ?? "internal",
          queueWhenFull: submission?.queueWhenFull === true
        });
        if (decision.state === "queued")
          return {
            taskId,
            runId,
            status: "queued",
            model: configuredSelection.model,
            sessionId: owner.sessionId,
            queuePosition: decision.position
          };
        if (decision.state === "duplicate")
          return {
            taskId,
            runId: decision.runId ?? runId,
            status: "duplicate",
            model: configuredSelection.model,
            sessionId: owner.sessionId,
            ...(decision.position === undefined ? {} : { queuePosition: decision.position })
          };
        admission.requestId = decision.requestId;
      }
    }
    // The connection, model and reasoning profile are fixed here, at the moment
    // this demand owns a slot: a host/project default changed while it waited
    // applies now, while an explicit profile/model/thinking choice above stays
    // the user's. The snapshot lives only in this process and on the Run record.
    // A field the connection leaves to the endpoint takes this model's own value.
    const resolved = resolveMainModel(roleRequest);
    const selection = applyEndpointLimits(resolved, await endpointLimits(resolved));
    const model = selection.model;
    const baseUrl = selection.baseUrl;
    const apiKey = selection.apiKey;
    if (!baseUrl || !apiKey) throw new Error("模型 API 未配置：请填写 config.json 或 .cowork/config.json");
    // Every check that can refuse this request has passed and the Run id it will
    // launch is fixed. Ownership is recorded only now, so a refused request
    // cannot rewrite a Run another process owns.
    if (submission?.onRunAccepted) await submission.onRunAccepted(location, runId);
    const inputPath = mainInputPath(taskWorkspace, taskId, runId);
    const input = continuation
      ? await readMainInput(mainInputPath(taskWorkspace, taskId, task.activeRunId!))
      : {
          version: 1 as const,
          prompt,
          submittedAt: Date.now(),
          body: submission?.body,
          taskId,
          runId,
          attachmentIds: submission?.attachmentIds,
          textAttachments: submission?.textAttachments,
          ...(submission?.thinkingLevel
            ? { thinkingLevel: normalizeReasoningEffort(submission.thinkingLevel, "thinkingLevel") }
            : {}),
          messageId,
          source:
            submission?.source ?? (readQueuedUserTurn(prompt) ? ("inbox" as const) : ("composer" as const))
        };
    if (input) await saveMainInput(inputPath, input);
    if (input && !continuation) {
      await saveAcceptedMainMessage(taskWorkspace, taskId, input);
      submission?.onAcceptedInput?.(input.messageId!);
    }
    if (!continuation) await requestStore.clear();
    if (retryRequest) await requestStore.reassignRun(retryRequest, runId);
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
      await location.store.transitionTask(taskId, "running", { runId, reason: "dashboard_run_restart" });
    }
    await location.store.updateTask(taskId, {
      goal: edit?.goalForTask ?? (task.goal || prompt.slice(0, 4_000)),
      model,
      activeRunId: runId,
      ...(task.pause ? { pause: undefined } : {})
    });
    await location.store.createRun(taskId, runId);
    await appendRunEvent(taskWorkspace, taskId, runId, "main.run_spawned", {
      model,
      modelSelection: modelRoleSnapshot(selection),
      prompt: prompt.slice(0, 4_000),
      resumed: continueSession,
      ...(continuation ? { continuation: true } : {})
    });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 关闭可能在上面的 await 写入期间开始，stopping 由 stop() 置位而 TS 看不到该闭包赋值
    if (stopping) {
      // This request claimed a Run before shutdown, but never acquired a process.
      // Settle it here: no child close event exists to persist its waiting state.
      await location.store.transitionTask(taskId, "waiting", {
        runId,
        reason: "desktop_shutdown_before_spawn"
      });
      await appendRunEvent(taskWorkspace, taskId, runId, "main.run_waiting", {
        reason: "desktop_shutdown_before_spawn"
      });
      throw new Error("Runtime is shutting down");
    }
    if (submission?.edit) await readyMessageEditTransaction(taskWorkspace, taskId);
    // The first turn of this Run arrives the way every later one does: through
    // the process's own durable Inbox. A continuation starts without new
    // input, so it is woken by the resume command instead.
    const inbox = new InboxStore(
      join(taskWorkspace, taskId, "runs", runId, "agents", "main", "inbox-store.json")
    );
    const createdAt = now();
    // A continuation and a message edit both already have their turn in the
    // session (restored from the accepted input); the process only needs to be
    // told to start it. A fresh message is itself the turn.
    // A replay must start its own turn: the callbacks that are waiting are
    // held until the archived request has been resent, so queued work cannot
    // be what starts it.
    const hasQueuedWork = await hasQueuedTurn(inbox);
    if ((continuation || submission?.edit) && (retryRequest || !hasQueuedWork)) {
      const resumeId = `main-resume-${randomUUID()}`;
      await inbox.enqueue({
        messageId: resumeId,
        recipientAgentId: "main",
        kind: "human_command",
        eventId: `main-resume-event-${resumeId}`,
        priority: 100,
        state: "ready",
        payload: { type: "main.resume" },
        createdAt
      });
    } else if (!continuation && !submission?.edit) {
      await inbox.enqueue({
        messageId,
        recipientAgentId: "main",
        kind: "human_command",
        eventId: `main-turn-${messageId}`,
        priority: 120,
        state: "ready",
        payload: { type: "human.message", message: prompt, delivery: "steer", initial: true },
        createdAt
      });
    }
    // This Run has a message that opens its first turn; the process is started
    // below. The extension replaces this acceptance with its own record at the
    // first boundary.
    pendingTurns.set(taskId, Date.now());
    const launchEnv: NodeJS.ProcessEnv = {
      ...process.env,
      COWORK_API_TOKEN: runCredential,
      ...mainRunEnv({
        baseUrl,
        apiKey,
        model,
        taskWorkspace,
        projectDirectory: task.projectDirectory,
        taskId,
        runId,
        dashboardUrl,
        piAgentDir: process.env.PI_CODING_AGENT_DIR,
        projectRoot,
        selection,
        ...(input?.thinkingLevel
          ? { thinkingLevel: normalizeReasoningEffort(input.thinkingLevel, "thinkingLevel") }
          : {})
      }),
      // A continuation restores the accepted input this Run inherits, and an
      // edit restores its rewritten input, into the selected session before
      // Pi starts. The resident process never reads stdin.
      COWORK_MAIN_CONTINUATION: continuation || submission?.edit ? inputPath : "",
      // Admission is this process's budget decision; the launcher must not
      // ask for a second slot for the same Run.
      ...(admission.requestId ? { COWORK_MAIN_CAPACITY_GRANTED: admission.requestId } : {}),
      COWORK_MAIN_RETRY_REQUEST_ID: retryRequest?.requestId ?? "",
      COWORK_MAIN_RETRY_MODEL: retryRequest ? JSON.stringify(retryRequest.model) : ""
    };
    const outputPath = join(taskWorkspace, taskId, "runs", runId, "runtime-output.log");
    const stderrPath = join(taskWorkspace, taskId, "runs", runId, "runtime-stderr.log");
    // The turn boundary is the Process's own event stream: a resident Main
    // starts and settles turns while the backend watches.
    const runOutput = new MainRunOutput((type) => {
      const current = residentMains.get(taskId);
      if (!current || current.runId !== runId) return;
      if (type === "agent_start") current.turnActive = true;
      else if (type === "agent_settled") {
        // A failed request ends this process; the Run stays "working" until
        // the exit settles it as failed, so a page cannot read it as idle.
        if (runOutput.message?.stopReason === "error") return;
        current.turnActive = false;
      }
    });
    // Concurrent appendFile calls can reorder stream chunks. Preserve arrival
    // order so message_start, deltas and final snapshots remain coherent.
    let outputWrites = Promise.resolve();
    const persistOutput = (path: string, chunk: Buffer) => {
      outputWrites = outputWrites
        .then(() => appendFile(path, chunk))
        .catch((error) =>
          console.error(
            `[cowork] output persist failed: ${error instanceof Error ? error.message : String(error)}`
          )
        );
    };
    // Registered before the launch returns: a process that exits during the
    // launch's own awaits must still be settled, and its late events must not
    // re-register it.
    const entry: ResidentMain = {
      taskId,
      runId,
      location,
      host: undefined as unknown as AgentProcessHost,
      record: undefined as unknown as AgentProcessRecord,
      output: runOutput,
      // The turn this launch enqueued has been accepted; it clears when Pi
      // reports the Run settled.
      turnActive: true,
      observed: true,
      replacing: false,
      settled: false,
      ...(admission.requestId ? { requestId: admission.requestId } : {})
    };
    const host = new AgentProcessHost({
      workspaceRoot: taskWorkspace,
      harnessRoot: projectRoot,
      env: launchEnv,
      onSpawn: (spawned, child) => {
        if (entry.settled) return;
        entry.record = spawned;
        activeRuns.set(taskId, child);
      },
      onExit: (record) => handleResidentExit(taskId, record.runId, record)
    });
    entry.host = host;
    residentMains.set(taskId, entry);
    let record: AgentProcessRecord;
    try {
      record = await host.launch({
        taskId,
        runId,
        callId: runId,
        agentId: "main",
        role: "main",
        workingDirectory: projectRoot,
        projectDirectory: task.projectDirectory ?? taskWorkspace,
        // One Pi session for the life of the resident process; a message edit
        // resumes exactly the version it rewrote.
        sessionDirectory: join(taskWorkspace, taskId, "sessions", "main", "pi"),
        resultPath: join(taskWorkspace, taskId, "runs", runId, "agents", "main", "process-result.json"),
        env: { COWORK_API_TOKEN: runCredential },
        mode: "resident",
        ...(versions?.sessionFile
          ? { sessionArgs: ["--session", versions.sessionFile] }
          : continueSession
            ? { sessionArgs: ["--continue"] }
            : { sessionArgs: ["--session-id", runId] }),
        onStdout: (chunk) => {
          runOutput.write(chunk);
          persistOutput(outputPath, chunk);
        },
        // A diagnostic can arrive between stdout fragments of one JSON event.
        // Preserve its original bytes without corrupting the model event stream.
        onStderr: (chunk) => persistOutput(stderrPath, chunk)
      });
    } catch (error) {
      // A process that never started owns no Run state to settle later, so the
      // failure is recorded here, once, with the cause the OS reported.
      const message = error instanceof Error ? error.message : String(error);
      runOutput.finish();
      await appendRunEvent(taskWorkspace, taskId, runId, "main.run_failed", {
        error: message,
        code: null,
        signal: null,
        failure: { kind: "main_process", spawn: true }
      });
      await location.store
        .transitionTask(taskId, "failed", { runId, error: message, reason: "dashboard_main_exit" })
        // eslint-disable-next-line no-restricted-syntax -- 失败事件已落盘，状态转换失败不能覆盖启动失败本身
        .catch(() => {});
      if (admission.requestId && mainCapacity)
        // eslint-disable-next-line no-restricted-syntax -- 启动失败已记录，释放名额失败不能替换这个错误
        await mainCapacity.release(admission.requestId).catch(() => {});
      activeRunIds.delete(taskId);
      interjectionTargets.delete(taskId);
      if (submission?.edit) await finishMessageEditTransaction(taskWorkspace, taskId);
      return { taskId, runId, status: "running", model };
    }
    admission.spawned = true;
    if (admission.requestId && mainCapacity)
      await mainCapacity
        .bindProcess(admission.requestId, record.pid)
        .catch((error) =>
          console.error(
            `[cowork] external capacity process record failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
    entry.record = record;
    activeRunIds.set(taskId, runId);
    interjectionTargets.set(taskId, { runId });
    if (submission?.edit) await finishMessageEditTransaction(taskWorkspace, taskId);
    return {
      taskId,
      runId,
      status: "running",
      model,
      ...(capacitySessionId ? { sessionId: capacitySessionId } : {})
    };
  }

  async function launchMainRun(
    ...args: [
      taskId: string,
      prompt: string,
      requestedRunId?: string,
      resume?: boolean,
      requestedModel?: string,
      retryRequestId?: string,
      submission?: MainLaunchSubmission
    ]
  ) {
    const admission: MainLaunchAdmission = { spawned: false };
    try {
      return await launchMainRunWithAdmission(
        args[0],
        args[1],
        args[2],
        args[3] ?? false,
        args[4],
        args[5],
        args[6],
        admission
      );
    } catch (error) {
      // A Run that never reached a process owns no slot; one that did keeps its
      // slot until the process exits, and only its queue row is settled here.
      if (admission.requestId && mainCapacity) {
        // eslint-disable-next-line no-restricted-syntax -- 启动失败要原样抛给调用方，容量记账失败不能替换这个错误
        if (admission.spawned) await mainCapacity.markStarted(admission.requestId).catch(() => {});
        // eslint-disable-next-line no-restricted-syntax -- 启动失败要原样抛给调用方，释放容量失败不能替换这个错误
        else await mainCapacity.release(admission.requestId).catch(() => {});
      }
      throw error;
    }
  }

  function startMainRun(...args: Parameters<typeof launchMainRun>) {
    return withTaskProjectLock(args[0], () => serialize(args[0], () => launchMainRun(...args)));
  }

  /**
   * Main recovery owned by this service.
   *
   * A Task whose Main died while callbacks remained addressed to it is started
   * again through the ordinary Main entry, so a full external budget queues the
   * wake instead of dropping it.
   */
  const mainGuardianDisabled = () => process.env.COWORK_DISABLE_MAIN_GUARDIAN === "1";
  const mainGuardianIntervalMs = () =>
    Math.max(1000, Number(process.env.COWORK_MAIN_GUARDIAN_INTERVAL_MS) || 60_000);
  let mainGuardianTimer: ReturnType<typeof setTimeout> | undefined;
  let mainGuardianPending: Promise<void> | undefined;
  let mainGuardianStopped = false;

  async function runMainGuardianCycle(): Promise<MainSupervisorCycleResult[]> {
    if (
      stopping ||
      mainGuardianStopped ||
      mainGuardianDisabled() ||
      !mainGuardian ||
      !mainGuardian.modelConfigured()
    )
      return [];
    const results: MainSupervisorCycleResult[] = [];
    for (const workspaceRoot of await mainGuardian.workspaceRoots()) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stop() 可在读取工作区期间置位，此时不能再启动新周期
      if (stopping || mainGuardianStopped) break;
      const supervisor = new MainSupervisor({
        workspaceRoot,
        // A Run this host owns is alive even before its heartbeat is written.
        isRunning: (taskId) => residentMain(taskId) !== undefined || activeRuns.has(taskId),
        launch: async ({ taskId, runId }) => {
          await startMainRun(taskId, SUPERVISOR_WAKE_TURN, runId, true, undefined, undefined, {
            origin: "internal",
            queueWhenFull: true
          });
        }
      });
      results.push(await supervisor.runCycle());
    }
    return results;
  }

  function tickMainGuardian() {
    if (stopping || mainGuardianStopped || mainGuardianPending) return;
    mainGuardianPending = runMainGuardianCycle()
      .then(() => undefined)
      .catch((error) => {
        console.error(
          `[cowork] main guardian cycle failed: ${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => {
        mainGuardianPending = undefined;
        if (!stopping && !mainGuardianStopped)
          mainGuardianTimer = setTimeout(tickMainGuardian, mainGuardianIntervalMs());
      });
  }

  function startMainGuardian() {
    if (mainGuardianTimer || stopping || mainGuardianStopped || mainGuardianDisabled() || !mainGuardian)
      return;
    tickMainGuardian();
  }

  async function stopMainGuardian() {
    mainGuardianStopped = true;
    clearTimeout(mainGuardianTimer);
    mainGuardianTimer = undefined;
    await mainGuardianPending;
  }

  function editMainMessage(
    taskId: string,
    request: MessageEditRequest,
    body: string,
    attachmentIds: string[],
    model?: string,
    textAttachments: EditTextFile[] = []
  ) {
    return withTaskProjectLock(taskId, () =>
      serialize(taskId, async () => {
        const location = await locateTask(taskId);
        const versions = await readMessageVersions(location.workspaceRoot, taskId);
        const repeated = versions?.edits.find((edit) => edit.editId === request.editId);
        if (repeated) {
          const input = await readMainInput(mainInputPath(location.workspaceRoot, taskId, repeated.runId));
          if (
            JSON.stringify(repeated.target) !== JSON.stringify(request) ||
            input?.body !== body ||
            JSON.stringify(attachmentIds) !== JSON.stringify(input.attachmentIds) ||
            JSON.stringify(textAttachments) !== JSON.stringify(input.textAttachments ?? [])
          )
            throw new MainMessageEditConflict("该重发标识已用于其他输入，请刷新后重试。");
          return {
            taskId,
            runId: repeated.runId,
            status: location.task.status,
            model: location.task.model || ""
          };
        }
        await taskFinalizations.get(taskId);
        // An edit rewrites the session behind a Main. A turn that is still
        // producing an answer is not editable: stopping it to rewrite its
        // transcript would discard work the person never cancelled. An idle
        // process — or one parked on a durable question — is stopped and
        // relaunched on the edited version, which is what keeps editing
        // possible now that the process outlives its turns.
        if (
          (await taskTurnActive(taskId)) &&
          (await new HumanRequestStore(location.workspaceRoot).list(taskId, "pending")).length === 0
        )
          throw new MainMessageEditConflict("当前回合仍在运行，请先停止或等待它结束后再修改重发。");
        if (location.task.activeRunId !== request.runId)
          throw new MainMessageEditConflict("请先停止当前运行并等待停止完成，再修改重发。");
        // An edit stops the process that owns the session, whether this
        // backend started it or took it over after a restart.
        if (await adoptResidentMain(taskId, location)) await stopResidentMain(taskId, { replacing: true });
        const source = await latestEditableMessage(location.workspaceRoot, taskId, request.runId);
        if (
          !source ||
          source.target.messageId !== request.messageId ||
          source.target.versionId !== request.versionId ||
          source.target.scopeToken !== request.scopeToken
        )
          throw new MainMessageEditConflict("可编辑的消息或会话版本已变化，编辑内容仍保留，请刷新后重试。");
        const files = [];
        for (const uploadId of [...new Set(attachmentIds)]) {
          if (source.target.attachments.some((file) => "uploadId" in file && file.uploadId === uploadId))
            files.push((await readTaskInput(join(location.workspaceRoot, taskId), uploadId)).file);
          else {
            if (!uploads) throw new Error("附件服务不可用");
            files.push(...(await uploads.attach(location.workspaceRoot, taskId, [uploadId])));
          }
        }
        const inline = textAttachments.length
          ? `\n\nAttached files:\n${textAttachments.map((file) => `--- ${file.name} ---\n${file.text}`).join("\n\n")}`
          : "";
        const prompt =
          (body.trim() ? body : files.length || textAttachments.length ? "请查看这些附件。" : "") +
          inline +
          inputPrompt(join(location.workspaceRoot, taskId), files);
        if (!prompt.trim()) throw new Error("请输入消息或保留至少一个附件。");
        let rollback: (() => Promise<void>) | undefined;
        let acceptedMessageId: string | undefined;
        try {
          return await launchMainRun(taskId, prompt, `main-edit-${randomUUID()}`, false, model, undefined, {
            body,
            edit: request,
            attachmentIds,
            textAttachments,
            onAcceptedInput: (messageId) => {
              acceptedMessageId = messageId;
            },
            onPrepared: (restore) => {
              rollback = restore;
            }
          });
        } catch (error) {
          if (rollback && !residentMain(taskId) && !activeRuns.has(taskId)) {
            if (acceptedMessageId)
              await rejectAcceptedMainMessage(location.workspaceRoot, taskId, acceptedMessageId);
            await rollback();
            const task = location.task;
            await location.store.updateTask(taskId, {
              activeRunId: task.activeRunId,
              goal: task.goal,
              model: task.model
            });
            const current = await location.store.readTask(taskId);
            if (current.status !== task.status)
              await location.store.transitionTask(taskId, task.status, {
                runId: task.activeRunId,
                reason: "message_edit_launch_rollback"
              });
          }
          throw error;
        }
      })
    );
  }

  async function interjectionTarget(taskId: string): Promise<InterjectionTarget | undefined> {
    // A resident Main is reachable while its entry exists, whether this
    // backend spawned it or took it over from the previous backend.
    if (!(await residentFor(taskId))) return;
    return interjectionTargets.get(taskId);
  }

  function queueInterjection(
    taskId: string,
    target: InterjectionTarget,
    message: string,
    delivery: "steer" | "followUp"
  ) {
    return serialize(taskId, async () => {
      await taskFinalizations.get(taskId);
      const location = await locateTask(taskId);
      // Keep the identity captured when the request entered the route. Reading
      // its body may span a stop or a whole new Run, which must not receive it.
      if (
        stopping ||
        residentMain(taskId)?.runId !== target.runId ||
        interjectionTargets.get(taskId) !== target ||
        activeRunIds.get(taskId) !== target.runId ||
        location.task.activeRunId !== target.runId ||
        location.task.status === "cancelled"
      )
        return { error: "该消息所属回合已结束或变更，请确认当前会话后重新发送。" };
      if (!message) throw new Error("message must not be empty");
      if (message.includes("\0") || Buffer.byteLength(message, "utf8") > 512 * 1024)
        throw new Error("补充消息包含二进制字符或超过 512 KB");
      const inbox = new InboxStore(
        join(location.workspaceRoot, taskId, "runs", target.runId, "agents", "main", "inbox-store.json")
      );
      const messageId = `user-message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = now();
      await inbox.enqueue({
        messageId,
        recipientAgentId: "main",
        kind: "human_command",
        eventId: `user-message-event-${messageId}`,
        priority: 120,
        state: "ready",
        payload: { type: "human.message", message, delivery },
        createdAt
      });
      await appendRunEvent(location.workspaceRoot, taskId, target.runId, "user.interjected", {
        message,
        messageId,
        delivery,
        createdAt
      });
      return { taskId, runId: target.runId, messageId, delivered: true, delivery };
    });
  }

  function queuedMessageAction(taskId: string, messageId: string, action: "send" | "cancel") {
    return withTaskProjectLock(taskId, () =>
      serialize(taskId, async () => {
        await taskFinalizations.get(taskId);
        const location = await locateTask(taskId);
        const currentRunId = location.task.activeRunId;
        if (!currentRunId) return { error: "这条消息已不在队列中。" };
        const active = (await adoptResidentMain(taskId, location)) !== undefined;
        // A process can exit between saving its first prompt and acknowledging it.
        if (!active)
          await new MainInboxDelivery(location.workspaceRoot, taskId, currentRunId).acknowledge(
            await readJsonFile(mainContextPaths(location.workspaceRoot, taskId).messages, [])
          );
        const directory = join(location.workspaceRoot, taskId, "runs");
        const runs = await readdir(directory, { withFileTypes: true });
        for (const runId of [
          currentRunId,
          ...runs
            .filter((entry) => entry.isDirectory() && entry.name !== currentRunId)
            .map((entry) => entry.name)
        ]) {
          const inbox = new InboxStore(join(directory, runId, "agents", "main", "inbox-store.json"));
          const message = (await inbox.list("main")).find((entry) => entry.messageId === messageId);
          const payload = message?.payload as
            { type?: string; message?: string; delivery?: string; cancelled?: boolean } | undefined;
          if (
            !message ||
            message.kind !== "human_command" ||
            payload?.type !== "human.message" ||
            typeof payload.message !== "string"
          )
            continue;
          if (!active && message.state === "leased") await inbox.release(messageId);
          if (action === "cancel") {
            if (!(await inbox.cancelUserMessage(messageId)))
              return { error: "这条消息已开始处理，无法取消。" };
            await appendRunEvent(location.workspaceRoot, taskId, runId, "user.message_cancelled", {
              messageId
            });
            return { taskId, messageId, cancelled: true };
          }
          if (payload.cancelled) return { error: "这条消息已取消。" };
          if (message.state === "consumed")
            return { taskId, runId: currentRunId, messageId, delivery: "steer" };
          // Our resumed prompt already owns this message; a repeated click is a no-op.
          if (active && message.state === "leased" && message.lease?.consumerId.startsWith("queue-resume-"))
            return { taskId, runId: currentRunId, messageId, delivery: "steer" };
          if (active && runId === currentRunId) {
            if (!(await inbox.promoteUserMessage(messageId)))
              return { error: "这条消息已开始处理或不在当前队列中。" };
            await appendRunEvent(location.workspaceRoot, taskId, runId, "user.message_promoted", {
              messageId,
              delivery: "steer"
            });
            return { taskId, runId: currentRunId, messageId, delivery: "steer" };
          }
          const consumer = `queue-resume-${messageId}`;
          const leased = await inbox.leaseMessage("main", messageId, 60_000, consumer);
          if (leased?.state !== "leased" || leased.lease?.consumerId !== consumer)
            return { error: "这条消息已开始处理，请稍后刷新。" };
          try {
            if (active) {
              // A remaining message can belong to an older run. Transfer its identity,
              // not a copy with a new id, into the currently running inbox.
              const target = new InboxStore(
                join(directory, currentRunId, "agents", "main", "inbox-store.json")
              );
              await target.enqueue({
                ...message,
                state: "ready",
                lease: undefined,
                payload: { ...payload, delivery: "steer" }
              });
              await inbox.consume(messageId);
              await appendRunEvent(location.workspaceRoot, taskId, runId, "user.message_promoted", {
                messageId,
                delivery: "steer"
              });
              return { taskId, runId: currentRunId, messageId, delivery: "steer" };
            }
            const result = await launchMainRun(
              taskId,
              queuedUserTurn({ taskId, runId, messageId, text: payload.message }),
              currentRunId,
              true,
              undefined,
              undefined,
              { origin: "internal", queueWhenFull: true }
            );
            // The first saved context acknowledges the durable message. Until then
            // its lease prevents the normal inbox poll from delivering it twice.
            return { ...result, messageId, delivery: "steer" };
          } catch (error) {
            await inbox.release(messageId);
            throw error;
          }
        }
        return { error: "这条消息已不在队列中。" };
      })
    );
  }

  /** `change` names what waits for the project to be idle, for the refusal. */
  function withIdleProjectTasks<T>(
    taskIds: string[],
    action: () => Promise<T>,
    change = "更改项目文件夹"
  ): Promise<T> {
    const ids = [...new Set(taskIds)].sort();
    const lockTasks = (index: number): Promise<T> =>
      index < ids.length ? serialize(ids[index], () => lockTasks(index + 1)) : inspect();
    async function inspect() {
      for (const taskId of ids) {
        const location = await locateTask(taskId);
        // eslint-disable-next-line no-restricted-syntax -- 接管失败只表示这里不认识该进程，后续的活进程检查仍会读心跳与执行记录
        const resident = await adoptResidentMain(taskId, location).catch(() => undefined);
        // A resident Main between turns is not activity: stop it so the folder
        // change can fork the session, exactly as an edit does. A turn that is
        // still producing an answer keeps the refusal.
        if (resident) {
          if (await taskTurnActive(taskId))
            throw new ProjectCatalogError(`请先停止项目中的会话及后台工作，再${change}`, 409);
          await stopResidentMain(taskId, { replacing: true });
        }
        if (
          activeRuns.has(taskId) ||
          // The adopted resident was stopped above; a record this backend did
          // not stop is still an owner.
          residentMains.has(taskId) ||
          taskFinalizations.has(taskId) ||
          ["running", "paused", "waiting"].includes(location.task.status) ||
          (await readSleep(location.workspaceRoot, taskId)) ||
          (await projectExecutionIsAlive(location.workspaceRoot, taskId))
        )
          throw new ProjectCatalogError(`请先停止项目中的会话及后台工作，再${change}`, 409);
        const privateAgents = join(location.workspaceRoot, taskId, "agents", "subagents");
        // eslint-disable-next-line no-restricted-syntax -- 没有 subagents 目录表示该会话没有私有子代理，按空列表继续检查
        for (const agent of await readdir(privateAgents).catch(() => [])) {
          if (
            (await listJobs({ directory: join(privateAgents, agent, "logs", "jobs") })).some(
              (job) => job.state === "running"
            )
          )
            throw new ProjectCatalogError(`请先停止项目中的后台命令，再${change}`, 409);
        }
        const runIds = await readdir(join(location.workspaceRoot, taskId, "runs")).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
          }
        );
        for (const runId of runIds) {
          const coordination = await coordinator.waitForSubagents({
            taskId,
            runId,
            workspaceRoot: location.workspaceRoot,
            timeoutMs: 0
          });
          if (coordination.pending.length || coordination.callbackPending.length)
            throw new ProjectCatalogError(`请先停止项目中的后台协作，再${change}`, 409);
          const agents = join(location.workspaceRoot, taskId, "runs", runId, "agents");
          // eslint-disable-next-line no-restricted-syntax -- 该 Run 可能从未启动子代理，subagents 目录缺失按空列表继续
          const subagents = await readdir(join(agents, "subagents")).catch(() => []);
          for (const agent of [
            join(agents, "main"),
            ...subagents.map((subagent) => join(agents, "subagents", subagent))
          ]) {
            if ((await listJobs({ directory: join(agent, "jobs") })).some((job) => job.state === "running"))
              throw new ProjectCatalogError(`请先停止项目中的后台命令，再${change}`, 409);
          }
        }
      }
      return action();
    }
    return lockTasks(0);
  }

  /**
   * Ask the running Main to stop after its current step.
   *
   * The request is durable on the Task record, which the Main process reads at
   * the next tool/model boundary. It changes no Run state by itself: the close
   * path records the pause only after the in-flight step has settled.
   */
  function pauseTask(taskId: string) {
    return serialize(taskId, async () => {
      const location = await locateTask(taskId);
      if (location.task.status === "paused") return { task: location.task };
      // Take over a Main the previous backend left running before deciding
      // whether a turn is in flight.
      if (!(await adoptResidentMain(taskId, location))) return { refused: "no_active_run" as const };
      if (location.task.status !== "running" || !location.task.activeRunId)
        return { refused: "no_active_run" as const };
      if (!location.task.pause) {
        const task = await location.store.updateTask(taskId, {
          pause: { requestedAt: new Date().toISOString(), requestedBy: "user" }
        });
        await appendRunEvent(
          location.workspaceRoot,
          taskId,
          location.task.activeRunId,
          "main.run_pause_requested",
          { reason: "ui_pause" }
        );
        return { task };
      }
      return { task: location.task };
    });
  }

  /**
   * Stop the turn Main is producing, leaving the session and its work alone.
   *
   * The command travels through the process's own durable Inbox like every
   * other message, so it needs no second control channel: Main aborts the run
   * where Pi next checks its signal and stays available for the next message.
   * Subagents already running are not cancelled; the Task is not ended.
   */
  function interruptTask(taskId: string) {
    return serialize(taskId, async () => {
      const location = await locateTask(taskId);
      // The adopted process reports its turn through the durable heartbeat;
      // a process this backend observes reports its event stream.
      // Adoption is only used for the Run identity; the turn decision below
      // reads the durable record and does not need the takeover to succeed.
      // eslint-disable-next-line no-restricted-syntax -- 接管失败时仍按持久回合记录判断，消息留给下一个 Main 读取
      const resident = await adoptResidentMain(taskId, location).catch(() => undefined);
      // Both this decision and `runtime.active` read the same durable record.
      const turnActive = await taskTurnActive(taskId);
      const runId = resident?.runId ?? location.task.activeRunId;
      if (!turnActive || !runId) return { refused: "no_active_turn" as const };
      const inbox = new InboxStore(
        join(location.workspaceRoot, taskId, "runs", runId, "agents", "main", "inbox-store.json")
      );
      const messageId = `main-interrupt-${randomUUID()}`;
      await inbox.enqueue({
        messageId,
        recipientAgentId: "main",
        kind: "human_command",
        eventId: `main-interrupt-event-${messageId}`,
        // Ahead of callbacks and external events, but behind a user insertion
        // enqueued before it: the person's message belongs to the turn the
        // interrupt then stops, not to a fresh turn after it.
        priority: 110,
        state: "ready",
        payload: { type: "main.interrupt" },
        createdAt: now()
      });
      await appendRunEvent(location.workspaceRoot, taskId, runId, "main.interrupt_requested", {
        messageId
      });
      return { taskId, runId, interrupted: true };
    });
  }

  function cancelTask(taskId: string) {
    return serialize(taskId, async () => {
      cancellations.add(taskId);
      // eslint-disable-next-line no-restricted-syntax -- 取消要继续停止进程，容量队列清理失败由进程退出时的 release 承接
      await mainCapacity?.cancelTask(taskId).catch(() => {});
      humanWakeups.delete(taskId);
      try {
        const location = await locateTask(taskId);
        // Closing is the destructive management action: it must reach a Main
        // the startup sweep has not taken over yet (or could not), so adoption
        // is resolved here instead of trusting the in-memory map.
        const resident = await adoptResidentMain(taskId, location).catch((error) => {
          console.error(
            `[cowork] resolving the Main to close for ${taskId} failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          return undefined;
        });
        if (location.task.status === "completed") {
          const runId = resident?.runId ?? activeRunIds.get(taskId);
          // A finished Task whose resident Main is idle keeps its completed
          // outcome; closing only ends that process. A turn still producing
          // the final response is a provisional completion, so cancelling it
          // takes the ordinary terminal path below.
          if (resident && (await taskTurnActive(taskId)) !== true) {
            await stopResidentMain(taskId);
            return (await locateTask(taskId)).task;
          }
          if (!runId || !(await prepareRunTransition(location, runId, "cancelled"))) return location.task;
        }
        let failed = false;
        let failure: unknown;
        const attempt = async (action: () => Promise<unknown>) => {
          try {
            await action();
          } catch (error) {
            if (!failed) {
              failed = true;
              failure = error;
            }
          }
        };
        // A persistence failure must not skip cancellation or process cleanup;
        // retain its original cause even when a later cleanup attempt also fails.
        await attempt(async () => {
          await location.store.transitionTask(taskId, "cancelled", { reason: "ui_cancel" });
          if (location.task.activeRunId)
            await appendRunEvent(
              location.workspaceRoot,
              taskId,
              location.task.activeRunId,
              "main.run_cancelled",
              { reason: "ui_cancel" }
            );
        });
        await attempt(() => clearSleep(location.workspaceRoot, taskId));
        // End the session before its delegated work settles: the settlement
        // callback is durable, and a Main still watching its Inbox would start
        // a turn from it and reopen the Task that was just closed.
        await attempt(() => stopResidentMain(taskId));
        await attempt(async () => {
          await taskFinalizations.get(taskId);
        });
        await attempt(async () => {
          if (location.task.activeRunId) {
            const coordination = await coordinator.waitForSubagents({
              taskId,
              runId: location.task.activeRunId,
              workspaceRoot: location.workspaceRoot,
              timeoutMs: 0
            });
            const results = await Promise.allSettled(
              coordination.pending.map((call) =>
                subagents
                  ? subagents.cancel({
                      taskId,
                      runId: location.task.activeRunId!,
                      callId: call,
                      reason: "User stopped the task"
                    })
                  : coordinator.cancelSubagent({
                      taskId,
                      runId: location.task.activeRunId!,
                      workspaceRoot: location.workspaceRoot,
                      callId: call,
                      reason: "User stopped the task"
                    })
              )
            );
            const rejected = results.find((result) => result.status === "rejected");
            if (rejected?.status === "rejected") throw rejected.reason;
          }
        });
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- failed 由 attempt 的 catch 回调置位，TS 在读取处看不到这次闭包写入
        if (failed) throw failure;
        return (await locateTask(taskId)).task;
      } finally {
        cancellations.delete(taskId);
      }
    });
  }

  async function pendingHumanAnswers(taskWorkspace: string, taskId: string, runId?: string) {
    if (!runId) return [];
    return (
      await new InboxStore(
        join(taskWorkspace, taskId, "runs", runId, "agents", "main", "inbox-store.json")
      ).list("main")
    ).filter(
      (message) =>
        message.kind === "human_command" &&
        message.state !== "consumed" &&
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- payload 来自 inbox-store.json 的持久化消息，旧记录可能没有该字段，直接读会抛错
        (message.payload as { type?: string })?.type === "human.answer"
    );
  }

  function resumeHumanAnswers(taskId: string): Promise<{ status: string; error?: string }> {
    const existing = humanResumes.get(taskId);
    if (existing) return existing;
    const operation = (async () => {
      const location = await locateTask(taskId);
      const runId = location.task.activeRunId;
      if (location.task.status === "cancelled" || !runId) {
        humanWakeups.delete(taskId);
        return { status: "cancelled" };
      }
      const pending = await new HumanRequestStore(location.workspaceRoot).listBlockingPending(taskId);
      if (pending.length) {
        humanWakeups.delete(taskId);
        return { status: "waiting" };
      }
      const answers = await pendingHumanAnswers(location.workspaceRoot, taskId, runId);
      if (!answers.length) {
        humanWakeups.delete(taskId);
        return { status: "delivered" };
      }
      if ((await adoptResidentMain(taskId, location)) || activeRuns.has(taskId)) {
        humanWakeups.add(taskId);
        return { status: "resuming" };
      }
      humanWakeups.delete(taskId);
      const inbox = new InboxStore(
        join(location.workspaceRoot, taskId, "runs", runId, "agents", "main", "inbox-store.json")
      );
      // The prior Dashboard process has stopped. Its unacknowledged answer
      // leases must be available to the resumed session immediately.
      for (const message of answers) if (message.state === "leased") await inbox.release(message.messageId);
      // The resumed user turn contains exactly the submitted decisions. The
      // durable Inbox provides delivery acknowledgement and crash recovery.
      // The shape is shared with the browser, which uses it to recognise this
      // turn as an answer and render it against its question rather than as a
      // fresh request the person typed.
      const prompt = answers
        .map((message) => {
          const payload = message.payload as { question: string; answer: string };
          return humanAnswerTurn(payload.question, payload.answer);
        })
        .join("\n\n");
      // A full external budget keeps the submitted answers in the durable
      // Inbox and queues this resume; the program starts it when a slot frees.
      const resumed = await startMainRun(taskId, prompt, runId, true, undefined, undefined, {
        source: "human",
        origin: "internal",
        queueWhenFull: true
      });
      return { status: resumed.status === "queued" ? "queued" : "running" };
    })()
      .catch((error) => ({ status: "error", error: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        humanResumes.delete(taskId);
      });
    humanResumes.set(taskId, operation);
    return operation;
  }

  /**
   * Whether a turn is running for this Task right now.
   *
   * `undefined` means this backend does not know the Task's Main (no resident
   * and no live process); the caller then reads the heartbeat itself. A
   * process this backend observed reports its own event stream; an adopted one
   * reports the durable turn state it writes at every boundary.
   */
  async function taskTurnActive(taskId: string): Promise<boolean> {
    // The heartbeat is the one record both the Task view and the interrupt
    // command read, so they cannot disagree about whether a turn exists. The
    // turn counts only while that process is still alive: a record left by a
    // dead Main is how the exit is classified, not a turn the user can stop.
    const resident = residentMains.get(taskId);
    const location = resident?.location ?? (await locateTask(taskId));
    // eslint-disable-next-line no-restricted-syntax -- 读不到任务时按没有回合处理：状态查询不能因为损坏的记录抛出
    const task = await location.store.readTask(taskId).catch(() => location.task);
    const runId = task.activeRunId ?? resident?.runId;
    if (!runId) return false;
    // A paused Task is not running a turn: the pause stops new turns, so the
    // Task view and the interrupt must not report the turn the record still
    // describes while the pause is being written.
    if (task.pause || task.status === "paused") return false;
    const state = await mainTurnState(location, taskId, runId);
    if (state) {
      // A record that says "running" stays the answer while this backend is
      // still settling that Run: a process that just exited has not written its
      // terminal Task status yet, and reporting "no turn" there is what lets a
      // reader see a running Task as idle.
      if (state.active && (state.alive || activeRuns.has(taskId))) return true;
      // The extension writes its own boundary; once that record is newer than
      // the acceptance, it is the answer and the acceptance no longer counts.
      const pendingAt = pendingTurns.get(taskId);
      if (pendingAt !== undefined && state.recordedAt >= pendingAt) {
        pendingTurns.delete(taskId);
        return false;
      }
    }
    const pendingAt = pendingTurns.get(taskId);
    if (pendingAt === undefined) return false;
    // A turn accepted for delivery has not written its first boundary yet; the
    // process that will write it must still be there, or the launch failed.
    if (resident) return residentProcessAlive(resident.record);
    return activeRuns.has(taskId);
  }

  /** Whether a Main process for this Task exists, idle or working. */
  function mainProcessRunning(taskId: string): boolean {
    return activeRuns.has(taskId) || residentMains.has(taskId);
  }

  /**
   * Whether a Main owns this Task, taking it over first when this backend has
   * not met it yet. Destructive management decisions use this instead of the
   * in-memory map so a Main still running from the previous backend cannot be
   * deleted, archived or duplicated during the startup adoption window.
   */
  async function ensureMainProcess(taskId: string): Promise<boolean> {
    if (mainProcessRunning(taskId)) return true;
    // eslint-disable-next-line no-restricted-syntax -- 未知或不可用的 Task 由调用方的正常 404 处理，这里只回答“有没有 Main”
    const resident = await residentFor(taskId).catch(() => undefined);
    return resident !== undefined;
  }

  return {
    activeRuns,
    taskTurnActive,
    mainProcessRunning,
    ensureMainProcess,
    adoptExistingMains,
    isBusy: () => activeRuns.size > 0 || taskOperations.size > 0 || finalizations.size > 0,
    startMainRun,
    pauseTask,
    interruptTask,
    editMainMessage,
    interjectionTarget,
    queueInterjection,
    queuedMessageAction,
    withIdleProjectTasks,
    cancelTask,
    cancellations,
    pendingHumanAnswers,
    resumeHumanAnswers,
    runMainGuardianCycle,
    startMainGuardian,
    stopMainGuardian,
    async stop() {
      stopping = true;
      // Stop taking decisions first: a guardian that is already launching is
      // drained with the other task operations before its process is reaped.
      await stopMainGuardian();
      // A startup may be between durable writes and spawn. Drain accepted task
      // operations before dropping observers so they can settle without a child.
      await Promise.allSettled([...taskOperations.values()]);
      // A resident Main is not a child of this backend: a restart or upgrade
      // must leave it running. Only the observers go away; the next backend
      // adopts the processes from their durable records.
      for (const resident of residentMains.values()) {
        resident.host.close();
        activeRuns.delete(resident.taskId);
      }
      await Promise.all(finalizations);
    }
  };
}

export type RunService = ReturnType<typeof createDashboardRunService>;
