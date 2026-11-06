import { readFile } from "node:fs/promises";

// SDK 0.87.1 builtin value-consumption rules only. Validation/extension flags
// remain the SDK's responsibility; this scanner never imports the runtime.
const valueFlags = new Set([
  "--provider",
  "--model",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--name",
  "-n",
  "--session",
  "--session-id",
  "--fork",
  "--session-dir",
  "--models",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--thinking",
  "--export",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme"
]);
const guardedValueFlags = new Set(["--mode", "--tui-mode", "--use-theme"]);

export function scanCliArguments(args) {
  const flags = new Map();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--") break;
    if (!flag.startsWith("-")) continue;
    const next = args[index + 1];
    const previous = flags.get(flag);
    flags.set(flag, { index, value: undefined });
    const consumes =
      (valueFlags.has(flag) && next !== undefined) ||
      (guardedValueFlags.has(flag) && next !== undefined && !next.startsWith("-")) ||
      (["--list-models", "--print", "-p"].includes(flag) &&
        next !== undefined &&
        !next.startsWith("@") &&
        (!next.startsWith("-") || (["--print", "-p"].includes(flag) && next.startsWith("---")))) ||
      (flag.startsWith("--") &&
        !flag.includes("=") &&
        !valueFlags.has(flag) &&
        !guardedValueFlags.has(flag) &&
        ![
          "--help",
          "--version",
          "--continue",
          "--resume",
          "--no-session",
          "--no-tools",
          "--no-builtin-tools",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "--verbose",
          "--approve",
          "--no-approve",
          "--offline"
        ].includes(flag) &&
        next !== undefined &&
        !next.startsWith("-") &&
        !next.startsWith("@"));
    if (consumes) {
      flags.get(flag).value = next;
      index++;
    }
    if (flag === "--mode") {
      const current = flags.get(flag);
      const valid = ["text", "json", "rpc"].includes(current.value);
      current.effectiveValue = valid ? current.value : previous?.effectiveValue;
      current.fatalValueError = Boolean(previous?.fatalValueError || !valid);
    }
  }
  return flags;
}

export function classifyCliInformation(args) {
  const flags = scanCliArguments(args);
  if (flags.has("--help") || flags.has("-h")) return "help";
  if (flags.has("--version") || flags.has("-v")) {
    if (args.length !== 1) throw new Error("版本查询不接受执行参数；请单独运行 coworkos --version。");
    return "version";
  }
  return undefined;
}

export async function printAtriaVersion() {
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  console.log(`CoworkOS ${version}`);
}

export function isInteractiveCli(args, stdinIsTTY, stdoutIsTTY) {
  const flags = scanCliArguments(args);
  const modeFlag = flags.get("--mode");
  const mode = modeFlag?.effectiveValue;
  return Boolean(
    stdinIsTTY &&
    stdoutIsTTY &&
    !modeFlag?.fatalValueError &&
    mode !== "json" &&
    mode !== "rpc" &&
    !["--print", "-p", "--help", "-h", "--version", "-v", "--list-models", "--export"].some((flag) =>
      flags.has(flag)
    )
  );
}

export function printAtriaHelp() {
  console.log(`CoworkOS — local multi-agent harness

Usage:
  coworkos init                 Configure a model (API Key input is hidden)
  coworkos doctor               Check Node, dependencies and configuration
  coworkos doctor --test-connection  Test streaming, tools and optional vision (uses model quota)
  coworkos desktop install [--directory PATH]  Install the published Mac App
  coworkos update [--check]     Update this source checkout or installed CLI package
  coworkos update --channel preview  Use preview releases for an installed CLI package
  coworkos [start] [options]    Start Main in the current project; Main can delegate Subagents
  coworkos --continue          Restore the latest conversation and its Task in this project
  coworkos --session ID|PATH   Restore a specific conversation
  coworkos --resume            Choose a saved conversation; enter 0 to cancel
  coworkos session export ID|PATH [--format json|html] [--output FILE] [--force]
                            Export locally, without model calls or uploads
  coworkos task list|create|status|cancel|resume|complete ...
  coworkos human list|reply|answer|cancel ...
  coworkos watch profiles|create|add|status ...
  coworkos watch-file|watch-research|watch-run|watch-supervisor ...
  coworkos main-supervisor ...   Inspect recovery; --spawn permits launching Main
  coworkos single PROMPT ...    Run the lower-level single-agent interface
  coworkos worker ...           Process delegated work
  coworkos main-worker ...      Internal wake worker
  coworkos COMMAND --help        Show command options without changing user data
  coworkos science status      Show installed scientific environments without probing Python
  coworkos science install general|chemistry [--python PATH] [--reinstall]
  coworkos science cancel general|chemistry
  coworkos data paths           Show persistent data paths
  coworkos data import --from PATH [--kind desktop|workspace] [--name NAME]
  coworkos --version

Non-interactive setup:
  coworkos init --base-url https://YOUR-HOST/v1 --model YOUR-MODEL --api-key-env COWORK_API_KEY
  Optional: --images --reasoning --thinking high --max-tokens 8192 --force

Config: COWORK_CONFIG, then project .cowork/config.json / config.json, then ~/.atria/config.json.
Environment overrides config. ATRIA_HOME relocates App, CLI and Web data together.
No configuration values or API keys are printed by doctor.
Source checkout: run npm run build:cli once before use; rebuild after changing source.`);
}
