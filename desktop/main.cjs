// The helper must exit this entry before profile locks, backend startup or application IPC.
if (process.argv.includes(require("./keychain-worker.cjs").workerFlag)) {
  const electron = require("electron");
  void require("./keychain-worker.cjs")
    .runKeychainWorker(electron)
    .catch(() => electron.app.exit(1));
  return;
}
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  shell,
  session,
  safeStorage,
  globalShortcut,
  autoUpdater,
  Menu,
  clipboard,
  nativeTheme
} = require("electron");
const { createAppearanceHost } = require("./appearance.cjs");
const { createLanguageHost } = require("./language.cjs");
const { windowBackground, followNativeTheme } = require("./system-theme.cjs");
const path = require("node:path");
const fs = require("node:fs/promises");
const { createDesktopUpdateHost } = require("./update-host.cjs");
const { prepareDesktopChange } = require("./update-lifecycle.cjs");
const { selectApplicationIcon, refreshDockIcon } = require("./application-icon.cjs");
const { isDashboardUrl, assertTrustedSender, externalNavigationUrl } = require("./trusted-content.cjs");
const { desktopPaths, prepareDesktopData, showLegacyDataNotice } = require("./paths.cjs");
const { createWebSearchSettings } = require("./web-search-settings.cjs");
const { createModelSettings } = require("./model-settings.cjs");
const { createRetryableStorage } = require("./retryable-storage.cjs");
const { createComputerPolicyStore, createComputerPolicyController } = require("./computer-policy.cjs");
const { createComposerDraftStore } = require("./composer-drafts.cjs");
const { installEditContextMenu } = require("./edit-context-menu.cjs");
const { connectRenderer } = require("./renderer-connection.cjs");
const { connectBackend } = require("./backend.cjs");
const { desktopProfile } = require("./profile.cjs");
const { createDesktopSpeechInput } = require("./speech-input.cjs");
const { migrateLegacyDesktopData } = require("../scripts/data-migration.cjs");
const {
  managedUpdateLaunch,
  recordManagedUpdateLaunch,
  confirmManagedUpdateLaunch
} = require("./update-install.cjs");
const managedLaunch = managedUpdateLaunch();
if (managedLaunch) process.env.COWORK_DESKTOP_DATA = managedLaunch.userData;

const profile = desktopProfile({
  isPackaged: app.isPackaged,
  appRoot: app.getAppPath(),
  appData: app.getPath("appData")
});

let backend,
  mainWindow,
  settings,
  webSearchSettings,
  paths,
  startupPromise,
  composerDrafts,
  updates,
  computerPolicy;
const computerControl = createComputerPolicyController({
  store: { snapshot: () => computerPolicy.snapshot(), save: (value) => computerPolicy.save(value) },
  getBackend: () => backend,
  registerTakeover: (enabled) => registerComputerTakeover(enabled),
  openPermissionSettings: (permission) =>
    shell.openExternal(
      `x-apple.systempreferences:com.apple.preference.security?${permission === "screenRecording" ? "Privacy_ScreenCapture" : "Privacy_Accessibility"}`
    )
});
const speechInput = createDesktopSpeechInput({
  appRoot: profile.appRoot,
  development: profile.development,
  onEvent: (value) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("bookman:voice-event", value);
  }
});
let quitting = false,
  closing = false,
  restarting = false,
  restartPromise;
let updateStoppedBackend = false;
const { createRendererFlush } = require("./renderer-flush.cjs");
const documents = createRendererFlush(() => mainWindow);
// Establish the stable profile before Chromium and the single-instance lock use it.
app.setName(profile.name);
app.setPath("userData", profile.userData);
const owner = app.requestSingleInstanceLock();
if (!owner) app.quit();
else recordManagedUpdateLaunch(managedLaunch);
const credentialStorage =
  process.platform === "darwin"
    ? createRetryableStorage({
        executable: process.execPath,
        args: [
          app.getAppPath(),
          ...(process.argv.includes("--use-mock-keychain") ? ["--use-mock-keychain"] : [])
        ]
      })
    : safeStorage;

function trust(event) {
  assertTrustedSender(event, mainWindow, backend?.url);
}
function openExternalLink(url) {
  const target = externalNavigationUrl(url, backend?.url);
  if (!target) return;
  void shell
    .openExternal(target)
    .catch(() => dialog.showErrorBox("无法打开链接", "请复制链接后在浏览器中打开。"));
}
async function launchBackend() {
  // An unavailable old secret must leave the settings UI reachable for replacement.
  // The backend is a detached execution host: it keeps running when this client
  // quits, so there is no child exit to report and no shutdown here.
  backend = await connectBackend(paths, await settings.read({ allowUnavailableSecret: true }));
  if (closing || quitting) return;
  // Window access is granted over trusted host IPC; an execution host that does
  // not expose that bridge yet reports it as a state instead of failing startup.
  if (typeof backend.computer === "function") await computerControl.initialize(backend);
  await connectRenderer(backend, session.defaultSession.cookies, () => mainWindow);
}
function createWindow() {
  const icon = applicationIcon();
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 752,
    minHeight: 700,
    backgroundColor: windowBackground(nativeTheme),
    title: profile.name,
    ...(icon ? { icon } : {}),
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 25 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  installEditContextMenu(mainWindow, { Menu, clipboard, getDashboardUrl: () => backend?.url });
  const publishWindowState = () =>
    mainWindow?.webContents.send("bookman:window-state", mainWindow.isFullScreen());
  mainWindow.on("enter-full-screen", publishWindowState);
  mainWindow.on("leave-full-screen", publishWindowState);
  mainWindow.on("focus", refreshApplicationIcon);
  mainWindow.webContents.on("did-finish-load", publishWindowState);
  followNativeTheme(mainWindow, nativeTheme);
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isDashboardUrl(url, backend?.url)) {
      event.preventDefault();
      openExternalLink(url);
    }
  });
  const releaseComputerSessions = () => {
    void speechInput.cancelActive();
    void computerControl.request({ operation: "release-sessions" }).catch(() => {});
  };
  mainWindow.webContents.on("did-start-navigation", (event) => {
    if (event.isMainFrame && !event.isSameDocument && mainWindow.webContents.getURL())
      releaseComputerSessions();
  });
  mainWindow.webContents.on("render-process-gone", releaseComputerSessions);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Raw artifacts open inside a separate, unprivileged browser; remote URLs never inherit native IPC.
    if (isDashboardUrl(url, backend?.url)) {
      const viewer = new BrowserWindow({
        width: 1000,
        height: 800,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
      });
      viewer.webContents.setWindowOpenHandler(({ url: target }) => {
        openExternalLink(target);
        return { action: "deny" };
      });
      viewer.webContents.on("will-navigate", (event, target) => {
        if (!isDashboardUrl(target, backend?.url)) event.preventDefault();
      });
      void viewer.loadURL(url);
    } else openExternalLink(url);
    return { action: "deny" };
  });
  mainWindow.on("close", (event) => {
    if (updates?.status().mode === "source" && updates.status().applying) event.preventDefault();
  });
  mainWindow.on("closed", () => {
    releaseComputerSessions();
    mainWindow = undefined;
  });
}
function applicationIcon() {
  return selectApplicationIcon(profile.appRoot);
}
function refreshApplicationIcon() {
  if (process.platform === "darwin") refreshDockIcon(profile.appRoot, app.dock);
}
ipcMain.handle("bookman:choose-project", async (event) => {
  trust(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    title: "选择项目目录"
  });
  return result.canceled ? undefined : result.filePaths[0];
});
ipcMain.handle("bookman:open-path", async (event, value) => {
  trust(event);
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("invalid path");
  return shell.openPath(value);
});
ipcMain.handle("bookman:notify", async (event, value) => {
  trust(event);
  if (!Notification.isSupported()) return false;
  new Notification({ title: String(value?.title || "CoworkOS"), body: String(value?.body || "") }).show();
  return true;
});
ipcMain.handle("bookman:model-status", async (event) => {
  trust(event);
  return settings.status();
});
ipcMain.handle("bookman:web-search-status", async (event) => {
  trust(event);
  return webSearchSettings.status();
});
ipcMain.handle("bookman:save-web-search", async (event, input) => {
  trust(event);
  if (restarting || closing || quitting) throw new Error("本地服务正在关闭或重启，请稍后重试");
  restarting = true;
  try {
    await speechInput.cancelActive();
    await prepareDesktopChange({ backend, documents, action: "修改联网搜索设置" });
    const status = await webSearchSettings.save(input);
    const previous = backend;
    restartPromise = new Promise((done) => setTimeout(done, 100))
      .then(() => previous.stop())
      .then(() => {
        if (!closing && !quitting) return launchBackend();
      })
      .catch((error) => dialog.showErrorBox("搜索配置已保存，服务重启失败", error.message))
      .finally(() => {
        restarting = false;
      });
    return status;
  } catch (error) {
    restarting = false;
    throw error;
  }
});
// Cached data makes this synchronous restore run before the page's ES modules.
ipcMain.on("bookman:composer-drafts", (event) => {
  try {
    trust(event);
    event.returnValue = composerDrafts.snapshot();
  } catch {
    event.returnValue = { entries: {}, warning: "草稿暂时无法恢复，请保留当前窗口并重试" };
  }
});
ipcMain.handle("bookman:save-composer-drafts", async (event, entries) => {
  trust(event);
  await composerDrafts.save(entries, new URL(event.senderFrame.url).origin);
});
ipcMain.handle("bookman:test-model", async (event, input) => {
  trust(event);
  if (restarting || closing || quitting) throw new Error("本地服务正在关闭或重启");
  return settings.test(input);
});
function registerComputerTakeover(enabled) {
  const shortcut = "Control+Alt+Escape";
  globalShortcut.unregister(shortcut);
  if (!enabled) return null;
  const registered = globalShortcut.register(shortcut, () => {
    globalShortcut.unregister(shortcut);
    void computerControl.request({ operation: "pause" }).catch(() => {});
  });
  return registered ? "Ctrl + Option + Esc" : null;
}
ipcMain.handle("bookman:computer-use", async (event, input) => {
  trust(event);
  if (closing || quitting || restarting || !backend) throw new Error("本地服务正在关闭或重启");
  // The saved preference and its status stay readable; only the grant needs the
  // execution host's native bridge.
  if (input?.operation === "policy-status") return computerPolicy.snapshot();
  if (typeof backend.computer !== "function")
    throw new Error("窗口访问由执行主机提供，当前独立后端尚未开放该能力");
  return computerControl.request(input);
});
ipcMain.handle("bookman:voice-start", (event, input) => {
  trust(event);
  if (closing || quitting || restarting) throw new Error("应用正在关闭或重启，请稍后重试");
  return speechInput.start(input);
});
ipcMain.handle("bookman:voice-stop", (event, input) => {
  trust(event);
  return speechInput.stop(input);
});
ipcMain.handle("bookman:voice-cancel", (event, input) => {
  trust(event);
  return speechInput.cancel(input);
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  void updates?.dispose().catch(() => {});
  void speechInput.dispose();
});
ipcMain.handle("bookman:documents-ready", (event, requestId, saved) => {
  trust(event);
  documents.acknowledge(requestId, saved);
});
ipcMain.handle("bookman:save-model", async (event, input) => {
  trust(event);
  if (restarting || closing) throw new Error("模型连接正在更新，请稍后");
  if (quitting) throw new Error("本地服务正在关闭，请稍后");
  restarting = true;
  try {
    await speechInput.cancelActive();
    await prepareDesktopChange({ backend, documents, action: "修改模型连接" });
    const status = await settings.save(input);
    const previous = backend;
    // Return the IPC response before loading a new document in the renderer.
    restartPromise = new Promise((done) => setTimeout(done, 100))
      .then(() => previous.stop())
      .then(() => {
        if (!closing && !quitting) return launchBackend();
      })
      .catch((error) => dialog.showErrorBox("模型配置已保存，服务重启失败", error.message))
      .finally(() => {
        restarting = false;
      });
    return status;
  } catch (error) {
    restarting = false;
    throw error;
  }
});
async function initializeUpdates(userData) {
  updates = await createDesktopUpdateHost({
    profile,
    userData,
    autoUpdater,
    onStatus: (value) => mainWindow?.webContents.send("bookman:update-status", value),
    beforeApply: async () => {
      if (closing || quitting || restarting) throw new Error("本地服务正在关闭或重启，请稍后更新");
      restarting = true;
      try {
        await speechInput.cancelActive();
        await prepareDesktopChange({ backend, documents, action: "更新 CoworkOS" });
        updateStoppedBackend = true;
        await backend.stop();
      } catch (error) {
        restarting = false;
        throw error;
      }
    },
    recover: async () => {
      if (!updateStoppedBackend) return;
      updateStoppedBackend = false;
      restarting = true;
      try {
        await launchBackend();
      } finally {
        restarting = false;
      }
    },
    quitForManaged: () => {
      quitting = true;
      setTimeout(() => app.quit(), 100);
    },
    installNative: () =>
      new Promise((resolve, reject) => {
        // Native installation closes windows before before-quit; preparation already saved and stopped them.
        setTimeout(() => {
          quitting = true;
          try {
            autoUpdater.quitAndInstall();
            resolve();
          } catch (error) {
            quitting = false;
            reject(error);
          }
        }, 100);
      }),
    quitForSource: () => {
      restarting = false;
      setTimeout(() => app.quit(), 100);
    }
  });
  ipcMain.handle("bookman:update-status", (event) => {
    trust(event);
    return updates.status();
  });
  ipcMain.handle("bookman:check-updates", (event, input) => {
    trust(event);
    if (closing || quitting || restarting) throw new Error("本地服务正在关闭或重启，请稍后检查更新");
    return updates.check(input);
  });
  ipcMain.handle("bookman:apply-update", (event) => {
    trust(event);
    if (closing || quitting || restarting) throw new Error("本地服务正在关闭或重启，请稍后更新");
    return updates.apply();
  });
}
if (owner)
  startupPromise = app
    .whenReady()
    .then(async () => {
      const userData = process.env.COWORK_DESKTOP_DATA || app.getPath("userData");
      const appearance = createAppearanceHost({
        userData,
        nativeTheme,
        ipcMain,
        getWindow: () => mainWindow,
        getDashboardUrl: () => backend?.url
      });
      await appearance.load();
      appearance.register();
      const language = createLanguageHost({
        userData,
        ipcMain,
        getWindow: () => mainWindow,
        getDashboardUrl: () => backend?.url
      });
      await language.load();
      language.register();
      let legacySource;
      if (profile.canMigrateLegacy) {
        const migration = await migrateLegacyDesktopData({ source: profile.legacyUserData, home: userData });
        if (migration.status === "available") {
          legacySource = migration.source;
          console.warn(
            `旧版 CoworkOS 数据保留在 ${migration.source}；使用 coworkos data import --from <目录> 导入。`
          );
        }
      }
      paths = desktopPaths(profile.appRoot, userData);
      await prepareDesktopData(paths, app.getVersion());
      computerPolicy = createComputerPolicyStore(userData);
      await computerPolicy.load();
      composerDrafts = createComposerDraftStore(userData);
      await composerDrafts.load();
      settings = createModelSettings(paths, credentialStorage);
      webSearchSettings = createWebSearchSettings(paths, credentialStorage);
      refreshApplicationIcon();
      // A fresh installation still has a valid empty, non-secret configuration.
      try {
        await fs.writeFile(paths.configPath, "{}\n", { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      await initializeUpdates(userData);
      createWindow();
      await launchBackend();
      await confirmManagedUpdateLaunch(managedLaunch);
      if (legacySource)
        await showLegacyDataNotice(paths, legacySource, (source) =>
          dialog.showMessageBox(mainWindow, {
            type: "info",
            title: "旧版数据已保留",
            message: "旧版会话可以导入统一数据目录",
            detail: `原始目录：${source}\n\n当前目录已有 CoworkOS 数据，因此未自动合并。退出相关旧版运行后，可使用 coworkos data import --from <原始目录> --kind desktop 导入；原始文件会保留。`,
            buttons: ["知道了"]
          })
        );
    })
    .catch((error) => {
      dialog.showErrorBox("CoworkOS 无法启动", error.message);
      app.quit();
    });
app.on("second-instance", () => {
  mainWindow?.show();
  mainWindow?.focus();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  refreshApplicationIcon();
  if (!mainWindow) {
    createWindow();
    // Reconnect before showing the page: a backend restarted outside the app
    // publishes a new host credential, and the window must carry the new one.
    void launchBackend().catch((error) => dialog.showErrorBox("CoworkOS 无法连接本地服务", error.message));
  } else mainWindow.show();
});
app.on("before-quit", (event) => {
  if (quitting || !owner || !app.isReady()) return;
  event.preventDefault();
  if (closing || (updates?.status().mode === "source" && updates.status().applying)) return;
  closing = true;
  void (async () => {
    await speechInput.cancelActive();
    const saved = await documents.request();
    if (!saved) {
      const choice = await dialog.showMessageBox(mainWindow, {
        type: "warning",
        message: "有文档或任务草稿尚未保存",
        detail: "请返回处理草稿保存错误或文档冲突。仍然退出会丢失未保存的更改。",
        buttons: ["返回编辑器", "仍然退出"],
        defaultId: 0,
        cancelId: 0
      });
      if (choice.response === 0) {
        closing = false;
        return;
      }
    }
    await startupPromise;
    await restartPromise;
    await updates?.dispose();
    // The backend keeps serving, and with it every task it already accepted.
    await speechInput.dispose();
    await credentialStorage.close?.();
    quitting = true;
    app.quit();
  })().catch((error) => {
    closing = false;
    dialog.showErrorBox("暂时无法退出", error.message);
  });
});
