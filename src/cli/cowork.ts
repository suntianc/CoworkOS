import { applyProxyEnvironment } from "../runtime/http-transport.js";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { id } from "../domain/types.js";
import { SubagentWorker } from "./subagent-worker.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { businessCommandEnvironment } from "../runtime/command-environment.js";
import { InboxStore } from "../runtime/scheduler.js";
import { MainSupervisor, MainSupervisorLoop, spawnMainProcess } from "../runtime/main-supervisor.js";
import { atriaInstallRoot } from "../tools/protected-paths.js";
import { HumanRequestStore } from "../runtime/human.js";
import { configuredWorkspaceRoot } from "../runtime/runtime-settings.js";
import { readHostCoworkConfig } from "../runtime/config.js";
import { cliHelp, parseCliCommand } from "./commands.js";

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
        // eslint-disable-next-line no-restricted-syntax -- task 可能已处于 running，状态转移冲突无需处理；答复已落盘并投递到 inbox
      } catch {
        /* task may already be running */
      }
      printResult({ request, delivered: true, runId: request.runId });
      process.exit(0);
    }
    fail(`未知 human 操作: ${action ?? ""}`);
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
      launch: async ({ taskId: resumeTask, runId: resumeRun }) => {
        if (!spawnAllowed) return;
        await spawnMainProcess({
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

  if (command === "worker") {
    const workerTask = parsed.options.task;
    const workerRun = parsed.options.run;
    if (!workerTask || !workerRun) fail("worker 命令需要 --task 和 --run");
    const controller = new AbortController();
    const worker = new SubagentWorker();
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
      harnessRoot: process.env.COWORK_HARNESS_ROOT,
      env: {
        COWORK_API_BASE: baseUrl,
        COWORK_API_KEY: apiKey,
        COWORK_WORKSPACE: workspaceRoot,
        ...(model ? { COWORK_MODEL: model } : {}),
        ...(process.env.COWORK_MODEL_API ? { COWORK_MODEL_API: process.env.COWORK_MODEL_API } : {}),
        ...(process.env.COWORK_CONNECTION_ID
          ? { COWORK_CONNECTION_ID: process.env.COWORK_CONNECTION_ID }
          : {}),
        ...(process.env.COWORK_REASONING_EFFORT
          ? { COWORK_REASONING_EFFORT: process.env.COWORK_REASONING_EFFORT }
          : {}),
        ...(process.env.COWORK_THINKING_FORMAT
          ? { COWORK_THINKING_FORMAT: process.env.COWORK_THINKING_FORMAT }
          : {}),
        ...(process.env.COWORK_SUPPORTS_REASONING_EFFORT
          ? { COWORK_SUPPORTS_REASONING_EFFORT: process.env.COWORK_SUPPORTS_REASONING_EFFORT }
          : {}),
        ...(process.env.COWORK_SUPPORTS_PROMPT_CACHE_KEY
          ? { COWORK_SUPPORTS_PROMPT_CACHE_KEY: process.env.COWORK_SUPPORTS_PROMPT_CACHE_KEY }
          : {})
      },
      ...(parsed.options["lease-ms"] ? { leaseMs: numberOption(parsed.options["lease-ms"], 60_000) } : {}),
      ...(parsed.options["poll-ms"] ? { pollMs: numberOption(parsed.options["poll-ms"], 2_000) } : {}),
      once: parsed.options.once === "true",
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
