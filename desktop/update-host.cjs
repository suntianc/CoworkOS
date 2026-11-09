const path = require("node:path");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { createDesktopUpdates } = require("./updates.cjs");
const { isSignedMacApplication } = require("./update-signature.cjs");
const { createManagedUpdateInstaller } = require("./update-install.cjs");

/** Installed builds use a local installer; source builds retain their development updater. */
async function createApplicationUpdateHost(options) {
  if (options.profile.development) return createDesktopUpdateHost(options);
  const manifest = JSON.parse(await fs.readFile(path.join(options.profile.appRoot, "package.json"), "utf8"));
  const state = {
    mode: "release",
    phase: "manual",
    installMethod: "manual",
    currentVersion: manifest.version,
    busy: false,
    available: false
  };
  return {
    status: () => ({ ...state }),
    async check(input = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)
        throw new Error("更新检查不接受配置参数");
      return { ...state };
    },
    async apply() {
      throw new Error("请使用本地安装包手动升级 CoworkOS");
    },
    async dispose() {}
  };
}

/** The host owns preferences and installation side effects; the coordinator owns update state. */
async function createDesktopUpdateHost(options) {
  const {
    profile,
    userData,
    autoUpdater,
    onStatus,
    beforeApply,
    recover,
    quitForSource,
    installNative,
    quitForManaged,
    executable = process.execPath,
    env = process.env
  } = options;
  const manifest = JSON.parse(await fs.readFile(path.join(profile.appRoot, "package.json"), "utf8"));
  const managedInstaller = profile.development
    ? undefined
    : options.managedInstaller || createManagedUpdateInstaller({ executable, userData });
  const nodeExecutable = env.COWORK_DESKTOP_NODE_EXECUTABLE;
  const npmCli = env.COWORK_DESKTOP_NPM_CLI;
  let active = false;
  let applying = false;
  let failure;
  const previousInstall = await managedInstaller?.readResult?.();
  if (["failed", "rolled-back"].includes(previousInstall?.phase)) failure = previousInstall.message;
  function reflect(value) {
    return {
      ...value,
      busy: active || value?.busy === true,
      applying,
      ...(failure
        ? { phase: "error", error: failure, message: failure, installReady: false, needsRelaunch: false }
        : {})
    };
  }
  function publish(value = updates.status()) {
    if (typeof onStatus !== "function") return;
    try {
      const observed = onStatus(reflect(value));
      // eslint-disable-next-line no-restricted-syntax -- onStatus is the fire-and-forget window send; its rejection has no consumer and the host transaction continues
      observed?.catch?.(() => {});
      // eslint-disable-next-line no-restricted-syntax -- the main window may be torn down and onStatus throw synchronously, and publishing must not interrupt the host transaction
    } catch {
      // Window teardown cannot interrupt the host transaction or backend recovery.
    }
  }
  function recordFailure(error) {
    failure =
      typeof error?.message === "string" && error.message ? error.message : "更新未完成，请稍后重试。";
    publish();
  }
  const updates = (options.createUpdates || createDesktopUpdates)({
    mode: profile.development ? "source" : "release",
    root: profile.appRoot,
    currentVersion: manifest.version,
    signed: !profile.development && (await (options.isSigned || isSignedMacApplication)(executable)),
    autoUpdater,
    downloadDirectory: path.join(userData, "updates"),
    toolchain:
      nodeExecutable && path.isAbsolute(nodeExecutable)
        ? { nodeExecutable, ...(npmCli && path.isAbsolute(npmCli) ? { npmCli } : {}) }
        : undefined,
    onStatus: publish,
    beforeApply,
    managedInstaller
  });
  const status = () => reflect(updates.status());
  async function exclusive(isApply, operation) {
    if (active) throw new Error("另一次更新操作正在进行，请稍后重试。");
    active = true;
    applying = isApply;
    failure = undefined;
    publish();
    let value;
    try {
      value = await operation();
    } catch (error) {
      recordFailure(error);
      throw error;
    } finally {
      active = false;
      applying = false;
      publish();
    }
    return reflect(value);
  }
  return {
    status,
    async dispose() {
      await Promise.all([updates.dispose(), managedInstaller?.dispose()]);
    },
    check(input = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)
        return Promise.reject(new Error("更新检查不接受配置参数"));
      const pendingRestart = profile.development && updates.status().updated === true;
      const restartFailure = failure;
      return exclusive(false, async () => {
        if (pendingRestart)
          throw new Error(restartFailure || "源码已更新，请先重启 CoworkOS；重启失败时可重试更新。");
        const value = await updates.check(input);
        return value;
      });
    },
    apply() {
      return exclusive(true, async () => {
        if (profile.development && (!nodeExecutable || !path.isAbsolute(nodeExecutable)))
          throw new Error("请先退出 App，在仓库运行 npm run desktop 刷新开发入口，之后即可在设置中更新。");
        try {
          const value = await updates.apply();
          if (value.installMethod === "managed" && value.installReady) {
            try {
              await managedInstaller.schedule();
              quitForManaged();
            } catch (error) {
              let failure = error;
              try {
                await managedInstaller.discard?.();
              } catch (cleanupError) {
                failure = new Error(error.message + "；暂存清理未完成，请重启 CoworkOS 后重试", {
                  cause: cleanupError
                });
              } finally {
                updates.installationFailed(failure, { discard: true });
              }
              throw failure;
            }
          } else if (value.installReady) {
            try {
              await installNative();
            } catch (error) {
              updates.installationFailed(error);
              throw error;
            }
          } else if (value.updated && value.needsRelaunch) {
            await (options.scheduleRestart || scheduleDevelopmentRestart)({
              root: profile.appRoot,
              userData,
              executable,
              env
            });
            quitForSource();
          } else await recover();
          return value;
        } catch (error) {
          recordFailure(error);
          try {
            await recover();
          } catch {
            throw new Error("本地服务无法恢复，请重新打开 CoworkOS；配置和任务仍在用户数据目录。");
          }
          throw error;
        }
      });
    }
  };
}

async function scheduleDevelopmentRestart({ root, userData, executable, env: environment }) {
  const nodeExecutable = environment.COWORK_DESKTOP_NODE_EXECUTABLE;
  if (!nodeExecutable || !path.isAbsolute(nodeExecutable))
    throw new Error("源码已更新。请退出 App，在仓库运行 npm run desktop 完成首次运行时升级。");
  const directory = path.join(userData, "updates");
  await fs.mkdir(directory, { recursive: true });
  const helper = path.join(directory, "restart-development.mjs");
  const configuration = path.join(directory, "restart-development.json");
  await fs.copyFile(path.join(root, "scripts/restart-development.mjs"), helper);
  await fs.writeFile(
    configuration,
    JSON.stringify({
      root,
      pid: process.pid,
      entry: executable,
      nodeExecutable,
      npmCli: environment.COWORK_DESKTOP_NPM_CLI,
      runtimeEnvironment: {
        COWORK_DESKTOP_DATA: userData,
        ...(environment.COWORK_WORKSPACE
          ? { COWORK_WORKSPACE: path.resolve(environment.COWORK_WORKSPACE) }
          : {})
      }
    }),
    { mode: 0o600 }
  );
  const env = { ...environment };
  for (const name of Object.keys(env)) {
    if (/^(?:COWORK_|PI_|ATRIA_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(name)) delete env[name];
  }
  const log = await fs.open(path.join(directory, "restart-development.log"), "a", 0o600);
  try {
    const child = spawn(nodeExecutable, [helper, configuration], {
      env,
      detached: true,
      stdio: ["ignore", log.fd, log.fd]
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } finally {
    await log.close();
  }
}

module.exports = { createApplicationUpdateHost, createDesktopUpdateHost };
