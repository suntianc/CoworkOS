import { coworkProviderId } from "../dist/src/runtime/model-profile.js";
import { parseMainRequestModel } from "../dist/src/storage/main-request-store.js";
import { visionModelEnv } from "../dist/src/runtime/vision-config.js";
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
import { resolveCliSession } from "./cli-session.mjs";
import { ensureCliBranding, ensureCliStartupSettings } from "./cli-branding.mjs";
import { installSearchToolAdapters } from "./search-tool-adapter.mjs";
import { atriaDataPaths } from "./data-home.cjs";
import { scanCliArguments, isInteractiveCli } from "./cli-information.mjs";
import { runCliProcess } from "./cli-runtime-host.mjs";

export async function startPi({ uiCompatibility } = {}) {
  // Component release credentials are never model/Agent/tool credentials.
  delete process.env.ATRIA_COMPONENTS_GITHUB_TOKEN;
  let projectExecution;
  let projectExecutionTimer;
  try {
    const harnessRoot = resolve(process.env.COWORK_HARNESS_ROOT ?? process.cwd());
    const piBin = resolve(
      harnessRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "pi.cmd" : "pi"
    );
    let piEntry = resolve(
      harnessRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "bundle",
      "cli.js"
    );
    let executable;
    try {
      await access(piBin);
      executable = piBin;
    } catch {
      try {
        // npm may hoist dependencies outside the package; resolve from this installed module.
        piEntry = fileURLToPath(
          new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
        );
        await access(piEntry);
        executable = piEntry;
      } catch {
        console.error("CoworkOS Agent 运行时未安装完整，请运行 npm ci 或重新安装 CLI。");
        process.exit(1);
      }
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
      // would lose the model env, vision connection and supervisor autostart.
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
      await projectExecution?.release().catch(() => {});
      console.error(error.message);
      process.exit(1);
    }
    // The CLI reads the same execution-host role defaults as the Dashboard. An
    // explicit --model or a model forced by the launch environment still wins;
    // a role-selected connection supplies its key, endpoint and profile.
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
      ...(hasExtension ? [] : ["--extension", resolve(harnessRoot, ".pi", "extensions", "cowork.ts")]),
      ...(hasModel ? [] : ["--provider", providerId, "--model", configuredModel]),
      // Pass the level explicitly: Pi otherwise restores old session defaults,
      // including the "off" value written by earlier Cowork launches.
      ...(thinkingIndex >= 0 ? [] : ["--thinking", thinkingLevel]),
      "--append-system-prompt",
      coworkPrompt,
      ...(projectDirectory !== harnessRoot ? ["--skill", resolve(harnessRoot, ".pi", "skills")] : []),
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
    const childEnv = {
      ...process.env,
      ...runtimeEnv,
      ...roleEnv,
      ...visionModelEnv(launchConfig),
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
      COWORK_CLI_TASK_EXPLICIT: explicitTaskId ? "1" : "0",
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      // Application MCP servers are owned by the Dashboard, so the agent reaches
      // their tools over HTTP. Absent for a run with no Dashboard, which simply
      // means no application-specific tools.
      ...(process.env.COWORK_DASHBOARD_URL ? { COWORK_DASHBOARD_URL: process.env.COWORK_DASHBOARD_URL } : {})
    };
    let supervisor;
    let onSdkReady;
    const supervisorEntry = resolve(harnessRoot, "dist", "src", "cli", "cowork.js");
    if (
      process.env.COWORK_DISABLE_WATCH_SUPERVISOR !== "1" &&
      (process.env.COWORK_API_KEY || launchConfig.apiKey) &&
      (process.env.COWORK_API_BASE || launchConfig.baseUrl || launchConfig.apiBase) &&
      (await canAccess(supervisorEntry))
    ) {
      const interval = process.env.COWORK_SUPERVISOR_INTERVAL_MS ?? "60000";
      childEnv.COWORK_SUPERVISOR_AUTOSTART = "1";
      // The loop holds a workspace-wide lock, so its winner must supervise every
      // Task, including Tasks created by later CLI sessions in this workspace.
      const startSupervisor = () => {
        if (supervisor) return;
        supervisor = spawn(
          process.execPath,
          [
            supervisorEntry,
            "watch-supervisor",
            "--workspace",
            workspaceRoot,
            "--interval",
            interval,
            "--supervise-main",
            "true"
          ],
          {
            stdio: "ignore",
            detached: true,
            cwd: process.cwd(),
            env: childEnv
          }
        );
        supervisor.unref();
        supervisor.on("error", () =>
          console.error("CoworkOS 后台监测进程启动失败，请运行 coworkos doctor。")
        );
      };
      if (publicTui) onSdkReady = startSupervisor;
      else startSupervisor();
    }
    process.exitCode = await runCliProcess({
      bootstrap: uiCompatibility
        ? undefined
        : fileURLToPath(new URL("./cli-shell-boot.mjs", import.meta.url)),
      executable: uiCompatibility ? fileURLToPath(new URL("./cli-ui-boot.mjs", import.meta.url)) : executable,
      args,
      env: childEnv,
      projectDirectory,
      uiCompatibility: Boolean(uiCompatibility),
      onSdkReady,
      onStop: () => supervisor?.kill("SIGTERM")
    });
  } finally {
    clearInterval(projectExecutionTimer);
    await projectExecution?.release().catch(() => {});
  }
}

async function canAccess(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
