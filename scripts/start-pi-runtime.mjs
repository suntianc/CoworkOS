import { coworkProviderId } from "../dist/src/runtime/model-profile.js";
import { parseMainRequestModel } from "../dist/src/storage/main-request-store.js";
import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configuredReasoningEffort,
  configuredThinkingFormat,
  configuredSupportsReasoningEffort,
  configuredSupportsPromptCacheKey,
  normalizeReasoningEffort,
  runtimeSettingsEnv
} from "../dist/src/runtime/runtime-settings.js";
import { ensurePiRetryDefaults } from "../dist/src/runtime/model-retry.js";
import { resolveModelRole, roleConnectionEnv } from "../dist/src/runtime/role-models.js";
import { bundledSkillRoot } from "../dist/src/runtime/skill-registry.js";
import { resolveCliSession } from "./cli-session.mjs";
import { ensureCliBranding, ensureCliStartupSettings } from "./cli-branding.mjs";
import { installSearchToolAdapters } from "./search-tool-adapter.mjs";
import { atriaDataPaths } from "./data-home.cjs";
import { scanCliArguments, isInteractiveCli } from "./cli-information.mjs";
import { runCliProcess } from "./cli-runtime-host.mjs";

export async function startPi({ uiCompatibility } = {}) {
  // Component release credentials are never model/Agent/tool credentials.
  delete process.env.ATRIA_COMPONENTS_GITHUB_TOKEN;
  // A delegated agent uses the same launcher and extension as Main; only the
  // role selects the other lifecycle. It is not a Main and must not take a Main
  // slot, a project execution lease or Main's continuation state.
  if (process.env.COWORK_AGENT_ROLE) {
    await startDelegatedAgent();
    return;
  }
  // A Main dispatched by the program must own a durable capacity slot before it
  // does any work. Registering the process itself closes the spawn→bind window:
  // a child whose reservation was already released refuses to run, so recovery
  // can never hand a second slot to a process it cannot count.
  const capacityGrant = process.env.COWORK_MAIN_CAPACITY_GRANTED;
  let capacityAlreadyGranted = false;
  if (capacityGrant) {
    try {
      const { openMainCapacityGate } = await import("./main-capacity-gate.mjs");
      const capacity = await openMainCapacityGate({
        taskId: process.env.COWORK_TASK_ID,
        cwd: process.cwd()
      });
      if (!capacity) throw new Error("外部 Main 容量配置缺失，未启动");
      if (!(await capacity.bindProcess(capacityGrant, process.pid)))
        throw new Error("外部 Main 名额已释放，未启动");
      // Children of this Main must not inherit the grant and claim the slot.
      delete process.env.COWORK_MAIN_CAPACITY_GRANTED;
      // The budget owns this Run for its whole life: an answer that arrives
      // between turns is resumed through the backend, which admits the turn.
      process.env.COWORK_MAIN_CAPACITY_MANAGED = "1";
      capacityAlreadyGranted = true;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }
  let projectExecution;
  let projectExecutionTimer;
  let capacityExecution;
  /** The CLI host's delegated-process backend; absent when a Dashboard serves the Run. */
  let subagentHost;
  try {
    const harnessRoot = resolve(process.env.COWORK_HARNESS_ROOT ?? process.cwd());
    const executable = await resolvePiEntry(harnessRoot);
    if (!executable) {
      console.error("CoworkOS Agent 运行时未安装完整，请运行 npm ci 或重新安装 CLI。");
      process.exit(1);
    }

    const userArgs = process.argv.slice(2);
    const optionBoundary = userArgs.indexOf("--");
    const optionArgs = optionBoundary < 0 ? userArgs : userArgs.slice(0, optionBoundary);
    const userFlags = scanCliArguments(userArgs);
    // Help and built-in catalog/version output do not need a Task, configuration,
    // writable Pi profile or a background runtime. Let Pi handle them directly.
    if (userFlags.has("--list-models")) {
      const information = spawn(process.execPath, [executable, ...userArgs], {
        stdio: "inherit",
        cwd: process.cwd(),
        env: process.env
      });
      process.once("SIGINT", () => information.kill("SIGINT"));
      process.once("SIGTERM", () => information.kill("SIGTERM"));
      try {
        const [code, signal] = await once(information, "exit");
        process.exit(code ?? (signal ? 1 : 0));
      } catch (error) {
        console.error(`启动 CoworkOS Agent 失败：${error.message}`);
        process.exit(1);
      }
    }
    const publicTui = isInteractiveCli(userArgs, process.stdin.isTTY, process.stdout.isTTY);
    const cliLaunch = process.env.COWORK_CLI_SESSION === "1" || publicTui;
    const hasExtension = userFlags.has("--extension") || userFlags.has("-e");
    const hasModel = userFlags.has("--model");
    const coworkPrompt = resolve(harnessRoot, ".pi", "prompts", "cowork-main.md");
    const launchConfigPath = resolve(
      process.env.COWORK_CONFIG ??
        (existsSync(resolve(".cowork", "config.json"))
          ? ".cowork/config.json"
          : existsSync(resolve("config.json"))
            ? "config.json"
            : atriaDataPaths().configPath)
    );
    const { readHostCoworkConfig } = await import("../dist/src/runtime/config.js");
    let launchConfig;
    try {
      // The host store holds the effective keys; without it `coworkos start`
      // would lose the model env.
      launchConfig = readHostCoworkConfig(process.cwd());
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
    const runtimeEnv = runtimeSettingsEnv(launchConfig);
    const thinkingIndex = userFlags.get("--thinking")?.index ?? -1;
    let thinkingLevel;
    let supportsReasoningEffort;
    let thinkingFormat;
    let supportsPromptCacheKey;
    try {
      if (thinkingIndex >= 0) {
        const value = optionArgs[thinkingIndex + 1];
        if (value === undefined || value.startsWith("--"))
          throw new Error("--thinking requires a value (off, minimal, low, medium, high, xhigh, max)");
        thinkingLevel = normalizeReasoningEffort(value, "--thinking");
        userArgs[thinkingIndex + 1] = thinkingLevel;
      } else {
        thinkingLevel = configuredReasoningEffort(runtimeEnv);
      }
      supportsReasoningEffort = configuredSupportsReasoningEffort(runtimeEnv);
      thinkingFormat = configuredThinkingFormat(runtimeEnv);
      supportsPromptCacheKey = configuredSupportsPromptCacheKey(runtimeEnv);
    } catch (error) {
      console.error(`Invalid CoworkOS reasoning configuration: ${error.message}`);
      process.exit(1);
    }
    const data = atriaDataPaths(process.env, launchConfig);
    const workspaceRoot = data.workspaceRoot;
    let configuredModel = process.env.COWORK_MODEL ?? launchConfig.model ?? "glm-5.3";
    const agentDir = data.piAgentDir;
    mkdirSync(agentDir, { recursive: true });
    await ensurePiRetryDefaults(agentDir);
    await installSearchToolAdapters(agentDir);
    const explicitTaskId = process.env.COWORK_TASK_ID;
    const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");
    const savedTask = explicitTaskId
      ? await new LocalWorkspaceStore(workspaceRoot).readTask(explicitTaskId).catch((error) => {
          if (error.message === `unknown task: ${explicitTaskId}`) return undefined;
          throw error;
        })
      : undefined;
    // Supervisor wakeups must honor a later project selection too. Durable task
    // storage and Pi history stay where they were; only the execution CWD changes.
    let projectDirectory = resolve(
      savedTask?.projectDirectory ?? process.env.COWORK_PROJECT_DIR ?? process.cwd()
    );
    let selectedSession;
    try {
      selectedSession = cliLaunch
        ? await resolveCliSession({
            args: userArgs,
            workspaceRoot,
            projectDirectory,
            agentDir,
            explicitTaskId
          })
        : {};
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
    if (selectedSession.cancelled) process.exit(0);
    const taskId = explicitTaskId ?? selectedSession.taskId ?? `task-${randomUUID()}`;
    projectDirectory = selectedSession.projectDirectory ?? projectDirectory;
    let taskProjectId;
    try {
      const task = await new LocalWorkspaceStore(workspaceRoot).readTask(taskId).catch((error) => {
        if (error.message === `unknown task: ${taskId}`) return undefined;
        throw error;
      });
      taskProjectId = task?.projectId;
      if (task?.projectId && task.projectCatalogPath) {
        const { GlobalProjectCatalog } = await import("../dist/src/workspace/project-catalog.js");
        const { beginProjectExecution } = await import("../dist/src/workspace/project-execution.js");
        await new GlobalProjectCatalog(task.projectCatalogPath).withProjectLock(
          task.projectId,
          async (project) => {
            projectDirectory = project.projectDirectory;
            projectExecution = await beginProjectExecution(workspaceRoot, taskId);
          }
        );
        // eslint-disable-next-line no-restricted-syntax -- 定时刷新执行状态失败不影响 CLI 运行，下一个 10 秒周期会自动重试
        projectExecutionTimer = setInterval(() => void projectExecution.refresh().catch(() => {}), 10_000);
        projectExecutionTimer.unref();
        if (selectedSession.sessionPath) {
          const { alignSelectedTaskSession } = await import("./main-session.mjs");
          selectedSession.sessionPath = await alignSelectedTaskSession(
            selectedSession.sessionPath,
            selectedSession.sessionDirectory,
            projectDirectory
          );
        }
      }
    } catch (error) {
      // eslint-disable-next-line no-restricted-syntax -- 启动失败即将以退出码 1 结束，释放执行权失败不能覆盖原始错误
      await projectExecution?.release().catch(() => {});
      console.error(error.message);
      process.exit(1);
    }
    // A CLI-launched external Main spends the same budget as the Dashboard. The
    // Dashboard and the worker hand down the slot they already reserved.
    if (!capacityAlreadyGranted)
      try {
        const { openMainCapacityGate } = await import("./main-capacity-gate.mjs");
        const capacity = await openMainCapacityGate({ taskId, cwd: process.cwd() });
        if (capacity?.external) {
          const decided = await capacity.admit({
            projectId: capacity.external.projectId,
            sessionId: capacity.external.sessionId,
            taskId,
            kind: capacity.external.kind,
            runId: process.env.COWORK_RUN_ID ?? `main-${taskId}`,
            resume: true,
            prompt: "External Main started from the CLI.",
            origin: "cli",
            queueWhenFull: false
          });
          if (decided.state !== "running")
            throw new Error(
              decided.state === "queued"
                ? `外部 Main 名额已满，已排队第 ${decided.position} 位；请等待当前 Main 完成后从界面继续`
                : "外部 Main 名额已满，请等待当前 Main 完成后从界面继续"
            );
          await capacity.bindProcess(decided.requestId, process.pid);
          capacityExecution = { capacity, requestId: decided.requestId };
        }
      } catch (error) {
        // eslint-disable-next-line no-restricted-syntax -- 名额申请失败即将以退出码 1 结束，释放执行权失败不改变失败结论
        await projectExecution?.release().catch(() => {});
        console.error(error.message);
        process.exit(1);
      }
    // The CLI reads the same execution-host role defaults as the Dashboard. An
    // explicit --model or a model forced by the launch environment still wins;
    // a role-selected connection supplies its key, endpoint and profile. This
    // runs after admission, so a default changed while the host was full is the
    // default this launch actually gets.
    const roleBinding =
      launchConfig.roleModels?.host?.main ??
      (taskProjectId ? launchConfig.roleModels?.projects?.[taskProjectId]?.main : undefined);
    let mainRole;
    if (roleBinding && !process.env.COWORK_API_BASE && !process.env.COWORK_MODEL) {
      const modelIndex = userFlags.get("--model")?.index ?? -1;
      const requestedModel = modelIndex >= 0 ? optionArgs[modelIndex + 1] : undefined;
      try {
        mainRole = resolveModelRole(launchConfig, {
          ...(taskProjectId ? { projectId: taskProjectId } : {}),
          ...(requestedModel ? { model: requestedModel } : {}),
          ...(thinkingIndex >= 0 ? { thinkingLevel } : {})
        });
      } catch (error) {
        // eslint-disable-next-line no-restricted-syntax -- 模型角色解析失败即将以退出码 1 结束，释放名额失败不改变失败结论
        await capacityExecution?.capacity.release(capacityExecution.requestId).catch(() => {});
        console.error(error.message);
        process.exit(1);
      }
      configuredModel = mainRole.model;
      if (thinkingIndex < 0) thinkingLevel = mainRole.thinkingLevel;
      supportsReasoningEffort = mainRole.profile.supportsReasoningEffort;
      thinkingFormat = mainRole.profile.thinkingFormat ?? "auto";
      supportsPromptCacheKey = mainRole.profile.supportsPromptCacheKey;
    }

    const sessionDirectoryArg = optionArgs.lastIndexOf("--session-dir");
    if (
      !cliLaunch &&
      explicitTaskId &&
      (optionArgs.includes("--continue") || optionArgs.includes("-c")) &&
      !optionArgs.some((arg) =>
        ["--no-session", "--session", "--session-id", "--resume", "-r", "--fork"].includes(arg)
      ) &&
      sessionDirectoryArg >= 0 &&
      userArgs[sessionDirectoryArg + 1]
    ) {
      const { alignTaskSessionDirectory, restoreUnflushedTaskSession } = await import("./main-session.mjs");
      await restoreUnflushedTaskSession(
        userArgs[sessionDirectoryArg + 1],
        projectDirectory,
        resolve(workspaceRoot, explicitTaskId, "agents/main/context/messages.json")
      );
      await alignTaskSessionDirectory(userArgs[sessionDirectoryArg + 1], projectDirectory);
      if (process.env.COWORK_MAIN_CONTINUATION) {
        const { restorePendingTaskInput } = await import("./main-session.mjs");
        await restorePendingTaskInput(
          userArgs[sessionDirectoryArg + 1],
          projectDirectory,
          process.env.COWORK_MAIN_CONTINUATION
        );
      }
    }
    // Dashboard message edits resume an explicitly selected version, never a
    // newer abandoned session discovered from the same Task directory.
    const dashboardSessionIndex = optionArgs.lastIndexOf("--session");
    if (
      !cliLaunch &&
      explicitTaskId &&
      process.env.COWORK_MAIN_CONTINUATION &&
      dashboardSessionIndex >= 0 &&
      sessionDirectoryArg >= 0
    ) {
      const { restorePendingTaskInput } = await import("./main-session.mjs");
      await restorePendingTaskInput(
        userArgs[sessionDirectoryArg + 1],
        projectDirectory,
        process.env.COWORK_MAIN_CONTINUATION,
        userArgs[dashboardSessionIndex + 1]
      );
    }
    // Freeze the chosen file: discovery and Pi must never race into two different sessions.
    if (selectedSession.sessionPath) {
      const boundary = userArgs.indexOf("--");
      const options = boundary < 0 ? userArgs : userArgs.slice(0, boundary);
      const forwarded = [];
      for (let index = 0; index < options.length; index++) {
        if (["--continue", "-c", "--resume", "-r"].includes(options[index])) continue;
        if (["--session", "--session-id"].includes(options[index])) {
          index++;
          continue;
        }
        forwarded.push(options[index]);
      }
      userArgs.splice(
        0,
        userArgs.length,
        ...forwarded,
        "--session",
        selectedSession.sessionPath,
        ...(boundary < 0 ? [] : userArgs.slice(boundary))
      );
    }
    if (selectedSession.sessionDirectory) {
      const boundary = userArgs.indexOf("--");
      const options = boundary < 0 ? userArgs : userArgs.slice(0, boundary);
      const selectedDirectoryArg = options.lastIndexOf("--session-dir");
      if (selectedDirectoryArg < 0) userArgs.unshift("--session-dir", selectedSession.sessionDirectory);
      else userArgs[selectedDirectoryArg + 1] = selectedSession.sessionDirectory;
    }
    const activeConnection = launchConfig.modelConnections?.profiles.find(
      (profile) => profile.id === launchConfig.modelConnections.activeId
    );
    const roleEnv = mainRole ? roleConnectionEnv(mainRole) : {};
    // A Dashboard run already resolved its connection and passes its identity;
    // a CLI launch without one falls back to the active connection as before.
    const connectionId =
      roleEnv.COWORK_CONNECTION_ID ??
      process.env.COWORK_CONNECTION_ID ??
      activeConnection?.contextId ??
      activeConnection?.id ??
      "";
    const providerId = process.env.COWORK_MAIN_RETRY_MODEL
      ? parseMainRequestModel(process.env.COWORK_MAIN_RETRY_MODEL).provider
      : coworkProviderId(
          roleEnv.COWORK_API_BASE ||
            process.env.COWORK_API_BASE ||
            launchConfig.baseUrl ||
            launchConfig.apiBase ||
            "",
          connectionId
        );
    const args = [
      // Pi 1.x loads a built-in MCP client that would add mcp__* tools to Main.
      // Adopting it is a separate decision, so every CoworkOS launch keeps it off.
      "--no-mcp",
      ...(hasExtension ? [] : ["--extension", resolve(harnessRoot, ".pi", "extensions", "cowork.ts")]),
      ...(hasModel ? [] : ["--provider", providerId, "--model", configuredModel]),
      // Pass the level explicitly: Pi otherwise restores old session defaults,
      // including the "off" value written by earlier Cowork launches.
      ...(thinkingIndex >= 0 ? [] : ["--thinking", thinkingLevel]),
      "--append-system-prompt",
      coworkPrompt,
      // Pi 1.0 runs the interactive TUI in fullscreen by default. The upgrade
      // keeps the previous regular-scrollback default; an explicit
      // `--tui-mode` (or a later launch flag) still chooses fullscreen.
      ...(publicTui && !userArgs.some((arg) => arg === "--tui-mode" || arg.startsWith("--tui-mode="))
        ? ["--tui-mode", "regular"]
        : []),
      ...(projectDirectory !== harnessRoot ? ["--skill", bundledSkillRoot(harnessRoot)] : []),
      ...userArgs
    ];
    if (
      publicTui &&
      ["1", "true"].includes(process.env.ATRIA_DEBUG?.toLowerCase()) &&
      !optionArgs.includes("--verbose")
    )
      args.unshift("--verbose");

    // Keep Pi's mutable state inside the Cowork workspace. This makes the launcher
    // portable on managed machines where ~/.pi may not exist or be writable.
    const piPackageDir = resolve(
      dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
      ".."
    );
    let brandingEnv = {};
    if (publicTui) await ensureCliStartupSettings({ agentDir, projectDirectory });
    if (cliLaunch) {
      brandingEnv = await ensureCliBranding({
        agentDir,
        piPackageDir,
        version: JSON.parse(await readFile(resolve(harnessRoot, "package.json"), "utf8")).version
      });
    }
    // A run with no Dashboard still delegates through a backend. This host is
    // it: it owns the workspace's delegated processes and answers Main over a
    // loopback route, so the same owner that launches a Subagent settles it.
    const providesSubagentHost =
      !process.env.COWORK_DASHBOARD_URL && !process.env.COWORK_SUBAGENT_BACKEND_URL;
    if (providesSubagentHost) {
      const { openSubagentHost } = await import("../dist/src/cli/subagent-host.js");
      subagentHost = await openSubagentHost({
        workspaceRoot,
        projectRoot: harnessRoot,
        configPath: launchConfigPath,
        piAgentDir: agentDir
      });
    }
    const childEnv = {
      ...process.env,
      ...runtimeEnv,
      ...roleEnv,
      ...brandingEnv,
      ...(process.env.COWORK_CONFIG || existsSync(launchConfigPath)
        ? { COWORK_CONFIG: launchConfigPath }
        : {}),
      COWORK_HARNESS_ROOT: harnessRoot,
      COWORK_CONFIG_ROOT: process.cwd(),
      COWORK_PROJECT_DIR: projectDirectory,
      COWORK_API_KEY: roleEnv.COWORK_API_KEY ?? process.env.COWORK_API_KEY ?? launchConfig.apiKey,
      COWORK_API_BASE:
        roleEnv.COWORK_API_BASE ??
        process.env.COWORK_API_BASE ??
        launchConfig.baseUrl ??
        launchConfig.apiBase,
      COWORK_MODEL: configuredModel,
      COWORK_CONNECTION_ID: roleEnv.COWORK_CONNECTION_ID ?? connectionId,
      COWORK_REASONING_EFFORT: thinkingLevel,
      COWORK_THINKING_FORMAT: roleEnv.COWORK_THINKING_FORMAT ?? thinkingFormat,
      COWORK_SUPPORTS_REASONING_EFFORT: supportsReasoningEffort ? "1" : "0",
      COWORK_SUPPORTS_PROMPT_CACHE_KEY: supportsPromptCacheKey ? "1" : "0",
      COWORK_WORKSPACE: workspaceRoot,
      COWORK_TASK_ID: taskId,
      COWORK_CLI_SESSION: cliLaunch ? "1" : "0",
      // A one-shot prompt is this process's initial turn. Callbacks already in
      // the Inbox must join that turn instead of opening their own before Pi
      // submits the prompt.
      ...(userFlags.has("--print") || userFlags.has("-p") ? { COWORK_INITIAL_PROMPT: "1" } : {}),
      COWORK_CLI_TASK_EXPLICIT: explicitTaskId ? "1" : "0",
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      // Application MCP servers are owned by the Dashboard, so the agent reaches
      // their tools over HTTP. Absent for a run with no Dashboard, which simply
      // means no application-specific tools.
      ...(process.env.COWORK_DASHBOARD_URL ? { COWORK_DASHBOARD_URL: process.env.COWORK_DASHBOARD_URL } : {}),
      ...(subagentHost
        ? {
            COWORK_SUBAGENT_BACKEND_URL: subagentHost.url,
            COWORK_SUBAGENT_BACKEND_TOKEN: subagentHost.token
          }
        : providesSubagentHost
          ? { COWORK_SUBAGENT_UNAVAILABLE: "workspace_owned" }
          : {})
    };
    process.exitCode = await runCliProcess({
      bootstrap: uiCompatibility
        ? undefined
        : fileURLToPath(new URL("./cli-shell-boot.mjs", import.meta.url)),
      executable: uiCompatibility ? fileURLToPath(new URL("./cli-ui-boot.mjs", import.meta.url)) : executable,
      args,
      env: childEnv,
      projectDirectory,
      uiCompatibility: Boolean(uiCompatibility)
    });
  } finally {
    // The delegated processes outlive this host; only its observation does not.
    await subagentHost?.close().catch((error) => {
      // The delegated processes are independent of this host; report the
      // cleanup failure instead of hiding it behind the launcher's exit code.
      console.error(
        `[cowork] subagent host shutdown failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    clearInterval(projectExecutionTimer);
    // eslint-disable-next-line no-restricted-syntax -- CLI 退出的 finally 里释放执行权，失败时进程已结束、状态由下次启动校正
    await projectExecution?.release().catch(() => {});
    if (capacityExecution)
      // eslint-disable-next-line no-restricted-syntax -- finally 释放名额失败时进程正在退出，租约由执行主机超时回收
      await capacityExecution.capacity.release(capacityExecution.requestId).catch(() => {});
  }
}

/** Locate the installed Pi entry, whichever way npm laid the package out. */
async function resolvePiEntry(harnessRoot) {
  const piBin = resolve(harnessRoot, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  try {
    await access(piBin);
    return piBin;
    // eslint-disable-next-line no-restricted-syntax -- npm 可能把依赖提升到包外，本地 .bin 缺失时改为从已安装模块解析入口
  } catch {
    try {
      // npm may hoist dependencies outside the package; resolve from this installed module.
      const entry = fileURLToPath(
        new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
      );
      await access(entry);
      return entry;
      // eslint-disable-next-line no-restricted-syntax -- 两种定位都失败时返回 undefined，由调用方打印安装提示并以退出码 1 结束
    } catch {
      return undefined;
    }
  }
}

/**
 * Launch one delegated agent turn.
 *
 * The backend already fixed the role, Task/Run/callId and work site in the
 * environment and the CWD. This path only adds the shared Pi flags, keeps the
 * new-capability defaults off, and hands the process to the same extension.
 */
async function startDelegatedAgent() {
  // The backend owns this process's connection and passes it down. A work site
  // is project code, so a config.json inside it can never supply model settings.
  const missing = ["COWORK_API_BASE", "COWORK_API_KEY", "COWORK_MODEL"].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`CoworkOS 子代理启动缺少模型环境变量：${missing.join("、")}。`);
    process.exit(1);
  }
  const harnessRoot = resolve(process.env.COWORK_HARNESS_ROOT ?? process.cwd());
  const executable = await resolvePiEntry(harnessRoot);
  if (!executable) {
    console.error("CoworkOS Agent 运行时未安装完整，请运行 npm ci 或重新安装 CLI。");
    process.exit(1);
  }
  const baseUrl = process.env.COWORK_API_BASE;
  const model = process.env.COWORK_MODEL;
  const thinkingLevel = normalizeReasoningEffort(
    process.env.COWORK_REASONING_EFFORT ?? configuredReasoningEffort(),
    "COWORK_REASONING_EFFORT"
  );
  const providerId = coworkProviderId(baseUrl, process.env.COWORK_CONNECTION_ID ?? "");
  const args = [
    // The same capability defaults Main pins: a delegated process must not
    // silently gain tools from the host's MCP configuration.
    "--no-mcp",
    "--extension",
    resolve(harnessRoot, ".pi", "extensions", "cowork.ts"),
    "--provider",
    providerId,
    "--model",
    model,
    "--thinking",
    thinkingLevel,
    // A delegated process does the same kind of work Main does, so it gets the
    // same published skills in its system prompt; without this its catalog is
    // missing every bundled skill because it runs outside the install root.
    ...(process.cwd() === harnessRoot ? [] : ["--skill", bundledSkillRoot(harnessRoot)]),
    ...process.argv.slice(2)
  ];
  process.exitCode = await runCliProcess({
    executable,
    args,
    env: { ...process.env },
    projectDirectory: process.cwd()
  });
}
