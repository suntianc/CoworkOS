import { ui, localizeShell } from "./assets/ui/language.js";
import { installLanguageSettings } from "./assets/controllers/language-settings.js";
import { createCoalescedRead } from "./assets/controllers/coalesced-read.js";
import { createMessageEditController } from "./assets/controllers/message-edit.js";
import { createComposerClipboard } from "./assets/controllers/composer-clipboard.js";
import { createComposerSession } from "./assets/controllers/composer-session.js";
import { createDraftRecovery } from "./assets/controllers/draft-recovery.js";
import { createComposerLayout } from "./assets/controllers/composer-layout.js";
import { createFileUpload, uploadedFileIds } from "./assets/controllers/file-upload.js";
import { installAttachmentPreview } from "./assets/controllers/attachment-preview.js";
import { composePrompt } from "./assets/attachments.js";
import { requestErrorMessage } from "./assets/request-error.js";
import { renderMessageQueue } from "./assets/message-queue.js";
import { createSidebarLayout } from "./assets/sidebar-layout.js";
import { icon } from "./assets/ui/icons.js";
import { createMenu } from "./assets/ui/menu.js";
import { createModal } from "./assets/ui/modal.js";
import { formatStamp } from "./assets/ui/time-format.js";
import { createVisiblePoll } from "./assets/ui/visible-poll.js";
import { installDesktopSettings } from "./assets/controllers/desktop-settings.js";
import { installUserMemorySettings } from "./assets/controllers/user-memory-settings.js";
import { installDesktopUpdates } from "./assets/controllers/desktop-updates.js";
import { presentToolCall } from "./assets/tool-presentation.js";
import { assistantDisplayContent, normalizeReasoningDisplay } from "./assets/activity.js";
import { createWorkbenchController } from "./assets/controllers/workbench-controller.js";
import { createArtifactController } from "./assets/controllers/artifact-controller.js";
import { createArtifactViewer } from "./assets/controllers/artifact-viewer.js";
import { createManagedMedia } from "./assets/controllers/managed-media.js";
import { createConversationView } from "./assets/controllers/conversation-view.js";
import { createConversationLayout } from "./assets/controllers/conversation-layout.js";
import { createConnectionController } from "./assets/controllers/connection-controller.js";
import { createManagementClient } from "./assets/controllers/management-client.js";
import { createTaskNotifications } from "./assets/controllers/task-notifications.js";
import { createBackendConnection } from "./assets/controllers/backend-connection.js";
import { createProjectExperienceController } from "./assets/controllers/project-experience.js";
import { createProjectController } from "./assets/controllers/project-controller.js";
import { createMainSessionsController } from "./assets/controllers/main-sessions.js";
import { createConversationMenu } from "./assets/controllers/conversation-menu.js";
import { createConversationOperations } from "./assets/controllers/conversation-operations.js";
import { createConversationReadState, conversationTaskId } from "./assets/conversation-actions.js";
import { renderMarkdown } from "./assets/markdown.js";
import { mergeRuntimeEvents } from "./assets/conversation.js";
import { createEntryController } from "./assets/controllers/entry-controller.js";
import { createSettingsPages } from "./assets/controllers/settings-pages.js";
import { createObserveData } from "./assets/controllers/observe-data.js";
import { createObserveSidebar } from "./assets/controllers/observe-sidebar.js";
import { createObserveRequirements } from "./assets/controllers/observe-requirements.js";
import { createRequirementPanel } from "./assets/controllers/requirement-panel.js";
import { createNewSessionView } from "./assets/controllers/new-session.js";
import { createAddProjectController } from "./assets/controllers/add-project.js";
import { createHumanQuestions } from "./assets/human-questions.js";
import { installComputerUse } from "./assets/controllers/computer-use.js";
import { formatArtifactSize, artifactParentPath, invalidateArtifactCache } from "./assets/artifacts.js";

localizeShell(document.body);

const state = {
  online: true,
  modelConfigured: undefined,
  tasks: [],
  projects: [],
  collapsedProjects: new Set(),
  collapsedSessions: new Set(),
  models: [],
  defaultModel: null,
  model: null,
  modelByTask: new Map(),
  thinkingLevel: null,
  thinkingLevelByTask: new Map(),
  selected: null,
  detail: null,
  previewPath: null,
  drawerTab: null,
  drawerFile: null,
  drawerDiff: null,
  drawerTrigger: null,
  artifactDrawerOpen: false,
  openFiles: [],
  artifactCache: new Map(),
  viewerTaskId: null,
  localMessages: [],
  submittingTaskId: null,
  composingNew: false,
  attachments: [],
  workspacePath: null,
  workspaceRoot: null,
  workspaceLabel: null,
  executionHistoryOpen: new Map()
};
const sending = new Map();
let attachmentReadVersion = 0;
let readingAttachments = false;
let fileUpload;
let attachmentPreview;
let observeRequirements;
const creatingTasks = new Map();
const stoppingTasks = new Set();
const stopEpochs = new Map();
const promotingMessages = new Set();
let detailRequestSequence = 0;
let listRequestSequence = 0;
let latestListRead;
const catalogReads = createCoalescedRead((_key, options) => refreshState(options));
const detailReads = createCoalescedRead(readDetail);
let renderedDetailSignature;

const $ = (selector) => document.querySelector(selector);
createComposerLayout($("#composer-input"));
createSidebarLayout($(".app-layout"), $(".conversation-sidebar"), $("#sidebar-divider"), {
  outputPane: $(".agent-pane"),
  outputToggle: $("#output-pane-toggle")
});
let draftStorage;
let browserSessionStorage;
try {
  draftStorage = window.localStorage;
  // eslint-disable-next-line no-restricted-syntax -- the localStorage getter throws SecurityError when the browser blocks storage, and every reader below treats draftStorage as optional
} catch {
  /* storage may be disabled */
}
try {
  browserSessionStorage = window.sessionStorage;
  // eslint-disable-next-line no-restricted-syntax -- the sessionStorage getter throws when storage is blocked; the management client then keeps sessions in memory
} catch {
  /* storage may be disabled */
}
const conversationReadState = createConversationReadState(draftStorage);
const entryController = createEntryController({
  root: $(".app-layout"),
  storage: draftStorage,
  onChange: (next) => observeRequirements?.applyEntry(next)
});
for (const button of document.querySelectorAll("[data-entry-mode]"))
  button.addEventListener("click", () => entryController.setMode(button.dataset.entryMode));
$(".entry-switch")?.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  event.preventDefault();
  const next = entryController.state().mode === "work" ? "observe" : "work";
  entryController.setMode(next);
  $(`[data-entry-mode="${next}"]`)?.focus();
});
for (const button of document.querySelectorAll("[data-observe-view]"))
  button.addEventListener("click", () => entryController.setObserveView(button.dataset.observeView));
let initialConversationTaskId = conversationTaskId(location.href);
let linkedConversationNavigation;
let lastReadSelection;
let backendConnection;
const taskNotifications = createTaskNotifications({ notify: window.bookmanDesktop?.notify });
/**
 * The one client every business call goes through.
 *
 * It owns the local session, the catalog snapshot and its event stream. The
 * page never learns a backend's file paths and never calls Electron IPC; the
 * desktop renderer and a plain browser consume exactly this module.
 */
const management = createManagementClient({
  ...(window.bookmanDesktop?.backend
    ? {
        hostManagedSession: true,
        transportHeaders: { "x-cowork-desktop-nonce": window.bookmanDesktop.transportNonce },
        authorizeSession: async (input) => {
          const result = await window.bookmanDesktop.backend.authorize(input);
          if (result.error) {
            const error = new Error(result.error.message);
            error.code = result.error.code;
            error.status = result.error.status;
            throw error;
          }
          return result;
        }
      }
    : {}),
  storage: browserSessionStorage,
  targetStorage: draftStorage,
  events: {
    onSnapshot: (snapshot) => adoptCatalogSnapshot(snapshot),
    onEvent: (record) => applyCatalogEvent(record),
    onReset: (reset) => {
      // A cursor reset only asks for a new snapshot of the same backend; the
      // screen is rebuilt from that snapshot. Only a backend change discards it.
      if (reset?.reason === "backend_switched" || reset?.reason === "backend_mismatch") resetBackendView();
    },
    onStatus: () => {
      backendConnection?.apply(management.state());
      updateSendButton();
    }
  },
  onStateChange: (state) => {
    backendConnection?.apply(state);
    updateSendButton();
    observeData.localChanged();
  }
});
const artifactViewer = createArtifactViewer({
  read: (path) => management.blob(path),
  identity: () => management.state(),
  host: window.bookmanDesktop?.artifactViewer
});
window.addEventListener(
  "unload",
  () => {
    artifactViewer.dispose();
    clearManagedMedia();
    observeRequirements?.dispose();
    observeData.dispose();
    management.stop();
  },
  { once: true }
);
window.addEventListener("pagehide", () => management.stop());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void bootBackend();
});

// The last model a person picked stays as the default for the next new
// conversation, so switching once is enough instead of re-picking each time.
const PREFERRED_MODEL_KEY = "atria.model.preferred";
const PREFERRED_THINKING_LEVEL_KEY = "atria.reasoning.preferred";
function readPreferredModel() {
  try {
    return (draftStorage && draftStorage.getItem(PREFERRED_MODEL_KEY)) || "";
    // eslint-disable-next-line no-restricted-syntax -- getItem throws when the browser blocks storage, and the composer must still start with no preferred model
  } catch {
    return "";
  }
}
function writePreferredModel(model) {
  try {
    if (!draftStorage) return;
    if (model) draftStorage.setItem(PREFERRED_MODEL_KEY, model);
    else draftStorage.removeItem(PREFERRED_MODEL_KEY);
    // eslint-disable-next-line no-restricted-syntax -- best-effort preference write: blocked or full storage only loses the remembered model
  } catch {
    /* storage may be disabled */
  }
}
function readPreferredThinkingLevel() {
  try {
    const value = draftStorage?.getItem(PREFERRED_THINKING_LEVEL_KEY) || "";
    return value === "off" || ["minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
      ? value
      : null;
    // eslint-disable-next-line no-restricted-syntax -- getItem throws in blocked-storage sessions, where no preferred reasoning level can be read
  } catch {
    return null;
  }
}
function writePreferredThinkingLevel(level) {
  try {
    if (!draftStorage) return;
    if (level) draftStorage.setItem(PREFERRED_THINKING_LEVEL_KEY, level);
    else draftStorage.removeItem(PREFERRED_THINKING_LEVEL_KEY);
    // eslint-disable-next-line no-restricted-syntax -- best-effort preference write: blocked or full storage only loses the remembered reasoning level
  } catch {
    /* storage may be disabled */
  }
}
const composerSession = createComposerSession({
  input: $("#composer-input"),
  storage: draftStorage,
  getAttachments: () => state.attachments,
  setAttachments: (files) => {
    fileUpload?.navigate();
    attachmentPreview?.close({ restoreFocus: false });
    // Navigation retires a read belonging to the previous draft immediately.
    attachmentReadVersion += 1;
    readingAttachments = false;
    state.attachments = files;
    renderAttachments();
  },
  onError: showToast,
  onPersist: () => window.bookmanDesktop?.saveComposerDrafts?.()
});
await composerSession.ready;
const messageEdit = createMessageEditController({
  composerSession,
  input: $("#composer-input"),
  getState: () => state,
  isBusy: () =>
    Boolean(currentSubmission() || readingAttachments || workbenchController.connecting || isTaskStopping()),
  api,
  onError: showToast,
  onChange: () => {
    renderAll();
    updateSendButton();
  },
  onSubmit: () => submitMessageEdit(),
  onAccepted: async (taskId, run) => {
    if (state.selected === taskId) {
      state.localMessages = [];
      await loadDetail(taskId);
      connectEventStream(taskId);
    }
    await refresh();
  }
});
state.selected = initialConversationTaskId || composerSession.activeTask;
state.composingNew = !initialConversationTaskId && composerSession.hasNewDraft;
state.selectedProjectId = composerSession.activeProject;
window.addEventListener("pagehide", () => composerSession.save());
const humanQuestions = createHumanQuestions($("#human-questions"), {
  onError: showToast,
  submit: (taskId, requestId, answer) =>
    humanAction(taskId, `human/${encodeURIComponent(requestId)}/answer`, { answer }),
  resume: (taskId) => humanAction(taskId, "human/resume", {}),
  onVisibility: (visible) => {
    $(".composer").hidden = visible;
  }
});
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
  );
const statusLabel = {
  created: ui("已创建"),
  idle: ui("空闲中"),
  running: ui("工作中"),
  waiting: ui("等待中"),
  completed: ui("已完成"),
  failed: ui("失败"),
  cancelled: ui("已取消"),
  queued: ui("排队中"),
  leased: ui("工作中"),
  succeeded: ui("已完成"),
  timed_out: ui("超时"),
  recorded: ui("已记录"),
  interrupted: ui("已结束")
};
const stateText = (value) => statusLabel[value] || value || ui("未知");

/**
 * The workbench, created only once a Task reports application state.
 *
 * A Task detail without an `applications` field means the feature is off, so
 * nothing here ever mounts and the conversation behaves exactly as before.
 */
/** The shared workspace that holds documents belonging to no conversation. */

const workbenchController = createWorkbenchController({
  state,
  $,
  showToast,
  createTask,
  beginNewConversation,
  loadDetail,
  openResourceInEditor: (...args) => artifacts.openResourceInEditor(...args),
  renderConversationList,
  renderEmpty,
  onViewChanged: paintTopbarContext,
  onShowTaskPanel: ({ focus = false } = {}) => {
    document.body.classList.remove("output-collapsed");
    renderRightPanel();
    if (focus) $("#panel-heading")?.focus();
  },
  refreshProjects: () => readProjectCatalog(),
  updateSendButton,
  closeConnection: () => connection.close(),
  activateDraft: (taskId) => composerSession.activate(taskId, { projectId: state.selectedProjectId }),
  saveDraft: () => composerSession.save(),
  getNavigationContext: () => composerSession.currentToken,
  connectEventStream: (taskId) => connection.connect(taskId),
  backendRequest: (path, options) => api(path, options),
  fetchBytes: (path, signal) => management.blob(path, { signal })
});
const computerUse = installComputerUse({
  api,
  showToast,
  getSelectedTaskId: () => state.selected,
  getTaskLabel: (taskId) =>
    conversationTitle(state.tasks.find((task) => task.taskId === taskId) || state.detail?.task)
});
const {
  api: applicationApi,
  refreshTabs,
  loadEditableKinds,
  enterConversation,
  activateConversationTab,
  ensureWorkbench,
  ensureBinding,
  syncBindingFromTabs
} = workbenchController;
let requirementPanel;
const artifacts = createArtifactController({
  state,
  $,
  api,
  showToast,
  renderRightPanel,
  getWorkbench: () => workbenchController,
  mediaUrl: mediaObjectUrl,
  openArtifactViewer: (path) => artifactViewer.open(path),
  getDelivery: () => requirementPanel?.records()
});
const {
  openArtifact,
  appDisplayName,
  openResourceInEditor,
  closeArtifactDrawer,
  renderArtifactDrawer,
  openPreview
} = artifacts;
requirementPanel = createRequirementPanel({
  state,
  $,
  api,
  onCollapse: () => void toggleOutputPane(),
  openArtifact,
  openResource: openResourceInEditor,
  openPreview,
  iconForDocument: (row) => workbenchController.iconForDocument(row)
});
const conversationView = createConversationView({
  state,
  $,
  textContent,
  openArtifact,
  openSettings: () => modelSettings.open(),
  retry: (taskId) => void retryFailedRequest(taskId),
  messageEdit,
  edit: (taskId, target) => messageEdit.begin(taskId, target)
});
/**
 * Backend files shown as images or iframes.
 *
 * A page may be managing another local backend, where a bare `<img src="/api/…">`
 * would reach the wrong origin without the session. Fetch the bytes through the
 * shared client and hand the DOM one object URL per path.
 */
const managedMedia = createManagedMedia({
  read: (path) => management.blob(path),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url)
});
function mediaObjectUrl(path) {
  return managedMedia.get(path);
}
function clearManagedMedia() {
  managedMedia.clear();
}

function hydrateUploadImages(root) {
  for (const image of root.querySelectorAll("img[data-upload-src]")) {
    if (image.dataset.uploadLoaded) continue;
    image.dataset.uploadLoaded = "1";
    const id = image.dataset.uploadSrc;
    void mediaObjectUrl(`/api/uploads/${encodeURIComponent(id)}`)
      .then((href) => {
        image.src = href;
      })
      // eslint-disable-next-line no-restricted-syntax -- a failed media read leaves this one upload image unloaded, and the transcript keeps rendering
      .catch(() => undefined);
  }
}

/**
 * A download that needs the management client addresses one backend file.
 *
 * Only root-relative `/api/` paths are backend files. A `blob:`/`data:` URL or
 * any other link was produced locally (the Markdown export builds a blob) or
 * belongs to someone else; rerouting it would ask the backend for a path it
 * never served. The client marks its own synthetic anchor so this listener
 * never intercepts the click it just created.
 */
function isBackendDownload(href) {
  return typeof href === "string" && href.startsWith("/api/");
}

document.addEventListener(
  "click",
  (event) => {
    const link = event.target.closest?.("a[download]");
    if (!link || link.dataset.managedDownload) return;
    const href = link.getAttribute("href");
    if (!isBackendDownload(href)) return;
    // The bytes belong to the bound backend; a plain navigation would carry
    // neither the session nor the right origin.
    event.preventDefault();
    void management.download(href, link.getAttribute("download") || undefined).catch((error) => {
      showToast(error.message);
    });
  },
  true
);

const { renderConversation: renderConversationView } = conversationView;
function renderConversation(messages, task) {
  renderConversationView(messages, task);
  hydrateUploadImages($("#conversation"));
}
const connection = createConnectionController({
  state,
  renderConversation,
  loadDetail,
  getWorkbench: () => workbenchController.host,
  readApplicationRevisions: (signal, ids) => applicationApi.listApplicationRevisions(signal, ids),
  refreshWorkbench: () => refreshTabs(),
  openStream: (path, options) => management.openStream(path, options)
});
const connectEventStream = (taskId) => connection.connect(taskId);

const workspaceDisplayName = (value) => {
  const raw = String(value || "");
  if (/^\/+\s*$/.test(raw)) return "/";
  if (/^[A-Za-z]:[\\/]+$/.test(raw)) return raw.slice(0, 2) + "\\";
  const normalized = raw.replace(/[\\/]+$/, "");
  if (!normalized) return ui("选择文件夹");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || normalized;
};
const projectExperienceController = createProjectExperienceController({ api, showToast });
const projectController = createProjectController({
  openProjectExperience: (project) => projectExperienceController.open(project),
  openAddProject: () => addProjectController.open(),
  state,
  $,
  api,
  storage: draftStorage,
  showToast,
  beginConversation: (projectId) => beginNewConversation(projectId),
  onSelectionChanged: (project) => {
    if (!state.selected) composerSession.activate(null, { projectId: project.projectId });
  },
  getApplicationWorkspaces: () =>
    (workbenchController.host?.openTabs || [])
      .filter((tab) => tab.kind === "application")
      .map((tab) => tab.workspaceRoot),
  isTaskVisible: (task) =>
    task.monitoring?.scope !== "background" || task.pinned || task.taskId === state.selected,
  isUnread: (taskId) => conversationReadState.isUnread(taskId),
  selectConversation,
  conversationTitle,
  taskMenuOpen: () => sessionMenu.isOpen,
  openTaskMenu: (node, taskId, last) => {
    sessionMenu.open(node, taskId, { last });
  },
  onRendered: () => {
    if (!sessionMenu.isOpen) return;
    if (sessionMenu.trigger === $("#session-menu-button")) {
      if (sessionMenu.context !== currentSessionMenuContext()) return sessionMenu.close();
      return sessionMenu.rebind(sessionMenu.trigger);
    }
    const trigger = $("#project-list").querySelector(
      `[data-session-menu="${CSS.escape(sessionMenu.taskId)}"]`
    );
    if (trigger) sessionMenu.rebind(trigger);
    else sessionMenu.close();
  },
  getNavigationIdentity: () =>
    JSON.stringify([
      state.selected,
      state.selectedProjectId,
      composerSession.currentToken,
      workbenchController.host?.navigationToken
    ]),
  onUpdated: () => void refresh()
});
const addProjectController = createAddProjectController({
  api,
  command: (path, options) => (api.command ? api.command(path, options) : api(path, options)),
  showToast,
  onCreated: async (project) => {
    await refresh();
    projectController.select(project.projectId);
    beginNewConversation(project.projectId);
  }
});
const newSession = createNewSessionView({
  state,
  $,
  titleFor: (task) => conversationTitle(task),
  onOpenTask: (taskId) => {
    const task = state.tasks.find((entry) => entry.taskId === taskId);
    if (task) projectController.selectTask(task);
    selectConversation(taskId);
  },
  onSelectProject: (projectId) => beginNewConversation(projectId),
  onAddProject: () => projectController.openCreate()
});
const mainSessionsController = createMainSessionsController({
  api,
  state,
  openSession: ({ projectId, taskId }) => {
    const project = state.projects.find((entry) => entry.projectId === projectId);
    if (project) projectController.select(project.projectId);
    selectConversation(taskId);
  }
});
$("#main-sessions-nav").addEventListener("click", () => mainSessionsController.open());
const draftRecovery = createDraftRecovery({
  button: $("#recover-drafts"),
  session: composerSession,
  getBackend: () => boundBackendId,
  getContext: () => backendRevision,
  getProjects: () => state.projects,
  openDraft: (projectId) => beginNewConversation(projectId)
});
function conversationTitle(task) {
  return task?.title || truncate(String(task?.goal || task?.taskId || ui("新的对话")).split("\n")[0], 48);
}
async function updateConversation(patch, taskId = state.selected) {
  if (!taskId) return;
  const navigation = composerSession.currentToken;
  await api(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch)
  });
  if (patch.archived && state.selected === taskId && composerSession.currentToken === navigation)
    beginNewConversation();
  await refresh();
}
async function removeConversation(taskId = state.selected) {
  if (!taskId) return;
  const navigation = composerSession.currentToken;
  await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
  if (state.selected === taskId && composerSession.currentToken === navigation) beginNewConversation();
  await refresh();
}
function renameConversation(task = state.detail?.task) {
  if (!task) return;
  const panel = document.createElement("div");
  panel.className = "modal-backdrop app-dialog-backdrop";
  panel.hidden = true;
  panel.innerHTML = ui`<section class="modal-card app-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-conversation-title"><h2 id="rename-conversation-title">重命名会话</h2><form novalidate><label class="dialog-field">会话名称<input name="title" maxlength="100" required autocomplete="off" aria-describedby="rename-conversation-error" value="${esc(conversationTitle(task))}"></label><p class="dialog-error" role="alert" id="rename-conversation-error" hidden></p><div class="dialog-actions"><button class="app-button is-secondary" type="button" data-close>取消</button><button class="app-button is-primary" type="submit">保存</button></div></form></section>`;
  document.body.append(panel);
  const dialog = createModal(panel, panel.querySelector("[data-close]"), { onClose: () => panel.remove() });
  panel.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = panel.querySelector("[type=submit]");
    const input = panel.querySelector("input");
    const errorMessage = panel.querySelector("[role=alert]");
    input.removeAttribute("aria-invalid");
    errorMessage.hidden = true;
    errorMessage.textContent = "";
    if (!input.value.trim()) {
      errorMessage.textContent = ui("请输入会话名称");
      errorMessage.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      await updateConversation({ title: input.value.trim() }, task.taskId);
      dialog.close();
      panel.remove();
    } catch (error) {
      errorMessage.textContent = error.message;
      errorMessage.hidden = false;
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  });
  dialog.open();
  panel.querySelector("input").select();
}
function setModelLabel(value) {
  const label = String(value || "").trim();
  if (!label) return;
  const name = $(".model-name");
  if (name) name.textContent = label;
  else $(".model-select").textContent = label;
  $("#model-select").title = ui`切换模型 · ${label}`;
}

const THINKING_LEVEL_LABELS = {
  off: ui("关闭"),
  minimal: ui("最少"),
  low: ui("低"),
  medium: ui("中"),
  high: ui("高"),
  xhigh: ui("极高"),
  max: ui("最大")
};
function setThinkingLabel(value) {
  const selected = value || null;
  const label = selected ? THINKING_LEVEL_LABELS[selected] || selected : ui("自动");
  const name = $(".reasoning-name");
  if (name) name.textContent = label;
  const button = $("#reasoning-select");
  if (!button) return;
  button.title = ui`设置推理强度 · ${label}`;
  button.setAttribute("aria-label", ui`推理强度：${label}`);
}

function defaultThinkingLevelForNewConversation() {
  return readPreferredThinkingLevel() || "high";
}

// A new conversation inherits the last picked model when it is still offered
// by the current connection; otherwise it falls back to the configured default.
function defaultModelForNewConversation() {
  const preferred = readPreferredModel();
  if (preferred && (!state.models.length || state.models.includes(preferred))) return preferred;
  return state.defaultModel;
}

function syncModelConnection(model, profileId) {
  if (state.connectionProfileId !== profileId || state.defaultModel !== model) {
    state.connectionProfileId = profileId;
    state.modelByTask.clear();
    state.thinkingLevelByTask.clear();
    state.model = model;
    state.thinkingLevel = defaultThinkingLevelForNewConversation();
  }
  state.defaultModel = model;
  state.model ||= model;
  setModelLabel(state.model);
  setThinkingLabel(state.thinkingLevel);
}

async function loadModels() {
  try {
    const data = await api("/api/models");
    state.modelConfigured = data.configured;
    updateSendButton();
    state.models = Array.isArray(data.models)
      ? data.models.filter((model) => typeof model === "string" && model.trim())
      : [];
    const defaultModel =
      typeof data.current === "string" && data.current.trim()
        ? data.current.trim()
        : state.models[0] || "glm-5.3";
    syncModelConnection(defaultModel, data.connectionProfileId);
    // eslint-disable-next-line no-restricted-syntax -- /api/models is unavailable while the backend restarts or is offline; the picker keeps a usable model instead of an empty list
  } catch {
    state.models = state.model ? [state.model] : ["glm-5.3"];
    state.defaultModel ||= state.models[0];
    state.model ||= state.defaultModel;
    setModelLabel(state.model);
  }
}

/** Every business request belongs to the bound backend's session. */
async function api(path, options) {
  return management.request(path, options);
}
/** A change command: same operation id and content may be retried after a lost response. */
api.command = (path, options) => management.command(path, options);

async function humanAction(taskId, action, body) {
  const result = await api(`/api/tasks/${encodeURIComponent(taskId)}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (state.selected === taskId) {
    await loadDetail(taskId);
    connectEventStream(taskId);
  }
  return result;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

function readProjectCatalog(requestSequence = ++listRequestSequence, isCurrent = () => true) {
  const request = api("/api/tasks").then((data) => {
    // All list readers share one ordering, including independent documents.
    // A superseded caller waits for the latest catalog instead of proceeding
    // with an old project identity while a newer request is still in flight.
    if (requestSequence !== listRequestSequence) return latestListRead;
    if (isCurrent()) projectController.accept(data);
    return data;
  });
  latestListRead = request;
  return request;
}

function refresh(options) {
  return catalogReads("catalog", options);
}

/**
 * Adopt one authoritative catalog, whether it came from `/api/tasks` or from a
 * snapshot the event client took. Replacing the lists here is what makes a
 * reconnect consistent: the sequence and revisions move in the same step.
 */
async function applyCatalog(data, { poll = false } = {}) {
  if (!data || typeof data !== "object") return;
  if (typeof data.workspaceRoot === "string" && data.workspaceRoot.trim()) {
    state.workspaceRoot = data.currentWorkspaceRoot || data.workspaceRoot;
    if (!state.workspacePath) state.workspacePath = state.workspaceRoot;
    state.workspaceLabel = workspaceDisplayName(state.workspacePath);
  }
  if (data.model) {
    // This local response arrives before provider model discovery. Establish
    // the active connection before historical task models can be cached.
    if (data.connectionProfileId) syncModelConnection(data.model, data.connectionProfileId);
    else {
      state.defaultModel = data.model;
      if (!state.model) state.model = data.model;
      if (!state.selected || !state.modelByTask.has(state.selected)) setModelLabel(state.model);
    }
  }
  state.online = true;
  backendConnection?.setOnline(true);
  const defaultTask = state.tasks.find((task) => !task.archived && task.monitoring?.scope !== "background");
  const linkedTaskId = initialConversationTaskId;
  initialConversationTaskId = null;
  if (linkedTaskId && !state.tasks.some((task) => task.taskId === linkedTaskId))
    showToast(ui("找不到链接中的会话，可能已被移除"));
  if (!state.selected && defaultTask && !state.composingNew) state.selected = defaultTask.taskId;
  if (state.selected && !state.tasks.some((task) => task.taskId === state.selected))
    state.selected = defaultTask?.taskId || null;
  renderConversationList();
  if (state.selected) {
    const listed = state.tasks.find((task) => task.taskId === state.selected);
    const loaded = state.detail?.task;
    if (
      !poll ||
      loaded?.taskId !== state.selected ||
      listed?.version !== loaded?.version ||
      listed?.activeRunId !== loaded?.activeRunId ||
      listed?.status !== loaded?.status
    )
      await loadDetail(state.selected, { poll });
    connectEventStream(state.selected);
    if (linkedTaskId && state.selected === linkedTaskId && linkedConversationNavigation?.current())
      await activateConversationTab(linkedTaskId, linkedConversationNavigation);
  } else renderEmpty();
  updateSendButton();
}

async function refreshState({ poll = false, isCurrent = () => true } = {}) {
  const requestSequence = ++listRequestSequence;
  try {
    const data = await readProjectCatalog(requestSequence, isCurrent);
    if (!isCurrent() || requestSequence !== listRequestSequence) return;
    await applyCatalog(data, { poll });
    observeData.localChanged();
  } catch (error) {
    // A request from the backend this page switched away from is not an outage.
    if (error?.stale || error?.code === "stale_client") return;
    if (!isCurrent() || requestSequence !== listRequestSequence) return;
    // An ended session has its own actionable state and reauthorize action.
    if (["session_revoked", "unauthorized", "host_credential_required"].includes(error?.code)) {
      updateSendButton();
      return;
    }
    state.online = false;
    backendConnection?.setOnline(false);
    updateSendButton();
    observeData.localChanged();
  }
}

/** The backend the visible catalog belongs to; events from any other are dropped. */
let boundBackendId = null;
let backendRevision = 0;

/**
 * Bind the page to one backend identity.
 *
 * Drafts and selections are per backend: the composer swaps its storage
 * namespace, and a switch back restores exactly what that backend had.
 */
function adoptBackendIdentity(backendId) {
  if (!backendId || backendId === boundBackendId) return;
  boundBackendId = backendId;
  backendRevision += 1;
  composerSession.setBackend(backendId);
  void draftRecovery.refresh();
  // The backend's own draft namespace may name a different last conversation
  // than the page had before the session bound. A conversation link keeps its
  // choice; otherwise the stored slot is what "the last conversation" means.
  if (!initialConversationTaskId) {
    const active = composerSession.activeTask;
    state.selected = active;
    state.composingNew = !active && composerSession.hasNewDraft;
    state.selectedProjectId = composerSession.activeProject ?? null;
    composerSession.activate(active, { projectId: state.selectedProjectId });
  }
}

/** Drop everything that belonged to the backend being left. */
function resetBackendView() {
  computerUse.reset();
  artifactViewer.reset();
  artifacts.resetMedia();
  clearManagedMedia();
  connection.close();
  boundBackendId = null;
  backendRevision += 1;
  void draftRecovery.refresh();
  state.selected = null;
  state.detail = null;
  state.tasks = [];
  state.projects = [];
  state.projectsLoaded = false;
  state.localMessages = [];
  state.previewPath = null;
  state.artifactDrawerOpen = false;
  state.openFiles = [];
  state.artifactCache.clear();
  state.viewerTaskId = null;
  state.modelByTask.clear();
  state.thinkingLevelByTask.clear();
  state.models = [];
  state.model = null;
  state.defaultModel = null;
  state.modelConfigured = undefined;
  state.connectionProfileId = undefined;
  state.workspacePath = null;
  state.workspaceRoot = null;
  state.workspaceLabel = null;
  state.selectedProjectId = null;
  state.composingNew = false;
  renderedDetailSignature = undefined;
  projectController.reset();
  composerSession.detach();
  renderConversationList();
  renderEmpty();
  updateSendButton();
}

/** The client's catalog snapshot: same payload as `/api/tasks`, plus its cursor. */
function adoptCatalogSnapshot(snapshot) {
  if (!snapshot || snapshot.backendId !== management.state().backendId) return;
  taskNotifications.snapshot(snapshot);
  if (snapshot.backendId !== boundBackendId) resetBackendView();
  adoptBackendIdentity(snapshot.backendId);
  // The snapshot is a catalog read: accept it exactly like `/api/tasks` before
  // deciding which conversation it names.
  projectController.accept(snapshot);
  // eslint-disable-next-line no-restricted-syntax -- a snapshot whose detail read fails while the backend restarts is re-applied by the 3.5s catalog poll
  void applyCatalog(snapshot).catch(() => undefined);
  observeData.localChanged();
}

/** Apply one live catalog event without waiting for a poll. */
function applyCatalogEvent(record) {
  if (!record || record.backendId !== boundBackendId) return;
  taskNotifications.event(record);
  if (record.scope === "task") {
    const index = state.tasks.findIndex((task) => task.taskId === record.objectId);
    if (record.type === "task.deleted") {
      if (index >= 0) state.tasks.splice(index, 1);
      if (state.selected === record.objectId) {
        state.selected = null;
        state.detail = null;
        connection.close();
      }
    } else {
      const task = record.payload;
      if (!task || typeof task.taskId !== "string") return;
      if (index >= 0) state.tasks[index] = { ...state.tasks[index], ...task };
      else state.tasks.unshift(task);
    }
  } else if (record.scope === "project" && record.type === "project.changed") {
    const project = record.payload;
    if (!project || typeof project.projectId !== "string") return;
    const index = state.projects.findIndex((entry) => entry.projectId === project.projectId);
    if (index >= 0) state.projects[index] = { ...state.projects[index], ...project };
    else state.projects.push({ ...project, tasks: [] });
  } else {
    return;
  }
  for (const project of state.projects) {
    project.tasks = state.tasks.filter(
      (task) =>
        task.projectId === project.projectId ||
        (project.tasks || []).some((entry) => entry.taskId === task.taskId)
    );
  }
  renderConversationList();
  if (state.selected) connectEventStream(state.selected);
  updateSendButton();
  observeData.localChanged();
}

function detailViewSignature(detail) {
  const { elapsedMs: _elapsed, observedAt: _observed, ...statistics } = detail.statistics || {};
  return JSON.stringify({ ...detail, statistics });
}

function loadDetail(taskId, options) {
  if (state.selected === taskId) {
    composerSession.activate(taskId);
    if (state.detail?.task?.taskId !== taskId) {
      const task = state.tasks.find((item) => item.taskId === taskId) || { taskId };
      projectController.selectTask(task);
      state.detail = { task, messages: [] };
      state.model =
        state.modelByTask.get(taskId) ||
        (state.connectionProfileId ? state.defaultModel : task.model) ||
        state.defaultModel ||
        state.model;
      setModelLabel(state.model);
      if (!state.thinkingLevelByTask.has(taskId))
        state.thinkingLevelByTask.set(taskId, defaultThinkingLevelForNewConversation());
      state.thinkingLevel = state.thinkingLevelByTask.get(taskId) ?? null;
      setThinkingLabel(state.thinkingLevel);
      renderAll();
    }
  }
  return detailReads(taskId, options);
}

async function readDetail(taskId, { poll = false, isCurrent = () => true } = {}) {
  if (state.selected !== taskId) return;
  const requestSequence = ++detailRequestSequence;
  try {
    const detail = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
    if (!isCurrent() || state.selected !== taskId || requestSequence !== detailRequestSequence) return;
    if (state.viewerTaskId !== taskId) {
      state.viewerTaskId = taskId;
      state.openFiles = [];
      state.artifactCache.clear();
      state.previewPath = null;
      state.drawerTab = null;
      state.drawerFile = null;
      state.drawerDiff = null;
      state.artifactDrawerOpen = false;
      requirementPanel.reset();
    }
    if (state.detail?.task?.taskId === taskId) {
      if (state.detail.conversationVersion === detail.conversationVersion)
        detail.runtimeEvents = mergeRuntimeEvents(detail.runtimeEvents, state.detail.runtimeEvents);
      else connection.close();
    }
    connection.remember(taskId, detail.runtimeEvents);
    state.detail = detail;
    const taskModel =
      (state.connectionProfileId ? state.defaultModel : detail.task?.model) ||
      detail.runtime?.model ||
      state.defaultModel;
    if (taskModel && !state.modelByTask.has(taskId)) state.modelByTask.set(taskId, taskModel);
    if (state.selected === taskId) {
      state.model = state.modelByTask.get(taskId) || taskModel || state.model;
      setModelLabel(state.model);
      if (!state.thinkingLevelByTask.has(taskId))
        state.thinkingLevelByTask.set(taskId, defaultThinkingLevelForNewConversation());
      state.thinkingLevel = state.thinkingLevelByTask.get(taskId) ?? null;
      setThinkingLabel(state.thinkingLevel);
    }
    state.workspacePath = detail.storageRoot || detail.task?.storageRoot || state.workspaceRoot || null;
    state.workspaceLabel = workspaceDisplayName(state.workspacePath);
    const savedUsers = (detail.messages || []).filter((message) => message.role === "user").length;
    const localCount = state.localMessages.length;
    state.localMessages = state.localMessages.filter(
      (message) =>
        message.taskId === taskId &&
        (message.interjected
          ? !(detail.messages || []).some((saved) => saved.id === message.id)
          : savedUsers <= message.savedUsers)
    );
    if (
      !poll ||
      state.localMessages.length !== localCount ||
      detailViewSignature(detail) !== renderedDetailSignature
    )
      renderAll();
  } catch (error) {
    if (isCurrent() && state.selected === taskId && requestSequence === detailRequestSequence)
      showToast(ui`Task 加载失败：${error.message}`);
  }
}

function renderConversationList() {
  if (lastReadSelection !== state.selected) {
    if (state.selected) conversationReadState.setUnread(state.selected, false);
    lastReadSelection = state.selected;
  }
  if (state.projectsLoaded) {
    const url = new URL(location.href);
    if (state.selected) url.searchParams.set("task", state.selected);
    else url.searchParams.delete("task");
    if (url.href !== location.href) history.replaceState(null, "", url.href);
  }
  projectController.render();
  mainSessionsController.render();
  newSession.sync();
}

function selectConversation(taskId) {
  sessionMenu.close();
  conversationReadState.setUnread(taskId, false);
  document.body.classList.remove("sidebar-mobile-open");
  state.selected = taskId;
  state.composingNew = false;
  state.previewPath = null;
  state.drawerTab = null;
  state.drawerFile = null;
  state.drawerDiff = null;
  state.artifactDrawerOpen = false;
  state.openFiles = [];
  state.artifactCache.clear();
  state.viewerTaskId = null;
  state.localMessages = [];
  requirementPanel.reset();
  connectEventStream(taskId);
  renderConversationList();
  void loadDetail(taskId);
  void enterConversation(taskId);
}

function renderAll() {
  computerUse.syncTask();
  const detail = state.detail || {};
  const task = detail.task || {};
  $("#topbar-task").textContent = truncate(conversationTitle(task), 44);
  if (detail.runtime?.model) setModelLabel(detail.runtime.model);
  updateSendButton();
  renderConversation(detail.messages || [], task);
  humanQuestions.update(detail);
  renderRightPanel();
  syncBindingFromTabs();
  renderedDetailSignature = detailViewSignature(detail);
}

function renderRightPanel() {
  const artifacts = state.detail?.artifacts || [];
  const artifactPaths = new Set(artifacts.map((artifact) => artifact.relativePath));
  invalidateArtifactCache(state.artifactCache, artifacts);
  state.openFiles = state.openFiles.filter((path) => artifactPaths.has(path));
  if (state.previewPath && !artifactPaths.has(state.previewPath))
    state.previewPath = state.openFiles.at(-1) || null;
  requirementPanel.render();
  renderArtifactDrawer();
}
function renderEmpty() {
  renderedDetailSignature = undefined;
  computerUse.syncTask();
  $("#topbar-task").textContent = ui("新会话");
  newSession.render();
  newSession.sync();
  humanQuestions.update(null);
  renderRightPanel();
  paintTopbarContext();
}
function paintTopbarContext() {
  const application = workbenchController.host?.applicationTab;
  const editing = Boolean(application && $("#conversation-pane").hidden);
  const name = editing
    ? application.title || appDisplayName(application.appType)
    : state.selected
      ? conversationTitle(state.detail?.task || state.tasks.find((task) => task.taskId === state.selected))
      : ui("新会话");
  $("#topbar-task").textContent = truncate(name, 44);
  $("#topbar-task").title = name;
  $("#session-menu-button").hidden = editing;
  $("#session-menu-button").title = state.selected ? ui("会话菜单") : ui("会话菜单 · 发送消息后可管理会话");
  if (
    sessionMenu.trigger === $("#session-menu-button") &&
    sessionMenu.context !== currentSessionMenuContext()
  )
    sessionMenu.close();
}
function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  return content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("");
}
function shortDate(value) {
  return formatStamp(value, window.atriaPreferences?.format() ?? "relative");
}
function truncate(value, length) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function beginNewConversation(projectId, applicationWorkspace) {
  if (!state.projectsLoaded) return false;
  sessionMenu.close();
  const project =
    typeof projectId === "string"
      ? projectController.select(projectId)
      : projectId === null
        ? undefined
        : projectController.projectForWorkspace(applicationWorkspace) || projectController.currentProject();
  if (project) projectController.select(project.projectId);
  else state.selectedProjectId = null;
  composerSession.activate(null, {
    projectId: project?.projectId,
    fresh:
      currentSubmission() &&
      state.selected === null &&
      composerSession.currentKey === `new:${encodeURIComponent(project?.projectId ?? "")}`
  });
  document.body.classList.remove("sidebar-mobile-open");
  connection.close();
  state.selected = null;
  state.detail = null;
  state.composingNew = true;
  state.model = defaultModelForNewConversation();
  setModelLabel(state.model);
  state.thinkingLevel = defaultThinkingLevelForNewConversation();
  setThinkingLabel(state.thinkingLevel);
  state.localMessages = [];
  state.previewPath = null;
  state.drawerTab = null;
  state.drawerFile = null;
  state.drawerDiff = null;
  state.artifactDrawerOpen = false;
  state.openFiles = [];
  state.artifactCache.clear();
  state.viewerTaskId = null;
  requirementPanel.reset();
  state.workspacePath = state.workspaceRoot;
  state.workspaceLabel = state.workspaceRoot ? workspaceDisplayName(state.workspaceRoot) : null;
  renderConversationList();
  renderEmpty();
  updateSendButton();
  // A conversation is a tab from the moment it is asked for. Without one the
  // strip went on highlighting the previous conversation while the composer
  // was writing a new one, so the row and the pane disagreed about where the
  // person was — and an application tab covering the area made the click look
  // like it had done nothing at all.
  const host = ensureWorkbench();
  if (host) {
    host.openDraftConversation();
    $("#workbench").hidden = false;
    $("#conversation-pane").hidden = false;
    document.body.classList.remove("app-fullbleed");
    $("#composer-input").focus();
    return true;
  }
  void showConversationArea().then(() => $("#composer-input").focus());
  return true;
}

/**
 * Put the conversation back in front of whatever application is showing.
 *
 * The strip is global, so an editor from any task can be the active tab. A
 * request to work in the conversation therefore has to move the strip, not just
 * change which task is selected — the tab is what decides what fills the pane.
 */
async function showConversationArea() {
  const active = workbenchController.host?.activeTab;
  if (!active || active.kind === "conversation") return;
  // Prefer this task's own conversation tab; with no task selected there is
  // nothing to activate, so the application is simply set aside.
  const own =
    state.selected &&
    workbenchController.tabs.tabs.find((tab) => tab.kind === "conversation" && tab.taskId === state.selected);
  if (own) {
    await workbenchController.host?.activate(own.tabId);
    return;
  }
  const anyConversation = workbenchController.tabs.tabs.find((tab) => tab.kind === "conversation");
  if (anyConversation && !state.selected) {
    await workbenchController.host?.activate(anyConversation.tabId);
    return;
  }
  await workbenchController.host?.showConversation();
}

let taskSearchDialog;
function openTaskSearch() {
  let overlay = $("#task-search");
  if (overlay && !overlay.hidden) return taskSearchDialog.close();
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "task-search";
    overlay.className = "search-overlay";
    overlay.hidden = true;
    overlay.innerHTML = ui`<section class="search-dialog" role="dialog" aria-modal="true" aria-label="搜索对话" aria-describedby="task-search-hint"><div class="search-dialog-head">${icon("search")}<input id="task-search-input" aria-label="搜索对话" placeholder="按名称或任务内容搜索…" autocomplete="off"/><button type="button" aria-label="关闭搜索">Esc</button></div><div id="task-search-results" aria-label="匹配的对话"></div><footer class="search-dialog-foot"><span id="task-search-hint">↑ ↓ 选择 · Enter 打开</span><span id="task-search-count" role="status"></span></footer></section>`;
    document.body.appendChild(overlay);
    taskSearchDialog = createModal(overlay, overlay.querySelector("button"));
    const input = overlay.querySelector("input");
    const results = overlay.querySelector("#task-search-results");
    const draw = () => {
      const query = input.value.trim().toLowerCase();
      const matches = state.tasks.filter((task) =>
        `${task.title || ""} ${task.goal || ""} ${task.taskId}`.toLowerCase().includes(query)
      );
      results.innerHTML = matches.length
        ? matches
            .slice(0, 12)
            .map(
              (task) =>
                `<button type="button" class="search-result" data-task="${esc(task.taskId)}" title="${esc(conversationTitle(task))}"><strong>${esc(conversationTitle(task))}${task.archived ? ui(" · 已归档") : ""}</strong><small>${esc(stateText(task.status))} · ${esc(shortDate(task.updatedAt))}</small></button>`
            )
            .join("")
        : ui('<div class="search-no-results">没有匹配的对话，试试其他关键词</div>');
      overlay.querySelector("#task-search-count").textContent =
        matches.length > 12 ? ui`显示前 12 项，共 ${matches.length} 项` : ui`${matches.length} 个对话`;
      results.querySelectorAll("[data-task]").forEach((node) =>
        node.addEventListener("click", () => {
          document.body.classList.remove("sidebar-mobile-open");
          taskSearchDialog.close();
          void activateConversationTab(node.dataset.task);
        })
      );
    };
    input.addEventListener("input", draw);
    overlay.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      const choices = [...results.querySelectorAll("[data-task]")];
      const index = choices.indexOf(document.activeElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next =
          event.key === "ArrowDown"
            ? (index + 1) % choices.length
            : index <= 0
              ? choices.length - 1
              : index - 1;
        choices[next]?.focus();
      } else if (event.key === "Home" && index >= 0) {
        event.preventDefault();
        choices[0]?.focus();
      } else if (event.key === "End" && index >= 0) {
        event.preventDefault();
        choices.at(-1)?.focus();
      } else if (event.key === "Enter" && event.target === input) {
        event.preventDefault();
        choices[0]?.click();
      }
    });
    overlay.drawResults = draw;
  }
  overlay.querySelector("input").value = "";
  overlay.drawResults();
  taskSearchDialog.open();
}

function positionModelMenu(button = $("#model-select"), menu = $("#model-menu")) {
  if (!menu || !button || menu.hidden || !menu.offsetParent) return;
  const bounds = menu.offsetParent.getBoundingClientRect();
  const anchor = button.getBoundingClientRect();
  const maximum = Math.max(0, bounds.width - menu.getBoundingClientRect().width);
  menu.style.left = `${Math.min(maximum, Math.max(0, anchor.left - bounds.left))}px`;
}

function renderModelMenu() {
  const menu = $("#model-menu");
  const button = $("#model-select");
  if (!menu || !button) return;
  const models = state.models.length ? state.models : [state.model || state.defaultModel || "glm-5.3"];
  menu.innerHTML = ui`<div class="model-menu-title">选择模型</div>${models.map((model) => `<button type="button" class="model-option ${model === state.model ? "active" : ""}" data-model="${esc(model)}" role="option" aria-selected="${model === state.model}"><span class="model-option-check">${model === state.model ? icon("check") : ""}</span><span class="model-option-name">${esc(model)}</span></button>`).join("")}`;
  menu.hidden = false;
  positionModelMenu();
  button.setAttribute("aria-expanded", "true");
  menu.querySelector("button.active, button")?.focus();
  menu
    .querySelectorAll("[data-model]")
    .forEach((node) => node.addEventListener("click", () => chooseModel(node.dataset.model)));
}

function closeModelMenu() {
  const menu = $("#model-menu");
  const button = $("#model-select");
  if (!menu || !button) return;
  menu.hidden = true;
  button.setAttribute("aria-expanded", "false");
}

async function toggleModelMenu() {
  const menu = $("#model-menu");
  if (!menu) return;
  if (!menu.hidden) return closeModelMenu();
  if (!state.models.length) await loadModels();
  renderModelMenu();
}

function chooseModel(model) {
  const selected = String(model || "").trim();
  if (!selected) return;
  state.model = selected;
  if (state.selected) state.modelByTask.set(state.selected, selected);
  writePreferredModel(selected);
  setModelLabel(selected);
  closeModelMenu();
  showToast(ui`已切换模型：${selected}`);
}

function renderThinkingMenu() {
  const menu = $("#reasoning-menu");
  const button = $("#reasoning-select");
  if (!menu || !button) return;
  const options = [
    ["auto", ui("自动")],
    ["off", ui("关闭")],
    ["low", ui("低")],
    ["medium", ui("中")],
    ["high", ui("高")],
    ["xhigh", ui("极高")],
    ["max", ui("最大")]
  ];
  const selected = state.thinkingLevel || "auto";
  menu.innerHTML = ui`<div class="model-menu-title">推理强度</div>${options
    .map(
      ([value, label]) =>
        `<button type="button" class="model-option ${value === selected ? "active" : ""}" data-thinking-level="${value}" role="option" aria-selected="${value === selected}"><span class="model-option-check">${value === selected ? icon("check") : ""}</span><span class="model-option-name">${label}</span></button>`
    )
    .join("")}`;
  menu.hidden = false;
  positionModelMenu(button, menu);
  button.setAttribute("aria-expanded", "true");
  menu.querySelector("button.active, button")?.focus();
  menu
    .querySelectorAll("[data-thinking-level]")
    .forEach((node) => node.addEventListener("click", () => chooseThinkingLevel(node.dataset.thinkingLevel)));
}

function closeThinkingMenu() {
  const menu = $("#reasoning-menu");
  const button = $("#reasoning-select");
  if (!menu || !button) return;
  menu.hidden = true;
  button.setAttribute("aria-expanded", "false");
}

function toggleThinkingMenu() {
  const menu = $("#reasoning-menu");
  if (!menu) return;
  if (!menu.hidden) return closeThinkingMenu();
  renderThinkingMenu();
}

function chooseThinkingLevel(value) {
  const selected = value === "auto" ? null : String(value || "").trim();
  if (selected && !Object.hasOwn(THINKING_LEVEL_LABELS, selected)) return;
  state.thinkingLevel = selected;
  if (state.selected) state.thinkingLevelByTask.set(state.selected, selected);
  writePreferredThinkingLevel(selected);
  setThinkingLabel(selected);
  closeThinkingMenu();
}

async function toggleOutputPane() {
  if (await workbenchController.toggleWorkspace()) return;
  document.body.classList.toggle("output-collapsed");
  if (!document.body.classList.contains("output-collapsed")) renderRightPanel();
}

function renderAttachments() {
  const strip = $("#attachment-strip");
  if (!strip) return;
  strip.innerHTML = state.attachments
    .map(
      (file, index) =>
        ui`<span class="attachment-chip"><span class="attachment-chip-icon">${file.kind === "image" ? `<img data-upload-src="${encodeURIComponent(file.uploadId)}" alt="" />` : icon("paperclip")}</span>${file.uploadId ? ui`<button type="button" class="attachment-name" data-upload-preview="${esc(file.uploadId)}" title="预览 ${esc(file.name)}">${esc(file.name)}</button>` : `<span class="attachment-name">${esc(file.name)}</span>`} <small>${esc(formatArtifactSize(file.size ?? new TextEncoder().encode(file.text || "").length))} · ${file.uploadId ? ui("已添加") : ui("完整文本")}</small><button data-remove-attachment="${index}" aria-label="移除 ${esc(file.name)}">${icon("close")}</button></span>`
    )
    .join("");
  strip.hidden = state.attachments.length === 0;
  strip.querySelectorAll("[data-remove-attachment]").forEach((node) =>
    node.addEventListener("click", () => {
      state.attachments.splice(Number(node.dataset.removeAttachment), 1);
      renderAttachments();
      composerSession.save();
      updateSendButton();
    })
  );
  hydrateUploadImages(strip);
}

function clearAttachments() {
  state.attachments = [];
  const input = $("#file-input");
  if (input) input.value = "";
  renderAttachments();
}

createConversationLayout($("#conversation"));
async function stopTask(taskId = state.selected) {
  if (!taskId || isTaskStopping(taskId)) return;
  stopEpochs.set(taskId, (stopEpochs.get(taskId) || 0) + 1);
  stoppingTasks.add(taskId);
  updateSendButton();
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "cancel" })
    });
    await refresh();
    showToast(ui("任务已停止，已保存的内容保留"));
  } catch (error) {
    showToast(requestErrorMessage(error));
  } finally {
    stoppingTasks.delete(taskId);
    updateSendButton();
  }
}
$("#stop-button").addEventListener("click", () => void stopTask());
$("#send-button").addEventListener("click", () => void sendMessage());
$("#composer-input").addEventListener("input", updateSendButton);
$("#composer-input").addEventListener("keydown", (event) => {
  // Enter sends like a desktop chat client; Shift+Enter keeps the textarea multiline.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void sendMessage();
  }
});
$("#new-conversation").addEventListener("click", beginNewConversation);
$("#output-pane-toggle").addEventListener("click", toggleOutputPane);
$("[data-panel-collapse]")?.addEventListener("click", () => void toggleOutputPane());
document.addEventListener("keydown", (event) => {
  const modifier = event.metaKey || event.ctrlKey;
  const modalOpen =
    document.querySelector('[role="dialog"]') &&
    [...document.querySelectorAll('[role="dialog"]')].some((node) => node.getClientRects().length);
  if (modifier && event.key.toLowerCase() === "p" && !event.isComposing && !modalOpen) {
    event.preventDefault();
    openTaskSearch();
  }
  if (modifier && event.key.toLowerCase() === "k" && !event.isComposing && !modalOpen) {
    event.preventDefault();
    beginNewConversation();
  }
  if (event.key === "Escape" && state.artifactDrawerOpen) closeArtifactDrawer(true);
});

$("#model-select").addEventListener("click", () => void toggleModelMenu());
$("#reasoning-select").addEventListener("click", toggleThinkingMenu);
document.addEventListener("click", (event) => {
  if (!event.target.closest("#model-select, #model-menu")) closeModelMenu();
  if (!event.target.closest("#reasoning-select, #reasoning-menu")) closeThinkingMenu();
});
$("#app-bind-select")?.addEventListener("click", () => ensureBinding()?.toggle());
document.addEventListener("click", (event) => {
  if (!event.target.closest("#app-bind-select, #app-bind-menu")) workbenchController.binding?.close();
});
const sessionAction = createConversationOperations({
  api,
  readState: conversationReadState,
  onReadChange: () => renderConversationList(),
  titleFor: conversationTitle,
  rename: renameConversation,
  update: updateConversation,
  remove: removeConversation,
  stop: stopTask,
  showToast
});
const sessionMenu = createConversationMenu({
  trigger: $("#session-menu-button"),
  panel: $("#session-menu"),
  getTask: (taskId) => state.tasks.find((task) => task.taskId === taskId),
  getContext: currentSessionMenuContext,
  isTaskActive: (taskId, task) =>
    ["running", "waiting"].includes(task.status) ||
    (state.detail?.task?.taskId === taskId && state.detail?.runtime?.active),
  isTaskStopping,
  isUnread: (taskId) => conversationReadState.isUnread(taskId),
  onAction: (action, taskId, task) => void sessionAction(action, taskId, task)
});
function currentSessionMenuContext() {
  return JSON.stringify([
    state.selected,
    $("#conversation-pane").hidden ? workbenchController.host?.applicationTab?.tabId : null
  ]);
}
$("#session-menu-button").addEventListener("click", (event) =>
  sessionMenu.open(event.currentTarget, state.selected)
);
window.addEventListener("resize", () => sessionMenu.reposition());
$("#project-list").addEventListener("scroll", () => sessionMenu.reposition(), true);
window.addEventListener("storage", (event) => {
  if (event.key !== "atria.conversations.unread.v1" && event.key !== null) return;
  conversationReadState.reload();
  renderConversationList();
});
window.addEventListener("popstate", () => {
  const taskId = conversationTaskId(location.href);
  if (!taskId || taskId === state.selected) return;
  if (state.tasks.some((task) => task.taskId === taskId)) selectConversation(taskId);
});
createMenu($("#model-select"), $("#model-menu"), { toggleOnClick: false, onClose: closeModelMenu });
createMenu($("#reasoning-select"), $("#reasoning-menu"), {
  toggleOnClick: false,
  onClose: closeThinkingMenu
});
window.addEventListener("resize", () => {
  positionModelMenu();
  positionModelMenu($("#reasoning-select"), $("#reasoning-menu"));
});
createMenu($("#app-bind-select"), $("#app-bind-menu"), {
  toggleOnClick: false,
  onClose: () => workbenchController.binding?.close()
});
/**
 * The observation entry's read-only port.
 *
 * The local node is the page's existing client; every remote node gets one of
 * its own, stored per origin, so a token or failure never crosses nodes. The
 * work entry keeps using only the local client above.
 */
let observeSidebar;
const observeData = createObserveData({
  storage: draftStorage,
  sessionStorage: browserSessionStorage,
  local: {
    origin: location.origin,
    name: ui("本机"),
    role: "internal",
    status: () => {
      // The same "online" flag the page's offline banner uses: a catalog read
      // that could not reach the backend means the local node is offline even
      // while the management client still reports its old session.
      if (!state.online) return "offline";
      const status = management.state().status;
      if (status === "connected") return "online";
      if (status === "connecting" || status === "idle") return "connecting";
      if (status === "unauthorized") return "unauthorized";
      return "offline";
    },
    snapshot: () => ({ projects: state.projects, tasks: state.tasks }),
    request: (path, options) => management.request(path, options)
  }
});
const settingsPages = createSettingsPages({
  root: $("#settings-entry"),
  app: $("#app-layout"),
  api,
  showToast,
  nodes: () => observeData.nodes(),
  members: () => [{ id: "self", name: ui("我"), owner: true }],
  addNode: (input) => observeData.addNode(input),
  renameNode: (origin, name) => observeData.renameNode(origin, name),
  reauthorizeNode: (origin) => observeData.reauthorizeNode(origin),
  reconnectNode: (origin) => observeData.reconnectNode(origin),
  disconnectNode: (origin) => observeData.disconnectNode(origin),
  removeNode: (origin) => observeData.removeNode(origin)
});
observeSidebar = createObserveSidebar({
  root: $(".observe-nav"),
  pane: $("#observe-entry"),
  data: observeData,
  addNode: () => settingsPages.addNodeDialog()
});
/**
 * The observation requirement view reads through the same port: the list, its
 * phase tabs and the detail are one read-only view of every connected node.
 */
observeRequirements = createObserveRequirements({
  pane: $("#observe-entry"),
  detail: $("#observe-detail"),
  layout: $(".app-layout"),
  data: observeData,
  showToast
});
observeRequirements.applyEntry(entryController.state());
observeData.subscribe(() => {
  observeSidebar.render();
  settingsPages.refresh();
});
document.querySelector(ui('.sidebar-icon[title="搜索"]'))?.addEventListener("click", openTaskSearch);
attachmentPreview = installAttachmentPreview({ api, mediaUrl: mediaObjectUrl });
fileUpload = createFileUpload({
  upload: (file, options) => management.upload(file, options),
  getContext: () => composerSession.currentToken,
  getFiles: () => state.attachments,
  setFiles: (files) => {
    state.attachments = files;
    renderAttachments();
    composerSession.save();
    updateSendButton();
  },
  onBusy: (busy) => {
    readingAttachments = busy;
    updateSendButton();
  },
  onError: showToast,
  onStatus: (status) => {
    const panel = $("#upload-status");
    panel.hidden = !status;
    panel.innerHTML = !status
      ? ""
      : status.failed
        ? ui`<span>${status.failed} 个文件未添加</span><button type="button" data-upload-retry>重试</button><button type="button" data-upload-cancel>关闭</button>`
        : ui`<span>${esc(status.name)} · ${status.progress}% (${status.index}/${status.total})</span><button type="button" data-upload-cancel>取消</button>`;
    panel
      .querySelector("[data-upload-retry]")
      ?.addEventListener("click", () => fileUpload.retry().catch((error) => showToast(error.message)));
    panel.querySelector("[data-upload-cancel]")?.addEventListener("click", () => fileUpload.cancel());
  }
});
async function addFiles(files) {
  try {
    await fileUpload.add(Array.from(files));
  } catch (error) {
    showToast(error.message);
  }
}
$(".attach-button").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", (event) => {
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  void addFiles(files);
});
createComposerClipboard({ input: $("#composer-input"), addFiles });
window.addEventListener("dragover", (event) => {
  if (Array.from(event.dataTransfer?.types || []).includes("Files")) event.preventDefault();
});
$(".composer").addEventListener("dragover", (event) => {
  if (Array.from(event.dataTransfer?.types || []).includes("Files")) {
    $(".composer").classList.add("is-file-drop");
    event.preventDefault();
  }
});
$(".composer").addEventListener("dragleave", (event) => {
  if (!$(".composer").contains(event.relatedTarget)) $(".composer").classList.remove("is-file-drop");
});
$(".composer").addEventListener("drop", (event) => {
  const files = event.dataTransfer?.files;
  if (files?.length) {
    event.preventDefault();
    event.stopPropagation();
    $(".composer").classList.remove("is-file-drop");
    void addFiles(files);
  }
});

window.addEventListener("drop", (event) => {
  if (event.dataTransfer?.files?.length) {
    event.preventDefault();
    showToast(ui("请将文件拖入对话输入区或应用编辑区；当前内容已保留。"));
  }
});

async function createTask(goal, workspaceRoot, submission, projectId) {
  const sourceKey = composerSession.currentKey;
  const sourceToken = composerSession.currentToken;
  const sourceNavigation = workbenchController.host?.navigationToken ?? 0;
  const sourceDraft = composerSession.snapshot();
  const sourceTask = state.selected;
  const sourceProject = projectId
    ? state.projects.find((project) => project.projectId === projectId)
    : workspaceRoot
      ? projectController.projectForWorkspace(workspaceRoot)
      : state.selectedProjectId === null
        ? undefined
        : projectController.currentProject();
  if (projectId && !sourceProject) throw new Error(ui("目标项目已不可用，请重新选择项目"));
  const creationKey = JSON.stringify([sourceProject?.projectId ?? null, sourceToken, sourceNavigation]);
  if (creatingTasks.has(creationKey)) return creatingTasks.get(creationKey);
  composerSession.save();
  const creation = createTaskFromDraft(
    goal,
    sourceTask,
    sourceKey,
    sourceToken,
    sourceDraft,
    sourceNavigation,
    sourceProject?.projectId ?? null,
    submission,
    sourceProject ? undefined : workspaceRoot
  );
  creatingTasks.set(creationKey, creation);
  try {
    return await creation;
  } finally {
    if (creatingTasks.get(creationKey) === creation) creatingTasks.delete(creationKey);
    composerSession.release(sourceToken);
  }
}

/**
 * One pending Task creation per draft and command content.
 *
 * A retry after an uncertain response must present the same operation id and
 * the same task id; otherwise a response that was lost after the commit would
 * become a second Task. Editing the draft changes the content key and starts a
 * genuinely new command.
 */
const pendingCreations = new Map();

function pendingCreation(draftIdentity, content) {
  const contentKey = JSON.stringify(content);
  const existing = pendingCreations.get(draftIdentity);
  if (existing && existing.contentKey === contentKey) return existing;
  const pending = {
    contentKey,
    operationId: management.newOperationId(),
    taskId: `task-${crypto.randomUUID()}`
  };
  pendingCreations.set(draftIdentity, pending);
  return pending;
}

async function createTaskFromDraft(
  goal,
  sourceTask,
  sourceKey,
  sourceToken,
  sourceDraft,
  sourceNavigation,
  projectId,
  submission,
  temporaryWorkspaceRoot
) {
  const draftIdentity = composerSession.currentDraftIdentity;
  const pending = pendingCreation(draftIdentity, [goal, projectId, temporaryWorkspaceRoot || null]);
  const taskId = pending.taskId;
  const body = { taskId, goal, projectId, ...(temporaryWorkspaceRoot ? { temporaryWorkspaceRoot } : {}) };
  // A catalog poll may expose the committed Task before this POST returns.
  if (submission) associateSubmission(submission, taskId);
  const task = await api.command("/api/tasks", {
    method: "POST",
    body,
    operationId: pending.operationId
  });
  if (pendingCreations.get(draftIdentity) === pending) pendingCreations.delete(draftIdentity);
  if (submission && task.taskId !== taskId) associateSubmission(submission, task.taskId);
  const foreground =
    state.selected === sourceTask &&
    (state.selectedProjectId ?? null) === projectId &&
    composerSession.currentToken === sourceToken &&
    (workbenchController.host?.navigationToken ?? 0) === sourceNavigation;
  composerSession.transfer(task.taskId, sourceKey, sourceToken, sourceDraft, { background: !foreground });
  if (!state.tasks.some((item) => item.taskId === task.taskId)) state.tasks.unshift(task);
  projectController.addTask(task);
  // The request owns its original draft; a late response must not undo navigation.
  if (!foreground || composerSession.currentKey !== task.taskId) {
    renderConversationList();
    return task.taskId;
  }
  state.selected = task.taskId;
  state.composingNew = false;
  state.detail = { task, messages: [] };
  state.localMessages = [];
  state.previewPath = null;
  state.artifactDrawerOpen = false;
  state.openFiles = [];
  state.artifactCache.clear();
  state.viewerTaskId = task.taskId;
  // The draft became this conversation, so its placeholder tab gives way to the
  // real one rather than sitting beside it.
  workbenchController.host?.dropDraft();
  // A document from another conversation can still be in front when creation
  // came from its binding button. Leave that view before refreshing, or its
  // owner would select the old conversation while opening the new one's tab.
  void workbenchController.host?.showConversation();
  void enterConversation(task.taskId);
  state.workspacePath = task.storageRoot || state.workspaceRoot;
  renderConversationList();
  // Clear the previous conversation's application binding immediately. Reading
  // the global strip must not hold up this conversation's first message.
  workbenchController.syncBindingFromTabs();
  void refreshTabs();
  return task.taskId;
}

/** Send to the running task's steering or follow-up queue, preserving draft ownership. */
async function interject(taskId, text, delivery = "followUp") {
  const draft = submissionDraft();
  const stopEpoch = stopEpochs.get(taskId) || 0;
  const model = state.model || state.defaultModel || undefined;
  const savedUsers = (state.detail?.messages || []).filter((message) => message.role === "user").length;
  const submission = beginSubmission(taskId);
  updateSendButton();
  try {
    let result;
    try {
      result = await api(`/api/tasks/${encodeURIComponent(taskId)}/interject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: text,
          delivery,
          attachmentIds: uploadedFileIds(JSON.parse(draft.attachments))
        })
      });
    } catch (error) {
      // A finished turn accepts the original complete message as a new run.
      // Neither navigation nor further typing may change its destination/input.
      if (error.status !== 409 || !/没有正在运行/.test(error.message)) throw error;
      // An explicit stop supersedes this request, even after cancellation settles.
      if (isTaskStopping(taskId) || (stopEpochs.get(taskId) || 0) !== stopEpoch) {
        showToast(ui("补充内容未发送，草稿已保留"));
        return;
      }
      await launchPrompt(taskId, text, {
        submission,
        model,
        thinkingLevel: state.thinkingLevel || undefined,
        resume: false,
        savedUsers,
        attachmentIds: uploadedFileIds(JSON.parse(draft.attachments))
      });
      clearSubmittedDraft(taskId, draft);
      await refresh();
      return;
    }
    clearSubmittedDraft(taskId, draft);
    if (state.selected === taskId) {
      state.localMessages = [
        ...state.localMessages,
        {
          role: "user",
          content: text,
          taskId,
          interjected: true,
          delivery,
          pending: delivery === "followUp",
          id: result.messageId,
          timestamp: Date.now()
        }
      ];
      renderAll();
    }
  } catch (error) {
    showToast(ui`补充失败：${requestErrorMessage(error)}`);
  } finally {
    finishSubmission(submission);
    updateSendButton();
  }
}

function currentSubmission() {
  return (
    (state.selected && sending.get(`task:${state.selected}`)) ||
    sending.get(`draft:${composerSession.currentDraftIdentity}`)
  );
}

function beginSubmission(taskId = state.selected) {
  const submission = { keys: new Set(), launching: false };
  const draftKey = `draft:${composerSession.currentDraftIdentity}`;
  submission.keys.add(draftKey);
  sending.set(draftKey, submission);
  if (taskId) associateSubmission(submission, taskId);
  return submission;
}

function associateSubmission(submission, taskId) {
  const key = `task:${taskId}`;
  submission.keys.add(key);
  sending.set(key, submission);
}

function finishSubmission(submission) {
  for (const key of submission.keys) if (sending.get(key) === submission) sending.delete(key);
}

function submissionDraft() {
  return {
    input: $("#composer-input").value,
    attachments: JSON.stringify(state.attachments),
    token: composerSession.currentToken,
    focusedSend: document.activeElement === $("#send-button")
  };
}

function clearSubmittedDraft(taskId, draft) {
  const input = $("#composer-input");
  if (
    state.selected === taskId &&
    composerSession.currentToken === draft.token &&
    input.value === draft.input &&
    JSON.stringify(state.attachments) === draft.attachments
  ) {
    input.value = "";
    clearAttachments();
    composerSession.save();
    if (
      draft.focusedSend &&
      document.activeElement === document.body &&
      input.getClientRects().length &&
      $("#human-questions").hidden
    )
      input.focus({ preventScroll: true });
  }
}

async function launchPrompt(
  taskId,
  prompt,
  { model, thinkingLevel, resume, retryRequestId, savedUsers, attachmentIds = [], submission, body }
) {
  if (submission) submission.launching = true;
  let optimisticMessage;
  if (state.selected === taskId && prompt) {
    optimisticMessage = { role: "user", content: prompt, taskId, savedUsers };
    state.localMessages = [...state.localMessages, optimisticMessage];
    state.submittingTaskId = taskId;
    renderAll();
  }
  try {
    const run = await api(`/api/tasks/${encodeURIComponent(taskId)}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, body, resume, model, thinkingLevel, attachmentIds, retryRequestId })
    });
    // A queued demand is accepted but not running: keeping the optimistic
    // running state would route the next message into interject instead of
    // letting the server refuse a different input.
    if (run.status === "queued") {
      showToast(ui`已排队第 ${run.queuePosition ?? 1} 位`);
      return run;
    }
    if (run.model) {
      state.modelByTask.set(taskId, run.model);
      if (state.selected === taskId) {
        state.model = run.model;
        setModelLabel(run.model);
      }
    }
    if (state.selected === taskId) {
      const detail = state.detail?.task?.taskId === taskId ? state.detail : {};
      state.detail = {
        ...detail,
        task: { ...detail.task, taskId, activeRunId: run.runId, status: "running" },
        runtime: { ...detail.runtime, active: true }
      };
      renderAll();
      connectEventStream(taskId);
    }
    return run;
  } catch (error) {
    state.localMessages = state.localMessages.filter((message) => message !== optimisticMessage);
    throw error;
  }
}

function isTaskStopping(taskId = state.selected) {
  return Boolean(
    stoppingTasks.has(taskId) || (state.detail?.task?.taskId === taskId && state.detail?.runtime?.stopping)
  );
}

function updateSendButton() {
  messageEdit.sync();
  const pendingSubmission = currentSubmission();
  const isSending = Boolean(pendingSubmission);
  state.submittingTaskId = pendingSubmission?.launching ? state.selected : null;
  // While working, new messages wait in the queue and can be promoted explicitly.
  const running = Boolean(state.detail?.task?.taskId === state.selected && state.detail?.runtime?.active);
  const stopping = isTaskStopping();
  const hasDraft = Boolean($("#composer-input").value.trim() || state.attachments.length);
  const showStop = stopping || (running && !hasDraft);
  renderMessageQueue($("#queued-messages"), {
    taskId: state.selected,
    messages:
      state.detail?.task?.taskId === state.selected
        ? [...(state.detail.messages || []), ...state.localMessages]
        : [],
    running,
    promoting: promotingMessages,
    disabled: !state.online || stopping,
    cancel: (taskId, messageId) => promoteQueuedMessage(taskId, messageId, "cancel"),
    promote: promoteQueuedMessage
  });
  const connecting = workbenchController.connecting;
  const backendReady = Boolean(backendConnection && backendConnection.ready());
  $("#send-button").hidden = showStop;
  $("#send-button").disabled =
    isSending || readingAttachments || connecting || stopping || !state.online || !backendReady;
  $("#stop-button").hidden = !showStop;
  $("#stop-button").disabled = stopping;
  $("#stop-button").setAttribute("aria-busy", String(stopping));
  $("#stop-button").setAttribute("aria-label", stopping ? ui("正在停止任务") : ui("停止任务"));
  $("#stop-button").title = stopping ? ui("正在停止任务…") : ui("停止任务");
  $("#model-setup-button").hidden = state.modelConfigured !== false;
  $("#send-button").title = !backendReady
    ? ui("后端连接不可用")
    : connecting
      ? ui("正在关联文件…")
      : isSending
        ? ui("正在发送…")
        : readingAttachments
          ? ui("正在读取附件…")
          : running
            ? ui("排队发送（当前任务结束后处理）")
            : ui("发送（Enter）");
  $("#send-button").setAttribute("aria-label", running ? ui("排队发送") : ui("发送"));
  if (composerSession.editing) {
    $("#send-button").title = ui("请先保存或取消正在编辑的消息");
    $("#send-button").disabled = true;
  }
}

async function promoteQueuedMessage(taskId, messageId, action = "steer") {
  const key = `${taskId}:${messageId}`;
  if (promotingMessages.has(key)) return;
  promotingMessages.add(key);
  updateSendButton();
  try {
    const result = await api(
      `/api/tasks/${encodeURIComponent(taskId)}/interject/${encodeURIComponent(messageId)}/${action}`,
      {
        method: "POST"
      }
    );
    if (state.selected === taskId) {
      if (action === "cancel") {
        state.localMessages = state.localMessages.filter((message) => message.id !== messageId);
        if (state.detail?.messages)
          state.detail.messages = state.detail.messages.filter((message) => message.id !== messageId);
      } else {
        for (const message of [...(state.detail?.messages || []), ...state.localMessages])
          if (message.id === messageId) Object.assign(message, { delivery: "steer", pending: false });
      }
      if (result.status === "running") connectEventStream(taskId);
      renderAll();
    }
  } catch (error) {
    showToast(requestErrorMessage(error));
  } finally {
    promotingMessages.delete(key);
    if (state.selected === taskId) await loadDetail(taskId);
    updateSendButton();
  }
}

async function submitMessageEdit() {
  if (
    !composerSession.editing ||
    currentSubmission() ||
    readingAttachments ||
    workbenchController.connecting ||
    !state.online ||
    isTaskStopping()
  )
    return;
  const submission = beginSubmission();
  updateSendButton();
  try {
    await messageEdit.submit();
  } finally {
    finishSubmission(submission);
    renderAll();
    updateSendButton();
  }
}

async function sendMessage() {
  if (!$("#human-questions").hidden) return;
  const input = $("#composer-input");
  const text = input.value.trim() || (state.attachments.length ? ui("请查看这些附件。") : "");
  if (!text) return;
  if (currentSubmission() || readingAttachments || workbenchController.connecting || !state.online) return;
  if (isTaskStopping()) return;
  if (composerSession.editing) {
    return showToast(ui("请先保存或取消正在编辑的消息，底部草稿会保留。"));
  }
  if (state.modelConfigured === false) return void modelSettings.open();
  // Running input waits for the current work to end unless the user promotes it.
  if (state.detail?.task?.taskId === state.selected && state.detail?.runtime?.active && state.selected) {
    try {
      return interject(state.selected, composePrompt(text, state.attachments));
    } catch (error) {
      showToast(error.message);
      return;
    }
  }
  const draft = submissionDraft();
  const submission = beginSubmission();
  updateSendButton();
  const selectedTask = state.selected;
  const detail = state.detail?.task?.taskId === selectedTask ? state.detail : null;
  const runOptions = {
    submission,
    body: draft.input,
    attachmentIds: uploadedFileIds(JSON.parse(draft.attachments)),
    resume: detail?.task?.status === "waiting",
    model: state.model || state.defaultModel || undefined,
    thinkingLevel: state.thinkingLevel || undefined,
    savedUsers: (detail?.messages || []).filter((message) => message.role === "user").length
  };
  let prompt;
  try {
    prompt = composePrompt(text, state.attachments);
  } catch (error) {
    finishSubmission(submission);
    updateSendButton();
    showToast(error.message);
    return;
  }
  try {
    const taskId = selectedTask || (await createTask(text, undefined, submission));
    associateSubmission(submission, taskId);
    await launchPrompt(taskId, prompt, runOptions);
    clearSubmittedDraft(taskId, draft);
    await refresh();
  } catch (error) {
    showToast(ui`发送失败：${requestErrorMessage(error)}`);
  } finally {
    finishSubmission(submission);
    renderAll();
    updateSendButton();
  }
}

async function retryFailedRequest(taskId) {
  const detail = state.detail?.task?.taskId === taskId ? state.detail : null;
  if (
    !taskId ||
    state.selected !== taskId ||
    !detail ||
    detail.runtime?.active ||
    ["completed", "cancelled"].includes(detail.task.status) ||
    !$("#human-questions").hidden ||
    currentSubmission() ||
    readingAttachments ||
    workbenchController.connecting ||
    !state.online
  )
    return;
  if (state.modelConfigured === false) return void modelSettings.open();
  if (detail.retryRequestUnavailable) {
    showToast(ui("原始模型请求的重试记录不可用，已有历史和草稿已保留。请恢复工作区备份或主动发送新消息。"));
    return;
  }
  // The exact request identity is independent of the next unsent message.
  const runOptions = {
    resume: true,
    retryRequestId: detail.retryRequest?.requestId,
    savedUsers: (detail.messages || []).filter((message) => message.role === "user").length
  };
  const recoveryFocus = document.activeElement?.hasAttribute?.("data-retry-request");
  const navigation = composerSession.currentToken;
  let rejected = false;
  composerSession.save();
  const submission = beginSubmission(taskId);
  runOptions.submission = submission;
  updateSendButton();
  try {
    await launchPrompt(taskId, undefined, runOptions);
    await refresh();
  } catch (error) {
    rejected = true;
    const classified = requestErrorMessage(error);
    showToast(
      ui`重试未能启动：${error.code === "main_retry_context_changed" || error.code === "main_retry_snapshot_invalid" ? error.message : classified !== error.message ? classified : ui("已有内容和草稿已保留，请检查连接后重试。")}`
    );
  } finally {
    finishSubmission(submission);
    renderAll();
    updateSendButton();
    if (
      rejected &&
      recoveryFocus &&
      state.selected === taskId &&
      composerSession.currentToken === navigation &&
      document.activeElement === document.body
    )
      $("#conversation [data-retry-request]")?.focus({ preventScroll: true });
  }
}

composerSession.activate(state.selected, { projectId: state.selectedProjectId });
// Opening a conversation link is a navigation choice. Reserve it before the
// first tab poll can restore a different conversation or independent editor.
if (initialConversationTaskId) linkedConversationNavigation = workbenchController.captureNavigation();
/**
 * Authorize this page and load its backend.
 *
 * The page can manage another local backend than the one that served it, so
 * nothing is read before the session binds; a refused session or an
 * incompatible protocol leaves the page in an actionable state instead of a
 * half-populated screen.
 */
async function bootBackend() {
  const connected = await management.connect({
    baseUrl: window.bookmanDesktop?.backend ? "" : management.rememberedTarget()
  });
  if (connected.status !== "connected") {
    updateSendButton();
    return;
  }
  // Bind drafts to the backend before the first conversation is activated, or
  // the composer would read the pre-connection namespace.
  adoptBackendIdentity(connected.backendId);
  void computerUse.refresh();
  await loadModels();
  await refresh();
  await draftRecovery.refresh();
  updateSendButton();
  if (window.bookmanDesktop && state.modelConfigured === false) void modelSettings.open();
}
void bootBackend();
// Reserve initial navigation before starting reads that can restore a tab.
// Automatic reads pause while hidden; explicit actions still refresh directly.
// A catalog read stays as the bounded fallback; live changes arrive as events.
createVisiblePoll({ run: () => refresh({ poll: true }), intervalMs: 3500 });
// List metadata supplies immediate Task version changes. This independent
// fallback catches external history/job changes even without a Task version bump.
createVisiblePoll({
  run: () => {
    if (state.selected) {
      connectEventStream(state.selected);
      return loadDetail(state.selected, { poll: true });
    }
  },
  intervalMs: () =>
    connection.isStreaming(state.selected) ? 30000 : state.detail?.runtime?.active ? 3500 : 15000
});
createVisiblePoll({ run: () => refreshTabs({ poll: true }), intervalMs: 3500, immediate: true });

async function prepareInterfaceClose() {
  const documentsSaved = (await workbenchController.host?.prepareClose()) ?? true;
  if (readingAttachments) {
    showToast(ui("附件仍在读取，请稍候再关闭窗口或更新模型连接"));
    return false;
  }
  const repliesSaved = humanQuestions.flushDrafts();
  if (!repliesSaved) showToast(ui("人工回复草稿暂时无法保存，请保留当前窗口并稍后重试"));
  const composerSaved = composerSession.prepareClose();
  return documentsSaved && repliesSaved && composerSaved;
}
observeData.start();
backendConnection = createBackendConnection({
  management,
  settingsHost: settingsPages.host,
  showToast,
  onReady: async ({ backendId }) => {
    adoptBackendIdentity(backendId);
    void computerUse.refresh();
    await loadModels();
    await refresh();
    updateSendButton();
  }
});
window.bookmanDesktop?.onPrepareClose(prepareInterfaceClose);
installLanguageSettings({ prepareClose: prepareInterfaceClose, storage: draftStorage });
installDesktopUpdates({ host: settingsPages.host });
const modelSettings = installDesktopSettings({
  host: settingsPages.host,
  showToast,
  api,
  projectId: () => state.selectedProjectId ?? "",
  identity: () => {
    const current = management.state();
    return current.status === "connected"
      ? JSON.stringify([current.backendId, current.baseUrl, current.pid, current.startedAt])
      : null;
  },
  onSaved: () => {
    state.modelByTask.clear();
    state.model = null;
    void loadModels().then(() => refresh());
  }
});
$("#model-setup-button").addEventListener("click", () => void modelSettings.open());
installUserMemorySettings({ host: settingsPages.host, showToast, api });
