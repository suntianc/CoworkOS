import { resetMainSupervisorBackoff } from "../../dist/src/runtime/main-supervisor.js";
import { configuredWebTools } from "../../dist/src/runtime/web-search-config.js";
import { queuedUserTurn, readQueuedUserTurn } from "../../dist/src/runtime/queued-user-turn.js";
import {
  formatSkillsForPrompt,
  type BeforeAgentStartEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type Skill
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CoordinatorRuntime } from "../../dist/src/runtime/coordinator-runtime.js";
import { experimentDigest } from "../../dist/src/runtime/experiment-digest.js";
import { ExperimentProgramStore } from "../../dist/src/runtime/experiment-program-store.js";
import { HumanRequestStore } from "../../dist/src/runtime/human.js";
import {
  ensureMainContext,
  mainContextPaths,
  persistMainContext,
  readMainContextState,
  readMainMemory,
  updateMainContextRuntime
} from "../../dist/src/runtime/main-context.js";
import { HEARTBEAT_STALE_MS, writeHeartbeat } from "../../dist/src/runtime/main-heartbeat.js";
import { onProcessWake, startAgentWake, stopAgentWake } from "../../dist/src/runtime/agent-wake.js";
import { watchFiles, type StopWatching } from "../../dist/src/runtime/file-watch.js";
import { MainInboxDelivery, type MainControlType } from "../../dist/src/runtime/main-inbox-delivery.js";
import {
  MAIN_CONTINUATION_TYPE,
  isMainContinuationMessage,
  mainInputPath,
  readMainInput,
  registerMainContinuation,
  type MainInput
} from "../../dist/src/runtime/main-continuation.js";
import { readSleep } from "../../dist/src/runtime/main-sleep.js";
import type { PiThinkingLevel } from "../../dist/src/runtime/runtime-settings.js";
import {
  configuredMainMaxTokens,
  configuredContextWindow,
  configuredMainMaxTurns,
  configuredMainIdleTimeout,
  configuredMainTimeout,
  configuredModelApi,
  configuredThinkingFormat,
  configuredReasoningEffort,
  configuredSupportsReasoningEffort,
  configuredSupportsPromptCacheKey,
  configuredSupportsImages,
  configuredWorkspaceRoot,
  normalizeReasoningEffort,
  runtimeSettingsEnv
} from "../../dist/src/runtime/runtime-settings.js";
import { createCoworkModel } from "../../dist/src/runtime/model-profile.js";
import { MAIN_MODEL_FROM_CONFIG, resolveMainTurnModel } from "../../dist/src/runtime/main-turn-model.js";
import { recordModelRequests } from "../../dist/src/runtime/model-request-recording.js";
import { ModelRequestRecorder } from "../../dist/src/storage/model-request-recorder.js";
import {
  MainRequestStore,
  mainRequestPath,
  parseMainRequestModel
} from "../../dist/src/storage/main-request-store.js";
import { MainRequestRetry, mainRequestEnvironment } from "../../dist/src/runtime/main-request-retry.js";
import { projectAtriaSystemMessage } from "../../dist/src/domain/agent-identity.js";
import { InboxStore } from "../../dist/src/runtime/scheduler.js";
import { SubagentQuestionStore } from "../../dist/src/runtime/subagent-questions.js";
import { assessTaskCompletion, isFinalAssistantMessage } from "../../dist/src/runtime/task-completion.js";
import { JsonlEventStore } from "../../dist/src/storage/event-store.js";
import { listJobs } from "../../dist/src/tools/jobs.js";
import { DEFAULT_PROTECTED_PATHS, guessedProtection } from "../../dist/src/tools/protected-paths.js";
import { LocalWorkspaceStore } from "../../dist/src/workspace/workspace-store.js";
import { capabilityProvider } from "../../dist/src/runtime/capability-provider.js";
import { discoverSkills, skillRoots } from "../../dist/src/runtime/skill-registry.js";
import { attachmentCapabilityProvider } from "../../dist/src/workspace/attachment-capabilities.js";
import { mainCompactionPreviousSummary, withMainCompactionContext } from "./main-compaction.ts";
import { MainCompactionRetry } from "./main-compaction-retry.ts";
import { projectCompactionMessages } from "../../dist/src/runtime/compaction-input.js";
import type { RuntimeToolResult } from "./helpers.ts";
import { errorMessage, loadConfig, textFromMessage } from "./helpers.ts";
import { registerCoordinationTools } from "./tools/coordination.ts";
import { registerJobsTools } from "./tools/jobs.ts";
import { registerProjectLedgerTool } from "./tools/project-ledger.ts";
import { registerProjectDevelopmentTool } from "./tools/project-development.ts";
import { registerWorkspaceTools } from "./tools/workspace.ts";
import { registerComputerTools } from "./tools/computer-use.ts";
import { registerBrowserTools } from "./tools/browser-use.ts";
import { createCuaDispatcher } from "./tools/cua-dispatch.ts";
import { registerCuaScriptTools } from "./tools/cua-script.ts";
import { CORE_TOOLS, registerCapabilityTools } from "./tools/capabilities.ts";
import { createCliPresentation } from "./cli-ui.ts";
import { registerCliCommands } from "./cli-commands.ts";
import { recordCliSessionBinding } from "../../scripts/cli-session.mjs";
import { registerWebSearchTools } from "./tools/web-search.ts";
import { registerSearchTools } from "./tools/file-search.ts";
import { registerImageTools } from "./tools/images.ts";
import { registerSubagentAgent } from "./subagent-agent.ts";
import { blockedToolCall, taskProtectedPaths } from "./protected-call.ts";
import { registerCoworkProvider } from "./provider.ts";

/**
 * One extension entry for Main and delegated agent processes.
 *
 * A delegated process selects its role through the environment the backend
 * launched it with; it loads the same file, tools and lifecycle hooks rather
 * than a second extension that would drift from Main's.
 */
export default async function registerCoworkExtension(pi: ExtensionAPI) {
  const role = process.env.COWORK_AGENT_ROLE;
  if (role === "executor" || role === "reviewer") {
    registerSubagentAgent(pi, role);
    return;
  }
  return registerMainExtension(pi);
}

async function registerMainExtension(pi: ExtensionAPI) {
  const config = loadConfig();
  const runtimeEnv = runtimeSettingsEnv(config);
  const supportsImages = configuredSupportsImages(runtimeEnv);
  const supportsReasoningEffort = configuredSupportsReasoningEffort(runtimeEnv);
  const currentThinkingLevel = (): PiThinkingLevel =>
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 旧版 Pi 宿主不提供 getThinkingLevel，缺方法时回退到配置的推理强度
    normalizeReasoningEffort(pi.getThinkingLevel?.() ?? configuredReasoningEffort(runtimeEnv));
  const baseUrl = process.env.COWORK_API_BASE ?? config.baseUrl ?? config.apiBase;
  const apiKey = process.env.COWORK_API_KEY ?? config.apiKey;
  const modelId = process.env.COWORK_MODEL ?? config.model ?? "glm-5.3";
  const web = configuredWebTools(config);
  const workspaceRoot = configuredWorkspaceRoot(config);
  const taskId = process.env.COWORK_TASK_ID ?? config.taskId ?? `task-${randomUUID()}`;
  // A stable task id gives the Main Run a stable Inbox across Pi restarts.
  // Override either value when deliberately starting a fresh run.
  const mainRunId = process.env.COWORK_RUN_ID ?? `main-${taskId}`;
  const taskWorkspace = resolve(workspaceRoot, taskId);
  const projectDirectory = resolve(process.env.COWORK_PROJECT_DIR ?? process.cwd());
  const harnessRoot = process.env.COWORK_HARNESS_ROOT ?? process.cwd();
  const cliPresentation = createCliPresentation(pi, { harnessRoot, projectDirectory });
  const cliCommands = registerCliCommands(pi, {
    workspaceRoot,
    taskId,
    runId: mainRunId,
    projectDirectory,
    secrets: [
      process.env.COWORK_API_KEY,
      config.apiKey,
      process.env.COWORK_SERPER_API_KEY,
      process.env.SERPER_API_KEY,
      config.serperApiKey,
      web?.exaApiKey,
      ...(config.modelConnections?.profiles.map((profile) => profile.apiKey) ?? [])
    ].filter((value): value is string => Boolean(value))
  });
  let projectDefaultIdentity = true;
  const baseSkillRoots = skillRoots(harnessRoot, projectDirectory);
  /**
   * Skill roots for this turn.
   *
   * A Subagent does the same kind of work Main does, so it discovers the same
   * project and bundled skills rather than a narrower set.
   */
  let sdkSkills: Skill[] | undefined;
  const skillScopeNow = () => ({ skillRoots: baseSkillRoots });
  let currentSkillsSection: string | undefined;
  /**
   * Pi owns skill discovery once structured options are available; its selection
   * is authoritative even when empty. Older callers without options fall back to
   * discovering the project and bundled roots here.
   */
  const mainSkills = async (sdkSkillList: readonly Skill[] | undefined): Promise<Skill[]> => {
    if (sdkSkillList) return sdkSkillList.filter((skill) => !skill.disableModelInvocation);
    const discovered = await discoverSkills(baseSkillRoots);
    return discovered.map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.path,
      baseDir: skill.directory,
      sourceInfo: { path: skill.path, source: "atria", scope: "project", origin: "top-level" },
      disableModelInvocation: false
    }));
  };
  const skillsSection = (skills: Skill[]): string =>
    `<skills>\n${formatSkillsForPrompt(skills, "read").trim()}\n</skills>`;
  const capabilityProviders = capabilityProvider(
    new Map([["attachments", attachmentCapabilityProvider(harnessRoot)]])
  );
  const inboxDelivery = new MainInboxDelivery(workspaceRoot, taskId, mainRunId);
  // A resident Main serves many turns from one process. It is started in Pi's
  // long-lived interface, its Inbox wakes it, and it exits only when the
  // session is closed, when it has been idle long enough, or when a turn
  // cannot continue (a model request that failed).
  const resident = process.env.COWORK_MAIN_RESIDENT === "1";
  let agentStartedAt = 0;
  let sessionContext: ExtensionContext | undefined;
  let turnActive = false;
  // Until the process's first turn starts, the Inbox is read as one batch: the
  // queued messages are appended and exactly one of them opens the run, so a
  // callback queued before startup cannot open a second run beside the user's.
  let firstTurnStarted = false;
  // Unique per process lifetime: a backend that adopts this process sees the
  // id change at every new turn and knows the previous one is over.
  let turnId = `${process.pid}-0`;
  let turnCount = 0;
  pi.on("agent_start", () => {
    agentStartedAt = Date.now();
  });
  // Pi 1.5 enables prompt-cache warming by default. CoworkOS does not adopt the
  // capability in this upgrade, so every refresh stops until the next real
  // request instead of sending an extra model call while Main is idle.
  pi.on("cache_warming_decision", () => ({ action: "stop" }));
  let requestRetry: MainRequestRetry | undefined;
  let freshRetryContext = false;
  // A one-turn host already has a user prompt to start the turn, so startup
  // Inbox delivery must append to that context instead of racing it. A
  // resident Main has no such prompt: its Inbox is what starts the first turn.
  let awaitingInitialPrompt = process.env.COWORK_INITIAL_PROMPT === "1" && !resident;
  /**
   * Whether this process's first turn was accepted before a pause request.
   *
   * A pause stops new turns from starting, but it does not cancel the turn the
   * Run was already launched with: that turn ends at the next boundary, where
   * the pause becomes the Task's state. A message accepted while the Task was
   * paused is newer than the request and stays in the Inbox.
   */
  let startupTurnBeforePause = false;
  const startupTurnAcceptedBeforePause = async (): Promise<boolean> => {
    // eslint-disable-next-line no-restricted-syntax -- 任务读不到时按暂停生效处理：宁可让消息等下一次唤醒，也不越过暂停开始回合
    const task = await new LocalWorkspaceStore(workspaceRoot).readTask(taskId).catch(() => undefined);
    const requestedAt = Date.parse(task?.pause?.requestedAt ?? "");
    if (!task?.pause || !Number.isFinite(requestedAt)) return false;
    // eslint-disable-next-line no-restricted-syntax -- 输入记录缺失时无法证明这一轮早于暂停，按暂停生效处理
    const input = await readMainInput(mainInputPath(workspaceRoot, taskId, mainRunId)).catch(() => undefined);
    if (!input) return false;
    return input.submittedAt < requestedAt;
  };
  /**
   * Whether the Inbox already holds the message that starts this process's
   * first turn. Only a message the startup delivery will actually send counts:
   * a paused Main reads only commands, and follow-ups wait for a later turn.
   */
  const startupTurnPending = async (): Promise<boolean> => {
    const paused = !startupTurnBeforePause && (await pausedNow());
    for (const message of await inboxDelivery.pending()) {
      if (message.state !== "ready") continue;
      const payload = message.payload as { type?: string; delivery?: string; initial?: boolean } | undefined;
      if (paused) {
        if (payload?.type === "main.resume") return true;
        continue;
      }
      if (message.kind === "human_command" && payload?.type === "human.message")
        return payload.initial === true;
      return true;
    }
    return false;
  };
  const pausedNow = async (): Promise<boolean> =>
    new LocalWorkspaceStore(workspaceRoot)
      .readTask(taskId)
      .then((task) => Boolean(task.pause) || task.status === "paused")
      // eslint-disable-next-line no-restricted-syntax -- 任务记录读不到时按未暂停处理；真正的暂停检查在回合边界还会再读一次
      .catch(() => false);
  const deliverCallbacks = async (includeFollowUps = false) => {
    // While an exact replay is pending, ordinary work stays queued: the old
    // request is resent as it was, not mixed with what arrived since. The
    // resume command is what starts that replay, so it is still read.
    const replaying = requestRetry?.isReplaying === true;
    await inboxDelivery.deliver(
      async (message, options) => {
        if (options.userTurn) {
          // The first message of a Run is the person's own turn. The identity
          // marker lets the Inbox receipt be confirmed from saved context.
          pi.sendUserMessage(
            queuedUserTurn({
              taskId,
              runId: mainRunId,
              messageId: options.userTurn.messageId,
              text: message.content
            }),
            { deliverAs: options.deliverAs }
          );
          return;
        }
        // A person's insertion that arrives while a turn is running joins that
        // turn. If the turn has already ended, the person is still waiting for
        // an answer, so the message opens one — it is never appended silently.
        pi.sendMessage(message, awaitingInitialPrompt ? { ...options, triggerTurn: false } : options);
      },
      {
        includeFollowUps,
        paused: replaying || (!(startupTurnBeforePause && !firstTurnStarted) && (await pausedNow())),
        // An externally budgeted Run resumes a durable answer through the
        // backend, which first admits the turn it opens to that budget; a Run
        // outside the budget still opens the turn here as it always did.
        holdAnswers: process.env.COWORK_MAIN_CAPACITY_MANAGED === "1" && (sessionContext?.isIdle() ?? true),
        // Only the startup read before the first turn needs the batch: after
        // that, each message is steered into the turn already in flight.
        batchStart: !firstTurnStarted && (sessionContext?.isIdle() ?? true),
        onControl: (type) => handleMainControl(type)
      }
    );
  };
  const coordinator = new CoordinatorRuntime();
  const experimentStore = new ExperimentProgramStore(workspaceRoot);
  const humanStore = new HumanRequestStore(workspaceRoot);
  const questionStore = new SubagentQuestionStore(workspaceRoot);
  const mainMaxTurns = configuredMainMaxTurns(runtimeEnv);
  const mainTimeoutMs = configuredMainTimeout(runtimeEnv);
  let mainTurns = 0;
  let recentContext: unknown[] = [];
  let mainContext: ReturnType<typeof mainContextPaths> | undefined;
  const compactionRetry = new MainCompactionRetry();
  let pendingContextClear: { reason: string } | undefined;
  let inboxDeliveryActive = false;
  // Every wake counts, so one that arrives while a delivery pass is running
  // repeats that pass instead of being dropped.
  let inboxWakeCount = 0;
  let stopInboxWatch: StopWatching | undefined;
  /** Unsubscribe functions for this process's wake channel, one per session. */
  const wakeSubscriptions: Array<() => void> = [];
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleCheck: Promise<void> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let mainTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let lastMainMessage: unknown;
  let runtimeWrites = Promise.resolve();
  const updateRuntime = (patch: Parameters<typeof updateMainContextRuntime>[1]) => {
    runtimeWrites = runtimeWrites
      .then(async () => {
        await updateMainContextRuntime(mainContext ?? mainContextPaths(workspaceRoot, taskId), patch);
      })
      // eslint-disable-next-line no-restricted-syntax -- runtime 快照只是进度记录，写入失败不能中断串行链和当前 Turn
      .catch(() => {});
    return runtimeWrites;
  };
  /**
   * Open a ledger row for a delegation.
   *
   * The ledger is Runtime bookkeeping, not a subsystem Main operates: every
   * delegation is recorded, the previous row is taken as this one's parent, and
   * nothing here asks Main to declare or maintain anything. Rows that turn out
   * to carry metrics form a series on their own; the rest are plain history.
   *
   * Bookkeeping must never break delegation, so any failure here leaves the
   * call to proceed unrecorded.
   */
  const mainIdleTimeoutMs = configuredMainIdleTimeout(runtimeEnv);
  /**
   * Read the process-level commands a resident Main receives from its Inbox.
   *
   * They are not model input: they act on the local turn loop, so they are
   * consumed rather than appended to the conversation.
   */
  const handleMainControl = async (type: MainControlType): Promise<boolean> => {
    if (type === "main.interrupt") {
      // Interrupting stops the turn in flight and nothing else: the process,
      // the Task and the Subagents already running stay as they are.
      sessionContext?.abort();
      return true;
    }
    // Resume is a turn in the same session without a new message from the
    // person; the task record no longer says paused by the time this runs.
    pi.sendMessage(
      { customType: MAIN_CONTINUATION_TYPE, content: [], display: false },
      { triggerTurn: true }
    );
    return true;
  };

  const stopMainIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  /**
   * Restart the idle clock.
   *
   * The clock only runs between turns: a resident Main that is waiting for a
   * Subagent is working, and one that still has a turn in flight is not idle
   * even when no model request is on the wire at that instant.
   */
  const touchMainActivity = () => {
    stopMainIdleTimer();
    if (!resident || mainIdleTimeoutMs <= 0) return;
    idleTimer = setTimeout(() => void runIdleCheck(), mainIdleTimeoutMs);
    idleTimer.unref();
  };
  const runIdleCheck = (): Promise<void> => {
    idleCheck ??= (async () => {
      // Re-arm first: a check that finds work simply leaves the next one set.
      touchMainActivity();
      if (inboxDelivery.queuedCount) return;
      if (sessionContext?.hasPendingMessages()) return;
      const pending = await coordinator
        .waitForSubagents({ taskId, runId: mainRunId, workspaceRoot, timeoutMs: 0 })
        // eslint-disable-next-line no-restricted-syntax -- 协作者队列读不到时按仍有工作在跑处理，宁可多留一会儿也不丢失等待中的回调
        .catch(() => undefined);
      if (!pending || pending.pending.length || pending.callbackPending.length) return;
      const paused = await pausedNow();
      // Work that arrived during a pause stays durable for the next Main; a
      // paused Task is idle even while it has queued messages.
      if (!paused) {
        const ready = (await inboxDelivery.pending()).filter((message) => message.state !== "consumed");
        if (ready.length) return;
      }
      // The exit preserves state: the session file, the Task and its Inbox
      // stay on disk, and the next message or callback starts a Main again.
      await new LocalWorkspaceStore(workspaceRoot)
        .transitionTask(taskId, "waiting", { runId: mainRunId, reason: "main_idle_timeout" })
        // eslint-disable-next-line no-restricted-syntax -- 状态转换失败不改变退出决定，退出的 Run 仍会由运行服务按空闲结束结算
        .catch(() => {});
      sessionContext?.shutdown();
    })().finally(() => {
      idleCheck = undefined;
    });
    return idleCheck;
  };

  /**
   * Record a refused write to a protected path.
   *
   * An agent optimizing a score has a reason to reach for the scorer, so a
   * refusal is worth seeing after the fact and not only in the transcript the
   * model reads. Diagnostics must never interfere with the refusal itself.
   */
  const appendGuardEvent = async (path: string, pattern: string, toolName: string): Promise<void> => {
    try {
      await new JsonlEventStore(join(workspaceRoot, taskId, "runs", mainRunId, "run_events.jsonl")).append({
        eventId: `guard-${randomUUID()}`,
        type: "guard.write_refused",
        taskId,
        runId: mainRunId,
        agentId: "main",
        occurredAt: new Date().toISOString(),
        payload: { path, pattern, toolName }
      });
      // eslint-disable-next-line no-restricted-syntax -- 拒绝写入已经通过 tool_call 返回给模型，诊断事件写入失败只少了事后记录
    } catch {
      /* diagnostics only */
    }
  };
  // The guard covers Main as well as Subagents. Main is a participant in the
  // optimization loop, not its referee, so it must not edit evaluation code,
  // this harness or version-control metadata either.
  // Rebuilt per call rather than once at startup: a grant made mid-session —
  // the user answering which paths are the scorer — has to take effect on the
  // next write, not on the next process.
  const currentGuard = () => taskProtectedPaths(workspaceRoot, taskId, projectDirectory);

  // Main's own jobs, kept beside its Run rather than in the Subagent tree so
  // one Task's long commands stay separable from its delegations'.
  const jobsDirectory = join(taskWorkspace, "runs", mainRunId, "agents", "main", "jobs");
  const currentCapabilities = async () =>
    new LocalWorkspaceStore(workspaceRoot)
      .readTask(taskId)
      .then((task) => task.capabilities)
      // eslint-disable-next-line no-restricted-syntax -- 任务记录缺失时按没有能力授予处理，长任务工具因此保持禁用
      .catch(() => undefined);
  // Read per call for the same reason as the guard: a grant made mid-session
  // has to work on the next call, not the next process.
  const refuseWithoutLongRunning = async (tool: string): Promise<RuntimeToolResult | undefined> => {
    if ((await currentCapabilities())?.longRunning === true) return undefined;
    const payload = {
      ok: false,
      reason: "capability_required",
      note: `${tool} needs the longRunning capability. Ask the user with askhuman whether this work runs for minutes or hours, then record it with grant_capabilities. Short commands do not need it — use bash.`
    };
    return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload, isError: true };
  };
  // spawn reports a missing cwd as ENOENT on the shell itself, which reads as
  // "no /bin/sh" and sends the model looking in the wrong place. Main's work
  // directory may not exist yet on the first job of a fresh Task.
  const jobCwd = async () => {
    const directory =
      (await currentCapabilities())?.projectWrite === true
        ? projectDirectory
        : join(taskWorkspace, "agents", "main", "work");
    // eslint-disable-next-line no-restricted-syntax -- 创建 work 目录是尽力而为，失败时由 spawn 返回真实错误，不在这里中断工具调用
    await mkdir(directory, { recursive: true }).catch(() => {});
    return directory;
  };
  /**
   * Jobs whose exit Main has already been told about.
   *
   * A finished job is Main's cue to decide what comes next, so it arrives the
   * same way a Subagent's result does — through the Inbox, which wakes Main —
   * rather than being something Main has to remember to poll for. The set only
   * suppresses duplicate wakes within a process; the Inbox message id is what
   * makes the delivery itself idempotent across a restart.
   */
  const observedJobs = new Set<string>();
  const mainInbox = new InboxStore(
    join(taskWorkspace, "runs", mainRunId, "agents", "main", "inbox-store.json")
  );

  /** Count running jobs and queue a wake for any that finished since the last check. */
  const pollJobs = async (): Promise<number> => {
    // eslint-disable-next-line no-restricted-syntax -- 作业目录首次运行时还不存在，读取失败等价于当前没有作业
    const jobs = await listJobs({ directory: jobsDirectory }).catch(() => []);
    let running = 0;
    for (const job of jobs) {
      if (job.state === "running") {
        running += 1;
        observedJobs.add(job.jobId);
        continue;
      }
      if (!observedJobs.has(job.jobId)) continue;
      // Liveness comes from the pid, but the exit code is written by the
      // spawning process's exit handler, so a job reads as exited a tick
      // before its outcome lands. Waking Main with "finished, code unknown"
      // would report a success and a crash identically. An orphan carries a
      // note instead of a code and is reported as it is, since no later pass
      // will fill one in.
      if (job.exitCode === undefined && job.signal === undefined && !job.note) {
        running += 1;
        continue;
      }
      observedJobs.delete(job.jobId);
      await mainInbox
        .enqueue({
          messageId: `job-finished-${job.jobId}`,
          recipientAgentId: "main",
          kind: "external_event",
          eventId: `event-job-${job.jobId}`,
          // Below a Subagent question, above an ordinary callback: a finished job
          // is usually what Main's next decision depends on.
          priority: 10,
          state: "ready",
          payload: {
            type: "job.finished",
            jobId: job.jobId,
            command: job.command,
            exitCode: job.exitCode,
            signal: job.signal,
            elapsedMs: job.elapsedMs,
            logPath: job.logPath,
            tail: job.tail,
            ...(job.note ? { note: job.note } : {})
          },
          createdAt: new Date().toISOString()
        })
        // eslint-disable-next-line no-restricted-syntax -- 入队失败只丢失这次唤醒通知，作业与日志仍在磁盘上，轮询继续
        .catch(() => undefined);
    }
    return running;
  };

  pi.on("tool_call", async (event) => {
    const refused = blockedToolCall(event.toolName, event.input, await currentGuard(), projectDirectory);
    if (!refused) return undefined;
    void appendGuardEvent(refused.path, refused.pattern, event.toolName);
    return { block: true, reason: refused.reason };
  });

  const prepareMainTurnSections = async () => {
    // Real Pi assembles this hook before the per-request context hook, so tool
    // discovery must finish here to exist on the first model request.
    await capabilityTools.refresh();
    const workspace = [
      `用户选择的项目目录：${projectDirectory}。read/edit/write/bash 的相对路径从这里开始；用户说“这个项目”“工作文件夹”指的是这里。以它为准，不要因为运行了 CoworkOS 就改去它的安装目录。`,
      "会话可能切换过项目目录，历史消息中的旧路径不会自动改写；当前操作以本段目录为准，继续操作旧路径前先核对用户意图。",
      `本次任务工作区：${taskWorkspace}。browse_workspace 和 Subagent 的 outputFiles 的相对路径都从这里开始。`,
      `你的 work 目录：${join(taskWorkspace, "agents", "main", "work")}`,
      `任务的 artifacts 目录：${join(taskWorkspace, "artifacts")}`,
      `长期记忆文件：${join(taskWorkspace, "agents", "main", "context", "memory.md")}`,
      "对任务文件优先使用上面的绝对路径，避免 read/bash 与 browse_workspace 的相对路径混淆。"
    ].join("\n");
    // Keep SDK-owned tools and rules dynamic. Returning a forced prompt here
    // freezes snippets when enable_tools changes the active loadout mid-turn.
    return {
      current_workspace: `<current_workspace>\n${workspace}\n</current_workspace>`
    };
  };

  pi.on("before_agent_start", async (event) => {
    const sections = await prepareMainTurnSections();
    const options = event.systemPromptOptions;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- systemPromptOptions 在旧版 Pi 调用方可能缺失，缺省时按项目默认身份处理
    projectDefaultIdentity = !options?.customPrompt && options?.forceSystemPrompt === undefined;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 旧版 Pi 调用方可能只提供 event.systemPrompt，缺少该系统选项时走下面的回退分支
    if (options) {
      sdkSkills = options.skills;
      options.skills = await mainSkills(options.skills);
      currentSkillsSection = skillsSection(options.skills);
      Object.assign(options.sections, sections);
      return;
    }
    // Compatibility with older extension callers lacking structured options.
    return { systemPrompt: `${event.systemPrompt}\n${sections.current_workspace}` };
  });

  let continuationSections: Awaited<ReturnType<typeof prepareMainTurnSections>> | undefined;
  if (process.env.COWORK_MAIN_CONTINUATION) {
    registerMainContinuation(pi, async (ctx) => {
      continuationSections = await prepareMainTurnSections();
      await requestRetry?.restore();
      const options = ctx.getSystemPromptOptions();
      sdkSkills = options.skills ?? [];
      currentSkillsSection = skillsSection(await mainSkills(sdkSkills));
      projectDefaultIdentity = !options.customPrompt && options.forceSystemPrompt === undefined;
    });
  }
  pi.on("context_with_system", async (event, ctx) => {
    const sections = continuationSections;
    let messages = sections
      ? event.messages.map((message) =>
          message.role === "system" && message.sections
            ? { ...message, sections: { ...message.sections, ...sections } }
            : message
        )
      : event.messages;
    if (mainContext) {
      try {
        await runtimeWrites;
        const runtime = await readMainContextState(mainContext);
        messages = withMainCompactionContext(messages, {
          runtime,
          // Full history already carries pre-compaction work. Bring auxiliary
          // memory back only after a checkpoint has replaced that older history.
          memory: runtime.contextEpoch > 0 ? await readMainMemory(mainContext) : "",
          experimentDigest:
            runtime.contextEpoch > 0
              ? // eslint-disable-next-line no-restricted-syntax -- 实验摘要是可选上下文，读取失败时快照里只是不带这一段
                await experimentDigest(workspaceRoot, taskId).catch(() => undefined)
              : undefined
        });
      } catch (error) {
        ctx.ui.notify(`Main current context refresh failed: ${errorMessage(error)}`, "warning");
      }
    }
    const skillSection = currentSkillsSection;
    const scoped = messages.map((message) => {
      if (message.role !== "system") return message;
      const withSkills = skillSection
        ? { ...message, sections: { ...message.sections, skills: skillSection } }
        : message;
      return projectDefaultIdentity ? projectAtriaSystemMessage(withSkills) : withSkills;
    });
    return { messages: scoped };
  });

  // Keep a bounded copy of the user-facing Main transcript. It is passed to
  // Coordinator automatically, so Main only needs to provide `task`.
  pi.on("context", async (event, ctx) => {
    const messages = event.messages.filter((message) => !isMainContinuationMessage(message));
    recentContext = messages.slice(-8);
    const firstUser = messages.find((message) => message.role === "user");
    const goal = firstUser ? textFromMessage(firstUser).trim() : "";
    if (goal) {
      const store = new LocalWorkspaceStore(workspaceRoot);
      const task = await store.readTask(taskId);
      const normalizedGoal = task.goal?.trim() || goal.slice(0, 2_000);
      if (!task.goal?.trim()) await store.updateTask(taskId, { goal: normalizedGoal });
      updateRuntime({
        runtimeGoal: normalizedGoal,
        // The goal itself lives in `runtimeGoal` and in the user's message;
        // repeating it in the event line would show it twice in one request.
        runtimeLastEvent: { type: "user_goal_observed", summary: "goal recorded" }
      });
    }
    try {
      if (mainContext) await persistMainContext(mainContext, ctx.sessionManager.getBranch());
      if (!requestRetry?.isReplaying) {
        await inboxDelivery.acknowledge(messages);
        if (process.env.COWORK_MAIN_RETRY_REQUEST_ID) freshRetryContext = true;
      }
      await updateRuntime({ runtimePendingDelegations: inboxDelivery.queuedCount });
      // Refresh between model requests, including changes made during a turn.
      await capabilityTools.refresh();
      currentSkillsSection = skillsSection(await mainSkills(sdkSkills ?? []));
    } catch (error) {
      ctx.ui.notify(`Main context snapshot failed: ${errorMessage(error)}`, "warning");
    }
    return {
      messages: messages.map((message) => {
        const queued = message.role === "user" ? readQueuedUserTurn(message.content) : undefined;
        return queued ? { ...message, content: [{ type: "text" as const, text: queued.text }] } : message;
      })
    };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!mainContext) return;
    const skipped = compactionRetry.before(event, ctx.sessionManager.getSessionId(), ctx.model);
    if (skipped) return skipped;
    await runtimeWrites;
    await persistMainContext(mainContext, ctx.sessionManager.getBranch());
    // Pi passes this prepared object to its native compactor after the hook.
    // Keep the native auth/retry/abort path, history and split-turn summaries,
    // file tracking and safe recent tail. A memory template must never replace
    // those summaries, including when clear_context explicitly requests one.
    event.preparation.previousSummary = mainCompactionPreviousSummary(event.preparation.previousSummary);
    event.preparation.messagesToSummarize = projectCompactionMessages(event.preparation.messagesToSummarize);
    event.preparation.turnPrefixMessages = projectCompactionMessages(event.preparation.turnPrefixMessages);
  });

  pi.on("session_compact", async (event, ctx) => {
    // The native checkpoint is already committed, even if the auxiliary snapshot fails.
    compactionRetry.succeeded();
    if (!mainContext) return;
    try {
      const state = await readMainContextState(mainContext);
      await persistMainContext(mainContext, ctx.sessionManager.getBranch(), {
        contextEpoch: state.contextEpoch + 1,
        lastClearReason: pendingContextClear?.reason ?? `automatic:${event.reason}`,
        lastClearAt: new Date().toISOString()
      });
    } catch (error) {
      // Pi has already committed the compaction. A secondary snapshot failure
      // must not be reported as if the original context were still active.
      ctx.ui.notify(
        `Main compaction succeeded, but its context snapshot failed: ${errorMessage(error)}`,
        "warning"
      );
    } finally {
      pendingContextClear = undefined;
    }
  });

  pi.on("session_compact_failed", (event, ctx) => {
    if (compactionRetry.failed(event)) return;
    if (pendingContextClear) {
      ctx.ui.notify(
        "Main compaction did not complete; the original session history is preserved.",
        "warning"
      );
      pendingContextClear = undefined;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    try {
      sessionContext = ctx;
      // A model request that failed ends this process and the Run service
      // settles the Run as failed from the exit. Keep the turn record active
      // until that exit: reporting the turn over here would show an idle Main
      // while the Task is still running and about to be failed.
      const failedTurn = lastMainMessage as { role?: string; stopReason?: string } | undefined;
      turnActive = failedTurn?.role === "assistant" && failedTurn.stopReason === "error";
      touchMainActivity();
      if (mainContext) await persistMainContext(mainContext, ctx.sessionManager.getBranch());
      const replayOnly = Boolean(process.env.COWORK_MAIN_RETRY_REQUEST_ID) && !freshRetryContext;
      await inboxDelivery.settle(replayOnly ? [] : ctx.sessionManager.getEntries());
      try {
        const taskStore = new LocalWorkspaceStore(workspaceRoot);
        const task = await taskStore.readTask(taskId);
        // eslint-disable-next-line no-restricted-syntax -- sleep 记录缺失或损坏时按未 park 处理，settle 流程继续
        const parked = await readSleep(workspaceRoot, taskId).catch(() => undefined);
        if (
          isFinalAssistantMessage(lastMainMessage) ||
          (parked && Date.parse(parked.parkedAt) >= agentStartedAt)
        )
          await resetMainSupervisorBackoff(workspaceRoot, taskId);
        // A resident Main stays alive when a pause stops the turn: the pause
        // is recorded here, at the boundary it stopped at, and the process
        // waits with its Inbox untouched until the resume command arrives.
        // A resident Main's failed model request ends its process, and the Run
        // service settles that Run from the exit, so this boundary records
        // nothing. A one-turn host has no backend to project that exit: its
        // failed turn is still settled here, as it always was.
        if (
          resident &&
          lastMainMessage &&
          (lastMainMessage as { stopReason?: string }).stopReason === "error"
        )
          return;
        if (task.pause && task.status === "running") {
          // Record when the turn stopped before the Task reports itself paused:
          // a reader that sees `paused` must already find the boundary time.
          if (!task.pause.pausedAt)
            await taskStore.updateTask(taskId, {
              pause: { ...task.pause, pausedAt: new Date().toISOString() }
            });
          await taskStore.transitionTask(taskId, "paused", { runId: mainRunId, reason: "ui_pause" });
          // The Turn stopped at this boundary; the Run keeps the pause on
          // record even though a resident process stays alive for the resume.
          try {
            await new JsonlEventStore(
              join(workspaceRoot, taskId, "runs", mainRunId, "run_events.jsonl")
            ).append({
              eventId: `pause-${randomUUID()}`,
              type: "main.run_paused",
              taskId,
              runId: mainRunId,
              agentId: "main",
              occurredAt: new Date().toISOString(),
              payload: { reason: "ui_pause", requestedAt: task.pause.requestedAt }
            });
            // eslint-disable-next-line no-restricted-syntax -- 暂停已写入 Task；事件只是记录，写不进去不影响暂停
          } catch {
            /* the Task's pause is the durable fact */
          }
          await updateRuntime({
            runtimePhase: "waiting",
            runtimeLastEvent: { type: "main_turn_settled", summary: "paused" }
          });
        } else if (task.status === "running" && !task.pause) {
          const pending = await coordinator.waitForSubagents({
            taskId,
            runId: mainRunId,
            workspaceRoot,
            timeoutMs: 0
          });
          let assessment = assessTaskCompletion({
            pendingCalls: pending.pending.length,
            pendingJobs: await pollJobs(),
            pendingCallbacks: Math.max(inboxDelivery.queuedCount, pending.callbackPending.length),
            pendingHumanRequests: (await humanStore.list(taskId, "pending")).length,
            pendingSubagentQuestions: (await questionStore.list(taskId, "pending")).length,
            // eslint-disable-next-line no-restricted-syntax -- 没有 sleep 记录或记录损坏时按未 park 处理，完成判定走正常路径
            parkedForWake: Boolean(await readSleep(workspaceRoot, taskId).catch(() => undefined)),
            hasFinalAnswer: isFinalAssistantMessage(lastMainMessage) && !pendingContextClear
          });
          if (!assessment.ready) {
            await taskStore.transitionTask(taskId, "waiting", {
              runId: mainRunId,
              reason: assessment.reason,
              completion: {
                signal: isFinalAssistantMessage(lastMainMessage) ? "natural_stop" : "interrupted"
              }
            });
            await updateRuntime({
              runtimePhase: "waiting",
              runtimePendingDelegations: pending.pending.length + pending.callbackPending.length,
              runtimeLastEvent: { type: "main_turn_settled", summary: assessment.reason }
            });
          } else {
            const completed = await taskStore.transitionTask(taskId, "completed", {
              runId: mainRunId,
              reason: "main_turn_settled",
              completion: {
                signal: task.completion?.signal === "finish_task" ? "finish_task" : "natural_stop",
                verifiedAt: new Date().toISOString()
              }
            });
            await updateRuntime({
              runtimePhase: "completed",
              runtimePendingDelegations: 0,
              runtimeLastEvent: {
                type: "task_completed",
                summary: completed.completion?.summary ?? "Main turn completed"
              }
            });
          }
        }
      } catch (error) {
        ctx.ui.notify(`Task lifecycle update failed: ${errorMessage(error)}`, "warning");
      }
      if (!pendingContextClear) return;
      const reason = pendingContextClear.reason;
      // compact() schedules asynchronous work. Keep the settled hook alive
      // until it finishes so a print/worker host cannot dispose the session
      // while the native summarizer is still generating its checkpoint.
      await new Promise<void>((resolve) => {
        ctx.compact({
          customInstructions: `Create a continuation checkpoint from the actual conversation and supplemental persisted state. Preserve the user's current requirements, completed changes, verification, unresolved work and next action. Workspace memory is supplementary and may be stale. Reason: ${reason}`,
          onComplete: () => resolve(),
          // session_compact_failed reports the error with a current context.
          onError: () => resolve()
        });
      });
    } catch (error) {
      ctx.ui.notify(`Task settlement hook failed: ${errorMessage(error)}`, "warning");
    } finally {
      // The durable turn record is what the next turn state is read from. It is
      // written after the boundary's Task status, so a reader never sees the
      // Task settled while the record still says a turn is running; a paused
      // Task is reported idle by the backend's read of this same record.
      if (resident) {
        // eslint-disable-next-line no-restricted-syntax -- 心跳只是存活与回合提示，写入失败由下一次写入重写
        void writeMainHeartbeat().catch(() => {});
      }
    }
  });

  const writeMainHeartbeat = () => writeHeartbeat(workspaceRoot, taskId, mainRunId, { turnActive, turnId });
  pi.on("agent_start", async (_event, ctx) => {
    awaitingInitialPrompt = false;
    lastMainMessage = undefined;
    sessionContext = ctx;
    firstTurnStarted = true;
    turnActive = true;
    turnCount += 1;
    turnId = `${process.pid}-${turnCount}`;
    touchMainActivity();
    // Tell any supervisor, and a backend that adopted this process, that the
    // Task has a turn running right now. A one-turn process reports liveness
    // on the regular interval only; its turn flag is not what is read.
    if (resident) {
      // eslint-disable-next-line no-restricted-syntax -- 心跳只是存活与回合提示，写入失败由下一次写入重写
      void writeMainHeartbeat().catch(() => {});
    }
    if (mainTimeoutTimer) clearTimeout(mainTimeoutTimer);
    if (mainTimeoutMs > 0) {
      mainTimeoutTimer = setTimeout(() => {
        ctx.abort();
        ctx.ui.notify(
          `Main reached the ${mainTimeoutMs}ms wall-clock deadline; checkpoint and artifacts are resumable`,
          "warning"
        );
      }, mainTimeoutMs);
    }
    // A closed Task is not reopened by a message that arrived while it was
    // closing: a late Subagent callback must not turn a cancelled session back
    // into a running one. An explicit new run transitions it first.
    const taskStore = new LocalWorkspaceStore(workspaceRoot);
    const startedTask = await taskStore.readTask(taskId);
    if (startedTask.status !== "cancelled")
      await taskStore.transitionTask(taskId, "running", {
        runId: mainRunId,
        reason: "main_turn_started"
      });
    await updateRuntime({
      runtimePhase: "active",
      runtimeRouting: { strategy: "undecided", reason: "Main turn started" },
      runtimeLastEvent: { type: "main_turn_started" }
    });
  });
  pi.on("agent_end", async (event, ctx) => {
    try {
      sessionContext = ctx;
      const last = event.messages.findLast((message) => message.role === "assistant");
      lastMainMessage = last;
      if (resident && last?.stopReason === "error") {
        // A failed model request is not a resting state: the session cannot
        // continue past it, and the backend settles the Run (and frees the
        // retry slot) from this exit. A person's retry starts the archived
        // request again in a fresh process, as it always did. The record stays
        // active until that exit: the backend's failed settlement is the
        // boundary, so an idle record here would report a still-running Task
        // as having no turn.
        ctx.shutdown();
        return;
      }
      if (!last || ["error", "aborted", "length"].includes(last.stopReason) || pendingContextClear) return;
      // Pi awaits this hook before settling --print. Keep the Main session
      // alive for outstanding one-shot work and let queued callbacks trigger
      // another turn before a final answer is accepted.
      let waitingFor = "";
      while (!ctx.signal?.aborted && mainTurns < mainMaxTurns) {
        const task = await new LocalWorkspaceStore(workspaceRoot).readTask(taskId);
        if (
          ["cancelled", "failed", "paused"].includes(task.status) ||
          task.pause ||
          (await humanStore.list(taskId, "pending")).length
        )
          return;
        // Before delivery, so a job that just exited wakes Main on this pass
        // rather than waiting for the next one.
        const runningJobs = await pollJobs();
        await deliverCallbacks(true);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 旧版 Pi 宿主没有 hasPendingMessages，缺方法时只能依赖 Inbox 队列计数
        if (inboxDelivery.queuedCount || ctx.hasPendingMessages?.()) return;
        const pending = await coordinator.waitForSubagents({
          taskId,
          runId: mainRunId,
          workspaceRoot,
          timeoutMs: 0
        });
        if (runningJobs || pending.pending.length || pending.callbackPending.length) {
          const signature = JSON.stringify([runningJobs, pending.pending, pending.callbackPending]);
          if (signature !== waitingFor) {
            waitingFor = signature;
            updateRuntime({
              runtimePhase: "waiting",
              runtimePendingDelegations: pending.pending.length + pending.callbackPending.length
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        return;
      }
    } finally {
      if (mainTimeoutTimer) clearTimeout(mainTimeoutTimer);
      mainTimeoutTimer = undefined;
    }
  });
  pi.on("turn_end", async (event, ctx) => {
    // A user pause is read from the Task record at the boundary between two
    // steps: the current tool call and model reply have settled, so aborting
    // here starts no new tool call or model request. The Run's close path
    // records the pause only if this boundary did not complete the Task.
    const pausedTask = await new LocalWorkspaceStore(workspaceRoot).readTask(taskId);
    if (pausedTask.pause || pausedTask.status === "paused") {
      ctx.abort();
      return;
    }
    mainTurns += 1;
    if (mainTurns >= mainMaxTurns) {
      ctx.abort();
      ctx.ui.notify(`Main reached the ${mainMaxTurns}-turn session limit`, "warning");
    } else if (
      event.message.role === "assistant" &&
      !["error", "aborted"].includes(event.message.stopReason)
    ) {
      // Drain accepted user messages before Pi chooses its next model call.
      // Leave follow-ups durable and promotable until the current work ends.
      await deliverCallbacks(event.message.stopReason === "stop");
    }
  });
  /**
   * What this resident process sends with, as of its latest turn.
   *
   * A resident Main serves many turns. When the Dashboard resolved its
   * connection from this host's saved configuration it marks the launch, and
   * every later turn re-reads the connection, protocol, model and image
   * capability saved now; the launch values are only the first turn's.
   */
  let currentModel: ReturnType<typeof createCoworkModel> | undefined;
  let currentApiKey = apiKey;
  let currentCacheKey = configuredSupportsPromptCacheKey(runtimeEnv);
  let currentSupportsImages = supportsImages;
  let currentSupportsReasoningEffort = supportsReasoningEffort;
  let currentModelId = modelId;
  if (baseUrl && apiKey) {
    const model = process.env.COWORK_MAIN_RETRY_MODEL
      ? parseMainRequestModel(process.env.COWORK_MAIN_RETRY_MODEL)
      : createCoworkModel({
          baseUrl,
          api: configuredModelApi(runtimeEnv),
          thinkingFormat: configuredThinkingFormat(runtimeEnv),
          model: modelId,
          maxTokens: configuredMainMaxTokens(runtimeEnv),
          contextWindow: configuredContextWindow(runtimeEnv),
          supportsImages: configuredSupportsImages(runtimeEnv),
          supportsReasoningEffort
        });
    requestRetry = new MainRequestRetry(
      new MainRequestStore(mainRequestPath(workspaceRoot, taskId), taskId),
      mainRunId,
      () => mainRequestEnvironment(workspaceRoot, taskId, projectDirectory),
      process.env.COWORK_MAIN_RETRY_REQUEST_ID || undefined,
      (names) => capabilityTools.restoreSelection(names),
      async (deferredContext) => {
        try {
          await deliverCallbacks();
          if (deferredContext && !inboxDelivery.queuedCount)
            pi.sendMessage(
              { customType: MAIN_CONTINUATION_TYPE, content: [], display: false },
              { triggerTurn: true, deliverAs: "steer" }
            );
        } catch (error) {
          console.error(`[CoworkOS] Deferred callback delivery: ${errorMessage(error)}`);
        }
      }
    );
    const retry = requestRetry;
    const recorder = new ModelRequestRecorder(
      join(taskWorkspace, "sessions", "main", `${mainRunId}-requests.jsonl`),
      { taskId, runId: mainRunId, agentId: "main" },
      [apiKey, web?.serperApiKey, web?.exaApiKey].filter((secret): secret is string => Boolean(secret))
    );
    const publishModel = (
      next: ReturnType<typeof createCoworkModel>,
      key: string,
      supportsPromptCacheKey: boolean
    ) =>
      registerCoworkProvider(pi, {
        model: next,
        apiKey: key,
        sessionId: `atria:${taskId}:main`,
        supportsPromptCacheKey,
        wrap: (streams) => recordModelRequests(streams, recorder, retry)
      });
    publishModel(model, apiKey, currentCacheKey);
    currentModel = model;

    /**
     * Move the process onto the connection saved for the turn that is starting.
     *
     * The Inbox hands over a turn only after the previous one settled, so no
     * model request is on the wire here: the provider, the session model and
     * the thinking level can all change at this boundary. A launch pinned by
     * the environment is never marked, so it keeps its connection.
     */
    const adoptSavedTurnModel = async (event: BeforeAgentStartEvent) => {
      if (process.env[MAIN_MODEL_FROM_CONFIG] !== "1") return;
      // An exact retry resends the archived connection; changing it would
      // change the request the retry exists to prove.
      if (retry.isReplaying) return;
      const task = await new LocalWorkspaceStore(workspaceRoot).readTask(taskId);
      const saved = loadConfig();
      let input: MainInput | undefined;
      try {
        input = await readMainInput(mainInputPath(workspaceRoot, taskId, mainRunId));
      } catch (error) {
        // A record this turn cannot use only drops its optional level: the
        // saved connection's own level still applies to the turn.
        console.error(`[CoworkOS] Turn input record: ${errorMessage(error)}`);
      }
      const identity = event.messageType === "user" ? readQueuedUserTurn(event.prompt) : undefined;
      // An explicit level belongs to the message that opened this turn, never
      // to an older message the input file still names.
      const explicitLevel =
        identity && input?.messageId === identity.messageId ? input.thinkingLevel : undefined;
      const selection = resolveMainTurnModel(saved, {
        projectId: task.projectId,
        ...(explicitLevel ? { thinkingLevel: explicitLevel } : {})
      });
      if (!selection) return;
      const next = createCoworkModel({
        baseUrl: selection.baseUrl,
        ...(selection.connectionId ? { connectionId: selection.connectionId } : {}),
        api: selection.profile.api,
        thinkingFormat: selection.profile.thinkingFormat,
        model: selection.model,
        maxTokens: selection.profile.mainMaxTokens,
        contextWindow: selection.profile.contextWindow,
        supportsImages: selection.supportsImages,
        supportsReasoningEffort: selection.profile.supportsReasoningEffort
      });
      const cacheKey = selection.profile.supportsPromptCacheKey;
      const modelChanged =
        !currentModel ||
        currentModel.provider !== next.provider ||
        currentModel.id !== next.id ||
        currentModel.api !== next.api ||
        currentModel.baseUrl !== next.baseUrl ||
        currentModel.reasoning !== next.reasoning ||
        currentModel.maxTokens !== next.maxTokens ||
        currentModel.contextWindow !== next.contextWindow ||
        currentModel.input.join(",") !== next.input.join(",") ||
        JSON.stringify(currentModel.compat) !== JSON.stringify(next.compat);
      if (modelChanged || currentApiKey !== selection.apiKey || currentCacheKey !== cacheKey)
        publishModel(next, selection.apiKey, cacheKey);
      if (modelChanged && !(await pi.setModel(next)))
        throw new Error("保存的模型连接未通过 Pi 的认证，本回合仍沿用当前连接");
      if (pi.getThinkingLevel() !== selection.thinkingLevel) pi.setThinkingLevel(selection.thinkingLevel);
      const imagesChanged = currentSupportsImages !== selection.supportsImages;
      currentModel = next;
      currentApiKey = selection.apiKey;
      currentCacheKey = cacheKey;
      currentSupportsImages = selection.supportsImages;
      currentSupportsReasoningEffort = selection.profile.supportsReasoningEffort;
      currentModelId = selection.model;
      // Image-only tools follow the connection that now sends the turn.
      if (imagesChanged) await capabilityTools.refresh();
    };
    pi.on("before_agent_start", adoptSavedTurnModel);
  }

  const toolContext = {
    baseSkillRoots,
    capabilityProvider: capabilityProviders,
    refreshCapabilities: () => capabilityTools.refresh(),
    get apiKey() {
      return apiKey;
    },
    get baseUrl() {
      return baseUrl;
    },
    get coordinator() {
      return coordinator;
    },
    get currentThinkingLevel() {
      return currentThinkingLevel;
    },
    get cliDebugEnabled() {
      return cliPresentation.debug;
    },
    get deliverCallbacks() {
      return () => deliverCallbacks();
    },
    get experimentStore() {
      return experimentStore;
    },
    get harnessRoot() {
      return harnessRoot;
    },
    get humanStore() {
      return humanStore;
    },
    get inboxDelivery() {
      return inboxDelivery;
    },
    get jobCwd() {
      return jobCwd;
    },
    get jobsDirectory() {
      return jobsDirectory;
    },
    get mainRunId() {
      return mainRunId;
    },
    get modelId() {
      return currentModelId;
    },
    get observedJobs() {
      return observedJobs;
    },
    get pendingContextClear() {
      return pendingContextClear;
    },
    set pendingContextClear(value) {
      pendingContextClear = value;
    },
    get pollJobs() {
      return pollJobs;
    },
    get projectDirectory() {
      return projectDirectory;
    },
    get questionStore() {
      return questionStore;
    },
    get recentContext() {
      return recentContext;
    },
    set recentContext(value) {
      recentContext = value;
    },
    get refuseWithoutLongRunning() {
      return refuseWithoutLongRunning;
    },
    get runtimeEnv() {
      return runtimeEnv;
    },
    get skillScopeNow() {
      return skillScopeNow;
    },
    get supportsReasoningEffort() {
      return currentSupportsReasoningEffort;
    },
    get supportsImages() {
      return currentSupportsImages;
    },
    get taskId() {
      return taskId;
    },
    get taskWorkspace() {
      return taskWorkspace;
    },
    get updateRuntime() {
      return updateRuntime;
    },
    get web() {
      return web;
    },
    get workspaceRoot() {
      return workspaceRoot;
    }
  };
  registerCoordinationTools(pi, toolContext);
  registerJobsTools(pi, toolContext);
  registerProjectLedgerTool(pi, toolContext);
  registerProjectDevelopmentTool(pi, toolContext);
  registerWorkspaceTools(pi, toolContext);
  const cuaBridge = createCuaDispatcher(pi);
  registerImageTools(cuaBridge.capturePi, toolContext);
  registerSearchTools(pi, projectDirectory);
  registerWebSearchTools(pi, web);
  registerComputerTools(cuaBridge.capturePi, taskId, taskWorkspace);
  const browserTools = registerBrowserTools(cuaBridge.capturePi, toolContext);
  const cuaScripts = registerCuaScriptTools(cuaBridge.capturePi, cuaBridge.dispatch);
  pi.on("session_shutdown", async () => {
    stopInboxWatch?.();
    stopInboxWatch = undefined;
    for (const unsubscribe of wakeSubscriptions.splice(0)) unsubscribe();
    await stopAgentWake();
    stopMainIdleTimer();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    // A message handed to Pi but never read before this process ends becomes
    // readable for the next Main now, not after the lease expires.
    // eslint-disable-next-line no-restricted-syntax -- 进程正在退出；未能交回的消息仍会在租约到期后可读
    await inboxDelivery.releaseUnconfirmed().catch(() => {});
    await cuaScripts.dispose();
    await browserTools.dispose();
  });
  const capabilityTools = registerCapabilityTools(pi, {
    workspaceRoot,
    taskId,
    mainRunId,
    // Read per refresh: a resident Main can move to a text-only connection
    // between turns, and image-only tools go with the model that can see.
    get supportsImages() {
      return currentSupportsImages;
    }
  });
  pi.registerCommand("cowork-status", {
    description: "Show Cowork workspace and active Coordinator jobs",
    handler: async (_args, ctx) =>
      ctx.ui.notify(
        `workspace=${workspaceRoot}; task=${taskId}; mainTurns=${mainTurns}/${mainMaxTurns}`,
        "info"
      )
  });

  pi.registerCommand("cowork-tools", {
    description: "Show Cowork tools currently visible to Main",
    handler: async (_args, ctx) => ctx.ui.notify(`active tools: ${pi.getActiveTools().join(", ")}`, "info")
  });

  pi.on("session_start", async (event, ctx) => {
    sessionContext = ctx;
    if (event.reason !== "startup") {
      await cuaScripts.reset();
      await browserTools.closeAll();
    }
    cliPresentation.configure(ctx);
    cliCommands.configure(ctx);
    // Direct `pi -e cowork.ts` launches need the same defaults as npm start.
    // Pi has already applied --thinking before session_start; preserve it,
    // and preserve interactive changes when an extension is reloaded/forked.
    const cliArgs = process.argv.slice(2);
    const endOfOptions = cliArgs.indexOf("--");
    const startupArgs = endOfOptions < 0 ? cliArgs : cliArgs.slice(0, endOfOptions);
    if (event.reason !== "reload" && event.reason !== "fork" && !startupArgs.includes("--thinking")) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 旧版 Pi 宿主不提供 setThinkingLevel，缺方法时保留宿主已有的 thinking 级别
      pi.setThinkingLevel?.(configuredReasoningEffort(runtimeEnv));
    }
    if (!baseUrl || !apiKey)
      ctx.ui.notify("CoworkOS 模型未配置：请运行 coworkos init，或设置模型环境变量。", "warning");
    else {
      const activeTools = pi.getActiveTools();
      const requiredTools = [...CORE_TOOLS, "find", "grep"];
      const missingTools = requiredTools.filter((name) => !activeTools.includes(name));
      if (missingTools.length > 0) pi.setActiveTools([...activeTools, ...missingTools]);
      const taskStore = new LocalWorkspaceStore(workspaceRoot);
      await taskStore.createTask(taskId, { projectDirectory });
      // Old CLI Tasks stored their CWD only in the native session binding.
      // Persist it before the Dashboard can adopt this history as a project.
      if (!(await taskStore.readTask(taskId)).projectDirectory) {
        await taskStore.updateTask(taskId, { projectDirectory });
      }
      await taskStore.createRun(taskId, mainRunId);
      if (process.env.COWORK_CLI_SESSION === "1") {
        const binding = await recordCliSessionBinding({
          sessionManager: ctx.sessionManager,
          workspaceRoot,
          taskId,
          projectDirectory,
          appendEntry: (type, data) => pi.appendEntry(type, data),
          allowOverride: event.reason === "startup" && process.env.COWORK_CLI_TASK_EXPLICIT === "1"
        });
        if (binding.status === "conflict") {
          ctx.ui.notify(
            "当前会话与任务不匹配。请退出后使用 coworkos --continue 或 coworkos --session <ID|path> 恢复。",
            "error"
          );
          ctx.shutdown();
          return;
        }
      }
      await capabilityTools.refresh();
      mainContext = mainContextPaths(workspaceRoot, taskId);
      await ensureMainContext(mainContext);
      if (!requestRetry?.isReplaying) await inboxDelivery.acknowledge(ctx.sessionManager.getEntries());
      // A pause that arrived after this Run's first turn was accepted stops the
      // next turn, not the accepted one. Decide that before any delivery: the
      // record of the accepted input is older than the pause request, while
      // work that arrived while paused is newer and stays queued.
      if (resident && !firstTurnStarted) startupTurnBeforePause = await startupTurnAcceptedBeforePause();
      const pollMainInbox = async (): Promise<void> => {
        inboxWakeCount += 1;
        // The running pass may have read the Inbox before this wake's write,
        // so it repeats once it is done rather than dropping the wake.
        if (inboxDeliveryActive) return;
        inboxDeliveryActive = true;
        try {
          for (;;) {
            const observed = inboxWakeCount;
            await deliverCallbacks();
            if (inboxWakeCount === observed) return;
          }
        } finally {
          inboxDeliveryActive = false;
        }
      };
      // A backend, a Subagent or a peer writes this Inbox and then nudges the
      // process that owns it. That nudge is what an OS directory event the host
      // reports late, coalesces or never delivers cannot take away; the watch
      // below stays as the second, best-effort wake.
      // The channel is bound once per process; each session only re-subscribes,
      // because a second listener on one endpoint would unlink the first.
      await startAgentWake().catch((error: unknown) =>
        ctx.ui.notify(`Main Inbox wake channel failed: ${errorMessage(error)}`, "warning")
      );
      for (const unsubscribe of wakeSubscriptions.splice(0)) unsubscribe();
      wakeSubscriptions.push(
        onProcessWake(() => {
          // eslint-disable-next-line no-restricted-syntax -- Pi 可能在子任务结束前销毁 Main，发送失败会释放 Inbox 租约并由下一次启动重新投递
          void pollMainInbox().catch(() => {
            // The next wake re-reads the same durable Inbox.
          });
          touchMainActivity();
        })
      );
      // The launch queued the turn that starts this process. Record it before
      // delivering, so a backend that reads the durable turn record between
      // process start and the first agent_start does not see an idle Main while
      // its first turn is already on its way.
      if (resident && !firstTurnStarted) {
        turnActive = await startupTurnPending();
        // eslint-disable-next-line no-restricted-syntax -- 心跳只是存活与回合提示，写入失败由下一次写入重写
        void writeMainHeartbeat().catch(() => {});
      }
      await pollMainInbox();
      // External events and callbacks are written to Main's Inbox by other
      // services. The writer's own notification is what reaches this process
      // while it is idle; the directory watch beside it is the fallback for a
      // queue the OS reports late or coalesces. Neither stdin nor polling is
      // involved, and if Main is offline the same messages stay durable for the
      // next startup.
      stopInboxWatch?.();
      stopInboxWatch = await watchFiles([inboxDelivery.inboxPath], () => {
        // eslint-disable-next-line no-restricted-syntax -- Pi 可能在子任务结束前销毁 Main，发送失败会释放 Inbox 租约并由下一次启动重新投递
        void pollMainInbox().catch(() => {
          // Pi can dispose Main before its children finish. Failed sends
          // release their leases; the next Main recovers the durable Inbox.
        });
        touchMainActivity();
      }).catch((error: unknown) => {
        // A watch that cannot attach leaves the durable Inbox for the next
        // process; turn boundaries still deliver what is already queued.
        ctx.ui.notify(`Main Inbox watch failed: ${errorMessage(error)}`, "warning");
        return undefined;
      });
      // Tell any supervisor that this Task already has a Main. Without this a
      // supervisor would read "no Main" while one is running and start a
      // second, putting two agents on the same project. The turn flag was
      // written above, before the delivery; it is not rewritten here because
      // Pi may already have started the turn and this write would be older.
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(
        // eslint-disable-next-line no-restricted-syntax -- 定时心跳写入失败时下一次 tick 会重写心跳文件，单次失败不影响 interval 本身
        () => void writeMainHeartbeat().catch(() => {}),
        Math.max(1_000, Math.floor(HEARTBEAT_STALE_MS / 3))
      );
      heartbeatTimer.unref();
      touchMainActivity();
      if (
        !cliPresentation.startup(ctx, {
          workspaceRoot,
          taskId,
          mainRunId,
          modelId,
          tools: pi.getActiveTools(),
          guessedProtection: guessedProtection(),
          protectedPaths: DEFAULT_PROTECTED_PATHS
        })
      ) {
        ctx.ui.notify(
          `CoworkOS loaded · workspace ${workspaceRoot} · task ${taskId} · tools ${requiredTools.join(", ")}`,
          "info"
        );
        if (guessedProtection())
          ctx.ui.notify(
            `Agents can edit ${projectDirectory}. Evaluation paths are only guessed (${DEFAULT_PROTECTED_PATHS.join(", ")}); a layout like scripts/evaluate.py or src/eval/ is currently writable. Set COWORK_EVAL_PATHS to protect them.`,
            "warning"
          );
      }
    }
  });
  if (process.env.COWORK_CLI_SESSION === "1") {
    const refuseSessionSwitch = async (_event: unknown, ctx: ExtensionContext) => {
      ctx.ui.notify("请先退出当前会话，再运行 coworkos 新建，或 coworkos --session <ID|path> 恢复。", "info");
      return { cancel: true };
    };
    pi.on("session_before_switch", refuseSessionSwitch);
    pi.on("session_before_fork", refuseSessionSwitch);
  }
  return toolContext;
}

export type CoworkToolContext = Awaited<ReturnType<typeof registerMainExtension>>;
