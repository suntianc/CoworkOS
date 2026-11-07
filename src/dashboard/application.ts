import {
  latestEditableMessage,
  readMessageVersions,
  messageVersionSummaries,
  readArchivedMessageVersion,
  versionRuntimeEvents
} from "../runtime/main-message-edit.js";
import { createWebSearchSettings } from "./web-search-settings.js";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ApplicationService, type ApplicationEvent } from "../applications/application-service.js";
import { applicationServiceForTask } from "../applications/task-service.js";
import { ResourceMappingStore } from "../applications/mapping-store.js";
import { McpSupervisor } from "../applications/mcp-supervisor.js";
import { id, now } from "../domain/types.js";
import { coworkConfigPath, readHostCoworkConfig } from "../runtime/config.js";
import {
  runtimeSettingsEnv,
  configuredContextWindow,
  configuredMainMaxTokens,
  configuredModelApi,
  configuredReasoningEffort,
  configuredSupportsReasoningEffort,
  configuredSupportsPromptCacheKey,
  configuredSupportsImages,
  configuredThinkingFormat
} from "../runtime/runtime-settings.js";
import { configuredWebTools } from "../runtime/web-search-config.js";
import { visionModelConfig } from "../runtime/vision-config.js";
import { availableModelIds } from "../runtime/model-catalog.js";
import { atriaDataPaths } from "../../scripts/data-home.cjs";
import { messagesWithRuntimeHistory, readTaskRuntimeEvents } from "../runtime/conversation-history.js";
import { conversationMessages } from "../runtime/conversation-view.js";
import { MainRequestStore, mainRequestPath } from "../storage/main-request-store.js";
import { CoordinatorRuntime } from "../runtime/coordinator-runtime.js";
import { listJobs } from "../tools/jobs.js";
import { HumanRequestStore } from "../runtime/human.js";
import { readSubagentProgress } from "../runtime/progress.js";
import { readRunStatistics } from "../runtime/run-statistics.js";
import { JsonlEventStore } from "../storage/event-store.js";
import { InputStore } from "../workspace/input-store.js";
import { listTaskArtifacts } from "../workspace/artifact-store.js";

import { readJsonFile, readJsonLines } from "./event-stream.js";
import { createGoalService } from "./goal-service.js";
import { createWatchService } from "./watch-service.js";
import { mainIsAlive, readHeartbeat } from "../runtime/main-heartbeat.js";
import { createModelSettings } from "./model-settings.js";
import { createDashboardHandler, type DashboardRoutePorts } from "./routes.js";
import { UserMemoryStore } from "../runtime/user-memory-store.js";
import {
  ProjectExperienceStore,
  listProjectExperienceIdentities
} from "../runtime/project-experience-store.js";
import {
  createProjectExperienceLearningService,
  enqueueProjectExperienceRun
} from "../runtime/project-experience-learning.js";
import { createUserMemoryLearningService } from "../runtime/user-memory-learning.js";
import { createDashboardRunService } from "./run-service.js";
import { LocalAccess } from "./local-access.js";
import { FileCommandRunner } from "./management-commands.js";
import { createCatalogEvents } from "./catalog-events.js";
import { EventLedger } from "./event-ledger.js";
import { createWorkspaceDirectory } from "./workspace-directory.js";
import { ProjectDataRuntime } from "../workspace/project-data-service.js";
import { ComputerUse } from "../gui/computer-use.js";
import type { ComputerDriver } from "../gui/computer-use.js";
import { MacComputerDriver } from "../gui/macos-driver.js";
import { createMacComputerApproval } from "../gui/macos-approval.js";
import { HttpError } from "./http.js";
import { ComputerApproval, type ComputerApprovalAuthentication } from "./computer-approval.js";

/** Assemble one local Dashboard; importing this module never opens a port or installs signals. */
export function createDashboardApplication(
  options: {
    projectRoot?: string;
    port?: number;
    computerDriver?: ComputerDriver;
    computerClock?: () => number;
    /** Local management credential used by the optional open development dashboard. */
    localAccessToken?: string;
    computerApprovalAuthenticate?: ComputerApprovalAuthentication;
    computerApprovalClock?: () => number;
    computerApprovalTtlMs?: number;
    /** Supplied by a host that persists identity; otherwise this process is the identity. */
    backendIdentity?: { backendId: string; startedAt: string };
  } = {}
) {
  const projectRoot = resolve(options.projectRoot ?? process.env.COWORK_HARNESS_ROOT ?? process.cwd());
  const port = options.port ?? Number(process.env.COWORK_UI_PORT ?? 3880);
  const backendIdentity = options.backendIdentity ?? { backendId: id("backend"), startedAt: now() };
  /**
   * Where this Dashboard answers.
   *
   * One constant, because two different things need it and they have to agree:
   * an application's MCP server reads its resource back over HTTP, and the Agent
   * reaches that server's tools through this same Dashboard. Deriving it twice
   * is how they drift; assuming the default port breaks every instance that is
   * not on it, including every test.
   */
  const dashboardUrl = `http://127.0.0.1:${port}`;
  /**
   * MCP servers for open application windows.
   *
   * Held here because a window outlives any single Agent run: an Agent process
   * is rebuilt each run, so a server it owned would die while the window was
   * still open.
   */
  const mcpSupervisor = new McpSupervisor(projectRoot, dashboardUrl);
  // The host-owned credential store is overlaid here, so child processes and routes share it.
  const runtimeConfig = readHostCoworkConfig(projectRoot);
  const data = atriaDataPaths(process.env, runtimeConfig, projectRoot);
  let workspaceRoot = data.workspaceRoot;
  const coordinator = new CoordinatorRuntime();
  const computerDriver = new MacComputerDriver();
  let folderPickerOpen = false;
  const globalIndexPath = data.globalIndex;
  /**
   * Where the global tab strip lives.
   *
   * Resolved once here rather than at the request that needs it, because the
   * Agent process needs the same path: a document it creates has to appear in the
   * strip the browser reads, and it cannot guess this location.
   */
  const tabStorePath = data.tabsIndex;
  /**
   * Local session authorization for this data root.
   *
   * It lives beside the backend identity so sessions survive a restart, and it
   * reads the host credential the serving process published. The credential is
   * read through a getter because a daemon sets it before assembling services.
   */
  const access = new LocalAccess(
    dirname(globalIndexPath),
    () => process.env.COWORK_API_TOKEN,
    () => options.localAccessToken ?? process.env.COWORK_API_TOKEN
  );
  const computerApproval = new ComputerApproval(
    options.computerApprovalAuthenticate ?? createMacComputerApproval(projectRoot),
    options.computerApprovalClock,
    options.computerApprovalTtlMs
  );
  /**
   * Durable receipts for idempotent change commands, beside the sessions and
   * the backend identity so a restart can answer a retry with the saved result.
   */
  const commands = new FileCommandRunner(join(dirname(globalIndexPath), "operations"));
  const workspaces = createWorkspaceDirectory(workspaceRoot, globalIndexPath, runtimeValue);
  /**
   * The shared project ledger's one authority.
   *
   * Opened from the resolved configuration and reported through `ready`: an
   * explicit PostgreSQL choice that cannot be reached refuses to start rather
   * than falling back to a local SQLite database.
   */
  const projectData = new ProjectDataRuntime({
    config: runtimeConfig.projectData,
    env: process.env,
    configPath: coworkConfigPath(projectRoot),
    dataRoot: dirname(globalIndexPath),
    backendId: backendIdentity.backendId
  });
  const { knownWorkspaceRoots, locateTask, taskListItem, globalTaskPayload } = workspaces;
  /**
   * The durable catalog event log, beside the sessions and receipts.
   *
   * A client reconciles against it after a disconnect: the snapshot and its
   * cursor come from the same serialized section, so a change made in the
   * handoff is replayed instead of lost, and a cursor older than the retained
   * log is refused so the client takes a fresh snapshot.
   */
  const catalogEvents = createCatalogEvents({
    ledger: EventLedger.open(join(dirname(globalIndexPath), "events"), backendIdentity.backendId, {
      ...(process.env.COWORK_EVENT_LEDGER_RECORDS
        ? { maxRecords: Number(process.env.COWORK_EVENT_LEDGER_RECORDS) }
        : {}),
      ...(process.env.COWORK_EVENT_FAULT_INJECT ? { faultInject: process.env.COWORK_EVENT_FAULT_INJECT } : {})
    }),
    readCatalog: globalTaskPayload,
    ...(process.env.COWORK_EVENT_RECONCILE_MS
      ? { reconcileMs: Number(process.env.COWORK_EVENT_RECONCILE_MS) }
      : {})
  });
  const computer = new ComputerUse(
    options.computerDriver ?? computerDriver,
    options.computerClock ?? Date.now,
    locateTask
  );
  const uploads = new InputStore(join(dirname(globalIndexPath), "uploads"));
  const userMemory = new UserMemoryStore();
  const projectExperienceStore = async (projectId: string) => {
    const project = await workspaces.applicationProjectForId(projectId);
    return project
      ? new ProjectExperienceStore({
          projectId: project.projectId,
          projectDirectory: project.projectDirectory,
          ...(project.projectCatalogPath ? { projectCatalogPath: project.projectCatalogPath } : {})
        })
      : undefined;
  };
  const runs = createDashboardRunService({
    userMemory,
    onRunStarting: () => {
      memoryLearning.pause();
      projectLearning.pause();
    },
    onRunFinalized: async (location, runId) => {
      if (!location.projectId) return;
      const store = await projectExperienceStore(location.projectId);
      if (store)
        await enqueueProjectExperienceRun({
          store,
          identity: store.identity,
          workspaceRoot: location.workspaceRoot,
          taskId: location.task.taskId,
          runId
        });
    },
    uploads,
    projectRoot,
    tabStorePath,
    dashboardUrl,
    runCredential: access.runCredential(),
    coordinator,
    locateTask,
    withTaskProjectLock: workspaces.withTaskProjectLock,
    runtimeValue,
    activeConnection: () => Boolean(runtimeConfig.modelConnections?.activeId),
    onRunExit: (taskId) => computer.finishTask(taskId),
    normalizeModel,
    appendRunEvent,
    readJsonFile
  });
  const { activeRuns, startMainRun, pendingHumanAnswers, resumeHumanAnswers } = runs;

  const watchers = createWatchService({
    harnessRoot: projectRoot,
    workspaceRoot: () => workspaceRoot,
    knownWorkspaceRoots,
    locateTask,
    runtimeValue,
    startMainRun,
    cancelTask: runs.cancelTask,
    runtimeOptions: () => {
      const env = runtimeSettingsEnv(runtimeConfig);
      return {
        runtimeEnv: env,
        commandEnv: { COWORK_API_TOKEN: access.runCredential(), COWORK_DASHBOARD_URL: dashboardUrl },
        api: configuredModelApi(env),
        thinkingFormat: configuredThinkingFormat(env),
        contextWindow: configuredContextWindow(env),
        thinkingLevel: configuredReasoningEffort(env),
        supportsReasoningEffort: configuredSupportsReasoningEffort(env),
        supportsPromptCacheKey: configuredSupportsPromptCacheKey(env),
        supportsImages: configuredSupportsImages(env),
        visionModel: visionModelConfig(runtimeConfig),
        web: configuredWebTools(runtimeConfig)
      };
    }
  });
  const uiRoot = process.env.COWORK_UI_DIR ?? join(projectRoot, "web");

  function runtimeValue(name: "COWORK_API_BASE" | "COWORK_API_KEY" | "COWORK_MODEL"): string | undefined {
    if (name === "COWORK_API_BASE")
      return process.env[name] || runtimeConfig.baseUrl || runtimeConfig.apiBase;
    if (name === "COWORK_API_KEY") return process.env[name] || runtimeConfig.apiKey;
    return process.env[name] || runtimeConfig.model || "glm-5.3";
  }

  function normalizeModel(value: unknown): string | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") throw new Error("model 必须是字符串");
    const model = value.trim();
    // Model ids are passed to a child process as one argv item. Keep the
    // accepted alphabet deliberately narrow so a UI request can never turn
    // into shell syntax or an oversized environment value.
    if (!model || model.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model))
      throw new Error("model id 不合法");
    return model;
  }

  async function availableModels(): Promise<string[]> {
    return availableModelIds({
      ...runtimeConfig,
      model: runtimeValue("COWORK_MODEL") ?? "glm-5.3",
      baseUrl: runtimeValue("COWORK_API_BASE"),
      apiKey: runtimeValue("COWORK_API_KEY")
    });
  }

  async function appendRunEvent(
    taskWorkspace: string,
    taskId: string,
    runId: string,
    type: string,
    payload: unknown
  ): Promise<void> {
    const events = new JsonlEventStore(join(taskWorkspace, taskId, "runs", runId, "run_events.jsonl"));
    await events.append({
      eventId: id("event"),
      type,
      taskId,
      runId,
      agentId: "main",
      occurredAt: now(),
      payload
    });
  }

  /**
   * Carry a resource event on the Task's existing SSE stream.
   *
   * ADR-06: no second transport. Application events are ordinary run events, so
   * a Tab learns that a resource changed through the same connection the
   * conversation already holds open. The envelope stays generic — the stream
   * never learns what an operation means, only which resource and revision it
   * touched — so a future Adapter needs no change here.
   *
   * A Task with no run yet has no stream to write to; the UI's existing poll is
   * what refreshes it until the first run starts.
   */
  async function publishApplicationEvent(taskId: string, event: ApplicationEvent): Promise<void> {
    try {
      const location = await locateTask(taskId);
      const runId = location.task.activeRunId;
      if (!runId) return;
      await appendRunEvent(location.workspaceRoot, taskId, runId, event.type, {
        appType: event.appType,
        resourceId: event.resourceId,
        appInstanceId: event.appInstanceId,
        revision: event.revision,
        ...event.payload
      });
    } catch (error) {
      // A missing stream must never fail the write that already succeeded.
      console.error(
        `[cowork] application event publish failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Which workspace root holds a resource.
   *
   * A document tab names only its resource — a resource belongs to no
   * conversation — so the strip cannot reach a task to ask. Scanned the same way
   * a task is located, and the store caches the owning application per id, so the
   * repeat cost is a map lookup.
   */
  async function locateResource(resourceId: string): Promise<{ workspaceRoot: string }> {
    for (const root of await workspaces.applicationWorkspaceRoots()) {
      try {
        await new ApplicationService(root).resources.appTypeOf(resourceId);
        return { workspaceRoot: root };
      } catch {
        /* the resource belongs to another registered workspace */
      }
    }
    throw new Error(`unknown resource: ${resourceId}`);
  }

  /**
   * Notify every conversation that references a resource.
   *
   * One document has one tab, shared by however many conversations reference it,
   * so an edit has to reach all of their SSE streams. Publishing only to the
   * acting conversation left the other side waiting on the poll — visible as an
   * editor that did not update while the other window was being typed into.
   */
  async function publishToReferencers(resourceId: string, event: ApplicationEvent): Promise<void> {
    const notified = new Set<string>();
    for (const root of await knownWorkspaceRoots()) {
      for (const taskId of await new ResourceMappingStore(root).tasksFor(resourceId).catch(() => [])) {
        if (notified.has(taskId)) continue;
        notified.add(taskId);
        await publishApplicationEvent(taskId, event);
      }
    }
  }

  async function resolveWorkspacePath(value: unknown): Promise<string> {
    if (typeof value !== "string" || !value.trim() || !isAbsolute(value))
      throw new Error("workspaceRoot 必须是本机绝对路径");
    const path = resolve(value);
    try {
      if (!(await stat(path)).isDirectory()) throw new Error("workspaceRoot 不是目录");
    } catch (error) {
      if (error instanceof Error && error.message === "workspaceRoot 不是目录") throw error;
      throw new Error("workspaceRoot 不存在或无法访问");
    }
    return path;
  }

  async function chooseLocalDirectory(): Promise<string | undefined> {
    if (folderPickerOpen) throw new Error("文件夹选择窗口已经打开");
    folderPickerOpen = true;
    try {
      const command =
        process.platform === "darwin"
          ? "/usr/bin/osascript"
          : process.platform === "win32"
            ? "powershell.exe"
            : "zenity";
      const args =
        process.platform === "darwin"
          ? [
              "-e",
              'try\nreturn POSIX path of (choose folder with prompt "选择 Cowork 工作空间")\non error number -128\nreturn ""\nend try'
            ]
          : process.platform === "win32"
            ? [
                "-NoProfile",
                "-STA",
                "-Command",
                'Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = "选择 Cowork 工作空间"; if ($picker.ShowDialog() -eq "OK") { Write-Output $picker.SelectedPath }; $picker.Dispose()'
              ]
            : ["--file-selection", "--directory", "--title=选择 Cowork 工作空间"];
      const selected = await new Promise<string>((resolveSelection, reject) => {
        const picker = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        picker.stdout.on("data", (chunk) => {
          output += String(chunk);
        });
        picker.once("error", () => reject(new Error("无法打开系统文件夹选择器，请使用桌面版")));
        picker.once("close", (code) => {
          if (code === 0 || (process.platform === "linux" && code === 1)) resolveSelection(output.trim());
          else reject(new Error("文件夹选择窗口未能正常打开，请重试"));
        });
      });
      return selected ? await resolveWorkspacePath(selected) : undefined;
    } finally {
      folderPickerOpen = false;
    }
  }

  async function switchWorkspace(nextRoot: string): Promise<void> {
    if (activeRuns.size > 0) throw new Error("请先等待运行中的任务结束，再切换工作空间");
    computer.close();
    workspaceRoot = await resolveWorkspacePath(nextRoot);
    await workspaces.switchRoot(workspaceRoot);
  }

  async function taskDetails(taskId: string): Promise<unknown> {
    // A run may settle while the slower history reads are in progress. Keep
    // that snapshot active instead of pairing stale task data with an idle run.
    const activeAtStart = activeRuns.has(taskId);
    const location = await locateTask(taskId);
    const { task } = location;
    const taskWorkspace = location.workspaceRoot;
    const runId = task.activeRunId;
    const coordination = runId
      ? await coordinator.waitForSubagents({ taskId, runId, workspaceRoot: taskWorkspace, timeoutMs: 0 })
      : { calls: [], pending: [], callbackPending: [], timedOut: false, waitedMs: 0 };
    const events = runId
      ? await readJsonLines(join(taskWorkspace, taskId, "runs", runId, "run_events.jsonl"), 30)
      : [];
    const messageVersions = await readMessageVersions(taskWorkspace, taskId);
    const runtimeEvents = versionRuntimeEvents(
      await readTaskRuntimeEvents(taskWorkspace, taskId),
      messageVersions
    );
    const artifacts = await listTaskArtifacts({ workspaceRoot: taskWorkspace, taskId, runId });
    const messages = messagesWithRuntimeHistory(
      conversationMessages(
        await readJsonFile(join(taskWorkspace, taskId, "agents", "main", "context", "messages.json"), [])
      ),
      runtimeEvents
    );
    const progress = runId
      ? await readSubagentProgress({ taskId, runId, workspaceRoot: taskWorkspace }).catch(() => null)
      : null;
    const jobs = runId
      ? await listJobs({
          directory: join(taskWorkspace, taskId, "runs", runId, "agents", "main", "jobs")
        }).catch(() => [])
      : [];
    const active =
      activeAtStart || activeRuns.has(taskId) || mainIsAlive(await readHeartbeat(taskWorkspace, taskId));
    const monitoring = await watchers.list(taskId);
    let damagedRetry = false;
    const requestStore = new MainRequestStore(mainRequestPath(taskWorkspace, taskId), taskId);
    const retry =
      !active && ["failed", "waiting"].includes(task.status)
        ? await requestStore.pending().catch(() => {
            damagedRetry = true;
            return undefined;
          })
        : undefined;
    const retryRequest =
      retry &&
      retry.executionScope &&
      retry.endpoint &&
      retry.taskId === taskId &&
      retry.runId === runId &&
      retry.state !== "completed"
        ? { requestId: retry.requestId, model: retry.model.id }
        : undefined;
    const lastFailure = [...events].reverse().find((event) => event.type === "main.run_failed")?.payload as
      { failure?: { kind?: string } } | undefined;
    const legacyRetry =
      !retry && !active && ["failed", "waiting"].includes(task.status)
        ? await requestStore.legacyPending().catch(() => {
            damagedRetry = true;
            return undefined;
          })
        : undefined;
    const retryRequestUnavailable =
      !active &&
      ["failed", "waiting"].includes(task.status) &&
      !retryRequest &&
      (damagedRetry ||
        (retry && (!retry.executionScope || !retry.endpoint)) ||
        (legacyRetry?.taskId === taskId && legacyRetry.runId === runId) ||
        lastFailure?.failure?.kind === "model_request");
    const statistics = await readRunStatistics({ workspaceRoot: taskWorkspace, task, active });
    const humanRequests = await new HumanRequestStore(taskWorkspace).list(taskId);
    const humanResumePending =
      !active &&
      task.status !== "cancelled" &&
      !humanRequests.some((request) => request.status === "pending") &&
      (await pendingHumanAnswers(taskWorkspace, taskId, runId)).length > 0;
    // An index only: titles, revisions and unread counts, never resource content.
    // Task detail is polled every few seconds and must not grow with a document.
    // It stays optional because reading it can fail on a damaged workspace, and
    // detail must still return when it does.
    const applications = await (async () => {
      const service = await applicationServiceForTask(taskWorkspace, taskId);
      const summary = await service.taskSummary(taskId).catch(() => undefined);
      if (!summary) return undefined;
      // The outputs panel is a view over two kinds of thing: published files
      // and live resources. Resources keep their own home on disk so one can
      // appear in more than one Task, so the list is assembled rather than
      // read off a single directory.
      // Hand over the resources `taskSummary` already listed: listing reads
      // and hashes every document, and this ran three times per poll.
      const deliverables = await service
        .deliverables(taskId, artifacts, summary.resources)
        .catch(() => undefined);
      return {
        ...summary,
        workspaceRoot: service.resourceWorkspaceRoot,
        ...(deliverables ? { deliverables } : {})
      };
    })();
    let editableMessage;
    let editableMessageError;
    try {
      editableMessage = (await latestEditableMessage(taskWorkspace, taskId, runId))?.target;
    } catch {
      editableMessageError = "原消息或附件记录无法校验，历史已保留，请重新添加有效附件并主动发送新消息。";
    }
    return {
      task: taskListItem(location),
      workspaceRoot: location.projectDirectory,
      storageRoot: taskWorkspace,
      projectId: location.projectId,
      projectName: location.projectName,
      projectDirectory: location.projectDirectory,
      coordination,
      events,
      runtimeEvents,
      artifacts,
      messages,
      editableMessage,
      ...(editableMessageError ? { editableMessageError } : {}),
      conversationVersions: messageVersionSummaries(messageVersions),
      conversationVersion: messageVersions?.versionId,
      retryRequest,
      ...(retryRequestUnavailable ? { retryRequestUnavailable: true } : {}),
      progress,
      statistics,
      humanRequests,
      jobs: jobs.map(({ jobId, state, exitCode, signal, logPath }) => ({
        jobId,
        state,
        exitCode,
        signal,
        logPath
      })),
      humanResumePending,
      monitoring,
      ...(applications ? { applications } : {}),
      runtime: {
        active,
        stopping: runs.cancellations.has(taskId),
        model:
          active || !runtimeConfig.modelConnections?.activeId
            ? task.model || runtimeValue("COWORK_MODEL")
            : runtimeValue("COWORK_MODEL")
      }
    };
  }

  const projectLearning = createProjectExperienceLearningService({
    stores: async () => {
      const identities = await listProjectExperienceIdentities();
      const stores: ProjectExperienceStore[] = [];
      for (const identity of identities) {
        // Do not revive another catalog or a deleted project from stale private state.
        if (identity.projectCatalogPath !== workspaces.projectCatalog.filePath) continue;
        const store = await projectExperienceStore(identity.projectId);
        if (store) stores.push(store);
      }
      return stores;
    },
    userMemoryStore: userMemory,
    connection: () => {
      const baseUrl = runtimeValue("COWORK_API_BASE"),
        apiKey = runtimeValue("COWORK_API_KEY");
      const env = runtimeSettingsEnv(runtimeConfig);
      return baseUrl && apiKey
        ? {
            baseUrl,
            apiKey,
            model: runtimeValue("COWORK_MODEL"),
            api: configuredModelApi(env),
            thinkingFormat: configuredThinkingFormat(env),
            thinkingLevel: configuredReasoningEffort(env),
            supportsReasoningEffort: configuredSupportsReasoningEffort(env),
            maxTokens: configuredMainMaxTokens(env),
            contextWindow: configuredContextWindow(env)
          }
        : undefined;
    },
    isTaskActive: (taskId) => activeRuns.has(taskId),
    isForegroundActive: () => runs.isBusy()
  });
  const memoryLearning = createUserMemoryLearningService({
    store: userMemory,
    connection: () => {
      const baseUrl = runtimeValue("COWORK_API_BASE"),
        apiKey = runtimeValue("COWORK_API_KEY");
      const env = runtimeSettingsEnv(runtimeConfig);
      return baseUrl && apiKey
        ? {
            baseUrl,
            apiKey,
            model: runtimeValue("COWORK_MODEL"),
            api: configuredModelApi(env),
            thinkingFormat: configuredThinkingFormat(env),
            thinkingLevel: configuredReasoningEffort(env),
            supportsReasoningEffort: configuredSupportsReasoningEffort(env),
            maxTokens: configuredMainMaxTokens(env),
            contextWindow: configuredContextWindow(env)
          }
        : undefined;
    },
    isTaskActive: (taskId) => activeRuns.has(taskId),
    isForegroundActive: () => runs.isBusy()
  });
  async function computerHostRequest(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new HttpError(400, "无效 Computer Use 请求");
    const input = value as Record<string, unknown>;
    const exact = (...keys: string[]) => Object.keys(input).every((key) => keys.includes(key));
    if (input.operation === "policy") {
      if (
        !exact("operation", "enabled", "mode") ||
        typeof input.enabled !== "boolean" ||
        (input.mode !== "observe" && input.mode !== "control")
      )
        throw new HttpError(400, "无效 Computer Use 策略");
      return computer.configurePolicy({ enabled: input.enabled, mode: input.mode });
    }
    if (input.operation === "resume" && exact("operation")) return computer.resume();
    if (input.operation === "pause" && exact("operation")) return computer.takeOver();
    if (input.operation === "release-sessions") {
      if (!exact("operation")) throw new HttpError(400, "无效 Computer Use 请求");
      computer.releaseSessions();
      return null;
    }
    if (input.operation === "end") {
      if (!exact("operation")) throw new HttpError(400, "无效 Computer Use 请求");
      computer.close();
      return null;
    }
    if (input.operation === "access" && exact("operation")) return computer.access();
    if (input.operation === "status" && exact("operation"))
      return (options.computerDriver ?? computerDriver).status();
    if (input.operation === "permissions") {
      if (
        !exact("operation", "permission") ||
        (input.permission !== "screenRecording" && input.permission !== "accessibility")
      )
        throw new HttpError(400, "无效系统权限请求");
      return (
        (options.computerDriver ?? computerDriver).requestPermissions?.(input.permission) ??
        Promise.reject(new HttpError(503, "当前驱动不支持系统权限请求"))
      );
    }
    if (
      input.operation !== "authorize" ||
      !exact("operation", "taskId", "pid", "windowId", "mode", "bundleId", "application", "title") ||
      [input.bundleId, input.application, input.title].some(
        (value) => value !== undefined && (typeof value !== "string" || value.length > 1024)
      ) ||
      typeof input.taskId !== "string" ||
      input.taskId.length === 0 ||
      input.taskId.length > 200 ||
      typeof input.pid !== "number" ||
      !Number.isSafeInteger(input.pid) ||
      input.pid <= 0 ||
      typeof input.windowId !== "number" ||
      !Number.isSafeInteger(input.windowId) ||
      input.windowId <= 0 ||
      (input.mode !== "observe" && input.mode !== "control")
    )
      throw new HttpError(400, "无效 Computer Use 授权");
    return computer.authorize(input.taskId, input.pid, input.windowId, input.mode);
  }
  const routes: DashboardRoutePorts = {
    userMemory,
    projectData,
    access,
    commands,
    events: catalogEvents,
    backendInfo: () => ({
      backendId: backendIdentity.backendId,
      pid: process.pid,
      startedAt: backendIdentity.startedAt
    }),
    projectExperienceStore,
    watchers,
    goals: createGoalService({
      harnessRoot: projectRoot,
      workspaceRoot: () => workspaceRoot,
      knownWorkspaceRoots,
      locateTask,
      resumeHumanAnswers,
      cancelTask: runs.cancelTask
    }),
    uploads,
    computer,
    computerHostRequest,
    computerApproval,
    dashboardUrl,
    uiRoot,
    webSearchSettings: createWebSearchSettings(projectRoot, runtimeConfig, () => activeRuns.size > 0),
    modelSettings: createModelSettings(projectRoot, runtimeConfig, () => activeRuns.size > 0),
    globalTaskPayload,
    locateTask,
    locateResource,
    knownWorkspaceRoots,
    applicationWorkspaceRoots: workspaces.applicationWorkspaceRoots,
    applicationProjectForRoot: workspaces.applicationProjectForRoot,
    applicationProjectForId: workspaces.applicationProjectForId,
    publishApplicationEvent,
    publishToReferencers,
    tabStorePath,
    workspaceRoot: () => workspaceRoot,
    mcpSupervisor,
    availableModels,
    chooseLocalDirectory,
    resolveWorkspacePath,
    registerWorkspace: workspaces.register,
    switchWorkspace,
    createProject: workspaces.createProject,
    updateProject: (projectId, input) =>
      workspaces.updateProject(projectId, input, runs.withIdleProjectTasks),
    createProjectTask: workspaces.createProjectTask,
    createTemporaryTask: workspaces.createTemporaryTask,
    createTemporaryWorkspace: workspaces.createTemporaryWorkspace,
    withApplicationProjectLock: workspaces.withApplicationProjectLock,
    normalizeModel,
    runtimeValue,
    startMainRun,
    editMainMessage: runs.editMainMessage,
    messageVersion: async (taskId, versionId) => {
      const location = await locateTask(taskId);
      return readArchivedMessageVersion(location.workspaceRoot, taskId, versionId);
    },
    activeRuns,
    cancelTask: runs.cancelTask,
    queuedMessageAction: runs.queuedMessageAction,
    queueInterjection: runs.queueInterjection,
    interjectionTarget: runs.interjectionTarget,
    resumeHumanAnswers,
    coordinator,
    taskDetails,
    taskListItem,
    appendRunEvent
  };
  const server = createServer(createDashboardHandler(routes));
  server.once("listening", () => watchers.start());
  server.once("listening", () => memoryLearning.start());
  server.once("listening", () => projectLearning.start());

  return {
    server,
    runs,
    mcpSupervisor,
    dashboardUrl,
    routePorts: routes,
    computerHostRequest,
    /** Resolves when the project data service is migrated and reachable. */
    ready: projectData.ready,
    async stop() {
      await computerApproval.close();
      await catalogEvents.close();
      await memoryLearning.stop();
      await projectLearning.stop();
      computer.close();
      await watchers.stop();
      server.closeAllConnections();
      await runs.stop();
      await mcpSupervisor.stopAll();
      await new Promise<void>((done) => server.close(() => done()));
      // After the listener is closed, so no in-flight ledger request loses its database.
      await projectData.close();
    }
  };
}
