const path = require("node:path");
const { pathToFileURL } = require("node:url");

function createDesktopUpdates(options) {
  const {
    mode,
    root,
    repository,
    signed = false,
    platform = process.platform,
    arch = process.arch,
    autoUpdater,
    downloadDirectory,
    toolchain,
    commandRunner,
    fetchImpl,
    beforeApply,
    onStatus,
    managedInstaller
  } = options;
  if (mode !== "source" && mode !== "release") throw new Error("Unknown desktop update mode");
  if (typeof root !== "string" || !path.isAbsolute(root))
    throw new Error("Desktop updates require an absolute application root");
  let disposed = false;
  let active = false;
  let checked;
  let nativeReady = false;
  let cancelNative;
  let sourceModule;
  let releaseModule;
  let releaseAbort;
  let pending;
  let state = {
    mode,
    currentVersion: options.currentVersion,
    phase: "idle",
    busy: false,
    available: false,
    installMethod: mode === "source" ? "source" : "managed",
    needsRelaunch: false,
    installReady: false,
    downloaded: false,
    updated: false,
    rebuildRequired: false,
    progress: null
  };

  const status = () => ({ ...state, progress: state.progress ? { ...state.progress } : null });
  function publish(patch) {
    state = { ...state, ...patch };
    if (!disposed && typeof onStatus === "function") {
      try {
        const observed = onStatus(status());
        // eslint-disable-next-line no-restricted-syntax -- the status listener is a fire-and-forget notification, so its rejection must not surface as an unhandled rejection of the update run
        observed?.catch?.(() => {});
        // eslint-disable-next-line no-restricted-syntax -- onStatus forwards to webContents.send, which throws once the trusted window is gone, and a closing window must not abort the running update
      } catch {
        // A closing renderer cannot interrupt installation or source promotion.
      }
    }
  }
  function progress(value) {
    if (disposed) return;
    const entry = typeof value === "string" ? { message: value } : value;
    if (!entry || typeof entry !== "object") return;
    const current = {};
    for (const key of ["phase", "message"])
      if (typeof entry[key] === "string") current[key] = entry[key].slice(0, 1000);
    for (const key of ["downloaded", "total"])
      if (Number.isFinite(entry[key]) && entry[key] >= 0) current[key] = entry[key];
    if (current.total > 0 && Number.isFinite(current.downloaded))
      current.percent = Math.min(100, (current.downloaded / current.total) * 100);
    publish({ progress: current, ...(current.message ? { message: current.message } : {}) });
  }
  async function moduleFor(name) {
    const configured =
      name === "npm-desktop"
        ? options.npmDesktopUpdater || options.releaseUpdater
        : options[`${name}Updater`];
    return typeof configured === "function"
      ? configured()
      : configured || import(pathToFileURL(path.join(root, `scripts/update-${name}.mjs`)).href);
  }
  async function exclusive(operation) {
    if (disposed) throw new Error("Desktop updater has been disposed");
    if (active) throw new Error("An update operation is already running");
    active = true;
    if (mode === "release") releaseAbort = new AbortController();
    publish({ busy: true, error: undefined });
    pending = Promise.resolve().then(() => {
      if (disposed) throw new Error("Desktop updater has been disposed");
      return operation();
    });
    try {
      await pending;
    } catch (error) {
      publish({
        phase: "error",
        error: error?.message || "Desktop update failed",
        message: error?.message || "Desktop update failed",
        installReady: false,
        needsRelaunch: false
      });
      throw error;
    } finally {
      active = false;
      pending = undefined;
      releaseAbort = undefined;
      publish({ busy: false });
    }
    return status();
  }
  function applyCheck(result) {
    checked = result;
    const fields = {};
    for (const key of ["currentVersion", "version", "currentCommit", "remoteCommit", "branch", "releaseUrl"])
      fields[key] = typeof result[key] === "string" ? result[key] : undefined;
    publish({
      ...fields,
      phase: result.available === true ? "available" : "up-to-date",
      available: result.available === true,
      rebuildRequired: result.rebuildRequired === true,
      installMethod: mode === "source" ? "source" : signed === true && result.feedUrl ? "native" : "managed",
      progress: null,
      error: undefined,
      message: typeof result.message === "string" ? result.message : undefined,
      downloaded: false,
      downloadPath: undefined,
      requiresManualInstall: false,
      needsRelaunch: false,
      installReady: false,
      updated: false
    });
  }
  async function performCheck() {
    publish({
      phase: "checking",
      available: false,
      rebuildRequired: false,
      version: undefined,
      remoteCommit: undefined,
      releaseUrl: undefined,
      downloaded: false,
      downloadPath: undefined,
      requiresManualInstall: false,
      needsRelaunch: false,
      installReady: false,
      updated: false,
      progress: null
    });
    if (mode === "source") {
      sourceModule ||= await moduleFor("source");
      applyCheck(
        await sourceModule.checkSourceUpdate({
          root,
          target: "desktop",
          onProgress: progress,
          toolchain,
          commandRunner
        })
      );
    } else {
      if (platform !== "darwin") throw new Error("Packaged desktop updates currently support macOS only");
      releaseModule ||= await moduleFor("npm-desktop");
      applyCheck(
        await (releaseModule.checkNpmDesktopRelease || releaseModule.checkRelease)({
          root,
          repository,
          kind: "mac",
          arch,
          fetchImpl,
          signal: releaseAbort?.signal
        })
      );
    }
  }
  async function prepare() {
    if (typeof beforeApply !== "function")
      throw new Error("The desktop host must prepare documents, tasks and the backend before installation");
    await beforeApply(status());
  }
  function nativeDownload() {
    if (!autoUpdater?.on || !autoUpdater?.removeListener || !autoUpdater?.checkForUpdates)
      throw new Error("The signed application updater is unavailable");
    const feed = new URL(checked.feedUrl);
    if (
      feed.protocol !== "https:" ||
      feed.hostname !== "github.com" ||
      feed.username ||
      feed.password ||
      feed.search ||
      feed.hash ||
      !/^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+\.json$/.test(feed.pathname)
    )
      throw new Error("The signed application update feed is not a GitHub release asset");
    return new Promise((resolve, reject) => {
      const listeners = {
        error: (error) => finish(error),
        "update-not-available": () => finish(undefined, false),
        "update-downloaded": () => finish(undefined, true),
        "checking-for-update": () => progress({ phase: "checking", message: "Checking signed update" }),
        "update-available": () => progress({ phase: "downloading", message: "Downloading signed update" })
      };
      let settled = false;
      function finish(error, downloaded) {
        if (settled) return;
        settled = true;
        for (const [event, listener] of Object.entries(listeners))
          autoUpdater.removeListener(event, listener);
        cancelNative = undefined;
        error ? reject(error) : resolve(downloaded);
      }
      cancelNative = () => finish(new Error("Desktop updater has been disposed"));
      for (const [event, listener] of Object.entries(listeners)) autoUpdater.on(event, listener);
      try {
        autoUpdater.setFeedURL({ url: feed.href, serverType: "json" });
        const result = autoUpdater.checkForUpdates();
        result?.catch?.((error) => finish(error));
      } catch (error) {
        finish(error);
      }
    });
  }

  return {
    status,
    check(input = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input))
        return Promise.reject(new Error("Invalid update check options"));
      if (Object.keys(input).length)
        return Promise.reject(new Error("Update checks do not accept renderer configuration"));
      return exclusive(async () => {
        if (nativeReady || state.downloaded) return;
        checked = undefined;
        await performCheck();
      });
    },
    apply() {
      return exclusive(async () => {
        if (state.updated) {
          await prepare();
          publish({ phase: "ready", needsRelaunch: true, available: false, progress: null });
          return;
        }
        if (!checked) await performCheck();
        if (disposed) throw new Error("Desktop updater has been disposed");
        if (checked.available !== true) return;
        if (mode === "source") {
          await prepare();
          publish({ phase: "updating", progress: null });
          const result = await sourceModule.updateSource({
            root,
            target: "desktop",
            onProgress: progress,
            toolchain,
            commandRunner
          });
          applyCheck(result);
          publish({
            phase: result.updated === true ? "ready" : "up-to-date",
            available: false,
            updated: result.updated === true,
            rebuildRequired: false,
            needsRelaunch: result.updated === true,
            progress: null
          });
        } else if (state.installMethod === "native") {
          if (nativeReady) {
            await prepare();
            publish({ phase: "ready", needsRelaunch: true, installReady: true });
          } else {
            publish({ phase: "downloading", progress: null });
            nativeReady = await nativeDownload();
            publish({
              phase: nativeReady ? "ready" : "up-to-date",
              downloaded: nativeReady,
              available: nativeReady,
              progress: null
            });
            if (!nativeReady) checked.available = false;
          }
        } else if (state.downloaded) {
          await prepare();
          publish({ phase: "ready", needsRelaunch: true, installReady: true });
        } else {
          if (typeof downloadDirectory !== "string" || !path.isAbsolute(downloadDirectory))
            throw new Error("The desktop host must configure an absolute update download directory");
          publish({ phase: "downloading", progress: null });
          const downloadPath = await (
            releaseModule.downloadNpmDesktopRelease || releaseModule.downloadRelease
          )({
            check: checked,
            directory: downloadDirectory,
            onProgress: progress,
            fetchImpl,
            signal: releaseAbort?.signal
          });
          if (disposed) throw new Error("Desktop updater has been disposed");
          if (typeof downloadPath !== "string" || !path.isAbsolute(downloadPath))
            throw new Error("The release helper did not return a verified installer path");
          if (!managedInstaller?.stage) throw new Error("The managed application installer is unavailable");
          await managedInstaller.stage({ archive: downloadPath, check: checked });
          publish({
            phase: "ready",
            downloaded: true,
            downloadPath,
            requiresManualInstall: false,
            needsRelaunch: true,
            progress: null
          });
        }
      });
    },
    // Only the trusted host reports a failed installation; it owns backend recovery.
    installationFailed(error, { discard = false } = {}) {
      if (disposed || (!nativeReady && !state.downloaded)) return status();
      const message =
        typeof error?.message === "string" && error.message
          ? error.message
          : "The signed update could not be installed";
      publish({
        ...(discard ? { downloaded: false, downloadPath: undefined, requiresManualInstall: false } : {}),
        phase: "error",
        error: message,
        message,
        available: nativeReady,
        installReady: false,
        needsRelaunch: false,
        progress: null
      });
      return status();
    },
    async dispose() {
      disposed = true;
      releaseAbort?.abort();
      cancelNative?.();
      // eslint-disable-next-line no-restricted-syntax -- the in-flight operation already published its own error phase, and dispose only has to wait for it to settle
      await pending?.catch(() => {});
    }
  };
}

module.exports = { createDesktopUpdates };
