import {
  readyMessageEditTransaction,
  finishMessageEditTransaction
} from "../runtime/main-message-edit-transaction.js";
import type { UserMemoryStore } from "../runtime/user-memory-store.js";
import { randomUUID } from "node:crypto";
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
import { MainInboxDelivery } from "../runtime/main-inbox-delivery.js";
import { mainContextPaths } from "../runtime/main-context.js";
import {
  MAIN_CONTINUATION_COMMAND,
  mainInputPath,
  readMainInput,
  saveMainInput
} from "../runtime/main-continuation.js";
import { appendFile, readdir, realpath } from "node:fs/promises";
import { listJobs } from "../tools/jobs.js";
import { join, resolve } from "node:path";
import { mainRunEnv } from "./main-run-env.js";
import { MainRequestConflictError, mainRequestEnvironment } from "../runtime/main-request-retry.js";
import {
  MainRequestStore,
  MainRequestSnapshotError,
  mainRequestPath
} from "../storage/main-request-store.js";
import { assertMainRequestExecutionScope } from "../runtime/main-request-execution-scope.js";
import { CoordinatorRuntime } from "../runtime/coordinator-runtime.js";
import { humanAnswerTurn } from "../runtime/human-answer-turn.js";
import { blockingHumanRequests } from "../runtime/goal-decisions.js";
import { HumanRequestStore } from "../runtime/human.js";
import { WatchProgramStore } from "../runtime/watch-program-store.js";
import { recoverWatchMain } from "../runtime/watch-recovery.js";
import { parkBackgroundWatchGoal } from "../runtime/watch-main-lifecycle.js";
import { resetMainSupervisorBackoff, SUPERVISOR_WAKE_TURN } from "../runtime/main-supervisor.js";
import { readSleep, clearSleep } from "../runtime/main-sleep.js";
import { ProcessHost } from "../runtime/process-host.js";
import { InboxStore } from "../runtime/scheduler.js";
import { SubagentQuestionStore } from "../runtime/subagent-questions.js";
import { assessTaskCompletion, isFinalAssistantMessage } from "../runtime/task-completion.js";
import { mainRunFailure, MainRunOutput } from "./main-run-outcome.js";
import { projectExecutionIsAlive } from "../workspace/project-execution.js";
import { ProjectCatalogError } from "../workspace/project-catalog.js";
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
  userMemory?: UserMemoryStore;
  uploads?: InputStore;
  projectRoot: string;
  tabStorePath: string;
  dashboardUrl: string;
  runCredential: string;
  coordinator: CoordinatorRuntime;
  locateTask(taskId: string): Promise<TaskLocation>;
  /**
   * Resolve the execution host's connection for one admitted Run.
   *
   * Called at the moment the launch is admitted, so a queued request that only
   * starts later reads the settings in force then. The returned snapshot is
   * fixed for the life of the process.
   */
  resolveMainModel(request: ModelRoleRequest): ResolvedModelRole;
  onRunStarting?: () => void;
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
  tabStorePath,
  dashboardUrl,
  runCredential,
  coordinator,
  locateTask,
  resolveMainModel,
  onRunStarting = () => {},
  onRunExit = () => {},
  onRunFinalized = async () => {},
  withTaskProjectLock = (_taskId, action) => action(),
  mainSessions,
  mainCapacity,
  normalizeModel,
  appendRunEvent,
  readJsonFile,
  userMemory
}: RunServicePorts) {
  const processes = new ProcessHost();
  const activeRuns = processes.processes;
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
    if (
      !activeRuns.has(taskId) ||
      activeRunIds.get(taskId) !== runId ||
      current.activeRunId !== runId ||
      current.status === "cancelled"
    )
      return;
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

  async function launchMainRunWithActivity(
    memoryActivityId: string,
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
    status: "running" | "queued" | "duplicate";
    model: string;
    sessionId?: string;
    queuePosition?: number;
  }> {
    if (stopping) throw new Error("Runtime is shutting down");
    // A dispatched demand already owns its slot; keep that identity so the
    // process record and the release below address the same claim.
    if (submission?.admittedRequestId) admission.requestId = submission.admittedRequestId;
    const existing = activeRuns.get(taskId);
    if (existing && !existing.killed) throw new Error("Task already has an active Main run");
    // Cancel only the background request. Task state still changes after the
    // normal validation below, and isBusy covers this asynchronous startup.
    onRunStarting();
    const location = await locateTask(taskId);
    const task = location.task;
    const taskWorkspace = location.workspaceRoot;
    // An answer can be queued while an edit replaces its Run. Validate again
    // inside the serialized launch so it cannot resume the replacement branch.
    if (submission?.source === "human" && task.activeRunId !== requestedRunId)
      throw new Error("该问题所属运行已变更，请刷新任务。");
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
          if (current.binding !== snapshot.environment.binding)
            throw new MainRequestConflictError(
              "原请求的应用绑定已变化，已有内容仍保留。请恢复原绑定后重试，或发送新消息。"
            );
          try {
            assertMainRequestExecutionScope(snapshot.executionScope, current.executionScope!, {
              checkMcpTools: false
            });
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
    if ((await blockingHumanRequests(taskWorkspace, taskId)).length)
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
    const selection = resolveMainModel(roleRequest);
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
      await userMemory
        ?.enqueueForegroundLearning({
          taskId,
          runId,
          text:
            input.body ??
            (input.attachmentIds?.length || input.textAttachments?.length
              ? ""
              : (readQueuedUserTurn(prompt)?.text ?? prompt)),
          projectDirectory: task.projectDirectory
        })
        // eslint-disable-next-line no-restricted-syntax -- 前台学习是已接受运行的附带记忆信号，写入失败不应让这次启动失败
        .catch(() => {});
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
    const script = join(projectRoot, "scripts", "start-pi.mjs");
    const child = processes.start(
      taskId,
      process.execPath,
      [
        script,
        "--print",
        "--mode",
        "json",
        ...(versions?.sessionFile
          ? ["--session", versions.sessionFile]
          : continueSession
            ? ["--continue"]
            : ["--session-id", runId]),
        "--session-dir",
        join(taskWorkspace, taskId, "sessions", "main", "pi")
      ],
      {
        cwd: projectRoot,
        env: {
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
            tabStorePath,
            dashboardUrl,
            piAgentDir: process.env.PI_CODING_AGENT_DIR,
            projectRoot,
            selection,
            ...(input?.thinkingLevel
              ? { thinkingLevel: normalizeReasoningEffort(input.thinkingLevel, "thinkingLevel") }
              : {})
          }),
          COWORK_MAIN_CONTINUATION: continuation ? inputPath : "",
          // Admission is this process's budget decision; the launcher must not
          // ask for a second slot for the same Run.
          ...(admission.requestId ? { COWORK_MAIN_CAPACITY_GRANTED: admission.requestId } : {}),
          COWORK_MAIN_RETRY_REQUEST_ID: retryRequest?.requestId ?? "",
          COWORK_MAIN_RETRY_MODEL: retryRequest ? JSON.stringify(retryRequest.model) : ""
        },
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    admission.spawned = true;
    if (admission.requestId && mainCapacity && child.pid)
      await mainCapacity
        .bindProcess(admission.requestId, child.pid)
        .catch((error) =>
          console.error(
            `[cowork] external capacity process record failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
    activeRunIds.set(taskId, runId);
    interjectionTargets.set(taskId, { runId });
    child.stdin?.on("error", () => {
      /* child close/error settles the run */
    });
    child.stdin?.end(
      continuation
        ? MAIN_CONTINUATION_COMMAND
        : input?.source === "composer" && input.messageId
          ? queuedUserTurn({ taskId, runId, messageId: input.messageId, text: prompt })
          : prompt
    );
    const outputPath = join(taskWorkspace, taskId, "runs", runId, "runtime-output.log");
    const stderrPath = join(taskWorkspace, taskId, "runs", runId, "runtime-stderr.log");
    const runOutput = new MainRunOutput();
    let spawnError: Error | undefined;
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
    child.stdout?.on("data", (chunk: Buffer) => {
      runOutput.write(chunk);
      persistOutput(outputPath, chunk);
    });
    // A diagnostic can arrive between stdout fragments of one JSON event.
    // Preserve its original bytes without corrupting the model event stream.
    child.stderr?.on("data", (chunk) => persistOutput(stderrPath, chunk));
    child.once("error", (error) => {
      // close owns the single durable terminal event and Task transition.
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      const finalization = (async () => {
        await outputWrites;
        runOutput.finish();
        const settledTask = await location.store.readTask(taskId);
        if (cancellations.has(taskId) || settledTask.status === "cancelled") return;
        // A pause this backend already recorded has no second close to settle.
        if (settledTask.status === "paused") return;
        if (activeRunIds.get(taskId) !== runId || settledTask.activeRunId !== runId) return;
        // A launch failure or truncated stream can leave the persisted context
        // unchanged. Only this process's terminal event can complete/fail it;
        // previous successful or failed turns remain diagnostic history.
        const last = runOutput.message;
        const modelFailed = last?.role === "assistant" && last.stopReason === "error";
        const interrupted =
          last?.role === "assistant" && ["aborted", "length"].includes(last.stopReason ?? "");
        if (stopping) {
          if (await prepareRunTransition(location, runId, "waiting"))
            await location.store.transitionTask(taskId, "waiting", { runId, reason: "desktop_shutdown" });
          return;
        }
        const settlePause = async (request: NonNullable<TaskRecord["pause"]>) => {
          if (!(await prepareRunTransition(location, runId, "paused"))) return;
          // The status is the fact the next resume reads; the event only
          // explains it, so it is appended after the transition.
          await location.store.transitionTask(taskId, "paused", {
            runId,
            reason: "ui_pause"
          });
          await appendRunEvent(taskWorkspace, taskId, runId, "main.run_paused", {
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
        // Aborting at the step boundary surfaces through Pi as an aborted
        // operation. The durable pause request identifies it, while a model
        // error that happened to overlap a pause still shows its own failure.
        if (settledTask.pause && modelFailed && /abort/i.test(last.errorMessage ?? "")) {
          await settlePause(settledTask.pause);
          return;
        }
        if ((code === 0 || interrupted) && !modelFailed) {
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
            await appendRunEvent(taskWorkspace, taskId, runId, "main.run_waiting", {
              reason: "completion_check_failed",
              error: String(error)
            });
            await location.store.transitionTask(taskId, "waiting", {
              runId,
              reason: "completion_check_failed"
            });
            return;
          }
          let assessment = assessTaskCompletion({
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
          if (assessment.ready && (await parkBackgroundWatchGoal(taskWorkspace, taskId, runId)))
            assessment = { ready: false, reason: "parked_for_wake" };
          // A user pause owns this boundary only when the step did not finish
          // the Task. Completed work stays completed rather than becoming a
          // pause a person would have to resume.
          // A pause can arrive while completion checks were awaiting jobs or
          // delegations, so read the request again at the boundary we are
          // about to write. Completion still wins when the step finished it.
          const pauseNow = assessment.ready ? undefined : (await location.store.readTask(taskId)).pause;
          if (pauseNow) {
            await settlePause(pauseNow);
            return;
          }
          const current = await prepareRunTransition(
            location,
            runId,
            assessment.ready ? "completed" : "waiting"
          );
          if (!current) return;
          if (assessment.ready || (await readSleep(taskWorkspace, taskId)))
            await resetMainSupervisorBackoff(taskWorkspace, taskId);
          await appendRunEvent(
            taskWorkspace,
            taskId,
            runId,
            assessment.ready ? "main.run_completed" : "main.run_waiting",
            { code, signal, coordination, reason: assessment.reason }
          );
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
        } else {
          if (!(await prepareRunTransition(location, runId, "failed"))) return;
          const recover = await recoverWatchMain(
            taskWorkspace,
            taskId,
            runId,
            prompt === SUPERVISOR_WAKE_TURN
          );
          const { error, failure } = mainRunFailure(last, code, signal, spawnError);
          await appendRunEvent(taskWorkspace, taskId, runId, "main.run_failed", {
            error,
            code,
            signal,
            failure
          });
          try {
            await location.store.transitionTask(taskId, recover ? "waiting" : "failed", {
              runId,
              error,
              reason: recover ? "watch_main_retry" : "dashboard_main_exit"
            });
            // eslint-disable-next-line no-restricted-syntax -- 失败事件的原始错误已落盘，状态转换失败不能覆盖或中断收尾
          } catch {
            /* preserve original failure */
          }
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
          // eslint-disable-next-line no-restricted-syntax -- 进程已退出，记忆占用释放失败不能让 finalization 记录残留
          await userMemory?.taskForegroundIdle(taskId, memoryActivityId).catch(() => {});
          // Keep the request active until its durable completion state is saved.
          finalizations.delete(finalization);
          if (taskFinalizations.get(taskId) === finalization) taskFinalizations.delete(taskId);
          if (activeRuns.get(taskId) === child) {
            onRunExit(taskId);
            activeRuns.delete(taskId);
            interjectionTargets.delete(taskId);
          }
          if (activeRunIds.get(taskId) === runId) activeRunIds.delete(taskId);
          // The process is gone, so this Run no longer occupies an external
          // slot; the next waiting demand may start now.
          if (admission.requestId && mainCapacity)
            await mainCapacity
              .release(admission.requestId)
              .catch((error) =>
                console.error(
                  `[cowork] external capacity release failed: ${
                    error instanceof Error ? error.message : String(error)
                  }`
                )
              );
          // A quick reply can arrive while askhuman's process is still exiting.
          // Wait for its durable settlement before starting the resumed session.
          if (!stopping && humanWakeups.has(taskId)) void resumeHumanAnswers(taskId);
        });
      finalizations.add(finalization);
      taskFinalizations.set(taskId, finalization);
    });
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
    const activityId = randomUUID();
    const admission: MainLaunchAdmission = { spawned: false };
    // eslint-disable-next-line no-restricted-syntax -- 前台活动标记只是记忆提示，写入失败不应拒绝这次启动
    await userMemory?.taskForegroundActive(args[0], activityId).catch(() => {});
    try {
      return await launchMainRunWithActivity(
        activityId,
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
      // eslint-disable-next-line no-restricted-syntax -- 错误路径必须抛出原始启动失败，记忆占用释放失败不能替换它
      await userMemory?.taskForegroundIdle(args[0], activityId).catch(() => {});
      throw error;
    }
  }

  function startMainRun(...args: Parameters<typeof launchMainRun>) {
    return withTaskProjectLock(args[0], () => serialize(args[0], () => launchMainRun(...args)));
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
        if (activeRuns.has(taskId) || location.task.activeRunId !== request.runId)
          throw new MainMessageEditConflict("请先停止当前运行并等待停止完成，再修改重发。");
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
          if (rollback && !activeRuns.has(taskId)) {
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

  function interjectionTarget(taskId: string): InterjectionTarget | undefined {
    const child = activeRuns.get(taskId);
    if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) return;
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
      const child = activeRuns.get(taskId);
      // Keep the identity captured when the request entered the route. Reading
      // its body may span a stop or a whole new Run, which must not receive it.
      if (
        stopping ||
        !child ||
        child.killed ||
        child.exitCode !== null ||
        child.signalCode !== null ||
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
        const active = activeRuns.has(taskId);
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

  function withIdleProjectTasks<T>(taskIds: string[], action: () => Promise<T>): Promise<T> {
    const ids = [...new Set(taskIds)].sort();
    const lockTasks = (index: number): Promise<T> =>
      index < ids.length ? serialize(ids[index], () => lockTasks(index + 1)) : inspect();
    async function inspect() {
      for (const taskId of ids) {
        const location = await locateTask(taskId);
        if (
          activeRuns.has(taskId) ||
          taskFinalizations.has(taskId) ||
          ["running", "paused", "waiting"].includes(location.task.status) ||
          (await readSleep(location.workspaceRoot, taskId)) ||
          (await projectExecutionIsAlive(location.workspaceRoot, taskId))
        )
          throw new ProjectCatalogError("请先停止项目中的会话及后台工作，再更改项目文件夹", 409);
        const privateAgents = join(location.workspaceRoot, taskId, "agents", "subagents");
        // eslint-disable-next-line no-restricted-syntax -- 没有 subagents 目录表示该会话没有私有子代理，按空列表继续检查
        for (const agent of await readdir(privateAgents).catch(() => [])) {
          if (
            (await listJobs({ directory: join(privateAgents, agent, "logs", "jobs") })).some(
              (job) => job.state === "running"
            )
          )
            throw new ProjectCatalogError("请先停止项目中的后台命令，再更改项目文件夹", 409);
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
            throw new ProjectCatalogError("请先停止项目中的后台协作，再更改项目文件夹", 409);
          const agents = join(location.workspaceRoot, taskId, "runs", runId, "agents");
          // eslint-disable-next-line no-restricted-syntax -- 该 Run 可能从未启动子代理，subagents 目录缺失按空列表继续
          const subagents = await readdir(join(agents, "subagents")).catch(() => []);
          for (const agent of [
            join(agents, "main"),
            ...subagents.map((subagent) => join(agents, "subagents", subagent))
          ]) {
            if ((await listJobs({ directory: join(agent, "jobs") })).some((job) => job.state === "running"))
              throw new ProjectCatalogError("请先停止项目中的后台命令，再更改项目文件夹", 409);
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
      if (location.task.status !== "running" || !activeRuns.has(taskId) || !location.task.activeRunId)
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

  function cancelTask(taskId: string) {
    return serialize(taskId, async () => {
      cancellations.add(taskId);
      // eslint-disable-next-line no-restricted-syntax -- 取消要继续停止进程，容量队列清理失败由进程退出时的 release 承接
      await mainCapacity?.cancelTask(taskId).catch(() => {});
      humanWakeups.delete(taskId);
      try {
        const location = await locateTask(taskId);
        if (location.task.status === "completed") {
          const runId = activeRunIds.get(taskId);
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
        await attempt(async () => {
          const watches = new WatchProgramStore(location.workspaceRoot);
          for (const program of await watches.listPrograms(taskId)) {
            for (const monitor of await watches.listVirtualAgents(taskId, program.programId)) {
              if (monitor.status === "active")
                await watches.updateVirtualAgent(taskId, program.programId, monitor.monitorId, {
                  status: "paused"
                });
            }
          }
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
                coordinator.cancelSubagent({
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
        await attempt(() => processes.stopKey(taskId));
        await attempt(async () => taskFinalizations.get(taskId));
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
      const pending = await new HumanRequestStore(location.workspaceRoot).list(taskId, "pending");
      if (pending.length) {
        humanWakeups.delete(taskId);
        return { status: "waiting" };
      }
      const answers = await pendingHumanAnswers(location.workspaceRoot, taskId, runId);
      if (!answers.length) {
        humanWakeups.delete(taskId);
        return { status: "delivered" };
      }
      if (activeRuns.has(taskId)) {
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

  return {
    activeRuns,
    isBusy: () => activeRuns.size > 0 || taskOperations.size > 0 || finalizations.size > 0,
    startMainRun,
    pauseTask,
    editMainMessage,
    interjectionTarget,
    queueInterjection,
    queuedMessageAction,
    withIdleProjectTasks,
    cancelTask,
    cancellations,
    pendingHumanAnswers,
    resumeHumanAnswers,
    async stop() {
      stopping = true;
      // A startup may be between durable writes and spawn. Drain accepted task
      // operations before disabling ProcessHost so they can settle without a child.
      await Promise.allSettled([...taskOperations.values()]);
      await processes.stop();
      await Promise.all(finalizations);
    }
  };
}

export type RunService = ReturnType<typeof createDashboardRunService>;
