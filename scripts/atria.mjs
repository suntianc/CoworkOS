#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { atriaHome, atriaDataPaths } from "./data-home.cjs";
import { classifyCliInformation, printAtriaHelp, printAtriaVersion } from "./cli-information.mjs";

const harness = fileURLToPath(new URL("../", import.meta.url));
const userHome = atriaHome();
const cwd = process.cwd();
const local = [join(cwd, ".cowork/config.json"), join(cwd, "config.json")].find(existsSync);
const configPath = resolve(process.env.COWORK_CONFIG || local || join(userHome, "config.json"));
const args = process.argv.slice(2);
const command = args.shift() || "start";

async function help(topic) {
  if (topic === "desktop") {
    const { runDesktop } = await import("./desktop.mjs");
    await runDesktop({ args: ["--help"] });
    return;
  }
  if (topic === "init") {
    console.log(`Usage: coworkos init [--base-url URL] [--model ID] [--api-key-env NAME]
  --images                   Enable image input
  --reasoning                Enable reasoning parameters
  --thinking off|minimal|low|medium|high|xhigh|max
  --max-tokens N             Output limit, integer 1–65536
  --force                    Update an existing configuration
  -h, --help                 Show help without writing configuration
API Key input is hidden. Use an environment variable for non-interactive setup.`);
    return;
  }
  if (topic === "doctor") {
    console.log(`Usage: coworkos doctor [--test-connection]
  --test-connection  Test the model connection; sends a request and uses quota
  -h, --help         Show help without probing or changing user data
The default check runs locally and does not send model requests.`);
    return;
  }
  if (topic === "backend") {
    console.log(`Usage: coworkos backend <start|status|stop>
  start    Start a detached backend for the current data root, or report the running one
  status   Report the backend instance for the current data root
  stop     Ask the backend to finish managed work and exit
The backend keeps running after the client that started it exits. It never installs a system service.`);
    return;
  }
  if (topic === "data") {
    console.log(`Usage: coworkos data paths
       coworkos data import --from PATH [--kind desktop|workspace] [--name NAME]
       coworkos data backup --to PATH
       coworkos data restore --from PATH
  -h, --help  Show help without importing or changing user data
Import copies legacy data and preserves its original directory. Backup writes one
logical snapshot of the project ledger; restore replaces it from the same engine.`);
    return;
  }
  if (topic) {
    const { cliHelp } = await import("../dist/src/cli/commands.js");
    console.log(cliHelp(topic, args[1]));
    return;
  }
  printAtriaHelp();
}

function flags(values, allowed) {
  const result = {};
  for (let index = 0; index < values.length; index++) {
    const flag = values[index];
    if (!allowed.includes(flag)) throw new Error(`Unknown option: ${flag}`);
    if (["--images", "--reasoning", "--force", "--test-connection"].includes(flag)) result[flag] = true;
    else {
      const value = values[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (
        flag === "--max-tokens" &&
        (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 65536)
      )
        throw new Error("--max-tokens requires an integer from 1 to 65536");
      if (
        flag === "--thinking" &&
        !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
      )
        throw new Error("--thinking requires off|minimal|low|medium|high|xhigh|max");
      result[flag] = value;
    }
  }
  return result;
}

async function runtime() {
  if (!existsSync(join(harness, "dist/src/runtime/config.js")))
    throw new Error("CLI 尚未构建，请在源码仓库执行 npm run build:cli；安装包用户请重新安装完整 CLI 包。");
  return {
    ...(await import("../dist/src/runtime/config.js")),
    ...(await import("../dist/src/runtime/model-profile.js")),
    ...(await import("../dist/src/runtime/runtime-settings.js"))
  };
}

function validateConnection(config, env = process.env) {
  const baseUrl = env.COWORK_API_BASE ?? config.baseUrl ?? config.apiBase;
  const model = env.COWORK_MODEL ?? config.model;
  const apiKey = env.COWORK_API_KEY ?? config.apiKey;
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("请配置有效的 API 地址；运行 coworkos init 或修改所选配置文件。");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("API 地址须为不含凭据、查询参数或片段的 HTTP(S) 地址。");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model || ""))
    throw new Error("请填写服务商提供的模型 ID。");
  if (!apiKey || apiKey === "replace-with-your-api-key" || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey))
    throw new Error("请配置 API Key；运行 coworkos init，或设置 COWORK_API_KEY。");
  return { baseUrl: url.href.replace(/\/+$/, ""), model, apiKey };
}

async function secret() {
  process.stdout.write("API Key（输入隐藏）: ");
  emitKeypressEvents(process.stdin);
  const previous = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((done, reject) => {
    let value = "";
    const finish = (error) => {
      process.stdin.removeListener("keypress", onKey);
      process.stdin.setRawMode(previous);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else done(value);
    };
    const onKey = (text, key = {}) => {
      if (key.ctrl && key.name === "c") return finish(new Error("配置已取消，未保存。"));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") value = value.slice(0, -1);
      else if (!key.ctrl && !key.meta && text) value += text;
    };
    process.stdin.on("keypress", onKey);
  });
}

async function init() {
  const options = flags(args, [
    "--base-url",
    "--model",
    "--api-key-env",
    "--images",
    "--reasoning",
    "--thinking",
    "--max-tokens",
    "--force"
  ]);
  const { readCoworkConfig, connectionProfile, parseConnectionProfile, NEW_CONNECTION_PROFILE } =
    await runtime();
  if (existsSync(configPath) && !options["--force"])
    throw new Error("配置已存在，未覆盖。修改该文件，或用 coworkos init --force 明确更新；其他设置会保留。");
  const previous = existsSync(configPath) ? readCoworkConfig(cwd, { COWORK_CONFIG: configPath }) : {};
  let baseUrl = options["--base-url"] ?? previous.baseUrl;
  let model = options["--model"] ?? previous.model;
  const keyEnv = options["--api-key-env"];
  let apiKey = keyEnv ? process.env[keyEnv] : (process.env.COWORK_API_KEY ?? previous.apiKey);
  if (keyEnv && !apiKey) throw new Error("指定的 API Key 环境变量为空，未保存。");
  if ((!baseUrl || !model || !apiKey) && process.stdin.isTTY && process.stdout.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!baseUrl) baseUrl = (await prompt.question("API 地址（根地址或 /v1）: ")).trim();
      if (!model) model = (await prompt.question("模型 ID: ")).trim();
    } finally {
      prompt.close();
    }
    if (!apiKey) apiKey = await secret();
  }
  const connection = validateConnection({ baseUrl, model, apiKey }, {});
  const profile = parseConnectionProfile(
    {
      ...NEW_CONNECTION_PROFILE,
      ...(previous.baseUrl || previous.apiBase ? { api: connectionProfile(previous).api } : {}),
      ...previous,
      ...(options["--reasoning"] ? { supportsReasoningEffort: true, reasoningEffort: "high" } : {}),
      ...(options["--thinking"] ? { reasoningEffort: options["--thinking"] } : {}),
      ...(options["--max-tokens"]
        ? {
            mainMaxTokens: Number(options["--max-tokens"]),
            subagentMaxTokens: Number(options["--max-tokens"])
          }
        : {})
    },
    NEW_CONNECTION_PROFILE
  );
  const next = {
    ...previous,
    ...connection,
    ...profile,
    supportsImages: options["--images"] || previous.supportsImages === true,
    workspaceRoot: previous.workspaceRoot ?? join(userHome, "workspace")
  };
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (options["--force"]) await rename(temporary, configPath);
    else {
      // Exclusive creation also protects against a concurrent first setup.
      const { link } = await import("node:fs/promises");
      await link(temporary, configPath);
    }
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(
    `连接配置已保存：${configPath}\nCLI 密钥以本机权限 0600 保存；模型测试请运行 coworkos doctor --test-connection。`
  );
}

function cliDataPaths(config = {}) {
  const paths = atriaDataPaths(process.env, config, cwd);
  return { workspace: paths.workspaceRoot, pi: paths.piAgentDir };
}

async function dataCommand() {
  const action = args.shift() || "paths";
  const options = flags(
    args,
    action === "import"
      ? ["--from", "--kind", "--name"]
      : action === "backup"
        ? ["--to"]
        : action === "restore"
          ? ["--from"]
          : []
  );
  if (!["paths", "import", "backup", "restore"].includes(action))
    throw new Error(
      "Usage: coworkos data paths|import --from PATH [--kind desktop|workspace]|backup --to PATH|restore --from PATH"
    );
  if (action === "import" && typeof options["--from"] !== "string")
    throw new Error("data import 需要 --from <旧数据目录>");
  if (options["--kind"] && !["desktop", "workspace"].includes(options["--kind"]))
    throw new Error("--kind requires desktop or workspace");
  const { readCoworkConfig } = await runtime();
  const config = readCoworkConfig(cwd);
  const paths = atriaDataPaths(process.env, config, cwd);
  if (action === "paths") {
    const appData =
      process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : process.platform === "win32"
          ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
          : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    const legacyCandidates = [
      join(appData, "Atria"),
      join(appData, "Atria Dev"),
      join(appData, "CoworkOS"),
      join(appData, "CoworkOS Dev"),
      join(harness, ".tmp")
    ].filter((path) => path !== paths.home && existsSync(path));
    console.log(JSON.stringify({ ...paths, configPath, legacyCandidates }, null, 2));
    return;
  }
  if (action === "backup" || action === "restore") {
    const option = action === "backup" ? "--to" : "--from";
    const file = options[option];
    if (typeof file !== "string" || !file.trim())
      throw new Error(`data ${action} 需要 ${option} <备份文件路径>`);
    const { ProjectDataRuntime } = await import("../dist/src/workspace/project-data-service.js");
    const runtime = new ProjectDataRuntime({
      config: config.projectData,
      env: process.env,
      configPath,
      dataRoot: dirname(paths.globalIndex)
    });
    try {
      const service = await runtime.service();
      const result =
        action === "backup"
          ? await service.backupTo(resolve(file))
          : await service.restoreFrom(resolve(file));
      console.log(JSON.stringify({ engine: service.description.engine, ...result }, null, 2));
    } finally {
      await runtime.close();
    }
    return;
  }
  const { importLegacyData } = await import("./data-migration.cjs");
  const result = await importLegacyData({
    source: options["--from"],
    home: paths.home,
    kind: options["--kind"] || "desktop",
    ...(options["--name"] ? { name: options["--name"] } : {})
  });
  const { GlobalWorkspaceCatalog } = await import("../dist/src/workspace/global-catalog.js");
  const catalog = new GlobalWorkspaceCatalog(paths.globalIndex);
  for (const root of result.catalogRoots) await catalog.register(root);
  console.log(JSON.stringify(result, null, 2));
  console.log("原始目录已保留。重启 App 后导入会话会出现在历史列表；默认新会话仍使用统一 workspace。");
}

async function doctor() {
  const options = flags(args, ["--test-connection"]);
  let failed = false;
  const check = async (name, action) => {
    try {
      const note = await action();
      console.log(`OK  ${name}${note ? ` — ${note}` : ""}`);
    } catch (error) {
      failed = true;
      console.error(`FAIL ${name} — ${error.message}`);
    }
  };
  console.log(`CoworkOS doctor\n配置路径：${configPath}`);
  await check("Node.js", () => {
    requireNode();
    return process.version;
  });
  let modules;
  await check("CLI 构建", async () => {
    modules = await runtime();
  });
  await check("Agent 运行时（Pi 依赖）", async () => {
    await import("@earendil-works/pi-coding-agent");
  });
  let config, input;
  await check("模型配置", () => {
    if (!modules) throw new Error("先修复 CLI 构建。");
    config = modules.readHostCoworkConfig(cwd, {
      COWORK_CONFIG: existsSync(configPath) || process.env.COWORK_CONFIG ? configPath : undefined
    });
    input = {
      ...validateConnection(config),
      ...modules.parseConnectionProfile(modules.connectionProfile(config), modules.NEW_CONNECTION_PROFILE),
      supportsImages: modules.configuredSupportsImages(modules.runtimeSettingsEnv(config))
    };
  });
  await check("工作区写入", async () => {
    const workspace = cliDataPaths(config).workspace;
    await mkdir(workspace, { recursive: true });
    const probe = join(workspace, `.atria-doctor-${randomUUID()}`);
    try {
      await writeFile(probe, "", { flag: "wx", mode: 0o600 });
    } finally {
      await rm(probe, { force: true });
    }
  });
  await check("离线文件查找与内容搜索", async () => {
    const { verifySearchToolInstallation } = await import("./search-tool-adapter.mjs");
    return verifySearchToolInstallation(resolve(cliDataPaths(config).pi));
  });
  if (options["--test-connection"] && input)
    await check("流式模型连接与工具调用", async () => {
      const { testModelConnection } = await import("../dist/src/runtime/model-connection.js");
      await testModelConnection(input);
    });
  else if (!options["--test-connection"])
    console.log("未发送模型请求。加 --test-connection 可验证真实连接，会消耗额度。");
  console.log("桌面窗口操作为可选宿主能力；此检查不要求安装它。");
  process.exitCode = failed ? 1 : 0;
}

function requireNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error("需要 Node.js >=22.19，请升级后重试。");
}

async function sessionExport(values) {
  // Export redaction must cover every effective key, including host-stored ones.
  const { readHostCoworkConfig } = await runtime();
  const config = readHostCoworkConfig(cwd);
  const data = cliDataPaths(config);
  const { exportCliSession, parseSessionExportArgs } = await import("./cli-session-export.mjs");
  const result = await exportCliSession({
    ...parseSessionExportArgs(values),
    agentDir: data.pi,
    workspaceRoot: data.workspace,
    directory: cwd,
    secrets: [
      process.env.COWORK_API_KEY,
      config.apiKey,
      process.env.COWORK_VISION_API_KEY,
      process.env.COWORK_SERPER_API_KEY,
      process.env.SERPER_API_KEY,
      config.serperApiKey,
      config.webSearch?.exaApiKey,
      process.env.COWORK_EXA_API_KEY,
      process.env.EXA_API_KEY,
      ...(config.modelConnections?.profiles.map((profile) => profile.apiKey) ?? [])
    ].filter(Boolean)
  });
  console.log(JSON.stringify(result));
}

// Keep the old offline HTML-export spelling without launching the agent engine.
function legacySessionExport(values) {
  const index = values.indexOf("--export");
  const boundary = values.indexOf("--");
  if (index < 0 || (boundary >= 0 && index > boundary)) return undefined;
  const source = values[index + 1];
  if (!source || source.startsWith("--")) throw new Error("--export requires a session ID or path");
  const rest = values.filter((_value, position) => position !== index && position !== index + 1);
  if (rest.some((value) => !["--output", "--force"].includes(value) && value.startsWith("--")))
    throw new Error("--export 不能与运行参数混用；请使用 coworkos session export。");
  if (rest.length && !rest[0].startsWith("--")) rest.splice(0, 1, "--output", rest[0]);
  return [source, "--format", "html", ...rest];
}

async function launch() {
  requireNode();
  let workerArgs = args;
  const boundary = args.indexOf("--");
  const optionArgs = boundary < 0 ? args : args.slice(0, boundary);
  const helpOnly = optionArgs.some((argument) => ["--help", "-h"].includes(argument));
  if (command === "main-worker") {
    const { cliHelp, parseCliCommand } = await import("../dist/src/cli/commands.js");
    const parsed = parseCliCommand(command, args);
    if (parsed.help) {
      console.log(cliHelp(command));
      return;
    }
    if (!parsed.options.task && !process.env.COWORK_TASK_ID)
      throw new Error("main-worker requires --task ID");
    if (!parsed.options.task && !/^(?!\.{1,2}$)[a-zA-Z0-9._-]+$/.test(process.env.COWORK_TASK_ID))
      throw new Error("COWORK_TASK_ID requires a valid task ID");
    workerArgs = Object.entries(parsed.options).flatMap(([name, value]) => [`--${name}`, value]);
  }
  const { readHostCoworkConfig } = await runtime();
  const explicit = process.env.COWORK_CONFIG;
  const config = helpOnly
    ? {}
    : readHostCoworkConfig(cwd, {
        COWORK_CONFIG: existsSync(configPath) || explicit ? configPath : undefined
      });
  const pi = command === "start" || command.startsWith("-");
  if (pi && !args.includes("--help") && ![command, ...args].includes("-h") && command !== "--help")
    validateConnection(config);
  const data = cliDataPaths(config);
  const env = {
    ...process.env,
    COWORK_HARNESS_ROOT: harness,
    COWORK_PROJECT_DIR: process.env.COWORK_PROJECT_DIR || cwd,
    COWORK_WORKSPACE: data.workspace,
    PI_CODING_AGENT_DIR: data.pi,
    ...(pi ? { COWORK_CLI_SESSION: "1" } : {}),
    ...(existsSync(configPath) || explicit ? { COWORK_CONFIG: configPath } : {})
  };
  const entry = pi
    ? "scripts/start-pi.mjs"
    : command === "main-worker"
      ? "scripts/main-worker.mjs"
      : "dist/src/cli/cowork.js";
  const forwarded = pi
    ? command === "start"
      ? args
      : [command, ...args]
    : command === "main-worker"
      ? workerArgs
      : [command, ...args];
  // Main starts from the user's project, while extensions and workers use the immutable install root.
  const child = spawn(process.execPath, [join(harness, entry), ...forwarded], {
    cwd: pi ? cwd : harness,
    env,
    stdio: "inherit"
  });
  const interrupt = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  child.once("error", () => {
    console.error("CLI 子进程启动失败，请运行 coworkos doctor。");
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

try {
  const startInformation =
    command === "start" || (command.startsWith("-") && !["--version", "-v"].includes(command))
      ? classifyCliInformation(command === "start" ? args : [command, ...args])
      : undefined;
  const exportArgs =
    command === "start" || command.startsWith("-")
      ? legacySessionExport(command === "start" ? args : [command, ...args])
      : undefined;
  if (
    ["--help", "-h", "help"].includes(command) ||
    (["init", "doctor", "data", "backend", "start", "session"].includes(command) &&
      (command === "start"
        ? startInformation === "help"
        : args.some((argument) => ["--help", "-h"].includes(argument))))
  )
    await help(
      command === "help"
        ? args[0]
        : ["init", "doctor", "data", "backend"].includes(command)
          ? command
          : undefined
    );
  else if (["--version", "-v"].includes(command)) {
    if (args.length) throw new Error("coworkos --version does not accept options");
    await printAtriaVersion();
  } else if (startInformation === "version") await printAtriaVersion();
  else if (startInformation === "help") printAtriaHelp();
  else if (command === "session") {
    if (args.shift() !== "export")
      throw new Error(
        "Usage: coworkos session export ID|PATH [--format json|html] [--output FILE] [--force]"
      );
    await sessionExport(args);
  } else if (exportArgs) await sessionExport(exportArgs);
  else if (command === "desktop") {
    requireNode();
    const { runDesktop } = await import("./desktop.mjs");
    await runDesktop({ root: harness, args });
  } else if (command === "backend") {
    requireNode();
    const { runBackendCommand } = await import("../dist/src/cli/backend.js");
    process.exitCode = await runBackendCommand(args);
  } else if (command === "data") await dataCommand();
  else if (command === "init") {
    requireNode();
    await init();
  } else if (command === "doctor") await doctor();
  else if (command === "update") {
    requireNode();
    const { runUpdate } = await import("./update.mjs");
    await runUpdate({ root: harness, args });
  } else await launch();
} catch (error) {
  const key = process.env.COWORK_API_KEY;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`CoworkOS: ${key ? message.replaceAll(key, "[REDACTED]") : message}`);
  process.exitCode = 1;
}
