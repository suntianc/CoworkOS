import { configuredWebTools } from "../runtime/web-search-config.js";
import { applyProxyEnvironment } from "../runtime/http-transport.js";
import { atriaRoleIdentity } from "../domain/agent-identity.js";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { id } from "../domain/types.js";
import { createBuiltinTools } from "../tools/builtin.js";
import { RunService } from "../runtime/run-service.js";
import { CoordinatorWorker } from "../runtime/worker.js";
import { FilePollingWatcher } from "../runtime/file-watcher.js";
import { WatcherLoop } from "../runtime/watcher-loop.js";
import { WatcherRuntime } from "../runtime/watcher.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { WatchProgramStore } from "../runtime/watch-program-store.js";
import { ResearchPollingWatcher } from "../runtime/research-watcher.js";
import { CoordinatorRuntime } from "../runtime/coordinator-runtime.js";
import { businessCommandEnvironment } from "../runtime/command-environment.js";
import { InboxStore } from "../runtime/scheduler.js";
import { WatchSupervisor, WatchSupervisorLoop } from "../runtime/watch-supervisor.js";
import { MainSupervisor, MainSupervisorLoop, spawnMainProcess } from "../runtime/main-supervisor.js";
import { atriaInstallRoot } from "../tools/protected-paths.js";
import { HumanRequestStore } from "../runtime/human.js";
import {
  configuredMainMaxTokens,
  configuredContextWindow,
  configuredMainMaxTurns,
  configuredMainTimeout,
  configuredModelApi,
  configuredThinkingFormat,
  configuredReasoningEffort,
  configuredSupportsReasoningEffort,
  configuredSupportsPromptCacheKey,
  configuredSupportsImages,
  normalizeReasoningEffort,
  configuredSubagentMaxTokens,
  configuredSubagentMaxTurns,
  configuredSubagentTimeout,
  configuredWorkspaceRoot,
  runtimeSettingsEnv
} from "../runtime/runtime-settings.js";
import { readHostCoworkConfig } from "../runtime/config.js";
import { visionModelConfig } from "../runtime/vision-config.js";
import { cliHelp, parseCliCommand } from "./commands.js";
import { runWatchEvent } from "./watch-run.js";

let errorApiKey: string | undefined;
async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log(cliHelp());
    return;
  }
  const parsed = parseCliCommand(command, args);
  if (parsed.help) {
    console.log(cliHelp(command, parsed.action));
    return;
  }
  const config = readHostCoworkConfig();
  applyProxyEnvironment(config);
  const apiKey = process.env.COWORK_API_KEY ?? config.apiKey;
  errorApiKey = apiKey;
  const baseUrl = process.env.COWORK_API_BASE ?? config.baseUrl;
  const model = process.env.COWORK_MODEL ?? config.model ?? "glm-5.3";
  const web = configuredWebTools(config);
  const runtimeEnv = runtimeSettingsEnv(config);
  const visionModel = visionModelConfig(config);
  const reasoningOptions = () => ({
    contextWindow: configuredContextWindow(runtimeEnv),
    supportsImages: configuredSupportsImages(runtimeEnv),
    thinkingLevel: normalizeReasoningEffort(
      parsed.options["reasoning-effort"] ?? parsed.options.thinking ?? configuredReasoningEffort(runtimeEnv),
      "--reasoning-effort / --thinking"
    ),
    api: configuredModelApi(runtimeEnv),
    thinkingFormat: configuredThinkingFormat(runtimeEnv),
    supportsReasoningEffort: configuredSupportsReasoningEffort(runtimeEnv)
  });
  const workspaceRoot = configuredWorkspaceRoot(config, {
    ...process.env,
    ...(parsed.options.workspace || parsed.options["workspace-root"]
      ? { COWORK_WORKSPACE: parsed.options.workspace ?? parsed.options["workspace-root"] }
      : {})
  });
  await mkdir(workspaceRoot, { recursive: true });

  if (command === "task") {
    const action = parsed.positionals.shift();
    const store = new LocalWorkspaceStore(workspaceRoot);
    if (action === "list") {
      printResult(await store.listTasks());
      process.exit(0);
    }
    const requestedTaskId = parsed.positionals.shift() ?? parsed.options.task;
    if (!requestedTaskId) fail("task 命令需要 task id");
    if (action === "create") {
      const goal = parsed.options.goal ?? (parsed.positionals.join(" ") || undefined);
      await store.createTask(requestedTaskId, goal ? { goal } : {});
      printResult(await store.readTask(requestedTaskId));
      process.exit(0);
    }
    if (action === "status") {
      printResult(await store.readTask(requestedTaskId));
      process.exit(0);
    }
    if (action === "cancel" || action === "resume" || action === "complete") {
      const status = action === "cancel" ? "cancelled" : action === "resume" ? "running" : "completed";
      printResult(
        await store.transitionTask(requestedTaskId, status, {
          reason: `cli_${action}`,
          completion:
            action === "complete"
              ? {
                  policy: "explicit",
                  signal: "finish_task",
                  summary: "Completed by explicit CLI action",
                  verifiedAt: new Date().toISOString()
                }
              : action === "resume"
                ? { signal: "none" }
                : undefined
        })
      );
      process.exit(0);
    }
    fail(`未知 task 操作: ${action ?? ""}`);
  }

  if (command === "human") {
    const action = parsed.positionals.shift();
    const taskId = parsed.options.task;
    if (!taskId) fail("human 需要 --task <id>");
    const human = new HumanRequestStore(workspaceRoot);
    if (action === "list") {
      printResult(
        await human.list(taskId, parsed.options.status as import("../runtime/human.js").HumanRequestStatus)
      );
      process.exit(0);
    }
    const requestId = parsed.options.request ?? parsed.positionals.shift();
    if (!requestId) fail("human 命令需要 request id");
    if (action === "cancel") {
      printResult(await human.cancel(taskId, requestId));
      process.exit(0);
    }
    if (action === "reply" || action === "answer") {
      const answer = parsed.options.answer ?? parsed.positionals.join(" ");
      if (!answer) fail("human reply 需要 --answer 或答案文本");
      const request = await human.answer(taskId, requestId, answer);
      const inbox = new InboxStore(
        join(workspaceRoot, taskId, "runs", request.runId, "agents", "main", "inbox-store.json")
      );
      await inbox.enqueue({
        messageId: `human-answer-${request.requestId}`,
        recipientAgentId: "main",
        kind: "human_command",
        eventId: `human-answer-event-${request.requestId}`,
        priority: 100,
        state: "ready",
        payload: {
          type: "human.answer",
          requestId: request.requestId,
          question: request.question,
          answer: request.answer,
          context: request.context
        },
        createdAt: request.answeredAt ?? new Date().toISOString()
      });
      try {
        await new LocalWorkspaceStore(workspaceRoot).transitionTask(taskId, "running", {
          runId: request.runId,
          reason: "human_answer_submitted"
        });
      } catch {
        /* task may already be running */
      }
      printResult({ request, delivered: true, runId: request.runId });
      process.exit(0);
    }
    fail(`未知 human 操作: ${action ?? ""}`);
  }

  if (command === "watch-file") {
    const taskId = parsed.options.task;
    const filePath = parsed.options.path;
    if (!taskId || !filePath) fail("watch-file 需要 --task <id> 和 --path <relative-file>");
    const store = new LocalWorkspaceStore(workspaceRoot);
    let task;
    try {
      task = await store.readTask(taskId);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("unknown task:")) throw error;
      await store.createTask(taskId, { goal: `Monitor ${filePath}` });
      task = await store.readTask(taskId);
    }
    const runId = parsed.options.run ?? task.activeRunId ?? `watch-${Date.now()}`;
    if (!task.activeRunId || task.activeRunId !== runId) await store.createRun(taskId, runId);
    const runtime = new WatcherRuntime({ workspaceRoot, taskId, runId });
    const watcher = new FilePollingWatcher({
      watcherId: parsed.options.watcher ?? `file-${filePath}`,
      rootDirectory: parsed.options.root ?? process.cwd(),
      relativePath: filePath,
      emitInitial: parsed.options["emit-initial"] === "true"
    });
    const controller = new AbortController();
    const loop = new WatcherLoop();
    const stop = () => {
      loop.stop();
      controller.abort();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await loop.run(runtime, watcher, {
      intervalMs: numberOption(parsed.options.interval, 5_000),
      once: parsed.options.once === "true",
      signal: controller.signal,
      onCycle: async (result) => console.log(JSON.stringify({ watcherId: watcher.watcherId, ...result }))
    });
    process.exit(0);
  }

  if (command === "watch") {
    const action = parsed.positionals.shift();
    if (action === "profiles") {
      printResult(new WatchProgramStore(workspaceRoot).listProfiles());
      process.exit(0);
    }
    const taskId = parsed.options.task;
    if (!taskId) fail("watch 需要 --task <id>");
    const taskStore = new LocalWorkspaceStore(workspaceRoot);
    try {
      await taskStore.readTask(taskId);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("unknown task:")) throw error;
      await taskStore.createTask(taskId);
    }
    const watchStore = new WatchProgramStore(workspaceRoot);
    if (action === "create") {
      const subject = parsed.options.subject ?? parsed.positionals.shift();
      const objective = parsed.options.objective ?? parsed.positionals.join(" ");
      if (!subject || !objective) fail("watch create 需要 --subject 和 --objective");
      printResult(
        await watchStore.createProgram({
          taskId,
          programId: parsed.options.program,
          subject,
          objective,
          notificationPolicy: parsed.options.policy as import("../domain/watch.js").NotificationPolicy,
          watchRunId: parsed.options.run
        })
      );
      process.exit(0);
    }
    if (action === "add") {
      const programId = parsed.options.program;
      const task = parsed.options.monitor ?? parsed.positionals.join(" ");
      if (!programId || !task) fail("watch add 需要 --program <id> 和 --monitor <task>");
      printResult(
        await watchStore.createVirtualAgent({
          programId,
          task,
          profileId: parsed.options.profile,
          cadenceSeconds: parsed.options.cadence ? numberOption(parsed.options.cadence, 0) : undefined,
          wake: parsed.options.wake as import("../domain/watch.js").WakePolicy,
          activate: parsed.options.activate === "true"
        })
      );
      process.exit(0);
    }
    if (action === "status") {
      const programId = parsed.options.program;
      if (!programId) fail("watch status 需要 --program <id>");
      const program = await watchStore.readProgram(taskId, programId);
      const monitors = await watchStore.listVirtualAgents(taskId, programId);
      printResult({
        program,
        monitors: await Promise.all(
          monitors.map(async (monitor) => ({
            ...monitor,
            state: await watchStore.readVirtualAgentState(taskId, programId, monitor.monitorId)
          }))
        )
      });
      process.exit(0);
    }
    fail(`未知 watch 操作: ${action ?? ""}`);
  }

  if (command === "watch-research") {
    const taskId = parsed.options.task ?? "rsi-research-watch";
    const query = parsed.options.query ?? "recursive self-improvement large language models";
    const store = new LocalWorkspaceStore(workspaceRoot);
    try {
      await store.readTask(taskId);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("unknown task:")) throw error;
      await store.createTask(taskId, { goal: `持续关注 AI 领域的 RSI 研究：${query}` });
    }
    const task = await store.readTask(taskId);
    const runId = parsed.options.run ?? task.activeRunId ?? id("watch");
    if (task.activeRunId !== runId) await store.createRun(taskId, runId);
    const watchStore = new WatchProgramStore(workspaceRoot);
    const program = await watchStore.createProgram({
      taskId,
      programId: parsed.options.program ?? "ai-rsi-watch",
      watchRunId: runId,
      subject: parsed.options.subject ?? "AI 领域的 Recursive Self-Improvement（RSI）研究",
      objective:
        parsed.options.objective ??
        "持续发现最新 RSI 论文，判断是否与大模型自我改进、自动研究或递归优化直接相关"
    });
    const monitor = await watchStore.createVirtualAgent({
      programId: program.programId,
      task: "发现并筛选最新 RSI 研究工作，说明与目标主题的关系并给出来源证据",
      profileId: "research-papers",
      sourcesHint: [query],
      cadenceSeconds: numberOption(parsed.options.cadence, 21_600),
      wake: "important",
      activate: true
    });
    const runtime = new WatcherRuntime({
      workspaceRoot,
      taskId,
      runId,
      programId: program.programId,
      recipientAgentId: monitor.monitorId
    });
    const watcher = new ResearchPollingWatcher({
      watcherId: monitor.monitorId,
      query,
      perPage: numberOption(parsed.options.limit, 10)
    });
    const result = await runtime.poll(watcher);
    await watchStore.updateVirtualAgentState(taskId, program.programId, monitor.monitorId, {
      status: "active",
      lastCheckedAt: new Date().toISOString()
    });
    printResult({
      taskId,
      runId,
      programId: program.programId,
      monitorId: monitor.monitorId,
      query,
      ...result
    });
    process.exit(result.failed ? 1 : 0);
  }

  if (command === "watch-run") {
    if (!apiKey || !baseUrl) fail("watch-run 需要 COWORK_API_BASE 和 COWORK_API_KEY");
    const taskId = parsed.options.task;
    const runId = parsed.options.run;
    const programId = parsed.options.program;
    const monitorId = parsed.options.monitor;
    if (!taskId || !runId || !programId || !monitorId)
      fail("watch-run 需要 --task、--run、--program 和 --monitor");
    const watchStore = new WatchProgramStore(workspaceRoot);
    const program = await watchStore.readProgram(taskId, programId);
    const monitor = (await watchStore.listVirtualAgents(taskId, programId)).find(
      (item) => item.monitorId === monitorId
    );
    if (!monitor) fail(`unknown monitor: ${monitorId}`);
    const inbox = new InboxStore(
      join(workspaceRoot, taskId, "runs", runId, "agents", monitorId, "inbox-store.json")
    );
    const message = await inbox.lease(monitorId, 60_000, `watch-run-${process.pid}`);
    if (!message) {
      printResult({ processed: false, reason: "no_pending_event", programId, monitorId });
      process.exit(0);
    }
    const monitorRunId = `${runId}-${monitorId}-${Date.now()}`;
    const eventPayload = message.payload;
    const task = [
      `${atriaRoleIdentity("Watch")} 当前作为 Watch Program 的 Virtual Agent，负责：${monitor.task}`,
      `Watch Program 目标：${program.objective}`,
      "请读取并分析下面的外部事件。输出完整结论，不要返回过程叙述。必须明确给出 classification（no_change/relevant_change/uncertain）、理由、来源证据和建议动作。",
      `外部事件：${JSON.stringify(eventPayload)}`
    ].join("\n");
    const coordinator = new CoordinatorRuntime();
    const commandEnv = await businessCommandEnvironment(process.env);
    const result = await runWatchEvent({
      taskId,
      programId,
      monitorId,
      monitorRunId,
      messageId: message.messageId,
      eventId: message.eventId,
      watchStore,
      inbox,
      dispatch: () =>
        coordinator.dispatch({
          taskId,
          runId: monitorRunId,
          activateRun: false,
          callId: `monitor-call-${message.eventId}`,
          agentId: monitorId,
          task,
          mode: "sync",
          workspaceRoot,
          commandEnv,
          baseUrl,
          apiKey,
          model,
          visionModel,
          ...reasoningOptions(),
          maxTurns: numberOption(parsed.options["max-turns"], configuredSubagentMaxTurns(runtimeEnv)),
          maxTokens: numberOption(parsed.options["max-tokens"], configuredSubagentMaxTokens(runtimeEnv)),
          timeoutMs: nonNegativeNumberOption(parsed.options.timeout, configuredSubagentTimeout(runtimeEnv)),
          web
        })
    });
    printResult({
      processed: true,
      monitorRunId,
      eventId: message.eventId,
      status: result.status,
      response: result.response,
      artifacts: result.artifacts.map((artifact) => artifact.relativePath),
      outputFiles: result.outputFiles,
      diagnostics: result.diagnostics
    });
    process.exit(result.status === "succeeded" ? 0 : 1);
  }

  if (command === "watch-supervisor") {
    if (!apiKey || !baseUrl) fail("watch-supervisor 需要 COWORK_API_BASE 和 COWORK_API_KEY");
    const commandEnv = await businessCommandEnvironment(process.env);
    const controller = new AbortController();
    const supervisor = new WatchSupervisor({
      workspaceRoot,
      signal: controller.signal,
      baseUrl,
      apiKey,
      model,
      visionModel,
      ...reasoningOptions(),
      runtimeEnv,
      commandEnv,
      supportsPromptCacheKey: configuredSupportsPromptCacheKey(runtimeEnv),
      maxTurns: numberOption(parsed.options["max-turns"], configuredMainMaxTurns(runtimeEnv)),
      maxTokens: numberOption(parsed.options["max-tokens"], configuredMainMaxTokens(runtimeEnv)),
      timeoutMs: nonNegativeNumberOption(parsed.options.timeout, configuredMainTimeout(runtimeEnv)),
      maxEventsPerMonitor: numberOption(parsed.options["max-events"], 4),
      web
    });
    const loop = new WatchSupervisorLoop();
    const stop = () => {
      loop.stop();
      controller.abort();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    // A parked Main is woken by an Inbox message, but something has to be alive
    // to notice and start one. Both supervisors take their own file locks, so
    // running the Main cycle here costs a process rather than needing one.
    const superviseMain =
      parsed.options["supervise-main"] === "true"
        ? new MainSupervisor({
            workspaceRoot,
            launch: ({ taskId: resumeTask, runId: resumeRun }) =>
              spawnMainProcess({
                taskId: resumeTask,
                runId: resumeRun,
                harnessRoot: process.env.COWORK_HARNESS_ROOT ?? atriaInstallRoot(),
                workspaceRoot,
                env: commandEnv
              })
          })
        : undefined;
    await loop.run(supervisor, {
      intervalMs: numberOption(parsed.options.interval, 60_000),
      once: parsed.options.once === "true",
      taskId: parsed.options.task,
      programId: parsed.options.program,
      signal: controller.signal,
      onCycle: async (result) => {
        const resumed = superviseMain
          ? await superviseMain
              .runCycle({ taskId: parsed.options.task })
              .catch((error) => ({ resumed: 0, error: String(error) }))
          : undefined;
        console.log(JSON.stringify(resumed ? { ...result, mainSupervisor: resumed } : result));
      }
    });
    process.exit(0);
  }

  if (command === "main-supervisor") {
    const controller = new AbortController();
    const harnessRoot = process.env.COWORK_HARNESS_ROOT ?? atriaInstallRoot();
    // Starting a model process is expensive and hard to undo, so a supervisor
    // that can do it unattended has to be asked for. Without --spawn it only
    // reports what it would resume, which is also how to check its judgment
    // before letting it act.
    const spawnAllowed = parsed.options.spawn === "true";
    const commandEnv = spawnAllowed ? await businessCommandEnvironment(process.env) : undefined;
    const supervisor = new MainSupervisor({
      workspaceRoot,
      launch: ({ taskId: resumeTask, runId: resumeRun }) => {
        if (!spawnAllowed) return;
        spawnMainProcess({
          taskId: resumeTask,
          runId: resumeRun,
          harnessRoot,
          workspaceRoot,
          env: commandEnv
        });
      }
    });
    const loop = new MainSupervisorLoop();
    const stopMain = () => {
      loop.stop();
      controller.abort();
    };
    process.once("SIGINT", stopMain);
    process.once("SIGTERM", stopMain);
    await loop.run(supervisor, {
      workspaceRoot,
      intervalMs: numberOption(parsed.options.interval, 60_000),
      once: parsed.options.once === "true",
      taskId: parsed.options.task,
      signal: controller.signal,
      onCycle: async (result) => console.log(JSON.stringify({ ...result, spawn: spawnAllowed }))
    });
    process.exit(0);
  }

  if (!apiKey || !baseUrl) fail("请先设置 COWORK_API_BASE 和 COWORK_API_KEY");

  const taskId = parsed.options.task ?? `cli-task-${Date.now()}`;
  const runId = parsed.options.run ?? id("run");

  if (command === "single") {
    const prompt = parsed.positionals.join(" ");
    if (!prompt) fail("single 命令需要一个 prompt");
    const commandEnv = await businessCommandEnvironment(process.env);
    const result = await new RunService(workspaceRoot).runPi({
      taskId,
      runId,
      prompt,
      baseUrl,
      apiKey,
      model,
      ...reasoningOptions(),
      maxTurns: numberOption(parsed.options["max-turns"], configuredMainMaxTurns(runtimeEnv)),
      maxTokens: numberOption(parsed.options["max-tokens"], configuredMainMaxTokens(runtimeEnv)),
      timeoutMs: nonNegativeNumberOption(parsed.options.timeout, configuredMainTimeout(runtimeEnv)),
      resume: parsed.options.resume === "true" ? true : undefined,
      tools: (workingDirectory, workspaceDirectory, artifactDirectory) =>
        createBuiltinTools({
          rootDirectory: workingDirectory,
          workspaceDirectory,
          artifactDirectory,
          commandEnv,
          web,
          supportsImages: configuredSupportsImages(runtimeEnv),
          visionModel
        })
    });
    printResult({
      command,
      taskId,
      runId,
      taskStatus: result.taskStatus,
      completion: result.completion,
      workingDirectory: result.workingDirectory,
      response: result.assistant?.content,
      artifacts: result.artifacts.map((artifact) => artifact.relativePath),
      diagnostics: result.diagnostics
    });
    process.exit(0);
  }

  if (command === "worker") {
    const workerTask = parsed.options.task;
    const workerRun = parsed.options.run;
    if (!workerTask || !workerRun) fail("worker 命令需要 --task 和 --run");
    const controller = new AbortController();
    const commandEnv = await businessCommandEnvironment(process.env);
    const worker = new CoordinatorWorker();
    const stop = () => {
      worker.stop();
      controller.abort();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await worker.run({
      taskId: workerTask,
      runId: workerRun,
      workspaceRoot,
      commandEnv,
      baseUrl,
      apiKey,
      model,
      visionModel,
      ...reasoningOptions(),
      maxTurns: numberOption(parsed.options["max-turns"], configuredSubagentMaxTurns(runtimeEnv)),
      maxTokens: numberOption(parsed.options["max-tokens"], configuredSubagentMaxTokens(runtimeEnv)),
      timeoutMs: nonNegativeNumberOption(parsed.options.timeout, configuredSubagentTimeout(runtimeEnv)),
      maxAttempts: numberOption(parsed.options["max-attempts"], 3),
      leaseMs: numberOption(parsed.options["lease-ms"], 60_000),
      pollMs: numberOption(parsed.options["poll-ms"], 2_000),
      once: parsed.options.once === "true",
      web,
      signal: controller.signal,
      onCycle: async (results) => {
        if (results.length > 0)
          console.log(
            JSON.stringify({
              recovered: results.map((result) => ({
                callId: result.callId,
                status: result.status,
                agentId: result.agentId,
                outputFiles: result.outputFiles,
                diagnostics: result.diagnostics,
                error: result.error
              }))
            })
          );
      }
    });
    process.exit(0);
  }

  fail(`Unknown command: ${command}. Run coworkos --help.`);
}

try {
  await main();
} catch (error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const key of [process.env.COWORK_API_KEY, errorApiKey]) {
    if (key) message = message.replaceAll(key, "[REDACTED]");
  }
  console.error(`CoworkOS: ${message}`);
  process.exitCode = 1;
}

function numberOption(value: string | undefined, fallback: number): number {
  return value === undefined ? fallback : Number(value);
}

function nonNegativeNumberOption(value: string | undefined, fallback: number): number {
  return numberOption(value, fallback);
}

function printResult(result: unknown): void {
  console.log(JSON.stringify(result, null, 2));
}

function fail(message: string): never {
  throw new Error(message);
}
