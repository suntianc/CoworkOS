// The helper must exit this entry before profile locks, backend startup or application IPC.
if (process.argv.includes(require("./keychain-worker.cjs").workerFlag)) {
  const electron = require("electron");
  void require("./keychain-worker.cjs")
    .runKeychainWorker(electron)
    // eslint-disable-next-line no-restricted-syntax -- a keychain worker that cannot start is fatal for this helper, which exits with code 1 while the host reports the storage error
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
  nativeTheme,
  net,
  Tray,
  nativeImage
} = require("electron");
const { createAppearanceHost } = require("./appearance.cjs");
const { createLanguageHost } = require("./language.cjs");
const { windowBackground, followNativeTheme } = require("./system-theme.cjs");
const { PRODUCT_NAME } = require("./product-name.cjs");
const { windowMaterial } = require("./window-material.cjs");
const {
  backgroundMode,
  prepareBackgroundApp,
  enterBackground,
  showInBackground,
  revealWindow
} = require("./background-mode.cjs");
const path = require("node:path");
const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { createApplicationUpdateHost } = require("./update-host.cjs");
const { prepareDesktopChange } = require("./update-lifecycle.cjs");
const { selectApplicationIcon, refreshDockIcon } = require("./application-icon.cjs");
const { isDashboardUrl, assertTrustedSender, externalNavigationUrl } = require("./trusted-content.cjs");
const { desktopPaths, prepareDesktopData, showLegacyDataNotice } = require("./paths.cjs");
const { createRetryableStorage } = require("./retryable-storage.cjs");
const { createSessionCredentialStore } = require("./session-credentials.cjs");
const { createSessionTransport } = require("./session-transport.cjs");
const { createDesktopNotifications } = require("./notifications.cjs");
const { createDesktopTray } = require("./tray.cjs");
const { createComputerTargetCoordinator } = require("./computer-target.cjs");
const { createComputerNavigationGuard } = require("./computer-navigation.cjs");
const { createComposerDraftStore } = require("./composer-drafts.cjs");
const { installEditContextMenu } = require("./edit-context-menu.cjs");
const { connectRenderer } = require("./renderer-connection.cjs");
const { connectBackend } = require("./backend.cjs");
const { createBackendAuthorization } = require("./backend-authorization.cjs");
const {
  isArtifactViewerUrl,
  validatePdfPayload,
  installPdfSession,
  PDF_VIEWER_URL
} = require("./artifact-viewer.cjs");
const { createSettingsTargetGuard } = require("./settings-target.cjs");
const { installBundledWeb } = require("./bundled-web.cjs");
const { desktopProfile } = require("./profile.cjs");
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
const material = windowMaterial();
const background = backgroundMode();
if (background) prepareBackgroundApp(app);

let backend,
  mainWindow,
  clientSessions,
  paths,
  startupPromise,
  composerDrafts,
  updates,
  backendAuthorization,
  desktopTray,
  selectedBackend,
  selectedRoot;
const settingsTarget = createSettingsTargetGuard({
  getOwner: () => backend,
  getSelected: () => selectedBackend,
  verifySelected: (selected) => backendAuthorization.verifySelected(selected)
});
const sessionTransport = createSessionTransport({
  getSelected: () => selectedBackend,
  requestToken: (selected) => backendAuthorization?.requestToken(selected)
});
const computerTargets = createComputerTargetCoordinator({
  registerTakeover: (enabled) => registerComputerTakeover(enabled),
  openPermissionSettings: (permission) =>
    shell.openExternal(
      `x-apple.systempreferences:com.apple.preference.security?${permission === "screenRecording" ? "Privacy_ScreenCapture" : "Privacy_Accessibility"}`
    )
});
let quitting = false,
  closing = false,
  restarting = false,
  restartPromise;
let updateStoppedBackend = false;
let updateComputerTransition = false;
const artifactViewers = new Set();
function closeArtifactViewers() {
  for (const viewer of artifactViewers) if (!viewer.isDestroyed()) viewer.close();
}
const computerNavigation = createComputerNavigationGuard({
  closeViewers: closeArtifactViewers,
  release: () => {
    // eslint-disable-next-line no-restricted-syntax -- this runs from a navigation event with no error channel; computerTargets.beginSwitch retries the release before the next switch
    void computerTargets.releaseForNavigation().catch(() => {});
  }
});
const { createRendererFlush } = require("./renderer-flush.cjs");
const documents = createRendererFlush(() => mainWindow);
// Establish the stable profile before Chromium and the single-instance lock use it.
app.setName(profile.name);
app.setPath("userData", profile.userData);
// The profile keeps the vendor identity used for runtime, data and update compatibility;
// the application name people see is the product name.
app.setName(PRODUCT_NAME);
const owner = app.requestSingleInstanceLock();
if (!owner) app.quit();
else recordManagedUpdateLaunch(managedLaunch);
const credentialStorage =
  process.platform === "darwin"
    ? createRetryableStorage({
        executable: process.execPath,
        appName: "CoworkOS Client",
        args: [
          app.getAppPath(),
          ...(process.argv.includes("--use-mock-keychain") ? ["--use-mock-keychain"] : [])
        ]
      })
    : safeStorage;

function trust(event) {
  assertTrustedSender(event, mainWindow, selectedBackend?.url || backend?.url);
}
function windowMaterialState(event) {
  // Only the trusted main window may read the material; it is host capability data.
  try {
    trust(event);
    event.returnValue = { material: material.material };
    // eslint-disable-next-line no-restricted-syntax -- an untrusted sender gets no host capability data and has no other error channel on a synchronous reply
  } catch {
    event.returnValue = null;
  }
}
function openExternalLink(url) {
  const target = externalNavigationUrl(url, selectedBackend?.url || backend?.url);
  if (!target) return;
  void shell
    .openExternal(target)
    // eslint-disable-next-line no-restricted-syntax -- the error box is the user-facing result of a failed shell.openExternal, and the dialog text already says what to do
    .catch(() => dialog.showErrorBox("无法打开链接", "请复制链接后在浏览器中打开。"));
}
async function connectSelectedRenderer(selected) {
  sessionTransport.rotate();
  return computerNavigation.navigate(selected.url, () =>
    connectRenderer(selected, session.defaultSession.cookies, () => mainWindow)
  );
}
async function stopSelectedExecutionHost(previous) {
  const result = await previous.stop();
  if (result.state !== "stopped") throw new Error("本地服务未完成停止，请重试或检查服务状态");
  computerTargets.invalidateStopped(previous.backendId, previous.pid);
  return result;
}
async function launchBackend({ computerTransitionHeld = false } = {}) {
  if (!computerTransitionHeld) await computerTargets.beginSwitch({ waitForNavigationRelease: true });
  try {
    // The backend is a detached execution host: it keeps running when this client
    // quits, so there is no child exit to report and no shutdown here.
    backend = await connectBackend(paths);
    if (closing || quitting) return;
    if (!backendAuthorization)
      backendAuthorization = createBackendAuthorization({
        appRoot: paths.appRoot,
        sessionStore: clientSessions
      });
    if (!selectedRoot) {
      try {
        const preference = JSON.parse(
          await fs.readFile(path.join(paths.userData, "desktop-backend.json"), "utf8")
        );
        if (typeof preference.home === "string") selectedRoot = preference.home;
      } catch (error) {
        if (error.code !== "ENOENT") console.warn("无法读取上次后端选择", error.message);
      }
    }
    try {
      selectedBackend = await backendAuthorization.select(selectedRoot || paths.userData);
    } catch (error) {
      console.warn("上次选择的后端不可用，连接本地后端", error.message);
      selectedRoot = paths.userData;
      selectedBackend = await backendAuthorization.select(selectedRoot);
    }
    const target = await computerTargets.activate(
      selectedRoot || paths.userData,
      backendAuthorization.computerBackend(selectedBackend)
    );
    if (!target.ok) console.warn("窗口访问策略恢复失败", target.error);
    computerTargets.endSwitch();
    await connectSelectedRenderer(selectedBackend);
  } finally {
    computerTargets.endSwitch();
  }
}
function createWindow() {
  const icon = applicationIcon();
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    show: !background,
    minWidth: 752,
    minHeight: 700,
    backgroundColor: windowBackground(nativeTheme, process.platform),
    title: PRODUCT_NAME,
    ...(icon ? { icon } : {}),
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 25 } }
      : {}),
    ...material.options,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  if (background) showInBackground(mainWindow);
  installEditContextMenu(mainWindow, {
    Menu,
    clipboard,
    getDashboardUrl: () => selectedBackend?.url || backend?.url
  });
  const publishWindowState = () =>
    mainWindow?.webContents.send("bookman:window-state", mainWindow.isFullScreen());
  mainWindow.on("enter-full-screen", publishWindowState);
  mainWindow.on("leave-full-screen", publishWindowState);
  mainWindow.on("focus", refreshApplicationIcon);
  mainWindow.webContents.on("did-finish-load", publishWindowState);
  followNativeTheme(mainWindow, nativeTheme, { transparent: material.material !== "none" });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isDashboardUrl(url, selectedBackend?.url || backend?.url)) {
      event.preventDefault();
      openExternalLink(url);
    }
  });
  const releaseComputerSessions = () => {
    // eslint-disable-next-line no-restricted-syntax -- this runs from render-process-gone with no error channel; computerTargets.beginSwitch retries the release before the next switch
    void computerTargets.releaseForNavigation().catch(() => {});
  };
  mainWindow.webContents.on("did-start-navigation", (event) => {
    computerNavigation.started(event, mainWindow.webContents.getURL());
  });
  mainWindow.webContents.on("render-process-gone", releaseComputerSessions);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Raw artifacts open inside a separate, unprivileged browser; remote URLs never inherit native IPC.
    if (isDashboardUrl(url, selectedBackend?.url || backend?.url)) {
      const viewer = new BrowserWindow({
        width: 1000,
        height: 800,
        show: !background,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: false }
      });
      viewer.webContents.setWindowOpenHandler(({ url: target }) => {
        openExternalLink(target);
        return { action: "deny" };
      });
      viewer.webContents.on("will-navigate", (event, target) => {
        if (!isDashboardUrl(target, selectedBackend?.url || backend?.url)) event.preventDefault();
      });
      if (background) showInBackground(viewer);
      void viewer.loadURL(url);
    } else openExternalLink(url);
    return { action: "deny" };
  });
  mainWindow.on("close", (event) => {
    if (updates?.status().mode === "source" && updates.status().applying) event.preventDefault();
  });
  mainWindow.on("closed", () => {
    closeArtifactViewers();
    releaseComputerSessions();
    mainWindow = undefined;
  });
}
function applicationIcon() {
  return selectApplicationIcon(profile.appRoot);
}
function refreshApplicationIcon() {
  if (process.platform === "darwin" && !background) refreshDockIcon(profile.appRoot, app.dock);
}
ipcMain.on("bookman:window-material", windowMaterialState);
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
ipcMain.handle("bookman:open-artifact-viewer", async (event, value, pdf) => {
  trust(event);
  if (!isArtifactViewerUrl(value, selectedBackend?.url)) throw new Error("无效的产出物预览地址");
  const sender = event.sender;
  let releasePdf;
  let target = value;
  let viewer;
  try {
    let webPreferences = { contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: false };
    if (pdf !== undefined) {
      const bytes = validatePdfPayload(pdf);
      const pdfSession = session.fromPartition(`artifact-pdf-${randomUUID()}`);
      releasePdf = installPdfSession(pdfSession, bytes);
      webPreferences = { ...webPreferences, session: pdfSession, javascript: true, plugins: true };
      target = PDF_VIEWER_URL;
    }
    viewer = new BrowserWindow({ width: 1000, height: 800, show: !background, webPreferences });
    if (background) showInBackground(viewer);
  } catch (error) {
    await releasePdf?.();
    throw error;
  }
  artifactViewers.add(viewer);
  viewer.webContents.on("will-navigate", (navigation) => navigation.preventDefault());
  viewer.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  viewer.on("closed", () => {
    artifactViewers.delete(viewer);
    void releasePdf?.().catch((error) => console.error("清理 PDF 预览失败", error.message));
    if (!sender.isDestroyed()) sender.send("bookman:artifact-viewer-closed", value);
  });
  try {
    await viewer.loadURL(target);
  } catch (error) {
    if (!viewer.isDestroyed()) viewer.close();
    throw error;
  }
});
const desktopNotifications = createDesktopNotifications({
  getBackendId: () => selectedBackend?.backendId,
  supported: () => Notification.isSupported(),
  show: (value) => new Notification(value).show()
});
ipcMain.on("bookman:transport-nonce", (event) => {
  try {
    trust(event);
    event.returnValue = sessionTransport.nonce();
    // eslint-disable-next-line no-restricted-syntax -- trust() throws deliberately for untrusted senders; the transport nonce stays null for them
  } catch {
    event.returnValue = null;
  }
});
ipcMain.on("bookman:capabilities", (event) => {
  try {
    trust(event);
    event.returnValue = { notifications: Notification.isSupported(), tray: desktopTray?.supported === true };
    // eslint-disable-next-line no-restricted-syntax -- trust() throws deliberately for untrusted senders; capabilities stay null for them
  } catch {
    event.returnValue = null;
  }
});
ipcMain.handle("bookman:notify", async (event, value) => {
  trust(event);
  return desktopNotifications.notify(value);
});
ipcMain.handle("bookman:choose-backend", async (event) => {
  trust(event);
  return settingsTarget.select(async () => {
    if (closing || quitting || restarting) throw new Error("应用正在关闭或重启，请稍后重试");
    const choice = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    if (choice.canceled) return;
    if (!Array.isArray(choice.filePaths) || choice.filePaths.length !== 1)
      throw new Error("请选择一个本地后端数据目录");
    await computerTargets.beginSwitch();
    try {
      if (!(await documents.request())) throw new Error("文档或草稿尚未保存，请保存后再切换后端");
      const home = choice.filePaths[0];
      const prepared = await backendAuthorization.prepare(home);
      await fs.writeFile(path.join(paths.userData, "desktop-backend.json"), JSON.stringify({ home }), {
        mode: 0o600
      });
      const selected = backendAuthorization.commit(prepared);
      closeArtifactViewers();
      selectedRoot = home;
      selectedBackend = selected;
      const target = await computerTargets.activate(home, backendAuthorization.computerBackend(selected));
      if (!target.ok) console.warn("窗口访问策略恢复失败", target.error);
      setTimeout(() => {
        void connectSelectedRenderer(selected).catch((error) =>
          dialog.showErrorBox("无法连接后端", error.message)
        );
      }, 0);
    } finally {
      computerTargets.endSwitch();
    }
  });
});
ipcMain.handle("bookman:authorize-backend", async (event, input) => {
  trust(event);
  if (!input || typeof input !== "object" || Array.isArray(input) || input.baseUrl !== "")
    throw new Error("无效的后端授权请求");
  try {
    const expected = selectedBackend;
    await credentialStorage.retry?.();
    if (expected !== selectedBackend) throw new Error("后端已切换，请重新授权");
    return await backendAuthorization.authorize({
      baseUrl: selectedBackend.url,
      backendId: selectedBackend.backendId,
      clientName: input.clientName,
      protocolVersion: input.protocolVersion,
      reuse: input.reuse
    });
  } catch (error) {
    return { error: { message: error.message, code: error.code, status: error.status } };
  }
});
// Cached data makes this synchronous restore run before the page's ES modules.
ipcMain.on("bookman:composer-drafts", (event) => {
  try {
    trust(event);
    event.returnValue = composerDrafts.snapshot();
    // eslint-disable-next-line no-restricted-syntax -- trust() throws for untrusted senders and composerDrafts is unset until startup finishes; the reply is the empty snapshot with a warning
  } catch {
    event.returnValue = { entries: {}, warning: "草稿暂时无法恢复，请保留当前窗口并重试" };
  }
});
ipcMain.handle("bookman:save-composer-drafts", async (event, entries) => {
  trust(event);
  await composerDrafts.save(entries, new URL(event.senderFrame.url).origin);
});
function registerComputerTakeover(enabled) {
  const shortcut = "Control+Alt+Escape";
  globalShortcut.unregister(shortcut);
  if (!enabled) return null;
  const registered = globalShortcut.register(shortcut, () => {
    globalShortcut.unregister(shortcut);
    // eslint-disable-next-line no-restricted-syntax -- a global-shortcut callback has no reply channel and the shortcut is already unregistered, so a failed pause cannot be retried from here
    void computerTargets.pauseForTakeover().catch(() => {});
  });
  return registered ? "Ctrl + Option + Esc" : null;
}
ipcMain.handle("bookman:computer-use", async (event, input) => {
  trust(event);
  if (closing || quitting || restarting || !selectedBackend) throw new Error("本地服务正在关闭或重启");
  return computerTargets.request(input);
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  // eslint-disable-next-line no-restricted-syntax -- the app is quitting; a failed updater dispose must not block will-quit
  void updates?.dispose().catch(() => {});
});
ipcMain.handle("bookman:documents-ready", (event, requestId, saved) => {
  trust(event);
  documents.acknowledge(requestId, saved);
});
async function initializeUpdates(userData) {
  updates = await createApplicationUpdateHost({
    profile,
    userData,
    autoUpdater,
    onStatus: (value) => mainWindow?.webContents.send("bookman:update-status", value),
    beforeApply: async () => {
      if (closing || quitting || restarting) throw new Error("本地服务正在关闭或重启，请稍后更新");
      restarting = true;
      try {
        await computerTargets.beginSwitch();
        updateComputerTransition = true;
        await prepareDesktopChange({ backend, documents, action: "更新 Formicand" });
        updateStoppedBackend = true;
        await stopSelectedExecutionHost(backend);
      } catch (error) {
        if (updateComputerTransition && !updateStoppedBackend) {
          computerTargets.endSwitch();
          updateComputerTransition = false;
        }
        restarting = false;
        throw error;
      }
    },
    recover: async () => {
      if (!updateStoppedBackend) return;
      updateStoppedBackend = false;
      restarting = true;
      try {
        await launchBackend({ computerTransitionHeld: updateComputerTransition });
      } finally {
        if (updateComputerTransition) {
          computerTargets.endSwitch();
          updateComputerTransition = false;
        }
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
      if (background) enterBackground(app);
      const userData = process.env.COWORK_DESKTOP_DATA || app.getPath("userData");
      const appearance = createAppearanceHost({
        userData,
        nativeTheme,
        ipcMain,
        getWindow: () => mainWindow,
        getDashboardUrl: () => selectedBackend?.url || backend?.url
      });
      await appearance.load();
      appearance.register();
      const language = createLanguageHost({
        userData,
        ipcMain,
        getWindow: () => mainWindow,
        getDashboardUrl: () => selectedBackend?.url || backend?.url,
        onChange: (value) => desktopTray?.setLanguage(value)
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
      await installBundledWeb({
        session: session.defaultSession,
        net,
        root: path.join(paths.appRoot, "web"),
        getOrigin: () => selectedBackend?.url || backend?.url,
        authorizeRequest: (request) => sessionTransport.authorize(request)
      });
      composerDrafts = createComposerDraftStore(userData);
      await composerDrafts.load();
      clientSessions = createSessionCredentialStore({ userData, storage: credentialStorage });
      refreshApplicationIcon();
      desktopTray = createDesktopTray({
        Tray,
        Menu,
        nativeImage,
        icon: applicationIcon(),
        platform: process.platform,
        language: language.get(),
        show: () => {
          if (!mainWindow) app.emit("activate");
          else revealWindow(mainWindow, background);
        },
        quit: () => app.quit()
      });
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
      dialog.showErrorBox("Formicand 无法启动", error.message);
      app.quit();
    });
app.on("second-instance", () => {
  if (mainWindow) revealWindow(mainWindow, background);
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
    void launchBackend().catch((error) => dialog.showErrorBox("Formicand 无法连接本地服务", error.message));
  } else if (background) showInBackground(mainWindow);
  else mainWindow.show();
});
app.on("before-quit", (event) => {
  if (quitting || !owner || !app.isReady()) return;
  event.preventDefault();
  if (closing || (updates?.status().mode === "source" && updates.status().applying)) return;
  closing = true;
  void (async () => {
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
    // eslint-disable-next-line no-restricted-syntax -- revoking the host approval cannot block quitting, and the approval dies with this process
    await computerTargets.dispose().catch(() => {});
    await credentialStorage.close?.();
    desktopTray?.dispose();
    quitting = true;
    app.quit();
  })().catch((error) => {
    closing = false;
    dialog.showErrorBox("暂时无法退出", error.message);
  });
});
