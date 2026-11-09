const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { backendExecutable } = require("./backend-executable.cjs");
const { desktopBackendEnvironment } = require("./backend-environment.cjs");
const { createComputerHost } = require("./computer-host.cjs");

/**
 * The desktop client of the execution host.
 *
 * The app no longer owns a private backend child: it attaches to the data
 * root's serving instance through the same lifecycle the CLI uses, so a desktop
 * launch, `backend start` and the development dashboard all resolve to one
 * process. The backend outlives this client — quitting the app must not stop a
 * task it already accepted — and the next launch finds the same instance again.
 *
 * The instance record is the only thing read from disk: it is the host
 * credential the renderer's local session is derived from. Business data stays
 * on the HTTP protocol the browser also uses.
 */

function instancePath(paths) {
  return path.join(paths.userData, "runtime", "backend-instance.json");
}

/** Validate the record the serving process published; a partial one is not usable. */
function validInstance(value) {
  if (!value || typeof value !== "object") return undefined;
  if (value.version !== 1) return undefined;
  if (typeof value.backendId !== "string" || !value.backendId) return undefined;
  if (!Number.isInteger(value.pid) || value.pid <= 0) return undefined;
  if (!Number.isInteger(value.port) || value.port <= 0 || value.port > 65535) return undefined;
  if (typeof value.url !== "string" || !value.url) return undefined;
  if (typeof value.token !== "string" || !value.token) return undefined;
  if (typeof value.startedAt !== "string" || !value.startedAt) return undefined;
  return value;
}

async function readInstance(paths) {
  let raw;
  try {
    raw = await fs.readFile(instancePath(paths), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("本地服务的实例记录不存在，请重启 CoworkOS");
    throw error;
  }
  let value;
  try {
    value = validInstance(JSON.parse(raw));
    // eslint-disable-next-line no-restricted-syntax -- the instance record is read from disk, so a partially written or corrupt file is not parseable JSON
  } catch {
    value = undefined;
  }
  if (!value) throw new Error(`本地服务的实例记录无法解析：${instancePath(paths)}`);
  return value;
}

/**
 * The environment the execution host starts with.
 *
 * Model settings normally come from the execution host's configuration. The
 * optional legacy input is retained for callers that explicitly supply it.
 */
async function backendEnvironment(paths, settings) {
  let legacySettings = {};
  if (settings) {
    const { visionModelEnv } = await import("../dist/src/runtime/vision-config.js");
    legacySettings = {
      COWORK_API_BASE: settings.baseUrl || "",
      COWORK_API_KEY: settings.apiKey || "",
      ...(settings.webSearch?.exaApiKey ? { COWORK_EXA_API_KEY: settings.webSearch.exaApiKey } : {}),
      COWORK_MODEL: settings.model || "glm-5.3",
      COWORK_VISION_API_BASE: "",
      COWORK_VISION_API_KEY: "",
      COWORK_VISION_MODEL: "",
      COWORK_VISION_MODEL_API: "",
      ...visionModelEnv(settings, {})
    };
  }
  return {
    ...desktopBackendEnvironment(),
    ELECTRON_RUN_AS_NODE: "1",
    ATRIA_HOME: paths.userData,
    COWORK_HARNESS_ROOT: paths.appRoot,
    COWORK_WORKSPACE: paths.workspaceRoot,
    COWORK_GLOBAL_INDEX: paths.globalIndex,
    COWORK_TABS_INDEX: paths.tabsIndex,
    PI_CODING_AGENT_DIR: paths.piAgentDir,
    COWORK_CONFIG: paths.configPath,
    COWORK_UI_DIR: path.join(paths.appRoot, "web"),
    ...legacySettings
  };
}

/**
 * Attach to this data root's backend, starting the detached instance if none serves it.
 *
 * Returns the host credential and identity the renderer needs for its local
 * session. `stop` is for the two explicit actions that replace the serving
 * process — settings restarts and updates — never for quitting the app.
 */
async function connectBackend(paths, settings, executable = process.execPath) {
  const env = await backendEnvironment(paths, settings);
  const runtime = backendExecutable(executable, process.platform, paths.appRoot);
  const entry = path.join(paths.appRoot, "dist/src/cli/backend.js");
  const { startBackend, stopBackend } = await import(pathToFileURL(entry).href);
  const status = await startBackend(env, paths.appRoot, runtime);
  const instance = await readInstance(paths);
  if (
    instance.backendId !== status.backendId ||
    instance.pid !== status.pid ||
    instance.url !== status.url ||
    instance.startedAt !== status.startedAt
  )
    throw new Error("本地服务的实例记录与启动结果不一致，请重试");
  return {
    backendId: instance.backendId,
    pid: instance.pid,
    port: instance.port,
    url: instance.url,
    token: instance.token,
    startedAt: instance.startedAt,
    computer: createComputerHost({ expected: instance, inspect: () => readInstance(paths) }),
    stop: () => stopBackend(env, instance)
  };
}

module.exports = { connectBackend, backendEnvironment, readInstance, instancePath };
