const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { backendExecutable } = require("./backend-executable.cjs");
const { desktopBackendEnvironment } = require("./backend-environment.cjs");

async function availablePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  return port;
}
/** Readiness comes from our child via IPC, never from an arbitrary process on a fixed port. */
async function startBackend(paths, settings, executable = process.execPath) {
  const { visionModelEnv } = await import("../dist/src/runtime/vision-config.js");
  const visionEnv = visionModelEnv(settings, {});
  const port = await availablePort();
  const token = crypto.randomBytes(32).toString("hex");
  const inheritedEnv = desktopBackendEnvironment();
  const child = spawn(
    backendExecutable(executable, process.platform, paths.appRoot),
    [path.join(paths.appRoot, "dist/src/cli/dashboard.js")],
    {
      cwd: paths.appRoot,
      env: {
        ...inheritedEnv,
        ELECTRON_RUN_AS_NODE: "1",
        ATRIA_HOME: paths.userData,
        COWORK_UI_PORT: String(port),
        COWORK_HARNESS_ROOT: paths.appRoot,
        COWORK_WORKSPACE: paths.workspaceRoot,
        COWORK_GLOBAL_INDEX: paths.globalIndex,
        COWORK_TABS_INDEX: paths.tabsIndex,
        PI_CODING_AGENT_DIR: paths.piAgentDir,
        COWORK_CONFIG: paths.configPath,
        COWORK_UI_DIR: path.join(paths.appRoot, "web"),
        COWORK_API_TOKEN: token,
        COWORK_API_BASE: settings.baseUrl || "",
        COWORK_API_KEY: settings.apiKey || "",
        ...(settings.webSearch?.exaApiKey ? { COWORK_EXA_API_KEY: settings.webSearch.exaApiKey } : {}),
        COWORK_MODEL: settings.model || "glm-5.3",
        COWORK_VISION_API_BASE: "",
        COWORK_VISION_API_KEY: "",
        COWORK_VISION_MODEL: "",
        COWORK_VISION_MODEL_API: "",
        ...visionEnv
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: process.platform !== "win32"
    }
  );
  const log = fs.createWriteStream(path.join(paths.logs, "dashboard.log"), { flags: "a", mode: 0o600 });
  const secrets = [settings.apiKey, visionEnv.COWORK_VISION_API_KEY, settings.webSearch?.exaApiKey].filter(
    Boolean
  );
  const record = (chunk) =>
    log.write(secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), String(chunk)));
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  child.once("close", () => log.end());
  const closed = new Promise((done) => child.once("close", done));
  const computerRequests = new Map();
  child.on("message", (message) => {
    if (message?.type !== "computer.reply") return;
    const pending = computerRequests.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    computerRequests.delete(message.requestId);
    message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result);
  });
  child.once("close", () => {
    for (const pending of computerRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Computer Use 本地服务已退出"));
    }
    computerRequests.clear();
  });
  const computer = (input) =>
    new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(
        () => {
          computerRequests.delete(requestId);
          reject(new Error("Computer Use 请求超时"));
        },
        input?.operation === "permissions" ? 5 * 60_000 + 5_000 : 20_000
      );
      computerRequests.set(requestId, { resolve, reject, timer });
      child.send({ type: "computer.host", requestId, input }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        computerRequests.delete(requestId);
        reject(error);
      });
    });
  let stopping;
  const stop = () =>
    (stopping ||= (async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      let timer;
      try {
        await Promise.race([
          closed,
          new Promise((done) => {
            timer = setTimeout(done, 5_000);
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else if (child.exitCode === null) child.kill("SIGKILL");
      } catch {
        /* group already exited */
      }
      await closed;
    })());
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("本地服务启动超时")), 15_000);
      function finish(error) {
        clearTimeout(timer);
        child.off("message", ready);
        child.off("error", failed);
        child.off("exit", exited);
        error ? reject(error) : resolve();
      }
      const failed = () => finish(new Error("本地服务无法启动，请查看诊断日志"));
      const exited = () => finish(new Error("本地服务在启动期间退出，请查看诊断日志"));
      const ready = (message) => {
        if (message?.type === "dashboard.ready" && message.url === `http://127.0.0.1:${port}`) finish();
      };
      child.on("message", ready);
      child.once("error", failed);
      child.once("exit", exited);
    });
    return { child, url: `http://127.0.0.1:${port}`, token, stop, computer };
  } catch (error) {
    await stop();
    throw error;
  }
}
module.exports = { startBackend };
