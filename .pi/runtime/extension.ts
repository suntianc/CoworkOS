import { resetMainSupervisorBackoff, SUPERVISOR_WAKE_TURN } from "../../dist/src/runtime/main-supervisor.js";
import { configuredWebTools } from "../../dist/src/runtime/web-search-config.js";
import { readQueuedUserTurn } from "../../dist/src/runtime/queued-user-turn.js";
import type { ExtensionAPI, ExtensionContext, SessionEntry, Skill } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
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
import { MainInboxDelivery } from "../../dist/src/runtime/main-inbox-delivery.js";
import {
  MAIN_CONTINUATION_TYPE,
  MAIN_CONTINUATION_COMMAND,
  mainInputPath,
  readMainInput,
  isMainContinuationMessage,
  registerMainContinuation
} from "../../dist/src/runtime/main-continuation.js";
import { readSleep } from "../../dist/src/runtime/main-sleep.js";
import {
  readGoalDelegationRequest,
  restoreGoalDelegationRequest,
  syncGoalDelegationRequest
} from "../../dist/src/runtime/goal-delegation-request.js";
import { parkBackgroundWatchGoal } from "../../dist/src/runtime/watch-main-lifecycle.js";
import type { PiThinkingLevel } from "../../dist/src/runtime/runtime-settings.js";
import {
  configuredMainMaxTokens,
  configuredContextWindow,
  configuredMainMaxTurns,
  configuredMainTimeout,
  configuredModelApi,
  configuredThinkingFormat,
  configuredReasoningEffort,
  configuredSubagentMaxQuestions,
  configuredSubagentMaxTokens,
  configuredSubagentMaxTurns,
  configuredSubagentQuestionTimeout,
  configuredSubagentTimeout,
  configuredSupportsReasoningEffort,
  configuredSupportsPromptCacheKey,
  configuredSupportsImages,
  configuredWorkspaceRoot,
  normalizeReasoningEffort,
  runtimeSettingsEnv
} from "../../dist/src/runtime/runtime-settings.js";
import { createCoworkModel } from "../../dist/src/runtime/model-profile.js";
import { createModelStreams } from "../../dist/src/runtime/model-provider.js";
import { guardCompactionSummaries } from "../../dist/src/runtime/compaction-summary-guard.js";
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
import { VirtualAgentStore } from "../../dist/src/runtime/virtual-agent-store.js";
import { WatchProgramStore } from "../../dist/src/runtime/watch-program-store.js";
import { monitoringPrograms, backgroundMonitoringPaused } from "../../dist/src/runtime/monitoring-control.js";
import { JsonlEventStore } from "../../dist/src/storage/event-store.js";
import { listJobs } from "../../dist/src/tools/jobs.js";
import {
  atriaInstallRoot,
  configuredProtectedPaths,
  DEFAULT_PROTECTED_PATHS,
  guessedProtection
} from "../../dist/src/tools/protected-paths.js";
import { LocalWorkspaceStore } from "../../dist/src/workspace/workspace-store.js";
import { createApplicationBridge } from "./application-bridge.ts";
import { mainCompactionPreviousSummary, withMainCompactionContext } from "./main-compaction.ts";
import { MainCompactionRetry } from "./main-compaction-retry.ts";
import { projectCompactionMessages } from "../../dist/src/runtime/compaction-input.js";
import {
  mainApplicationSkillScope,
  mainApplicationSkills,
  mainApplicationSkillsSection
} from "./application-skills.ts";
import type { RuntimeToolResult } from "./helpers.ts";
import { errorMessage, loadConfig, textFromMessage } from "./helpers.ts";
import { registerCoordinationTools } from "./tools/coordination.ts";
import { registerJobsTools } from "./tools/jobs.ts";
import { registerMonitorsTools } from "./tools/monitors.ts";
import { registerGoalTools } from "./tools/goals.ts";
import { registerProjectLedgerTool } from "./tools/project-ledger.ts";
import { goalContext } from "../../dist/src/runtime/goal-context.js";
import { registerWorkspaceTools } from "./tools/workspace.ts";
import { registerUserMemoryTool } from "./tools/user-memory.ts";
import { UserMemoryStore, userMemoryContext } from "../../dist/src/runtime/user-memory-store.js";
import {
  userMemoryWithinContextBudget,
  optionalContextSectionWithinBudget
} from "../../dist/src/runtime/user-memory-context.js";
import {
  ProjectExperienceStore,
  projectExperienceIdentity
} from "../../dist/src/runtime/project-experience-store.js";
import { createProjectExperienceEvidenceRecorder } from "../../dist/src/runtime/project-experience-evidence.js";
import {
  projectExperienceContext,
  projectExperienceSkillCatalog
} from "../../dist/src/runtime/project-experience-context.js";
import {
  createProjectExperienceLearningService,
  enqueueProjectExperienceRun
} from "../../dist/src/runtime/project-experience-learning.js";
import { createUserMemoryLearningService } from "../../dist/src/runtime/user-memory-learning.js";
import { registerComputerTools } from "./tools/computer-use.ts";
import { businessCommandEnvironment } from "../../dist/src/runtime/command-environment.js";
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
import { visionModelConfig } from "../../dist/src/runtime/vision-config.js";

export default async function registerCoworkExtension(pi: ExtensionAPI) {
  const config = loadConfig();
  const runtimeEnv = runtimeSettingsEnv(config);
  const visionModel = visionModelConfig(config);
  const supportsReasoningEffort = configuredSupportsReasoningEffort(runtimeEnv);
  const currentThinkingLevel = (): PiThinkingLevel =>
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
      visionModel?.apiKey,
      config.apiKey,
      process.env.COWORK_SERPER_API_KEY,
      process.env.SERPER_API_KEY,
      config.serperApiKey,
      web?.exaApiKey,
      ...(config.modelConnections?.profiles.map((profile) => profile.apiKey) ?? [])
    ].filter((value): value is string => Boolean(value))
  });
  let projectDefaultIdentity = true;
  const baseSkillRoots = [
    ...new Set([join(harnessRoot, ".pi", "skills"), join(projectDirectory, ".pi", "skills")])
  ];
  /**
   * Skill roots for this turn, including the bound application's own.
   *
   * A Subagent asked to work on a CAD drawing needs the same domain knowledge
   * Main has, so the binding widens what gets discovered rather than only
   * affecting Main's prompt.
   */
  let sdkSkills: Skill[] | undefined;
  let learnedSkillPaths: string[] = [];
  const seenLearnedPaths = new Set<string>();
  const projectStoreNow = async () => {
    const task = await new LocalWorkspaceStore(workspaceRoot).readTask(taskId);
    const identity = projectExperienceIdentity(task, projectDirectory);
    return identity ? new ProjectExperienceStore(identity) : undefined;
  };
  let projectEvidenceRecorder: ReturnType<typeof createProjectExperienceEvidenceRecorder> | undefined;
  let projectRecordedUserText = "";
  const refreshLearnedSkills = async () => {
    learnedSkillPaths = [];
    try {
      const store = await projectStoreNow();
      if (store) learnedSkillPaths = (await store.readProfile()).skills.map((skill) => skill.path);
      for (const path of learnedSkillPaths) seenLearnedPaths.add(path);
    } catch {
      /* Optional project knowledge fails closed. */
    }
  };
  const skillScopeNow = () => {
    const scope = mainApplicationSkillScope(
      baseSkillRoots,
      applicationBridge.boundApplication,
      harnessRoot,
      sdkSkills?.filter((skill) => !seenLearnedPaths.has(skill.filePath))
    );
    return { ...scope, skillRoots: [...scope.skillRoots, ...learnedSkillPaths] };
  };
  let currentSkillsSection: string | undefined;
  const inboxDelivery = new MainInboxDelivery(workspaceRoot, taskId, mainRunId);
  let agentStartedAt = 0;
  pi.on("agent_start", () => {
    agentStartedAt = Date.now();
  });
  let requestRetry: MainRequestRetry | undefined;
  let goalDelegationBranch: readonly SessionEntry[] = [];
  let freshRetryContext = false;
  let awaitingInitialPrompt = process.env.COWORK_INITIAL_PROMPT === "1";
  // Dashboard's --print invocation already has a user prompt to start the
  // turn. Startup Inbox delivery must append to that context, not race it
  // with a second model turn before Pi has even attached its event stream.
  const deliverCallbacks = (includeFollowUps = false) =>
    requestRetry?.isReplaying
      ? Promise.resolve()
      : inboxDelivery.deliver(
          (message, options) =>
            pi.sendMessage(message, awaitingInitialPrompt ? { ...options, triggerTurn: false } : options),
          { includeFollowUps }
        );
  const coordinator = new CoordinatorRuntime();
  const watchStore = new WatchProgramStore(workspaceRoot);
  const experimentStore = new ExperimentProgramStore(workspaceRoot);
  const virtualAgentStore = new VirtualAgentStore(workspaceRoot);
  const humanStore = new HumanRequestStore(workspaceRoot);
  const questionStore = new SubagentQuestionStore(workspaceRoot);
  const mainMaxTurns = configuredMainMaxTurns(runtimeEnv);
  const mainTimeoutMs = configuredMainTimeout(runtimeEnv);
  let mainTurns = 0;
  let active = 0;
  let recentContext: unknown[] = [];
  let userMemoryRequest = "";
  let userMemoryLearningRequest = "";
  const userMemoryStore = new UserMemoryStore();
  let memoryTurnActive = false;
  const memoryLearning =
    !process.env.COWORK_DASHBOARD_URL && baseUrl && apiKey
      ? createUserMemoryLearningService({
          store: userMemoryStore,
          connection: () => ({
            baseUrl,
            apiKey,
            model: modelId,
            api: configuredModelApi(runtimeEnv),
            thinkingFormat: configuredThinkingFormat(runtimeEnv),
            thinkingLevel: currentThinkingLevel(),
            supportsReasoningEffort,
            maxTokens: configuredMainMaxTokens(runtimeEnv),
            contextWindow: configuredContextWindow(runtimeEnv)
          }),
          isTaskActive: (id) => id === taskId && memoryTurnActive,
          isForegroundActive: () => memoryTurnActive
        })
      : undefined;
  const projectLearning =
    !process.env.COWORK_DASHBOARD_URL && baseUrl && apiKey
      ? createProjectExperienceLearningService({
          stores: async () => {
            const store = await projectStoreNow();
            return store ? [store] : [];
          },
          userMemoryStore,
          connection: () => ({
            baseUrl,
            apiKey,
            model: modelId,
            api: configuredModelApi(runtimeEnv),
            thinkingFormat: configuredThinkingFormat(runtimeEnv),
            supportsReasoningEffort,
            maxTokens: configuredMainMaxTokens(runtimeEnv),
            contextWindow: configuredContextWindow(runtimeEnv)
          }),
          isTaskActive: (id) => id === taskId && memoryTurnActive,
          isForegroundActive: () => memoryTurnActive
        })
      : undefined;
  pi.on("session_shutdown", async () => {
    await memoryLearning?.stop();
    await projectLearning?.stop();
    await userMemoryStore.taskForegroundIdle(taskId, mainRunId).catch(() => {});
  });
  let mainContext: ReturnType<typeof mainContextPaths> | undefined;
  const compactionRetry = new MainCompactionRetry();
  let pendingContextClear: { reason: string } | undefined;
  let inboxDeliveryActive = false;
  let recoveryActive = false;
  let inboxPoller: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let mainTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let lastMainMessage: unknown;
  let runtimeWrites = Promise.resolve();
  const updateRuntime = (patch: Parameters<typeof updateMainContextRuntime>[1]) => {
    runtimeWrites = runtimeWrites
      .then(async () => {
        await updateMainContextRuntime(mainContext ?? mainContextPaths(workspaceRoot, taskId), patch);
      })
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
  const openExperimentRun = async (input: { callId: string; agentId: string; objective: string }) => {
    try {
      return await experimentStore.openRun({
        taskId,
        callId: input.callId,
        agentId: input.agentId,
        objective: input.objective
      });
    } catch {
      return undefined;
    }
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
    } catch {
      /* diagnostics only */
    }
  };
  const recoverSubagents = async (ctx: ExtensionContext) => {
    if (recoveryActive || !baseUrl || !apiKey) return;
    recoveryActive = true;
    try {
      const commandEnv = await businessCommandEnvironment(runtimeEnv);
      const results = await coordinator.recoverRun({
        taskId,
        runId: mainRunId,
        workspaceRoot,
        commandEnv,
        baseUrl,
        apiKey,
        model: modelId,
        thinkingLevel: currentThinkingLevel(),
        api: configuredModelApi(runtimeEnv),
        thinkingFormat: configuredThinkingFormat(runtimeEnv),
        supportsReasoningEffort,
        supportsPromptCacheKey: configuredSupportsPromptCacheKey(runtimeEnv),
        supportsImages: configuredSupportsImages(runtimeEnv),
        visionModel,
        maxTurns: configuredSubagentMaxTurns(runtimeEnv),
        maxTokens: configuredSubagentMaxTokens(runtimeEnv),
        contextWindow: configuredContextWindow(runtimeEnv),
        timeoutMs: configuredSubagentTimeout(runtimeEnv),
        questionTimeoutMs: configuredSubagentQuestionTimeout(runtimeEnv),
        maxQuestions: configuredSubagentMaxQuestions(runtimeEnv),
        skillRoots: baseSkillRoots,
        skillApplications: [],
        capabilityProvider: applicationBridge.capabilityProvider
      });
      if (results.length) {
        try {
          ctx.ui.notify(`Recovered ${results.length} pending Subagent call(s)`, "info");
        } catch {
          // Recovery may outlive the Main context that started it.
        }
      }
      await deliverCallbacks();
    } catch (error) {
      try {
        ctx.ui.notify(`Subagent recovery failed: ${errorMessage(error)}`, "warning");
      } catch {
        // Durable calls and callbacks remain available to the next Main.
      }
    } finally {
      recoveryActive = false;
    }
  };

  // The guard covers Main as well as Subagents. Main is a participant in the
  // optimization loop, not its referee, so it must not edit evaluation code,
  // this harness or version-control metadata either. Subagent writes are
  // checked inside the file tools; Main uses Pi's native tools, so the same
  // rule is applied here at the call boundary.
  // Rebuilt per call rather than once at startup: a grant made mid-session —
  // the user answering which paths are the scorer — has to take effect on the
  // next write, not on the next process.
  const currentGuard = async () => {
    const granted = await new LocalWorkspaceStore(workspaceRoot)
      .readTask(taskId)
      .then((task) => task.capabilities?.evalPaths ?? [])
      .catch(() => [] as string[]);
    return configuredProtectedPaths(projectDirectory, process.env, [atriaInstallRoot()], granted);
  };

  // Main's own jobs, kept beside its Run rather than in the Subagent tree so
  // one Task's long commands stay separable from its delegations'.
  const jobsDirectory = join(taskWorkspace, "runs", mainRunId, "agents", "main", "jobs");
  const currentCapabilities = async () =>
    new LocalWorkspaceStore(workspaceRoot)
      .readTask(taskId)
      .then((task) => task.capabilities)
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

  /**
   * Shared application resources.
   *
   * An application's documents are always reachable; what changes is whether
   * the conversation is *bound* to one. Unbound, nothing here contributes to a
   * turn: no context section, no application tools. Bound, the resource's
   * summary and that application's own tools appear, and unbinding takes both
   * away again. That is the only state this feature has.
   */
  const applicationBridge = createApplicationBridge({ pi, workspaceRoot, taskId, mainRunId, harnessRoot });
  /** Count running jobs and queue a wake for any that finished since the last check. */
  const pollJobs = async (): Promise<number> => {
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
        .catch(() => undefined);
    }
    return running;
  };

  pi.on("tool_call", async (event) => {
    const paths: unknown[] = [];
    if (event.toolName === "write" || event.toolName === "edit")
      paths.push(
        (event.input as { path?: unknown; file_path?: unknown }).path ??
          (event.input as { file_path?: unknown }).file_path
      );
    if (paths.length === 0) return undefined;
    const guard = await currentGuard();
    for (const candidate of paths) {
      if (typeof candidate !== "string" || !candidate) continue;
      const pattern = guard.match(resolve(projectDirectory, candidate));
      if (!pattern) continue;
      void appendGuardEvent(candidate, pattern, event.toolName);
      return {
        block: true,
        reason: `${candidate} is read-only for agents (protected by "${pattern}"). Evaluation code, the CoworkOS runtime and version-control metadata stay outside the optimization loop so results remain trustworthy. Change what is being measured instead, or ask the user to change what is protected.`
      };
    }
    return undefined;
  });

  const prepareMainTurnSections = async () => {
    // Real Pi assembles this hook before the per-request context hook.
    // Discover bound tools here so they exist on the first model request.
    await applicationBridge.prepareApplicationContext();
    await capabilityTools.refresh();
    // The active application is appended as its own system section rather than
    // spliced into the user's message, so the transcript keeps showing what the
    // person actually typed. The application section is prepared before prompt assembly,
    // independently of the later per-request context hook.
    //
    // WHAT BELONGS IN `<bound_application>`, and what does not.
    //
    // Only what is true *this turn and unknowable when this code was written*:
    // which document, what it is called on disk, which tools exist right now.
    // Two questions decide it:
    //
    //   - Would this sentence read the same for every document? Then it is a
    //     durable principle and belongs in `.pi/prompts/cowork-main.md`.
    //   - Is it about how one tool is called, or how it fails? Then it belongs
    //     in that tool's `description` / `promptGuidelines`, which only reach
    //     the prompt while the tool is active.
    //
    // This is not a new rule — `cowork-main.md` already states it for tool
    // schemas. It is written here because the block stopped obeying it: it grew
    // from 8 lines to 14 in one session, one incident at a time, until ~3,270
    // characters across four files were all answering "where does output go and
    // which tool writes it". The size guard in the tests is what keeps the next
    // incident-driven fix honest: past the cap, something has to be displaced
    // rather than appended, which forces the "which layer owns this?" question
    // at the moment it is easiest to skip.
    const bound = applicationBridge.boundApplication;
    const application = applicationBridge.pendingApplicationContext
      ? [
          "",
          "",
          applicationBridge.pendingApplicationContext,
          ...(bound
            ? [
                "",
                "<bound_application>",
                // The title leads, because that is what the user calls it. The path
                // follows only when it differs, and then it says so outright: a
                // document titled 「算法.md」 stored as `算法 2.md` read as two
                // different files, and one run spent four `bash` calls on the disk
                // working out which was meant.
                ...applicationBridge.describeBoundResource(bound),
                ...(bound.systemPrompt ? [bound.systemPrompt] : []),
                "绑定只为与当前文档相关的请求提供编辑上下文；无关的问答、调研或项目开发继续使用通用工具，不把其他任务写进这份文档。专用 skill 只用于匹配的任务。",
                // The tool list precedes every rule that refers to it.
                ...(bound.tools.length || applicationBridge.boundMcpTools.length
                  ? [
                      `这个应用的专用工具：${[...bound.tools.map((tool) => tool.name), ...applicationBridge.boundMcpTools.map((tool) => tool.name)].join(", ")}。它们只在绑定期间可用，是读写这份文档的唯一正确方式。`
                    ]
                  : []),
                ...(bound.skillRoots.length
                  ? ["这个应用带有专用 skill，需要时用 load_skill 按名称加载。"]
                  : []),
                // Name the bound document explicitly for references and requests
                // that omit a destination, instead of applying general file rules.
                `用户这一轮说的“这个文件”“这份文档”“这一段”“改一下”，默认就是指《${bound.resourceTitle}》，除非他点名了别的东西。`,
                `当本轮目标是编辑这份文档时，他让你写、整理、补充、扩写而没说放哪儿时，默认写进《${bound.resourceTitle}》，再在回复里说一句写好了，而不是把内容只贴在对话里。除非他说了只想看看或先讨论。`,
                // Keep editing rules beside the bound application's concrete tools.
                "改它只用上面这些专用工具。用 write/edit 直接覆盖资源文件会绕过版本协议，被记成来源不明的外部修改，可能冲掉用户正在编辑的内容，而且历史里只剩“被改过”。",
                `绑定已经确定了是哪一份，不需要用 bash/find/ls 去磁盘上找它或核对是哪一个——用 这个应用的读取工具 读到的就是它。磁盘上有名字相近的其他文件是正常的。`,
                "</bound_application>"
              ]
            : [])
        ].join("\n")
      : "";
    const workspace = [
      `用户选择的项目目录：${projectDirectory}。read/edit/write/bash 的相对路径从这里开始；用户说“这个项目”“工作文件夹”指的是这里。以它为准，不要因为运行了 CoworkOS 就改去它的安装目录。`,
      "会话可能切换过项目目录，历史消息中的旧路径不会自动改写；当前操作以本段目录为准，继续操作旧路径前先核对用户意图。已绑定的应用文档仍是原文档。",
      `本次任务工作区：${taskWorkspace}。browse_workspace 和 Subagent 的 outputFiles 的相对路径都从这里开始。`,
      `你的 work 目录：${join(taskWorkspace, "agents", "main", "work")}`,
      `任务的 artifacts 目录：${join(taskWorkspace, "artifacts")}`,
      `长期记忆文件：${join(taskWorkspace, "agents", "main", "context", "memory.md")}`,
      "对任务文件优先使用上面的绝对路径，避免 read/bash 与 browse_workspace 的相对路径混淆。"
    ].join("\n");
    const goals = await goalContext(workspaceRoot, taskId);
    // Keep SDK-owned tools and rules dynamic. Returning a forced prompt here
    // freezes snippets when enable_tools changes the active loadout mid-turn.
    return {
      current_workspace: `<current_workspace>\n${workspace}\n</current_workspace>${goals ? `\n\n${goals}` : ""}`,
      application_context: application
    };
  };

  pi.on("before_agent_start", async (event) => {
    // Yield the connection before any setup awaits; older Tasks must not compete
    // with the user's new foreground turn for a model request.
    memoryTurnActive = true;
    memoryLearning?.pause();
    projectLearning?.pause();
    await userMemoryStore.taskForegroundActive(taskId, mainRunId).catch(() => {});
    userMemoryRequest = readQueuedUserTurn(event.prompt)?.text ?? event.prompt;
    userMemoryLearningRequest = userMemoryRequest;
    try {
      const input = await readMainInput(mainInputPath(workspaceRoot, taskId, mainRunId));
      if (input && (readQueuedUserTurn(input.prompt)?.text ?? input.prompt) === userMemoryRequest) {
        userMemoryRequest =
          typeof input.body === "string"
            ? input.body
            : input.textAttachments?.length || input.attachmentIds?.length
              ? ""
              : userMemoryRequest;
        userMemoryLearningRequest = userMemoryRequest;
      }
    } catch {
      // An unreadable host input cannot establish which text came from the user.
      userMemoryRequest = "";
      userMemoryLearningRequest = "";
    }
    if ([MAIN_CONTINUATION_COMMAND, SUPERVISOR_WAKE_TURN].includes(userMemoryRequest)) {
      userMemoryRequest = "";
      userMemoryLearningRequest = "";
    }
    await userMemoryStore
      .enqueueForegroundLearning({
        taskId,
        runId: mainRunId,
        text: userMemoryLearningRequest,
        projectDirectory
      })
      .catch(() => {});
    memoryLearning?.start();
    projectLearning?.start();
    await refreshLearnedSkills();
    const sections = await prepareMainTurnSections();
    const options = event.systemPromptOptions;
    projectDefaultIdentity = !options?.customPrompt && options?.forceSystemPrompt === undefined;
    if (options) {
      sdkSkills = options.skills;
      options.skills = (await mainApplicationSkills(skillScopeNow(), options.skills)).filter(
        (skill) => !seenLearnedPaths.has(skill.filePath)
      );
      currentSkillsSection = mainApplicationSkillsSection(options.skills);
      Object.assign(options.sections, sections);
      return;
    }
    // Compatibility with older extension callers lacking structured options.
    return {
      systemPrompt: `${event.systemPrompt}\n${sections.current_workspace}${sections.application_context}`
    };
  });

  let continuationSections: Awaited<ReturnType<typeof prepareMainTurnSections>> | undefined;
  if (process.env.COWORK_MAIN_CONTINUATION) {
    registerMainContinuation(pi, async (ctx) => {
      continuationSections = await prepareMainTurnSections();
      await refreshLearnedSkills();
      await requestRetry?.restore();
      const options = ctx.getSystemPromptOptions();
      sdkSkills = options.skills ?? [];
      currentSkillsSection = mainApplicationSkillsSection(
        (await mainApplicationSkills(skillScopeNow(), sdkSkills)).filter(
          (skill) => !seenLearnedPaths.has(skill.filePath)
        )
      );
      projectDefaultIdentity = !options.customPrompt && options.forceSystemPrompt === undefined;
    });
  }
  let memoryContextSettings: SettingsManager | undefined;
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
              ? await experimentDigest(workspaceRoot, taskId).catch(() => undefined)
              : undefined
        });
      } catch (error) {
        ctx.ui.notify(`Main current context refresh failed: ${errorMessage(error)}`, "warning");
      }
    }
    // Refresh every request, including after a memory tool edit. Do not cache
    // user memory in the session: disabling/deleting must affect the next request.
    let memory = "";
    try {
      memory = await userMemoryContext(userMemoryStore, projectDirectory);
    } catch {
      /* A corrupt profile must not prevent ordinary chat; the tool reports the error. */
    }
    let experience = "",
      projectSkills = "";
    try {
      const store = await projectStoreNow();
      if (store) {
        experience = await projectExperienceContext(store);
        projectSkills = await projectExperienceSkillCatalog(store);
      }
    } catch {
      /* Optional context must not stop Main. */
    }
    const refreshed = messages.map((message) =>
      message.role === "system"
        ? {
            ...message,
            sections: { ...message.sections, user_memory: "", project_experience: "", project_skills: "" }
          }
        : message
    );
    const skillSection = currentSkillsSection;
    const scoped = skillSection
      ? refreshed.map((message) =>
          message.role === "system" && message.sections
            ? { ...message, sections: { ...message.sections, skills: skillSection } }
            : message
        )
      : refreshed;
    const projected = projectDefaultIdentity ? scoped.map(projectAtriaSystemMessage) : scoped;
    if ((!memory && !experience && !projectSkills) || !ctx.model) return { messages: projected };
    // Pi's threshold check precedes context_with_system. Resolve the same SDK
    // settings (including model overrides and project trust), but never cause
    // an extra compaction solely to fit optional personal memory.
    memoryContextSettings ??= SettingsManager.create(ctx.cwd, undefined, {
      projectTrusted: ctx.isProjectTrusted()
    });
    memoryContextSettings.setProjectTrusted(ctx.isProjectTrusted());
    const budget = {
      contextWindow: ctx.model.contextWindow,
      reserveTokens: memoryContextSettings.getCompactionReserveTokens(ctx.model),
      maxTokens: ctx.model.maxTokens
    };
    const withExperience = optionalContextSectionWithinBudget(
      userMemoryWithinContextBudget(projected, memory, budget),
      "project_experience",
      experience,
      budget
    );
    return {
      messages: optionalContextSectionWithinBudget(withExperience, "project_skills", projectSkills, budget)
    };
  });

  // Keep a bounded copy of the user-facing Main transcript. It is passed to
  // Coordinator automatically, so Main only needs to provide `task`.
  pi.on("context", async (event, ctx) => {
    // Retain old audit records, but never replay retired completion reminders
    // into the model when an existing conversation is continued.
    const messages = event.messages.filter(
      (message) =>
        !isMainContinuationMessage(message) &&
        ("customType" in message ? message.customType : undefined) !== "cowork-completion-check"
    );
    recentContext = messages.slice(-8);
    goalDelegationBranch = ctx.sessionManager.getBranch();
    if (!requestRetry?.isReplaying)
      await syncGoalDelegationRequest(workspaceRoot, taskId, mainRunId, {
        sessionId: ctx.sessionManager.getSessionId(),
        branch: ctx.sessionManager.getBranch(),
        messages
      });
    const firstUser = messages.find((message) => message.role === "user");
    const goal = firstUser ? textFromMessage(firstUser).trim() : "";
    if (goal) {
      const store = new LocalWorkspaceStore(workspaceRoot);
      const task = await store.readTask(taskId);
      const normalizedGoal = task.goal?.trim() || goal.slice(0, 2_000);
      if (!task.goal?.trim()) await store.updateTask(taskId, { goal: normalizedGoal });
      updateRuntime({
        runtimeGoal: normalizedGoal,
        runtimeLastEvent: { type: "user_goal_observed", summary: normalizedGoal.slice(0, 240) }
      });
    }
    try {
      if (mainContext) await persistMainContext(mainContext, ctx.sessionManager.getBranch());
      if (!requestRetry?.isReplaying) {
        await inboxDelivery.acknowledge(messages);
        if (process.env.COWORK_MAIN_RETRY_REQUEST_ID) freshRetryContext = true;
      }
      await updateRuntime({ runtimePendingDelegations: active + inboxDelivery.queuedCount });
      // Refresh between model requests, including changes made during a turn.
      await applicationBridge.prepareApplicationContext();
      await refreshLearnedSkills();
      await capabilityTools.refresh();
      const skills = (await mainApplicationSkills(skillScopeNow(), sdkSkills ?? [])).filter(
        (skill) => !seenLearnedPaths.has(skill.filePath)
      );
      currentSkillsSection = mainApplicationSkillsSection(skills);
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
      if (mainContext) await persistMainContext(mainContext, ctx.sessionManager.getBranch());
      const replayOnly = Boolean(process.env.COWORK_MAIN_RETRY_REQUEST_ID) && !freshRetryContext;
      await inboxDelivery.settle(replayOnly ? [] : ctx.sessionManager.getEntries());
      // The turn carrying the application context has completed, so what was
      // injected can now be treated as seen. A crash before this point leaves
      // the same changes queued for the next turn.
      if (applicationBridge.injectedResources.length && !replayOnly) {
        for (const entry of applicationBridge.injectedResources) {
          await applicationBridge.workbench.context
            .recordAcknowledged(taskId, "main", entry.resourceId, entry.revision)
            .catch(() => {});
        }
        applicationBridge.injectedResources = [];
      }
      try {
        const taskStore = new LocalWorkspaceStore(workspaceRoot);
        const task = await taskStore.readTask(taskId);
        const parked = await readSleep(workspaceRoot, taskId).catch(() => undefined);
        if (
          isFinalAssistantMessage(lastMainMessage) ||
          (parked && Date.parse(parked.parkedAt) >= agentStartedAt)
        )
          await resetMainSupervisorBackoff(workspaceRoot, taskId);
        if (task.status === "running") {
          const pending = await coordinator.waitForSubagents({
            taskId,
            runId: mainRunId,
            workspaceRoot,
            timeoutMs: 0
          });
          let assessment = assessTaskCompletion({
            pendingCalls: Math.max(active, pending.pending.length) + Number(recoveryActive),
            pendingJobs: await pollJobs(),
            pendingCallbacks: Math.max(inboxDelivery.queuedCount, pending.callbackPending.length),
            pendingHumanRequests: (await humanStore.list(taskId, "pending")).length,
            pendingSubagentQuestions: (await questionStore.list(taskId, "pending")).length,
            parkedForWake: Boolean(await readSleep(workspaceRoot, taskId).catch(() => undefined)),
            hasFinalAnswer: isFinalAssistantMessage(lastMainMessage) && !pendingContextClear
          });
          if (assessment.ready && (await parkBackgroundWatchGoal(workspaceRoot, taskId, mainRunId)))
            assessment = { ready: false, reason: "parked_for_wake" };
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
            try {
              const store = await projectStoreNow();
              if (store) {
                const profile = await store.readProfile();
                if (profile.enabled && profile.learningEnabled)
                  await projectEvidenceRecorder?.finish("completed");
                await enqueueProjectExperienceRun({
                  store,
                  identity: store.identity,
                  workspaceRoot,
                  taskId,
                  runId: mainRunId
                });
              }
            } catch {
              /* Background intake never changes task completion. */
            }
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
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    // Internal continuation and Inbox turns can bypass before_agent_start.
    memoryTurnActive = true;
    memoryLearning?.pause();
    projectLearning?.pause();
    await userMemoryStore.taskForegroundActive(taskId, mainRunId).catch(() => {});
    awaitingInitialPrompt = false;
    lastMainMessage = undefined;
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
    await new LocalWorkspaceStore(workspaceRoot).transitionTask(taskId, "running", {
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
      const last = event.messages.findLast((message) => message.role === "assistant");
      lastMainMessage = last;
      if (!last || ["error", "aborted", "length"].includes(last.stopReason) || pendingContextClear) return;
      // Pi awaits this hook before settling --print. Keep the Main session
      // alive for outstanding one-shot work and let queued callbacks trigger
      // another turn before a final answer is accepted.
      let waitingFor = "";
      while (!ctx.signal?.aborted && mainTurns < mainMaxTurns) {
        const task = await new LocalWorkspaceStore(workspaceRoot).readTask(taskId);
        if (
          ["cancelled", "failed"].includes(task.status) ||
          (await humanStore.list(taskId, "pending")).length
        )
          return;
        // Before delivery, so a job that just exited wakes Main on this pass
        // rather than waiting for the next one.
        const runningJobs = await pollJobs();
        await deliverCallbacks(true);
        if (inboxDelivery.queuedCount || ctx.hasPendingMessages?.()) return;
        const pending = await coordinator.waitForSubagents({
          taskId,
          runId: mainRunId,
          workspaceRoot,
          timeoutMs: 0
        });
        if (
          runningJobs ||
          active ||
          recoveryActive ||
          pending.pending.length ||
          pending.callbackPending.length
        ) {
          const signature = JSON.stringify([
            runningJobs,
            active,
            recoveryActive,
            pending.pending,
            pending.callbackPending
          ]);
          if (signature !== waitingFor) {
            waitingFor = signature;
            updateRuntime({
              runtimePhase: "waiting",
              runtimePendingDelegations:
                Math.max(active, pending.pending.length) + pending.callbackPending.length
            });
          }
          if (!active && pending.calls.some((call) => call.status === "queued")) void recoverSubagents(ctx);
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        return;
      }
    } finally {
      memoryTurnActive = false;
      await userMemoryStore.taskForegroundIdle(taskId, mainRunId).catch(() => {});
      if (mainTimeoutTimer) clearTimeout(mainTimeoutTimer);
      mainTimeoutTimer = undefined;
    }
  });
  pi.on("turn_end", async (event, ctx) => {
    if (!process.env.COWORK_DASHBOARD_URL) {
      try {
        const store = await projectStoreNow();
        const profile = await store?.readProfile();
        if (store && profile?.enabled && profile.learningEnabled) {
          projectEvidenceRecorder ??= createProjectExperienceEvidenceRecorder({
            identity: store.identity,
            workspaceRoot,
            taskId,
            runId: mainRunId
          });
          if (userMemoryLearningRequest && userMemoryLearningRequest !== projectRecordedUserText) {
            projectEvidenceRecorder.record([{ role: "user", content: userMemoryLearningRequest }]);
            projectRecordedUserText = userMemoryLearningRequest;
          }
          projectEvidenceRecorder.record([event.message, ...event.toolResults]);
        } else projectEvidenceRecorder = undefined;
      } catch {
        projectEvidenceRecorder = undefined;
      }
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
      async () => ({
        ...(await mainRequestEnvironment(workspaceRoot, taskId, projectDirectory)),
        executionScope: await applicationBridge.executionScope(projectDirectory)
      }),
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
      },
      {
        beginTurn: () => applicationBridge.beginModelTurn(),
        protectReplayScope: (scope) => applicationBridge.protectReplayScope(scope),
        goalDelegation: {
          read: async () => (await readGoalDelegationRequest(workspaceRoot, taskId, mainRunId))?.requestId,
          restore: (requestId, messages) =>
            restoreGoalDelegationRequest(workspaceRoot, taskId, mainRunId, requestId, {
              branch: goalDelegationBranch,
              messages
            })
        },
        memoryReserveTokens: (model) => memoryContextSettings?.getCompactionReserveTokens(model) ?? 16_384
      }
    );
    pi.registerProvider(model.provider, {
      baseUrl: model.baseUrl,
      apiKey,
      api: model.api,
      streamSimple: guardCompactionSummaries(
        recordModelRequests(
          createModelStreams(model.api, {
            supportsPromptCacheKey: configuredSupportsPromptCacheKey(runtimeEnv),
            sessionId: `atria:${taskId}:main`
          }),
          new ModelRequestRecorder(
            join(taskWorkspace, "sessions", "main", `${mainRunId}-requests.jsonl`),
            { taskId, runId: mainRunId, agentId: "main" },
            [apiKey, web?.serperApiKey, web?.exaApiKey].filter((secret): secret is string => Boolean(secret))
          ),
          requestRetry
        )
      ).streamSimple,
      models: [model]
    });
  }

  /**
   * The generic resource tools.
   *
   * They are deliberately not text tools: the schema of `payload` comes from
   * whichever Adapter owns the resource, so these same tools will drive a CAD
   * or spreadsheet Adapter later without another registration here.
   *
   * Reading content is not among them. That belongs to the application, which
   * is the only thing that knows what a useful view of its own resource is.
   */
  applicationBridge.registerGenericTools();

  const toolContext = {
    baseSkillRoots,
    capabilityProvider: applicationBridge.capabilityProvider,
    delegationGrants: applicationBridge.delegationGrants,
    refreshCapabilities: () => capabilityTools.refresh(),
    get active() {
      return active;
    },
    set active(value) {
      active = value;
    },
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
      return modelId;
    },
    get observedJobs() {
      return observedJobs;
    },
    get openExperimentRun() {
      return openExperimentRun;
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
    get recoveryActive() {
      return recoveryActive;
    },
    set recoveryActive(value) {
      recoveryActive = value;
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
      return supportsReasoningEffort;
    },
    get supportsImages() {
      return configuredSupportsImages(runtimeEnv);
    },
    get visionModel() {
      return visionModel;
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
    get virtualAgentStore() {
      return virtualAgentStore;
    },
    get watchStore() {
      return watchStore;
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
  registerMonitorsTools(pi, toolContext);
  registerGoalTools(pi, toolContext);
  registerProjectLedgerTool(pi, toolContext);
  registerWorkspaceTools(pi, toolContext);
  registerUserMemoryTool(pi, {
    store: userMemoryStore,
    taskId,
    runId: mainRunId,
    projectDirectory,
    userText: async () => {
      // Human answers arrive as tool results, not a new before_agent_start input.
      // Read only durable answers owned by this Task/Run; never trust arbitrary tool text.
      const answers = (await humanStore.list(taskId, "answered"))
        .filter((request) => request.runId === mainRunId)
        .map((request) => request.answer ?? "");
      return [userMemoryRequest, ...answers].join("\n");
    }
  });
  const cuaBridge = createCuaDispatcher(pi);
  registerImageTools(cuaBridge.capturePi, toolContext);
  registerSearchTools(pi, projectDirectory);
  registerWebSearchTools(pi, web);
  registerComputerTools(cuaBridge.capturePi, taskId, taskWorkspace);
  const browserTools = registerBrowserTools(cuaBridge.capturePi, toolContext);
  const cuaScripts = registerCuaScriptTools(cuaBridge.capturePi, cuaBridge.dispatch);
  pi.on("session_shutdown", async () => {
    await cuaScripts.dispose();
    await browserTools.dispose();
  });
  const capabilityTools = registerCapabilityTools(pi, {
    workspaceRoot,
    taskId,
    mainRunId,
    hasResources: async () => (await applicationBridge.workbench.listResources(taskId)).length > 0
  });
  pi.registerCommand("cowork-status", {
    description: "Show Cowork workspace and active Coordinator jobs",
    handler: async (_args, ctx) =>
      ctx.ui.notify(
        `workspace=${workspaceRoot}; task=${taskId}; mainTurns=${mainTurns}/${mainMaxTurns}; active=${active}`,
        "info"
      )
  });

  pi.registerCommand("cowork-tools", {
    description: "Show Cowork tools currently visible to Main",
    handler: async (_args, ctx) => ctx.ui.notify(`active tools: ${pi.getActiveTools().join(", ")}`, "info")
  });

  pi.on("session_start", async (event, ctx) => {
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
      goalDelegationBranch = ctx.sessionManager.getBranch();
      if (!requestRetry?.isReplaying)
        await syncGoalDelegationRequest(workspaceRoot, taskId, mainRunId, {
          sessionId: ctx.sessionManager.getSessionId(),
          branch: ctx.sessionManager.getBranch(),
          initializeOnly: true
        });
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
      await refreshLearnedSkills();
      await capabilityTools.refresh();
      mainContext = mainContextPaths(workspaceRoot, taskId);
      await ensureMainContext(mainContext);
      if (!requestRetry?.isReplaying) await inboxDelivery.acknowledge(ctx.sessionManager.getEntries());
      void recoverSubagents(ctx);
      const pollMainInbox = async (): Promise<void> => {
        if (inboxDeliveryActive) return;
        inboxDeliveryActive = true;
        try {
          const programs = await monitoringPrograms(workspaceRoot, taskId);
          if (
            backgroundMonitoringPaused(programs) &&
            (await new LocalWorkspaceStore(workspaceRoot).readTask(taskId)).monitoring?.scope === "background"
          ) {
            if (!ctx.isIdle()) ctx.abort();
            return;
          }
          await deliverCallbacks();
        } finally {
          inboxDeliveryActive = false;
        }
      };
      await pollMainInbox();
      // Watch Supervisor runs independently of Pi and writes durable messages
      // to Main's Inbox. Polling keeps an already-running Main responsive to
      // important watch results; if Main is offline, the same messages remain
      // durable and are delivered by the startup call above.
      if (inboxPoller) clearInterval(inboxPoller);
      const pollMs = Math.max(1_000, Number(process.env.COWORK_INBOX_POLL_MS ?? 3_000));
      inboxPoller = setInterval(
        () =>
          void pollMainInbox().catch(() => {
            // Pi can dispose Main before its children finish. Failed sends
            // release their leases; the next Main recovers the durable Inbox.
          }),
        pollMs
      );
      // Do not keep Pi --print alive solely because the background poller is
      // scheduled. An interactive Pi process remains alive normally, while a
      // one-shot session can exit once its turn has settled.
      inboxPoller.unref?.();
      // Tell any supervisor that this Task already has a Main. Without this a
      // supervisor would read "no Main" while one is running and start a
      // second, putting two agents on the same project.
      void writeHeartbeat(workspaceRoot, taskId, mainRunId).catch(() => {});
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(
        () => void writeHeartbeat(workspaceRoot, taskId, mainRunId).catch(() => {}),
        Math.max(1_000, Math.floor(HEARTBEAT_STALE_MS / 3))
      );
      heartbeatTimer.unref?.();
      const supervisor =
        process.env.COWORK_SUPERVISOR_AUTOSTART === "1"
          ? "Watch Supervisor auto-started"
          : "Watch Supervisor is external (run watch-supervisor for background monitoring)";
      if (
        !cliPresentation.startup(ctx, {
          workspaceRoot,
          taskId,
          mainRunId,
          modelId,
          supervisor,
          tools: pi.getActiveTools(),
          guessedProtection: guessedProtection(),
          protectedPaths: DEFAULT_PROTECTED_PATHS
        })
      ) {
        ctx.ui.notify(
          `CoworkOS loaded · workspace ${workspaceRoot} · task ${taskId} · ${supervisor} · tools ${requiredTools.join(", ")}`,
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

export type CoworkToolContext = Awaited<ReturnType<typeof registerCoworkExtension>>;
