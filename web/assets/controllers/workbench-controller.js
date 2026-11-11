import { ui } from "../ui/language.js";
import { reducedMotion } from "../ui/motion.js";
import {
  sameWorkspace,
  taskWorkspace,
  workspaceLabel,
  applicationProjectLabel
} from "../workbench/workspace-scope.js";
import { createWorkbenchHost } from "../workbench/host.js";
import { createApplicationApi } from "../workbench/api.js";
import { createBindingControl } from "../workbench/binding.js";
import { createWorkbenchRegistry } from "../workbench/registry.js";
import { importArtifactFile } from "../workbench/file-import.js";
import { createTabRefresh } from "../workbench/tab-refresh.js";
import { applicationIconName } from "../workbench/application-icons.js";
import { createApplicationTaskPanel } from "../workbench/task-panel-layout.js";

/** Owns the tab strip, registry, catalog and bindings. Conversation actions are explicit ports. */
export function createWorkbenchController({
  state,
  $,
  showToast,
  createTask,
  beginNewConversation,
  loadDetail,
  openResourceInEditor,
  renderConversationList,
  renderEmpty,
  onViewChanged = () => {},
  onShowTaskPanel = () => {},
  refreshProjects = async () => {},
  updateSendButton,
  closeConnection,
  activateDraft = () => {},
  saveDraft = () => {},
  getNavigationContext = () => state.selected,
  /** The selected requirement's phase, for the title-bar panel control. */
  getRequirementStage = () => "",
  connectEventStream,
  backendRequest,
  fetchBytes
}) {
  const STANDALONE_TASK = "workspace";
  // Below this width the requirement panel is a drawer, so its control names it.
  const narrowWindow = window.matchMedia?.("(max-width: 1279px)") ?? { matches: false };
  let pendingConnections = 0;
  function conversationWorkspace() {
    const detail = state.detail?.task?.taskId === state.selected ? state.detail : undefined;
    const task = detail?.task ?? state.tasks.find((entry) => entry.taskId === state.selected);
    const project = !state.selected
      ? state.projects?.find((entry) => entry.projectId === state.selectedProjectId)
      : undefined;
    return (
      detail?.projectDirectory ||
      task?.projectDirectory ||
      detail?.workspaceRoot ||
      task?.workspaceRoot ||
      project?.projectDirectory ||
      state.workspacePath ||
      state.workspaceRoot ||
      taskWorkspace(task)
    );
  }
  function canLoadApplication(tab) {
    if (tab?.kind !== "application") return false;
    const detail = state.detail?.task?.taskId === state.selected ? state.detail : undefined;
    const task = detail?.task ?? state.tasks.find((entry) => entry.taskId === state.selected);
    const storageRoot =
      detail?.storageRoot || taskWorkspace(task) || (!state.selected ? state.workspaceRoot : undefined);
    // Documents live in their project; Task persistence can live elsewhere.
    // Keep legacy storage/default document homes and existing server-resolved
    // references available without admitting another project's unrelated view.
    return Boolean(
      tab.accessTaskId?.startsWith("temporary-") ||
      sameWorkspace(tab.workspaceRoot, conversationWorkspace()) ||
      (storageRoot && sameWorkspace(tab.workspaceRoot, storageRoot)) ||
      (detail?.applications?.workspaceRoot &&
        sameWorkspace(tab.workspaceRoot, detail.applications.workspaceRoot)) ||
      (state.selected &&
        [...(tab.conversations ?? []), ...(tab.loadedConversations ?? [])].some(
          (entry) => entry.taskId === state.selected
        ))
    );
  }
  async function connectApplication(action) {
    pendingConnections++;
    updateSendButton();
    try {
      return await action();
    } finally {
      pendingConnections--;
      updateSendButton();
    }
  }

  /**
   * Name a conversation created just to hold a document.
   *
   * A conversation is about the work, not the file, so it is not simply named
   * after it — the strip would otherwise show the same words twice and say
   * nothing about what the conversation is for.
   */
  function conversationNameFor(title) {
    const stem = String(title ?? "")
      .replace(/\.[^.]+$/, "")
      .trim();
    return stem ? ui`编辑《${stem}》` : ui("新的文档");
  }

  async function createApplicationConversation(tab, title, navigation) {
    await refreshProjects();
    if (!navigation.current()) return;
    const conversationRoot = tab.project?.projectDirectory ?? tab.workspaceRoot;
    if (tab.project) {
      if (beginNewConversation(tab.project.projectId, conversationRoot) === false) return;
    } else {
      state.selectedProjectId = null;
      if (beginNewConversation(null) === false) return;
    }
    if (conversationRoot) {
      state.workspacePath = conversationRoot;
      state.workspaceLabel = workspaceLabel(conversationRoot);
    }
    navigation.rebase();
    return createTaskForNavigation(
      conversationNameFor(title),
      navigation,
      conversationRoot,
      tab.project?.projectId
    );
  }

  /** Load an independent instance into the chosen conversation without moving it. */
  async function adoptIntoConversation({
    fromTaskId,
    resourceId,
    appInstanceId,
    title,
    taskId,
    focus = "conversation",
    navigation = captureNavigation()
  }) {
    try {
      const adopted = await applicationApi.bindResourceToTask({
        fromTaskId,
        fromAppInstanceId: appInstanceId,
        // Empty instances have no resource yet; their identity is sufficient.
        ...(resourceId ? { resourceId } : {}),
        taskId
      });
      if (!navigation.current()) {
        await refreshTabs();
        return;
      }
      // Register the destination before refreshing, without revealing an
      // intermediate conversation-only layout. The captured navigation keeps
      // polls from changing the current view; activateConversationTab commits
      // the conversation and its companion editor together once they are ready.
      if (focus !== "application") {
        await applicationApi.openTab({ kind: "conversation", taskId, activate: false });
        if (!navigation.current()) return;
      }
      await refreshTabs();
      if (!navigation.current()) return;
      if (focus === "application")
        await workbench?.activate(`window:${adopted.appInstance.appInstanceId}`, {
          navigation: navigation.navigation
        });
      else {
        await activateConversationTab(taskId, navigation);
        if (workbench?.navigationToken !== navigation.navigation || state.selected !== taskId) return;
        // This action intentionally chose the conversation. Subsequent reads
        // belong to it; a later user navigation still invalidates this scope.
        navigation.rebase();
      }
      if (state.selected === taskId) await loadDetail(taskId);
      if (!navigation.current()) return;
      const where = state.tasks.find((task) => task.taskId === taskId);
      showToast(ui`已关联${title ? `《${title}》` : ""}到「${where?.goal || taskId}」`);
      return taskId;
    } catch (error) {
      await refreshTabs();
      if (navigation.current() && appInstanceId)
        await workbench?.activate(`window:${appInstanceId}`, { navigation: navigation.navigation });
      showToast(
        error.code === "resource_not_found" || error.code === "instance_not_found"
          ? ui("文档已关闭或不可用，应用列表已刷新，请重新选择。")
          : ui`关联失败：${error.message}`
      );
    }
  }

  let collaborationPending = false;
  async function requestCollaboration({ taskId, resourceId, appInstanceId, title }) {
    if (collaborationPending) return;
    collaborationPending = true;
    const navigation = captureNavigation();
    const tabId = appInstanceId
      ? `window:${appInstanceId}`
      : tabState.tabs.find((tab) => tab.resourceId === resourceId)?.tabId;
    try {
      await refreshTabs();
      if (!navigation.current()) return;
      const tab = tabState.tabs.find((entry) => entry.tabId === tabId);
      if (!tab) throw new Error(ui("应用已关闭，请重新打开"));
      const fromTaskId = taskId ?? tab.taskId ?? tab.conversations?.[0]?.taskId ?? STANDALONE_TASK;
      const loadedConversations = tab.loadedConversations ?? [];
      const target = await connectApplication(async () => {
        if (!(await workbench.prepareTab(tabId))) {
          showToast(ui("请先保存草稿或处理文档冲突，再加载应用"));
          return;
        }
        if (!navigation.current()) return;
        // The instance's collaboration action returns to its own conversation.
        // Loading into the selected conversation is an explicit composer action.
        let targetTaskId =
          loadedConversations.find((entry) => entry.taskId === state.selected)?.taskId ??
          loadedConversations[0]?.taskId;
        if (!targetTaskId) {
          // An independent app may have established a project since the last
          // catalog read. Move the draft to its workspace before creating the
          // conversation so creation and its binding share the same identity.
          targetTaskId = await createApplicationConversation(tab, title, navigation);
        }
        if (!targetTaskId || !navigation.current()) return;
        return adoptIntoConversation({
          fromTaskId,
          resourceId,
          appInstanceId,
          title,
          taskId: targetTaskId,
          navigation
        });
      });
      if (target && navigation.current() && state.selected === target) $("#composer-input")?.focus();
      return target;
    } catch (error) {
      showToast(ui`关联失败：${error.message}`);
    } finally {
      collaborationPending = false;
    }
  }

  const applicationApi = createApplicationApi({
    ...(backendRequest ? { request: backendRequest } : {}),
    ...(fetchBytes ? { fetchBytes } : {}),
    isStandaloneTask: (taskId) => taskId === STANDALONE_TASK || taskId?.startsWith("temporary-"),
    // The editor's own "打开" menu reaches the rest of the Task's documents
    // through this. It was declared by `createApplicationApi` and never supplied,
    // so `api.openResourceInTab?.()` optional-chained into nothing and clicking a
    // document in that list silently did nothing at all.
    openResourceInTab: (taskId, resourceId) => openResourceInEditor(resourceId, taskId),
    bindToConversation: requestCollaboration,
    // Creating a document from the apps panel opens it as its own tab.
    createAndOpen: async (taskId, title, kind, workspaceRoot) => {
      const navigation = captureNavigation();
      const created = await applicationApi.createResource(
        taskId,
        { kind, title, initialContent: "" },
        workspaceRoot
      );
      if (created.resource?.resourceId) {
        await applicationApi.openTab({
          kind: "application",
          resourceId: created.resource.resourceId,
          activate: false
        });
      }
      await refreshTabs();
      if (navigation.current() && created.resource?.resourceId)
        await workbench?.activate(`resource:${created.resource.resourceId}`, {
          navigation: navigation.navigation
        });
    },
    // Creating inside a window that is already open keeps the person where they
    // are instead of stacking another tab beside it. Re-reading the strip is what
    // remounts that window holding the document: the empty state and the editing
    // state are different mounts, so the editor cannot switch on its own.
    onDocumentCreated: async ({ navigation = captureNavigation(), tabId } = {}) => {
      await refreshTabs();
      if (navigation.current() && tabId)
        await workbench?.activate(tabId, { navigation: navigation.navigation });
      else if (!navigation.current()) await workbench?.persistSelection();
      // Creating/opening the document has succeeded. An auxiliary catalog
      // outage must not turn it into a failed creation or leave an empty view.
      // eslint-disable-next-line no-restricted-syntax -- 项目列表只是辅助目录，失败已由 toast 告知，文档本身已创建成功
      void refreshProjects().catch(() => {
        showToast(ui("文档已打开；项目列表暂时无法刷新，请稍后重试。"));
      });
    },
    handoffToConversation: async ({ taskId, resourceId, appInstanceId, title, hasSelection }) => {
      if (!taskId || taskId === STANDALONE_TASK || taskId?.startsWith("temporary-"))
        return requestCollaboration({ taskId, resourceId, appInstanceId, title });
      const navigation = captureNavigation();
      const conversationId = taskId ?? state.selected;
      await applicationApi.openTab({
        kind: "application",
        resourceId,
        bindTo: conversationId,
        activate: false
      });
      if (!navigation.current()) return;
      await activateConversationTab(conversationId, navigation);
      if (workbench?.navigationToken !== navigation.navigation || state.selected !== conversationId) return;
      await loadDetail(conversationId);
      if (workbench?.navigationToken !== navigation.navigation || state.selected !== conversationId) return;
      const input = $("#composer-input");
      if (input.value.trim()) return;
      // A prefilled request the user can read and edit, never an automatic run.
      input.value = hasSelection
        ? ui`请保留我在《${title}》中的修改，把我当前选中的这一段写得更具体。`
        : ui`请保留我在《${title}》中的修改，然后继续完善这份内容。`;
      saveDraft();
      input.focus();
      showToast(ui("已切回对话，可以补充要求后发送"));
    }
  });
  applicationApi.captureNavigation = captureNavigation;
  const workbenchRegistry = createWorkbenchRegistry();
  /**
   * What the global tab strip currently holds.
   *
   * Polled from its own endpoint rather than derived from a task's detail: the
   * strip spans every open task, so no single task's payload can describe it.
   */
  let tabState = { tabs: [], activeTabId: undefined };
  let workbench;
  let sidebarFlipPending = false;
  const taskPanel = createApplicationTaskPanel({ body: document.body, onShow: onShowTaskPanel });
  function captureNavigation() {
    const host = ensureWorkbench();
    const scope = {
      context: getNavigationContext(),
      navigation: host?.beginNavigation(),
      current: () => getNavigationContext() === scope.context && host?.navigationToken === scope.navigation,
      rebase() {
        scope.context = getNavigationContext();
        scope.navigation = host?.beginNavigation();
      }
    };
    return scope;
  }
  async function createTaskForNavigation(goal, navigation, workspaceRoot, projectId) {
    const context = getNavigationContext();
    const taskId = await createTask(goal, workspaceRoot, undefined, projectId);
    if (getNavigationContext() === context && state.selected === taskId) navigation?.rebase();
    return taskId;
  }
  let binding;
  /** The catalog, kept for labels in the binding menu and the apps panel. */
  let applicationCatalog = [];
  /**
   * Resource kinds some registered application can edit.
   *
   * Fetched from the server rather than hard-coded, so the artifact panel's
   * "编辑" affordance follows the Adapter registry instead of a list here.
   */
  const editableKinds = new Set();

  async function loadEditableKinds() {
    if (editableKinds.size) return;
    try {
      const { applications } = await applicationApi.listApplications();
      applicationCatalog = applications || [];
      syncBindingFromTabs();
      for (const application of applicationCatalog) {
        if (!application.capabilities?.includes("edit")) continue;
        for (const kind of application.resourceKinds || []) editableKinds.add(kind);
        for (const format of application.fileImportFormats || []) editableKinds.add(format.mimeType);
      }
      // eslint-disable-next-line no-restricted-syntax -- 应用目录请求失败时面板只是不提供编辑入口，与目录为空的表现一致
    } catch {
      /* without the catalog the panel simply offers no edit affordance */
    }
  }

  /** The composer changes what the conversation loads; editor navigation is separate. */
  function ensureBinding() {
    const button = $("#app-bind-select");
    const menu = $("#app-bind-menu");
    if (!button || !menu) return undefined;
    binding ??= createBindingControl({
      button,
      menu,
      label: button.querySelector(".app-bind-name"),
      api: applicationApi,
      getTaskId: () => state.selected,
      getContext: getNavigationContext,
      onError: (message) => showToast(message),
      onRefresh: async () => {
        await refreshTabs({ poll: true });
        if (tabRefreshFailed) throw new Error(ui("请检查连接后重试"));
      },
      onPendingChange: (pending) => {
        pendingConnections += pending ? 1 : -1;
        updateSendButton();
      },
      onSelect: async (value, option, { taskId: selectedTaskId } = {}) => {
        const navigation = captureNavigation();
        const originalTaskId = selectedTaskId ?? state.selected;
        return connectApplication(async () => {
          if (!value) {
            if (!navigation.current() || state.selected !== originalTaskId) return;
            workbench?.preserveApplicationView();
            await loadDetail(originalTaskId);
            if (navigation.current()) await refreshTabs();
            return;
          }
          // Revalidate even if the document closed after the menu was opened.
          await refreshTabs();
          if (!navigation.current() || state.selected !== originalTaskId) return;
          if (tabRefreshFailed) throw new Error(ui("无法刷新打开的应用，请稍后重试"));
          let tab = tabState.tabs.find((entry) => (entry.appInstanceId ?? entry.resourceId) === value);
          if (!tab && option?.appInstanceId) {
            await applicationApi.openTab({
              kind: "application",
              appInstanceId: option.appInstanceId,
              activate: false
            });
            await refreshTabs();
            if (!navigation.current()) return;
            tab = tabState.tabs.find((entry) => entry.appInstanceId === option.appInstanceId);
          }
          if (!tab) throw new Error(ui("应用已关闭，请重新选择"));
          if (!canLoadApplication(tab)) throw new Error(ui("只能加载当前工作区的应用实例，请重新选择"));
          if (
            !tab.loadedConversations?.some((entry) => entry.taskId === originalTaskId) &&
            !(await workbench.prepareTab(tab.tabId))
          )
            throw new Error(ui("请先保存草稿或处理文档冲突，再加载应用"));
          if (!navigation.current()) return;
          const taskId =
            originalTaskId ??
            (await createTaskForNavigation(
              conversationNameFor(tab.title),
              navigation,
              conversationWorkspace()
            ));
          if (!taskId || !navigation.current()) return;
          if (originalTaskId) {
            // The composer changes context for this chat, without navigating or
            // collapsing its currently displayed editor.
            await applicationApi.bindResourceToTask({
              fromAppInstanceId: tab.appInstanceId,
              ...(tab.resourceId ? { resourceId: tab.resourceId } : {}),
              taskId
            });
            if (!navigation.current() || state.selected !== taskId) return;
            workbench?.preserveApplicationView();
            await loadDetail(taskId);
            if (navigation.current()) await refreshTabs();
            return;
          }
          await adoptIntoConversation({
            resourceId: tab.resourceId,
            appInstanceId: tab.appInstanceId,
            title: tab.title,
            taskId,
            navigation
          });
        });
      }
    });
    return binding;
  }

  function ensureWorkbench() {
    if (workbench) return workbench;
    const root = $("#workbench");
    if (!root) return undefined;
    root.querySelector("[data-app-expand]")?.addEventListener("click", () => {
      workbench?.setExpanded(!root.parentElement.classList.contains("is-app-expanded"));
    });
    root.querySelector("[data-app-collaborate]")?.addEventListener("click", () => {
      const tab = workbench?.applicationTab;
      if (tab)
        void requestCollaboration({
          resourceId: tab.resourceId,
          appInstanceId: tab.appInstanceId,
          title: tab.title
        });
    });
    document.querySelectorAll("[data-sidebar-view]").forEach((button) => {
      button.addEventListener("click", () => void flipSidebarView(button));
    });
    $("[data-composer-context]")?.addEventListener("click", async () => {
      const resourceId = state.detail?.applications?.boundResourceId;
      const tab = tabState.tabs.find(
        (entry) => resourceId && entry.kind === "application" && entry.resourceId === resourceId
      );
      if (tab) await workbench?.activate(tab.tabId);
    });
    workbench = createWorkbenchHost({
      root,
      conversationElement: $("#conversation-pane"),
      registry: workbenchRegistry,
      api: applicationApi,
      onError: (message) => showToast(message),
      onContextChange: () => paintComposerContext(),
      onTabChange: (event) => {
        root.hidden = false;
        if (event?.refresh) {
          void refreshTabs();
          return;
        }
        // Closing a tab updates the host immediately, before the next poll.
        if (workbench) tabState = { tabs: workbench.openTabs, activeTabId: workbench.activeTabId };
        syncBindingFromTabs();
      },
      // Selecting a conversation tab is what switches the conversation, so the
      // strip drives the pane rather than the left-hand list doing it alone.
      onConversationTask: (taskId, { draft = false } = {}) => {
        // Selecting the draft tab means "compose a new conversation": there is no
        // task to load, and clearing `selected` is what makes the composer start
        // a new one instead of appending to whichever conversation was last open.
        if (draft) {
          activateDraft(null);
          if (state.composingNew && state.selected === null) return;
          state.selected = null;
          state.detail = null;
          state.composingNew = true;
          state.localMessages = [];
          state.selectedAgent = null;
          state.previewPath = null;
          state.artifactDrawerOpen = false;
          state.openFiles = [];
          state.artifactCache.clear();
          state.viewerTaskId = null;
          closeConnection();
          renderConversationList();
          renderEmpty();
          updateSendButton();
          return;
        }
        if (state.selected === taskId) return;
        activateDraft(taskId);
        state.selected = taskId;
        state.composingNew = false;
        state.localMessages = [];
        state.selectedAgent = null;
        state.previewPath = null;
        state.artifactDrawerOpen = false;
        state.openFiles = [];
        state.artifactCache.clear();
        state.viewerTaskId = null;
        renderConversationList();
        connectEventStream(taskId);
        void loadDetail(taskId);
      }
    });
    return workbench;
  }

  /**
   * Re-read the global strip.
   *
   * The strip spans every task, so it cannot be a field on one task's detail —
   * it is polled on its own and is the source of truth for what is open.
   */
  /**
   * Re-read the global strip and hand it to the host.
   *
   * `follow` says this read is the result of something the person just did, so
   * the server's active tab wins over a draft conversation holding the front.
   * The 3.5s poll leaves it out, because a poll must never move the person.
   */
  let tabRefreshFailed = false;
  let followNavigation;
  const readTabs = createTabRefresh({
    read: () => applicationApi.listTabs(),
    async apply({ tabs = [], activeTabId }, { follow }) {
      const root = $("#workbench");
      if (!root) return;
      tabRefreshFailed = false;
      tabState = { tabs, activeTabId };
      const host = ensureWorkbench();
      if (!host) return;
      // A draft conversation exists only in this browser and must stay visible.
      root.hidden = tabs.length === 0 && !state.selected && !state.composingNew;
      void loadEditableKinds();
      // Publish the catalog before a viewer's mount can delay the refresh.
      syncBindingFromTabs();
      await host.update({
        ...tabState,
        actingTaskId: state.selected ?? undefined,
        loadedInstanceId:
          state.detail?.task?.taskId === state.selected
            ? state.detail.applications?.loadedInstanceId
            : undefined,
        boundResourceId:
          state.detail?.task?.taskId === state.selected
            ? state.detail.applications?.boundResourceId
            : undefined,
        follow: follow && Boolean(followNavigation?.current())
      });
      syncBindingFromTabs();
    },
    onError(error) {
      // A network failure must never unmount an editor holding the user's draft.
      // An unavailable feature is hidden only before anything has been mounted.
      if (workbench) {
        if (!tabRefreshFailed) showToast(ui`工作台暂时无法刷新，当前文档已保留：${error.message}`);
        tabRefreshFailed = true;
        return;
      }
      if (error.status !== 404) return;
      const root = $("#workbench");
      if (root) root.hidden = true;
    }
  });
  function refreshTabs({ follow = false, navigation, poll = false } = {}) {
    if (follow) followNavigation = navigation || captureNavigation();
    return readTabs({ follow, poll });
  }

  async function enterConversation(taskId) {
    await activateConversationTab(taskId);
  }

  /**
   * Show a task's conversation, opening its tab if it is not in the strip.
   *
   * There is no single conversation tab any more: each open task has its own, so
   * "back to the conversation" has to name which one.
   */
  async function activateConversationTab(
    taskId,
    navigation = captureNavigation(),
    { conversationOnly = false } = {}
  ) {
    if (!taskId) return;
    if (!navigation.current()) return;
    const id = `conversation:${taskId}`;
    if (!tabState.tabs.some((tab) => tab.tabId === id)) {
      // Reserve the conversation view before refreshing tabs. Otherwise the
      // still-active editor can reselect its owner and invalidate this choice.
      // Keep mounted editors (and their unsaved contents) intact.
      await workbench?.showConversation({ navigation: navigation.navigation, persist: false });
      if (!navigation.current()) return;
      // eslint-disable-next-line no-restricted-syntax -- 会话标签以服务端登记为准，重复或过期的 openTab 拒绝不影响随后 refreshTabs 的读取
      await applicationApi.openTab({ kind: "conversation", taskId }).catch(() => {});
      if (!navigation.current()) return;
      await refreshTabs();
      if (!navigation.current()) return;
    }
    await workbench?.activate(id, { navigation: navigation.navigation, conversationOnly });
  }

  function paintComposerContext() {
    const button = $("[data-composer-context]");
    if (!button) return;
    const id =
      state.detail?.task?.taskId === state.selected ? state.detail?.applications?.boundResourceId : undefined;
    const tab = tabState.tabs.find((entry) => id && entry.kind === "application" && entry.resourceId === id);
    button.hidden = !tab || state.composingNew;
    if (!tab) return;
    const context = workbench?.getContext(id);
    const text = [
      ui`正在编辑：${context?.title || tab.title}`,
      context?.selection ? ui`选中：${context.selection}` : "",
      context?.dirty ? ui("有未保存修改") : ""
    ]
      .filter(Boolean)
      .join(" · ");
    if (button.textContent !== text) button.textContent = text;
    button.title = ui`${text}。点击查看文件；发送前请先保存人工修改。`;
  }

  async function flipSidebarView(button) {
    if (sidebarFlipPending || !workbench?.workspaceApplicationTab) return;
    const tabId = workbench.workspaceApplicationTab.tabId;
    const selected = state.selected;
    const wasCollapsed = document.body.classList.contains("output-collapsed");
    const current = () =>
      workbench?.workspaceApplicationTab &&
      !document.body.classList.contains("sidebar-collapsed") &&
      workbench.workspaceApplicationTab.tabId === tabId &&
      state.selected === selected;
    let focusRequested = document.activeElement === button;
    const switchView = () => {
      focusRequested &&= [button, document.body].includes(document.activeElement);
      taskPanel.toggle({ focus: focusRequested });
      syncBindingFromTabs();
    };
    const focusNavigation = () => {
      if (
        focusRequested &&
        current() &&
        [button, document.body].includes(document.activeElement) &&
        document.body.classList.contains("output-collapsed")
      )
        $('[data-sidebar-view="tasks"]')?.focus();
    };
    if (reducedMotion() || !button.animate) {
      switchView();
      focusNavigation();
      return;
    }
    sidebarFlipPending = true;
    const buttons = [...document.querySelectorAll("[data-sidebar-view]")];
    buttons.forEach((entry) => (entry.disabled = true));
    let animation;
    try {
      animation = button.animate(
        [
          { transform: "perspective(480px) rotateX(0deg)", opacity: 1 },
          { transform: "perspective(480px) rotateX(-88deg)", opacity: 0.2 }
        ],
        { duration: 140, easing: "cubic-bezier(.55, 0, 1, .45)", fill: "forwards" }
      );
      // eslint-disable-next-line no-restricted-syntax -- 该退场动画随后会被 cancel，finished 因取消而拒绝是这条取消路径的预期结果
      await animation.finished.catch(() => {});
      animation.cancel();
      if (!current() || document.body.classList.contains("output-collapsed") !== wasCollapsed) return;
      switchView();
      const incoming = $(wasCollapsed ? '[data-sidebar-view="navigation"]' : '[data-sidebar-view="tasks"]');
      if (incoming) {
        animation = incoming.animate(
          [
            { transform: "perspective(480px) rotateX(88deg)", opacity: 0.2 },
            { transform: "perspective(480px) rotateX(-5deg)", opacity: 1, offset: 0.78 },
            { transform: "perspective(480px) rotateX(0deg)", opacity: 1 }
          ],
          { duration: 220, easing: "cubic-bezier(.16, 1, .3, 1)" }
        );
        // eslint-disable-next-line no-restricted-syntax -- 进场动画在 finally 里被 cancel 换取响应性，finished 的拒绝不代表翻页失败
        await animation.finished.catch(() => {});
      }
    } finally {
      animation?.cancel();
      buttons.forEach((entry) => (entry.disabled = false));
      sidebarFlipPending = false;
      focusNavigation();
    }
  }

  /**
   * One control, two jobs: it collapses the workspace when an application is
   * open, and the requirement panel otherwise. A narrow window shows the
   * panel's name and phase as text; a wide one keeps the icon alone and gives
   * the same words to assistive technology.
   */
  function paintPanelToggle() {
    const outputToggle = $("#output-pane-toggle");
    if (!outputToggle) return;
    const workspace = Boolean(workbench?.canToggleApplication);
    const visible = workspace && Boolean(workbench?.applicationVisible);
    const stage = workspace ? "" : getRequirementStage();
    const name = workspace ? (visible ? ui("收起工作区") : ui("展开工作区")) : ui("需求进度");
    const text = workspace || !stage ? name : `${name} · ${ui(stage)}`;
    const label = workspace ? name : narrowWindow.matches ? text : ui("切换任务面板");
    const value = outputToggle.querySelector("[data-panel-toggle-label]");
    if (value && value.textContent !== text) value.textContent = text;
    outputToggle.setAttribute("aria-label", label);
    outputToggle.title = label;
    outputToggle.setAttribute("aria-controls", workspace ? "workbench" : "agent-pane");
    outputToggle.setAttribute(
      "aria-expanded",
      String(workspace ? visible : !document.body.classList.contains("output-collapsed"))
    );
  }

  /** The binding control offers the application tabs of the current conversation. */
  function syncBindingFromTabs() {
    const application = workbench?.workspaceApplicationTab;
    const applicationAvailable = Boolean(application);
    const conversationVisible = !$("#conversation-pane")?.hidden;
    const collaborating = Boolean(
      conversationVisible &&
      state.selected &&
      application?.loadedConversations?.some((entry) => entry.taskId === state.selected)
    );
    taskPanel.sync({ applicationAvailable, conversationVisible: collaborating });
    if (applicationAvailable && !taskPanel.active) document.body.classList.add("output-collapsed");
    const collaborate = $("[data-app-collaborate]");
    if (collaborate) collaborate.hidden = conversationVisible;
    document.querySelectorAll("[data-sidebar-view]").forEach((button) => {
      button.hidden = !applicationAvailable;
    });
    const panelTitle = $("[data-panel-title]");
    if (panelTitle) panelTitle.hidden = applicationAvailable;
    onViewChanged();
    const header = $("[data-workbench-header]");
    if (header) {
      const tab = workbench?.applicationTab;
      const belongsHere =
        state.selected && tab?.loadedConversations?.some((entry) => entry.taskId === state.selected);
      const detail = belongsHere && state.detail?.task?.taskId === state.selected ? state.detail : undefined;
      const running = Boolean(detail?.runtime?.active);
      header.dataset.running = String(running);
      header.dataset.state = running ? "running" : detail?.task?.status === "failed" ? "failed" : "idle";
      const label = header.querySelector("[data-app-task-status]");
      const message = running ? ui("正在处理") : detail?.task?.status === "failed" ? ui("任务未完成") : "";
      const ownership = applicationProjectLabel(tab, state.projects);
      const status = [message, ownership.replace(/ · (?:自动保存|草稿自动保留)$/, "")]
        .filter(Boolean)
        .join(" · ");
      if (label && label.textContent !== status) label.textContent = status;
      if (label) label.title = status;
    }
    paintPanelToggle();
    if (!tabState.tabs.length && !workbench) return;
    const control = ensureBinding();
    if (!control) return;
    // Loading is workspace-scoped; opening a view in the sidebar is global navigation.
    const instances = tabState.tabs.filter(canLoadApplication).map((tab) => {
      const home = tab.taskId ?? tab.conversations?.[0]?.taskId ?? STANDALONE_TASK;
      const belongsHere =
        tab.taskId === state.selected || tab.conversations?.some((entry) => entry.taskId === state.selected);
      return {
        appInstanceId: tab.appInstanceId,
        resourceId: tab.resourceId,
        appType: tab.appType,
        taskId: home,
        conversations: tab.conversations,
        // A shared document is already here when this conversation references
        // it, even though the document tab has no single owning task.
        standalone: !belongsHere,
        elsewhere: false,
        taskGoal: tab.taskGoal ?? tab.conversations?.[0]?.goal,
        mcp: tab.mcp,
        title: tab.title,
        resourceIds: tab.resourceId ? [tab.resourceId] : [],
        status: "open"
      };
    });
    const loadedId =
      state.detail?.task?.taskId === state.selected ? state.detail.applications?.loadedInstanceId : undefined;
    const loaded = state.detail?.applications?.instances?.find((entry) => entry.appInstanceId === loadedId);
    if (loaded && !instances.some((entry) => entry.appInstanceId === loadedId))
      instances.push({ ...loaded, resourceId: loaded.resourceIds[0], taskId: state.selected });
    const bindButton = $("#app-bind-select");
    // Keep binding available for unattached windows: binding creates their
    // conversation when none is selected.
    if (bindButton) bindButton.hidden = !applicationCatalog.length || (!state.selected && !instances.length);
    paintComposerContext();
    control.update({
      instances,
      loadedInstanceId:
        state.detail?.task?.taskId === state.selected
          ? state.detail.applications?.loadedInstanceId
          : undefined,
      boundResourceId:
        state.detail?.task?.taskId === state.selected
          ? state.detail.applications?.boundResourceId
          : undefined,
      applications: applicationCatalog
    });
  }

  return {
    async toggleWorkspace() {
      if (!workbench?.canToggleApplication) return false;
      return workbench.toggleApplication();
    },
    get connecting() {
      return pendingConnections > 0;
    },
    api: applicationApi,
    async importArtifact(taskId, artifact) {
      await loadEditableKinds();
      return importArtifactFile({
        taskId,
        artifact,
        catalog: applicationCatalog,
        registry: workbenchRegistry,
        api: applicationApi
      });
    },
    captureNavigation,
    refreshTabs,
    paintPanelToggle,
    loadEditableKinds,
    toggleSidebarVisibility() {
      if (!taskPanel.toggleVisibility({ mobile: window.matchMedia("(max-width: 900px)").matches }))
        return false;
      syncBindingFromTabs();
      return true;
    },
    enterConversation,
    activateConversationTab,
    ensureWorkbench,
    ensureBinding,
    syncBindingFromTabs,
    get host() {
      return workbench;
    },
    get tabs() {
      return tabState;
    },
    get binding() {
      return binding;
    },
    iconForDocument(row) {
      const appType =
        row.appType ||
        applicationCatalog.find(
          (app) =>
            app.resourceKinds?.includes(row.mimeType) ||
            app.fileImportFormats?.some((format) => format.mimeType === row.mimeType)
        )?.appType;
      return applicationIconName(appType, workbenchRegistry[appType]?.definition?.icon);
    },
    get catalog() {
      return applicationCatalog;
    },
    get editableKinds() {
      return editableKinds;
    }
  };
}
