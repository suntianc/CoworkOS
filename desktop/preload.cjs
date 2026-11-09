const { contextBridge, ipcRenderer, webUtils } = require("electron");

const composerPrefix = "atria.composer.v1:";
const isDraftKey = (key) => key?.startsWith(composerPrefix) || key?.startsWith("atria.human.v1:");
let draftWarning;
const draftErrorListeners = new Set();
let lastDraftError;
function reportDraftFailure(error) {
  draftWarning =
    typeof error?.message === "string" ? error.message : "草稿暂时无法保存到本机，请保留当前窗口";
  if (lastDraftError === draftWarning) return;
  lastDraftError = draftWarning;
  for (const handler of draftErrorListeners) {
    try {
      handler(draftWarning);
      // eslint-disable-next-line no-restricted-syntax -- a renderer draft-error listener must not block the close acknowledgement the host is waiting for
    } catch {
      /* A renderer callback must not block the close acknowledgement. */
    }
  }
}
let draftsReady = true;
let draftWrites = Promise.resolve();
let lastDraftSnapshot;
let draftTimer;
let inputRevision = 0;
function draftSnapshot() {
  const entries = {};
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (isDraftKey(key)) entries[key] = localStorage.getItem(key);
  }
  return entries;
}
if (location.protocol === "http:" || location.protocol === "https:") {
  try {
    const snapshot = ipcRenderer.sendSync("bookman:composer-drafts");
    draftWarning = snapshot.warning;
    const existing = {};
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (isDraftKey(key)) existing[key] = localStorage.getItem(key);
    }
    // A new origin uses the profile snapshot, including deletions. The current
    // origin's own storage may be newer immediately after a window closes.
    if ((snapshot.persisted && snapshot.origin !== location.origin) || !Object.keys(existing).length) {
      try {
        for (const key of Object.keys(existing)) localStorage.removeItem(key);
        for (const [key, value] of Object.entries(snapshot.entries || {}))
          if (isDraftKey(key) && typeof value === "string") localStorage.setItem(key, value);
      } catch (error) {
        for (let index = localStorage.length - 1; index >= 0; index--) {
          const key = localStorage.key(index);
          if (isDraftKey(key)) localStorage.removeItem(key);
        }
        for (const [key, value] of Object.entries(existing)) localStorage.setItem(key, value);
        throw error;
      }
    }
    // eslint-disable-next-line no-restricted-syntax -- the snapshot restore failed and the warning already tells the user which local storage problem to check
  } catch {
    draftsReady = false;
    draftWarning = "草稿暂时无法恢复，请保留当前窗口并检查本机存储空间";
  }
}
function persistComposerDrafts(force = false) {
  if (force && draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = undefined;
  }
  if (!draftsReady) return Promise.reject(new Error(draftWarning));
  let entries, serialized;
  try {
    entries = draftSnapshot();
    serialized = JSON.stringify(entries);
    // eslint-disable-next-line no-restricted-syntax -- localStorage access throws quota or security DOMExceptions that are intentionally replaced by the fixed user-facing message
  } catch {
    return Promise.reject(new Error("草稿暂时无法保存到本机，请保留当前窗口"));
  }
  if (!force && serialized === lastDraftSnapshot) return draftWrites;
  lastDraftSnapshot = serialized;
  draftWrites = draftWrites
    // eslint-disable-next-line no-restricted-syntax -- draftWrites holds the previous write whose rejection was already reported through reportDraftFailure
    .catch(() => {})
    .then(() => ipcRenderer.invoke("bookman:save-composer-drafts", entries));
  // eslint-disable-next-line no-restricted-syntax -- the rejection is already reported by reportDraftFailure, so this branch only has to drop the deduplication snapshot for the next attempt
  draftWrites.catch(() => {
    lastDraftSnapshot = undefined;
  });
  draftWrites
    .then(() => {
      draftWarning = undefined;
      lastDraftError = undefined;
    })
    // eslint-disable-next-line no-restricted-syntax -- the write result is returned to the caller, so this tail only clears the warning after a successful save
    .catch(() => {});
  return draftWrites;
}
const scheduleComposerDrafts = () => {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    draftTimer = undefined;
    void persistComposerDrafts().catch(reportDraftFailure);
  }, 200);
};
const mirrorComposerDrafts = () => {
  inputRevision += 1;
  queueMicrotask(scheduleComposerDrafts);
};
for (const event of ["input", "change", "drop"]) document.addEventListener(event, mirrorComposerDrafts);
window.addEventListener("beforeunload", () => {
  void persistComposerDrafts().catch(reportDraftFailure);
});

let fullscreen = false;
function reflectWindowState() {
  if (!document.documentElement) return;
  document.documentElement.dataset.desktopPlatform = process.platform;
  document.documentElement.dataset.desktopFullscreen = String(fullscreen);
}
document.addEventListener("DOMContentLoaded", reflectWindowState, { once: true });
ipcRenderer.on("bookman:window-state", (_event, value) => {
  if (typeof value !== "boolean") return;
  fullscreen = value;
  reflectWindowState();
});

let initialAppearance;
try {
  initialAppearance = ipcRenderer.sendSync("bookman:appearance");
  // eslint-disable-next-line no-restricted-syntax -- the synchronous reply is null when the sender is untrusted or the host is not ready, and the theme then follows the system
} catch {
  /* System fallback. */
}
let initialLanguage;
try {
  initialLanguage = ipcRenderer.sendSync("bookman:language");
  // eslint-disable-next-line no-restricted-syntax -- the synchronous reply is null when the sender is untrusted or the host is not ready, and the language keeps its zh-CN default
} catch {
  /* Chinese fallback. */
}
let capabilities;
try {
  capabilities = ipcRenderer.sendSync("bookman:capabilities");
  // eslint-disable-next-line no-restricted-syntax -- the synchronous reply is null when the sender is untrusted or the host is not ready, and capabilities stay null
} catch {
  capabilities = null;
}
let transportNonce;
try {
  transportNonce = ipcRenderer.sendSync("bookman:transport-nonce");
  // eslint-disable-next-line no-restricted-syntax -- the synchronous reply is null when the sender is untrusted or the host is not ready, and the transport nonce stays null
} catch {
  transportNonce = null;
}
contextBridge.exposeInMainWorld("bookmanDesktop", {
  capabilities,
  transportNonce,
  language: {
    initial: initialLanguage,
    set: (value) => ipcRenderer.invoke("bookman:set-language", value)
  },
  appearance: {
    initial: initialAppearance,
    set: (value) => ipcRenderer.invoke("bookman:set-appearance", value),
    onChange: (handler) => {
      if (typeof handler !== "function") return;
      ipcRenderer.on("bookman:appearance-changed", (_event, value) => handler(value));
    }
  },
  platform: process.platform,
  draftWarning,
  saveComposerDrafts: scheduleComposerDrafts,
  onDraftError: (handler) => {
    if (typeof handler !== "function") return;
    draftErrorListeners.add(handler);
    if (draftWarning) handler(draftWarning);
  },
  onPrepareClose: (handler) => {
    ipcRenderer.on("bookman:prepare-close", async (_event, requestId) => {
      let saved = false;
      try {
        for (;;) {
          const revision = inputRevision;
          saved = await handler();
          if (!saved) break;
          const snapshot = JSON.stringify(draftSnapshot());
          await persistComposerDrafts(true);
          // Edits remain usable while the disk write is pending. Recheck both
          // memory-only input and programmatic storage changes before closing.
          if (revision === inputRevision && snapshot === JSON.stringify(draftSnapshot())) break;
        }
      } catch (error) {
        saved = false;
        reportDraftFailure(error);
        /* the host will keep the app open */
      }
      await ipcRenderer.invoke("bookman:documents-ready", requestId, saved === true);
    });
  },
  backend: {
    choose: () => ipcRenderer.invoke("bookman:choose-backend"),
    authorize: (input) => ipcRenderer.invoke("bookman:authorize-backend", input)
  },
  artifactViewer: {
    open: (url, pdf) => ipcRenderer.invoke("bookman:open-artifact-viewer", url, pdf),
    onClosed: (handler) => {
      if (typeof handler !== "function") return () => {};
      const listener = (_event, value) => handler(value);
      ipcRenderer.on("bookman:artifact-viewer-closed", listener);
      return () => ipcRenderer.removeListener("bookman:artifact-viewer-closed", listener);
    }
  },
  // Global policy mutation and human resume stay on the trusted main-frame IPC surface.
  computerUse: (input) => ipcRenderer.invoke("bookman:computer-use", input),
  updateStatus: () => ipcRenderer.invoke("bookman:update-status"),
  checkUpdates: (options = {}) => ipcRenderer.invoke("bookman:check-updates", options),
  applyUpdate: () => ipcRenderer.invoke("bookman:apply-update"),
  onUpdateStatus: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, value) => handler(value);
    ipcRenderer.on("bookman:update-status", listener);
    return () => ipcRenderer.removeListener("bookman:update-status", listener);
  },
  version: process.env.npm_package_version || "0.1.0",
  pathForFile: (file) => webUtils.getPathForFile(file),
  chooseProject: () => ipcRenderer.invoke("bookman:choose-project"),
  openPath: (path) => ipcRenderer.invoke("bookman:open-path", path),
  notify: (notice) => ipcRenderer.invoke("bookman:notify", notice)
});
