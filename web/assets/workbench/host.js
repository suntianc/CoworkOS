import { ui } from "../ui/language.js";
import { openSaveCopyDialog } from "./save-copy-dialog.js";
import { readLocalDocument } from "./adapters/local-file-opener.js";
import { sameWorkspace } from "./workspace-scope.js";
import { createWorkspaceLayout } from "./workspace-layout.js";
import { icon } from "../ui/icons.js";
import { createMenu } from "../ui/menu.js";
import { applicationIconName } from "./application-icons.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
  );

/** File destinations belong to the document's file menu, beside its exports. */
function addDocumentFileAction(element, saveCopy) {
  const anchor = document.createElement("div");
  anchor.className = "ui-menu-anchor workbench-document-menu";
  anchor.innerHTML = ui`<button class="app-button" type="button" data-application-file-menu aria-haspopup="menu" aria-expanded="false" aria-label="文件操作">文件${icon("chevron-down")}</button><div class="ui-menu" data-application-file-panel role="menu" aria-label="文件操作" hidden></div>`;
  const panel = anchor.querySelector("[data-application-file-panel]");
  const download = element.querySelector("[data-editor-download]");
  if (download) {
    download.classList.remove("is-icon");
    download.setAttribute("role", "menuitem");
    if (download.matches("[data-editor-download]")) {
      download.innerHTML = ui`${icon("download")}<span>下载到本机</span>`;
      download.setAttribute("aria-label", ui("下载到本机"));
    }
    panel.append(download);
  }
  panel.append(saveCopy);
  const toolbar = element.querySelector(".editor-menu-actions, header");
  (toolbar || element).prepend(anchor);
  return createMenu(anchor.querySelector("[data-application-file-menu]"), panel);
}

/**
 * Durable tabs span conversations and resource identities. On wide screens the
 * current conversation remains beside its document; companion visibility and
 * resizing are presentation state and never create extra file tabs.
 */

/**
 * The tab for a conversation being composed but not yet created.
 *
 * A conversation exists as a tab the moment the person asks for one, not only
 * once it has a task id: without this, clicking 新对话 left the previous
 * conversation's tab highlighted while the composer was writing a new one, so
 * the strip and the pane disagreed about where the person was. It lives only in
 * the browser because there is no task to record yet; sending the first message
 * replaces it with the real conversation's tab.
 */
export const DRAFT_TAB_ID = "conversation:__draft__";

export function draftConversationTab() {
  return { tabId: DRAFT_TAB_ID, kind: "conversation", taskId: null, title: ui("新对话"), draft: true };
}

/** Group tabs by task so one conversation's views stay together in the row. */
export function buildTabs({ tabs = [], activeTabId, drafts = new Map(), actingTaskId } = {}) {
  // Which group a tab sorts into. A conversation tab and an empty window have
  // a conversation of their own; a document tab belongs to every conversation
  // that references it, so the server nominates one and a document referenced
  // by nobody groups on its own.
  const groupOf = (tab) => tab.groupTaskId ?? tab.taskId ?? "";
  const order = [];
  const seen = new Set();
  for (const tab of tabs) {
    const group = groupOf(tab);
    if (!seen.has(group)) {
      seen.add(group);
      order.push(group);
    }
  }
  const grouped = order.flatMap((group) => {
    const own = tabs.filter((tab) => groupOf(tab) === group);
    // The conversation leads its own group: an application tab only makes sense
    // next to the conversation it belongs to.
    return [
      ...own.filter((tab) => tab.kind === "conversation"),
      ...own.filter((tab) => tab.kind !== "conversation")
    ];
  });
  // How many *conversations* are open, which is what a task label is for.
  // The shared workspace holding unattached windows is not one of them: counting
  // it meant that opening a single standalone editor labelled every other tab
  // with its own conversation's name, for no benefit. A draft conversation has
  // no documents under it, so it does not need counting either.
  const conversations = new Set(
    tabs.filter((tab) => tab.kind === "conversation" && !tab.draft).map((tab) => tab.taskId)
  );
  const model = grouped.map((tab) => ({
    ...tab,
    // A short task label only when the strip really spans several
    // conversations, and only on a tab that could otherwise be confused with
    // one from another conversation. A conversation tab's own title *is* the
    // task, so labelling it would print the name twice.
    //
    // A document shared by several conversations says how many instead of
    // naming one: picking one would be arbitrary, and the honest fact is that
    // more than one person is working on it.
    taskLabel:
      tab.kind === "conversation" || tab.standalone
        ? undefined
        : (tab.conversations?.length ?? 0) > 1
          ? ui`${tab.conversations.length} 个对话`
          : conversations.size > 1
            ? tab.taskGoal || tab.conversations?.[0]?.goal || tab.taskId
            : undefined,
    // A conversation that has not been sent yet: it holds a place in the strip
    // so the person can see where they are, and cannot be closed from the
    // server because it was never recorded there.
    draft: tab.draft === true,
    // An unattached window says so, rather than borrowing the internal
    // placeholder goal of the workspace that happens to hold it.
    standalone: tab.standalone === true,
    // A window with no document yet is the application itself; it is named
    // after the application and carries no document markers.
    empty: tab.kind === "application" && tab.hasResource === false,
    title: tab.title || (tab.kind === "conversation" ? ui("对话") : ui("未命名")),
    closable: true,
    dirty: drafts.get(tab.tabId) === true,
    // Shared document tabs display the active conversation's unread cursor.
    unread:
      tab.kind === "conversation" || tab.hasResource === false
        ? 0
        : ((actingTaskId && tab.unreadByTask?.[actingTaskId]) ?? tab.unread ?? 0)
  }));
  return {
    tabs: model,
    activeTabId: model.some((tab) => tab.tabId === activeTabId) ? activeTabId : model[0]?.tabId
  };
}

export function renderTabStrip({ tabs, activeTabId, icons = {}, compact = false }) {
  if (!tabs.length) return ui('<span class="workbench-tabs-empty">没有打开的标签</span>');
  return tabs
    .map((tab) => {
      const marks = [
        tab.dirty ? ui('<span class="tab-dirty" title="有未保存的修改">●</span>') : "",
        tab.unread > 0
          ? ui`<span class="tab-unread" title="${tab.unread} 项修改 CoworkOS 尚未读取">${esc(tab.unread)}</span>`
          : ""
      ].join("");
      // The close control is a sibling, not a nested button: a button inside a
      // button is invalid HTML and browsers hoist it out, which would put the
      // close affordance outside the tab it belongs to.
      const close = ui`<span class="tab-close" role="button" tabindex="${tab.tabId === activeTabId ? 0 : -1}" data-close-tab="${esc(tab.tabId)}" aria-label="关闭 ${esc(tab.title)}">${icon("close")}</span>`;
      // One chip at most, and only when it says something the title does not.
      // Its neighbouring conversation already names the group. Repeat that
      // name only when the conversation is closed; shared files retain their
      // conversation count, and unattached windows their unbound marker.
      const owner = tab.groupTaskId ?? tab.taskId ?? tab.conversations?.[0]?.taskId;
      const namedByConversation =
        (tab.conversations?.length ?? 0) <= 1 &&
        tabs.some((entry) => entry.kind === "conversation" && entry.taskId === owner);
      const chip = tab.standalone
        ? ui('<span class="tab-task is-loose" title="尚未关联到任何对话">未关联</span>')
        : tab.taskLabel && !namedByConversation && (!compact || (tab.conversations?.length ?? 0) > 1)
          ? `<span class="tab-task" title="${esc(tab.taskLabel)}">${esc(truncate(tab.taskLabel, 14))}</span>`
          : "";
      const tabIcon =
        tab.kind === "conversation"
          ? "i-chat"
          : applicationIconName(tab.appType, icons[tab.appType] ?? (tab.empty ? "i-apps" : "i-file"));
      const kindLabel = tab.kind === "conversation" ? ui("对话") : tab.empty ? ui("应用") : ui("文件");
      const hover = [
        `${kindLabel}：${tab.title}`,
        tab.standalone ? ui("未关联对话") : tab.taskLabel ? ui`关联对话：${tab.taskLabel}` : undefined
      ]
        .filter(Boolean)
        .join(" · ");
      const kindBadge =
        tab.kind === "conversation" ? ui('<span class="tab-kind-label" aria-hidden="true">对话</span>') : "";
      const classes = [
        "workbench-tab",
        tab.tabId === activeTabId ? "active" : "",
        tab.kind === "conversation" ? "is-conversation" : "",
        tab.draft ? "is-draft" : "",
        tab.empty ? "is-empty-window" : ""
      ]
        .filter(Boolean)
        .join(" ");
      return `<span class="${classes}" role="tab" tabindex="${tab.tabId === activeTabId ? 0 : -1}" aria-selected="${tab.tabId === activeTabId}" aria-label="${esc(hover)}" data-tab="${esc(tab.tabId)}" data-tab-kind="${tab.kind === "conversation" ? "conversation" : tab.empty ? "application" : "file"}" title="${esc(hover)}">${chip}<span class="tab-icon"><svg class="ui-icon" aria-hidden="true"><use href="#${esc(tabIcon)}"/></svg></span>${kindBadge}<span class="tab-title">${esc(tab.title)}</span>${marks}${close}</span>`;
    })
    .join("");
}

/**
 * Render the quiet application rail used in place of a full global tab row.
 * Conversations remain in the left history list; this rail only exposes open
 * application views in the workbench that owns the editor.
 */
export function renderTabRail({ tabs = [], activeTabId, icons = {} } = {}) {
  return tabs
    .filter((tab) => tab.kind === "application")
    .map((tab) => {
      const tabIcon = applicationIconName(
        tab.appType,
        icons[tab.appType] ?? (tab.empty ? "i-apps" : "i-file")
      );
      const kindLabel = tab.empty ? ui("应用") : ui("文件");
      const label = `${kindLabel}：${tab.title}`;
      const active = tab.tabId === activeTabId;
      const marks =
        tab.dirty || tab.unread > 0 ? '<span class="workbench-rail-dot" aria-hidden="true"></span>' : "";
      return ui`<div class="workbench-rail-entry${active ? " active" : ""}${tab.dirty ? " is-dirty" : ""}"><button class="workbench-rail-item${active ? " active" : ""}" type="button" data-tab="${esc(tab.tabId)}" aria-label="${esc(label)}" aria-pressed="${active}" title="${esc(label)}"><span class="workbench-rail-icon"><svg class="ui-icon" aria-hidden="true"><use href="#${esc(tabIcon)}"/></svg></span><span class="workbench-rail-label">${esc(truncate(tab.title, 24))}</span>${marks}</button><button class="workbench-rail-close" type="button" data-close-tab="${esc(tab.tabId)}" aria-label="关闭 ${esc(tab.title)}" title="关闭 ${esc(tab.title)}">${icon("close")}</button></div>`;
    })
    .join("");
}

const belongsToTask = (tab, taskId) =>
  Boolean(taskId && (tab.taskId === taskId || tab.conversations?.some((entry) => entry.taskId === taskId)));

/** Keep the durable global catalog out of a conversation's document navigation. */
function sessionApplications(tabs, actingTaskId, display) {
  if (!display) return [];
  const taskId = [actingTaskId, display.taskId, display.conversations?.[0]?.taskId].find((id) =>
    belongsToTask(display, id)
  );
  return tabs.filter(
    (tab) =>
      tab.kind === "application" &&
      (taskId
        ? belongsToTask(tab, taskId)
        : tab.tabId === display.tabId ||
          (!tab.conversations?.length &&
            !tab.taskId &&
            sameWorkspace(tab.workspaceRoot, display.workspaceRoot)))
  );
}

function truncate(value, length) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/**
 * Create the workbench host.
 *
 * The host owns the strip, mounting and event routing, and knows nothing about
 * any application's data model. An adapter gets a container and a set of
 * callbacks; it never reaches into global state, so a broken adapter can only
 * break its own tab.
 */
export function createWorkbenchHost({
  root,
  conversationElement,
  registry,
  api,
  onTabChange,
  onTabActivate,
  onError,
  onConversationTask,
  onContextChange
}) {
  const mounted = new Map();
  const closingTabs = new Set();
  const drafts = new Map();
  let state = { tabs: [], activeTabId: undefined, actingTaskId: undefined };
  let visibleTabId;
  let railTabId;
  let companionTabId;
  let boundResourceId;
  let loadedInstanceId;
  let collapsed = false;
  const collapsedViews = new Map();
  let navigationToken = 0;
  const beginNavigation = () => ++navigationToken;
  const contexts = new Map();
  const layout = createWorkspaceLayout({
    root,
    conversationElement,
    onResize: () => {
      const display = applicationTab();
      if (display) void mount(display).then(render);
      else render();
    }
  });

  const rail = root.querySelector("[data-tab-rail]") ?? root.parentElement?.querySelector("[data-tab-rail]");
  const appIcons = () =>
    Object.fromEntries(
      Object.entries(registry).map(([appType, adapter]) => [appType, adapter.definition?.icon ?? "i-text"])
    );

  /**
   * Last-resort protection for work that never reached the server.
   *
   * Closing or reloading the page runs no unmount, so a debounced edit would
   * simply vanish. `pagehide` is the reliable point to attempt the write, and
   * `beforeunload` is what lets the browser ask before the user loses it —
   * neither alone is enough: the first cannot block, the second cannot wait.
   */
  const flushAll = () => {
    for (const controller of mounted.values()) {
      try {
        if (typeof controller?.flush === "function") controller.flush();
      } catch {
        /* nothing better is available here */
      }
    }
  };
  const onPageHide = () => flushAll();
  const onBeforeUnload = (event) => {
    flushAll();
    if (![...drafts.values()].some(Boolean)) return undefined;
    event.preventDefault();
    event.returnValue = "";
    return "";
  };
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("beforeunload", onBeforeUnload);

  const activeTab = () => state.tabs.find((tab) => tab.tabId === state.activeTabId);
  const revealActiveTab = () => {
    if (state.activeTabId)
      root
        .querySelector(`[data-tab="${CSS.escape(state.activeTabId)}"]`)
        ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };
  window.addEventListener("resize", revealActiveTab);
  /**
   * Which conversation a shared document tab acts as.
   *
   * Prefers the one the person is looking at, so an edit is attributed to the
   * conversation they are in; any referencer satisfies the access check.
   */
  const actingTaskFor = (tab) => {
    if (tab.accessTaskId) return tab.accessTaskId;
    const owners = tab.conversations ?? [];
    const selected = state.actingTaskId && owners.find((entry) => entry.taskId === state.actingTaskId);
    return (selected ?? owners[0])?.taskId;
  };

  const conversationContextFor = (tab) => {
    const owners = tab.conversations ?? [];
    const owner = owners.find((entry) => entry.taskId === state.actingTaskId) ?? owners[0];
    const storageRoot =
      owner?.storageRoot ??
      state.tabs.find((entry) => entry.kind === "conversation" && entry.taskId === owner?.taskId)
        ?.storageRoot;
    return {
      workspaceRoot: tab.workspaceRoot,
      conversationTaskId: owner?.taskId,
      taskWorkspaceDirectory:
        owner && storageRoot ? `${storageRoot.replace(/\/+$/, "")}/${owner.taskId}` : undefined
    };
  };

  function container(tabId) {
    let element = root.querySelector(`[data-app-mount="${CSS.escape(tabId)}"]`);
    if (!element) {
      element = document.createElement("div");
      element.className = "workbench-app";
      element.dataset.appMount = tabId;
      element.hidden = true;
      root.appendChild(element);
    }
    return element;
  }

  async function mount(tab) {
    const existing = mounted.get(tab.tabId);
    // The in-flight promise is stored, not just the finished controller: the
    // adapter's mount awaits a network read, and a second caller arriving in
    // that window would otherwise mount the same tab twice — leaving the first
    // controller unreachable with its autosave and selection timers still live.
    if (existing) return existing;
    const adapter = registry[tab.appType];
    if (!adapter) {
      const element = container(tab.tabId);
      element.innerHTML = ui`<div class="workbench-unsupported"><strong>暂不支持的应用：${esc(tab.appType)}</strong><p>这个标签页需要当前版本没有的应用适配器。资源本身没有丢失，升级后可以继续编辑。</p></div>`;
      return null;
    }
    let settle;
    mounted.set(
      tab.tabId,
      new Promise((resolve) => {
        settle = resolve;
      })
    );
    try {
      let creationNavigation;
      let createdTabId;
      const openLocalFile = async (file) => {
        if (!adapter.readFile) throw new Error(ui("此应用不支持打开本地文件"));
        const navigation = api.captureNavigation?.();
        const document = await readLocalDocument(file, adapter.readFile);
        if (navigation && !navigation.current()) return;
        const opened = await api.openApplication(tab.taskId ?? actingTaskFor(tab), tab.appType);
        const instance = opened.appInstance ?? opened;
        const created = await api.createInApplication(
          tab.taskId ?? actingTaskFor(tab),
          instance.appInstanceId,
          document
        );
        await api.openTab({
          kind: "application",
          resourceId: created.resource.resourceId,
          activate: false
        });
        await api.onDocumentCreated?.({ navigation, tabId: `resource:${created.resource.resourceId}` });
      };
      const adapterApi = api.createInApplication
        ? {
            ...api,
            openLocalFile,
            listResources: (taskId) => api.listResources(taskId, tab.workspaceRoot),
            createAndOpen: (taskId, title, kind) =>
              api.createAndOpen?.(taskId, title, kind, tab.workspaceRoot),
            createInApplication: async (...args) => {
              creationNavigation = api.captureNavigation?.();
              const created = await api.createInApplication(...args);
              createdTabId = tab.tabId;
              return created;
            },
            onDocumentCreated: () =>
              api.onDocumentCreated?.({ navigation: creationNavigation, tabId: createdTabId })
          }
        : api;
      const controller = await adapter.mount(container(tab.tabId), {
        // The tab carries its own task: an adapter must never read "the current
        // task", because several are open at once.
        instance: {
          appInstanceId: tab.appInstanceId,
          title: tab.title,
          resourceIds: tab.resourceId ? [tab.resourceId] : []
        },
        // Which conversation this editor acts as. A document tab belongs to no
        // one conversation, so it acts as whichever of its referencers the
        // person is in, falling back to the first — the resource routes need
        // *a* task to check the reference against, and any referencer proves it.
        taskId: tab.taskId ?? actingTaskFor(tab),
        // Native viewers scan task storage, which may differ from the resource's
        // project or temporary document workspace.
        ...conversationContextFor(tab),
        api: adapterApi,
        onDirtyChange: (dirty) => {
          if (drafts.get(tab.tabId) === dirty) return;
          drafts.set(tab.tabId, dirty);
          render();
        },
        onContextChange: (context) => {
          contexts.set(tab.tabId, context);
          onContextChange?.({ tab, ...context });
        },
        onChanged: () => onTabChange?.({ refresh: true })
      });
      if (tab.resourceId) {
        const element = container(tab.tabId);
        const dropStatus = document.createElement("p");
        dropStatus.setAttribute("role", "alert");
        dropStatus.hidden = true;
        element.append(dropStatus);
        let importing = false;
        const drop = async (event) => {
          if (!event.dataTransfer?.files?.length) return;
          event.preventDefault();
          event.stopPropagation();
          if (importing) return;
          const files = [...event.dataTransfer.files];
          const navigation = api.captureNavigation?.();
          importing = true;
          try {
            if (files.length !== 1 || !adapter.readFile)
              throw new Error(ui("请一次拖入一个此应用支持的文件"));
            if (navigation && !navigation.current()) return;
            await openLocalFile(files[0]);
          } catch (error) {
            dropStatus.hidden = false;
            dropStatus.textContent = ui`导入失败，当前文档和原文件已保留：${error.message}`;
          } finally {
            importing = false;
          }
        };
        const dragover = (event) => {
          if ([...(event.dataTransfer?.types ?? [])].includes("Files")) {
            event.preventDefault();
            event.stopPropagation();
          }
        };
        element.addEventListener("drop", drop);
        element.addEventListener("dragover", dragover);
        const saveButton = document.createElement("button");
        saveButton.className = "app-button";
        saveButton.type = "button";
        saveButton.setAttribute("role", "menuitem");
        saveButton.dataset.applicationSaveCopy = "";
        saveButton.innerHTML = ui`${icon("folder")}<span>保存副本…</span>`;
        saveButton.onclick = () => {
          if (saveButton.getAttribute("aria-busy") === "true") return;
          saveButton.setAttribute("aria-busy", "true");
          const navigation = api.captureNavigation?.();
          void openSaveCopyDialog({
            api: adapterApi,
            taskId: tab.taskId ?? actingTaskFor(tab),
            resourceId: tab.resourceId,
            appType: tab.appType,
            flush: () => (controller?.canClose ? controller.canClose() : controller?.flush?.()),
            isCurrent: () => element.isConnected && !element.hidden && (!navigation || navigation.current()),
            onSaved: () => onTabChange?.({ refresh: true })
          })
            .catch((error) => {
              if (!element.isConnected || element.hidden || (navigation && !navigation.current())) return;
              saveButton.title = error.message;
              onError?.(ui`无法保存副本：${error.message}`);
            })
            .finally(() => saveButton.removeAttribute("aria-busy"));
        };
        const fileMenu = addDocumentFileAction(element, saveButton);
        const unmount = controller?.unmount?.bind(controller);
        if (controller)
          controller.unmount = async (...args) => {
            element.removeEventListener("drop", drop);
            element.removeEventListener("dragover", dragover);
            fileMenu?.dispose();
            await unmount?.(...args);
          };
      }
      mounted.set(tab.tabId, controller);
      settle(controller);
      return controller;
    } catch (error) {
      mounted.delete(tab.tabId);
      settle(null);
      onError?.(ui`应用加载失败：${error.message}`);
      return null;
    }
  }

  async function unmount(tabId) {
    const controller = await mounted.get(tabId);
    mounted.delete(tabId);
    drafts.delete(tabId);
    contexts.delete(tabId);
    try {
      controller?.setVisible?.(false);
      await controller?.unmount?.();
    } catch {
      /* the container is removed regardless */
    }
    root.querySelector(`[data-app-mount="${CSS.escape(tabId)}"]`)?.remove();
  }

  function render() {
    const focusedRailControl = rail?.contains(document.activeElement) ? document.activeElement : undefined;
    const focusedRailTab = focusedRailControl?.dataset.tab ?? focusedRailControl?.dataset.closeTab;
    const focusedRailKind = focusedRailControl?.hasAttribute("data-close-tab")
      ? "data-close-tab"
      : "data-tab";
    const focusedRailIndex = focusedRailControl
      ? [...rail.querySelectorAll(`[${focusedRailKind}]`)].indexOf(focusedRailControl)
      : -1;
    const model = buildTabs({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      drafts,
      actingTaskId: state.actingTaskId
    });
    // `undefined` is a deliberate state — the conversation is in front and no
    // tab is active — so it must survive the fallback `buildTabs` applies to a
    // stale id.
    if (state.activeTabId !== undefined) state.activeTabId = model.activeTabId;
    const active = activeTab();
    const display = applicationTab();
    const split = Boolean(display && layout.wide && !layout.expanded);
    const showingConversation = !display || ((split || active?.kind === "conversation") && !layout.expanded);
    const applicationTabs = sessionApplications(model.tabs, state.actingTaskId, display);
    const strip = root.querySelector("[data-tab-strip]");
    if (strip) {
      // Keep the strip's state and event wiring for compatibility, while the
      // shell presents application navigation through the quieter rail below.
      strip.hidden = true;
      const markup = renderTabStrip({
        ...model,
        tabs: display && layout.wide ? model.tabs.filter((tab) => tab.kind !== "conversation") : model.tabs,
        compact: Boolean(display && layout.wide),
        activeTabId: display?.tabId ?? model.activeTabId,
        icons: appIcons()
      });
      if (strip.innerHTML !== markup) {
        const focusedTab = document.activeElement?.closest("[data-tab]")?.dataset.tab;
        const focusedClose = document.activeElement?.hasAttribute("data-close-tab");
        strip.innerHTML = markup;
        strip.querySelectorAll("[data-tab]").forEach((node) => {
          const open = (event) => {
            if (event.target.closest("[data-close-tab]")) return;
            void activate(node.dataset.tab);
          };
          node.addEventListener("click", open);
          node.addEventListener("keydown", async (event) => {
            if (event.target.closest("[data-close-tab]")) return;
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const tabs = [...strip.querySelectorAll("[data-tab]")];
              const index = tabs.indexOf(node);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
              const id = tabs[next]?.dataset.tab;
              if (id) {
                await activate(id);
                strip.querySelector(`[data-tab="${CSS.escape(id)}"]`)?.focus();
              }
              return;
            }
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              open(event);
            }
          });
        });
        strip.querySelectorAll("[data-close-tab]").forEach((node) => {
          const shut = (event) => {
            event.stopPropagation();
            void close(node.dataset.closeTab);
          };
          node.addEventListener("click", shut);
          node.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              shut(event);
            }
          });
        });
        if (focusedTab) {
          const selector = focusedClose ? "data-close-tab" : "data-tab";
          strip.querySelector(`[${selector}="${CSS.escape(focusedTab)}"]`)?.focus();
        }
      }
      if (state.activeTabId && visibleTabId !== state.activeTabId) {
        revealActiveTab();
      }
      visibleTabId = state.activeTabId;
    }
    if (rail) {
      const railMarkup = renderTabRail({
        tabs: applicationTabs,
        activeTabId: display?.tabId ?? model.activeTabId,
        icons: appIcons()
      });
      rail.hidden = !railMarkup || (!split && showingConversation);
      if (rail.innerHTML !== railMarkup) {
        rail.innerHTML = railMarkup;
        rail.querySelectorAll("[data-tab]").forEach((node) => {
          const open = () => void activate(node.dataset.tab);
          node.addEventListener("click", open);
          node.addEventListener("keydown", (event) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const tabs = [...rail.querySelectorAll("[data-tab]")];
              const index = tabs.indexOf(node);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
              tabs[next]?.focus();
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              open();
            }
          });
        });
        rail.querySelectorAll("[data-close-tab]").forEach((node) => {
          node.addEventListener("click", () => {
            void close(node.dataset.closeTab).catch((error) => onError?.(ui`关闭文件失败：${error.message}`));
          });
        });
      }
      if (!rail.hidden && display?.tabId !== railTabId) {
        rail
          .querySelector(`[data-tab="${CSS.escape(display.tabId)}"]`)
          ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      }
      railTabId = display?.tabId;
    }
    const header = root.querySelector("[data-workbench-header]");
    if (header) header.hidden = !display || (!split && showingConversation);
    if (conversationElement) conversationElement.hidden = !showingConversation;
    root.classList.toggle("has-app-open", Boolean(display));
    document.body.classList.toggle("app-fullbleed", Boolean(display));
    layout.paint({ split, hasApp: Boolean(display), showingConversation });
    for (const element of root.querySelectorAll("[data-app-mount]")) {
      element.hidden = element.dataset.appMount !== display?.tabId || (!split && showingConversation);
    }
    // Visibility is a host lifecycle event, not a side effect of ResizeObserver.
    // Release hidden native views before the displayed tab claims its singleton.
    const elements = [...root.querySelectorAll("[data-app-mount]")];
    for (const element of elements.filter((entry) => entry.hidden))
      mounted.get(element.dataset.appMount)?.setVisible?.(false);
    for (const element of elements.filter((entry) => !entry.hidden)) {
      const tab = state.tabs.find((entry) => entry.tabId === element.dataset.appMount);
      if (tab) mounted.get(tab.tabId)?.setVisible?.(true, conversationContextFor(tab));
    }
    onTabChange?.({ model, active });
    if (focusedRailTab) {
      const controls = [...rail.querySelectorAll(`[${focusedRailKind}]`)];
      const target =
        controls.find((node) => node.getAttribute(focusedRailKind) === focusedRailTab) ??
        controls[Math.min(focusedRailIndex, controls.length - 1)];
      if (!header?.hidden && !rail.hidden && target) target.focus();
      else
        (document.querySelector("#output-pane-toggle") ?? document.querySelector("#composer-input"))?.focus();
    }
  }

  function applicationTab() {
    const active = activeTab();
    if (active?.kind === "application") return active;
    if (!layout.wide || collapsed || active?.draft || !state.actingTaskId) return undefined;
    const belongs = (tab) => tab.kind === "application" && belongsToTask(tab, state.actingTaskId);
    return (
      state.tabs.find((tab) => belongs(tab) && loadedInstanceId && tab.appInstanceId === loadedInstanceId) ??
      state.tabs.find((tab) => belongs(tab) && boundResourceId && tab.resourceId === boundResourceId) ??
      state.tabs.find((tab) => belongs(tab) && tab.tabId === companionTabId)
    );
  }

  const viewKey = () => (activeTab()?.draft ? DRAFT_TAB_ID : (state.actingTaskId ?? "__standalone__"));
  function restorableApplication() {
    if (activeTab()?.draft) return undefined;
    const remembered = collapsedViews.get(viewKey());
    return (
      state.tabs.find(
        (tab) =>
          tab.kind === "application" &&
          tab.tabId === remembered?.tabId &&
          (!state.actingTaskId || belongsToTask(tab, state.actingTaskId))
      ) ??
      state.tabs.find(
        (tab) =>
          tab.kind === "application" &&
          belongsToTask(tab, state.actingTaskId) &&
          ((loadedInstanceId && tab.appInstanceId === loadedInstanceId) ||
            (boundResourceId && tab.resourceId === boundResourceId))
      )
    );
  }

  async function persistSelection() {
    for (;;) {
      const navigation = navigationToken;
      const selected = state.activeTabId;
      const persisted = activeTab()?.draft ? null : (selected ?? null);
      try {
        await api.activateTab?.(persisted);
      } catch {
        // Offline persistence must never change or stall the visible choice.
        return;
      }
      if (navigation === navigationToken && selected === state.activeTabId) return;
      // The previous write may have landed after a newer selection's write.
      // Reassert the latest choice so a reload restores what is visible now.
    }
  }

  async function activate(tabId, { navigation = beginNavigation(), conversationOnly = false } = {}) {
    if (navigation !== navigationToken) return;
    const tab =
      state.tabs.find((entry) => entry.tabId === tabId) ??
      (tabId?.startsWith("resource:")
        ? state.tabs.find((entry) => entry.resourceId === tabId.slice(9))
        : undefined);
    if (!tab) return;
    tabId = tab.tabId;
    const current = () => navigation === navigationToken && state.activeTabId === tabId;
    state.activeTabId = tabId;
    if (tab.kind === "application") {
      collapsed = false;
      companionTabId = tabId;
    } else {
      layout.expanded = false;
      collapsed = conversationOnly;
      if (conversationOnly) {
        companionTabId = undefined;
        boundResourceId = undefined;
      }
      state.actingTaskId = tab.taskId ?? undefined;
    }
    // The server owns which tab is active, so a reload comes back where the
    // user was rather than at whichever tab happens to be first. A draft
    // conversation is recorded as no server tab in front.
    // Binding depends on this durable choice; do not race its focus-preserving write.
    await persistSelection();
    if (!current()) return;
    if (tab.kind === "conversation") {
      // Selecting a conversation tab is what switches the conversation pane;
      // the left-hand list no longer decides it on its own.
      onConversationTask?.(tab.taskId, { draft: tab.draft === true });
    } else {
      await mount(tab);
      if (!current()) return;
      // Only an explicit tab choice changes the conversation's binding.
      // Rendering or polling an editor must not issue another binding write.
      try {
        await onTabActivate?.(tab);
      } catch (error) {
        if (current()) onError?.(ui`应用关联失败：${error.message}`);
      }
    }
    if (!current()) return;
    const display = applicationTab();
    if (display) await mount(display);
    if (!current()) return;
    render();
    if (tab.kind !== "conversation") (await mounted.get(tabId))?.focus?.();
  }

  async function close(tabId) {
    const tab = state.tabs.find((entry) => entry.tabId === tabId);
    if (!tab || closingTabs.has(tabId)) return;
    if (tab.kind !== "conversation") {
      const controller = await mounted.get(tabId);
      if (controller?.canClose && !(await controller.canClose())) return;
    }
    closingTabs.add(tabId);
    const siblingApplications = sessionApplications(state.tabs, state.actingTaskId, tab).filter(
      (entry) => entry.tabId !== tabId
    );
    if (tab.kind !== "conversation") await unmount(tabId);
    state.tabs = state.tabs.filter((entry) => entry.tabId !== tabId);
    if (state.activeTabId === tabId) {
      beginNavigation();
      state.activeTabId =
        (tab.kind === "application"
          ? (siblingApplications.find(
              (entry) =>
                entry.appType === tab.appType && sameWorkspace(entry.workspaceRoot, tab.workspaceRoot)
            )?.tabId ??
            siblingApplications[0]?.tabId ??
            state.tabs.find((entry) => entry.kind === "conversation" && entry.taskId === state.actingTaskId)
              ?.tabId)
          : undefined) ?? state.tabs[0]?.tabId;
    }
    render();
    // Closing a tab closes a view, never the task or the resource behind it.
    // A draft was never recorded on the server, so there is nothing to close.
    if (!tab.draft) {
      try {
        await api.closeTab?.(tabId);
        await persistSelection();
      } catch (error) {
        onError?.(ui`关闭应用失败：${error.message}`);
      }
    }
    closingTabs.delete(tabId);
    if (!tab.draft) onTabChange?.({ refresh: true });
    const next = activeTab();
    if (next?.kind === "conversation") onConversationTask?.(next.taskId, { draft: next.draft === true });
    else if (next) await mount(next);
    render();
  }

  return {
    get navigationToken() {
      return navigationToken;
    },
    beginNavigation,
    persistSelection,
    get activeTabId() {
      return state.activeTabId;
    },
    get activeTab() {
      return activeTab();
    },
    get applicationTab() {
      return applicationTab();
    },
    /** The editor destination is retained while its pane is collapsed. */
    get workspaceApplicationTab() {
      return applicationTab() ?? restorableApplication();
    },
    get canToggleApplication() {
      return Boolean(this.workspaceApplicationTab);
    },
    get applicationVisible() {
      return Boolean(applicationTab() && !root.classList.contains("is-conversation-only"));
    },
    async toggleApplication() {
      if (this.applicationVisible) {
        await this.collapseApplication();
        return true;
      }
      const tab = restorableApplication();
      if (!tab) return false;
      const remembered = collapsedViews.get(viewKey());
      const navigation = beginNavigation();
      await activate(tab.tabId, { navigation });
      if (navigation === navigationToken && state.activeTabId === tab.tabId) {
        layout.expanded = remembered?.expanded ?? false;
        render();
      }
      return true;
    },
    getContext(resourceId) {
      return contexts.get(state.tabs.find((tab) => tab.resourceId === resourceId)?.tabId);
    },
    setExpanded(value) {
      layout.expanded = value;
      render();
    },
    preserveApplicationView() {
      const display = applicationTab();
      if (display) companionTabId = display.tabId;
    },
    async collapseApplication() {
      const navigation = beginNavigation();
      const display = applicationTab();
      if (display) collapsedViews.set(viewKey(), { tabId: display.tabId, expanded: layout.expanded });
      collapsed = true;
      layout.expanded = false;
      const conversation = state.tabs.find(
        (tab) => tab.kind === "conversation" && tab.taskId === state.actingTaskId
      );
      state.activeTabId = conversation?.tabId;
      await persistSelection();
      if (navigation !== navigationToken) return;
      render();
    },
    get openTabs() {
      return state.tabs;
    },

    /** Replace the host's view of the strip, mounting and retiring tabs. */
    async update({
      tabs = [],
      activeTabId,
      actingTaskId,
      boundResourceId: nextBinding,
      loadedInstanceId: nextInstance,
      follow = false
    }) {
      const navigation = navigationToken;
      // A poll can finish before an in-flight close reaches durable storage.
      tabs = tabs.filter((tab) => !closingTabs.has(tab.tabId));
      if (actingTaskId !== undefined) state.actingTaskId = actingTaskId;
      boundResourceId = nextBinding;
      loadedInstanceId = nextInstance;
      // A draft conversation exists only here, so a poll from the server must
      // not erase it: the person is typing into it. It is dropped as soon as
      // their first message turns it into a real conversation, which is when
      // `dropDraft` is called with its new task.
      let draft = state.tabs.find((tab) => tab.draft);
      let merged = draft ? [...tabs, draft] : tabs;
      const known = new Map(merged.map((tab) => [tab.tabId, tab]));
      for (const tabId of [...mounted.keys()]) {
        const next = known.get(tabId);
        if (!next) {
          await unmount(tabId);
          continue;
        }
        // The tab is the same, but what it holds changed: an empty application
        // window that now has a document must be remounted, because the empty
        // state and the editing state are different mounts. Without this a
        // document created in the window never appeared in it.
        const before = state.tabs.find((tab) => tab.tabId === tabId);
        if (before && before.resourceId !== next.resourceId) {
          await unmount(tabId);
          continue;
        }
        // The acting conversation changed under a mounted editor: a document
        // referenced by another conversation, or one just related to this one,
        // has to send its writes as a conversation that references it. The
        // mount captured the old one, so remount rather than let every save
        // fail the access check.
        if (before && actingTaskFor(before) !== actingTaskFor(next)) await unmount(tabId);
      }
      if (navigation !== navigationToken) {
        // A draft may have been opened while retiring an old adapter.
        draft = state.tabs.find((tab) => tab.draft);
        merged = draft ? [...tabs, draft] : tabs;
        follow = false;
      }
      state.tabs = merged.filter((tab) => !closingTabs.has(tab.tabId));
      // A server that reports no active tab means the user stepped away from
      // every application; honouring that is what keeps the conversation in
      // front instead of snapping back to an editor every few seconds. A draft
      // the person is composing keeps the focus it already has: the server has
      // never heard of it and cannot be reporting it.
      //
      // Except when the person just opened something. A draft holds the front
      // against the 3.5s poll, which is the point — but it also held it against
      // a deliberate act, so opening the editor from a draft conversation and
      // creating a document showed nothing at all: the document was made, the
      // tab was in the strip, and the draft stayed in front of both. `follow`
      // is how a caller says "this update is a choice, not a poll".
      if (
        !follow &&
        ((state.activeTabId === DRAFT_TAB_ID && draft) ||
          (navigationToken > 0 && (state.activeTabId === undefined || known.has(state.activeTabId))))
      ) {
        // Initial load follows persisted selection. After a local choice,
        // polls refresh documents but cannot replay an older server activation.
      } else if (activeTabId === undefined || activeTabId === null) state.activeTabId = undefined;
      else if (known.has(activeTabId)) state.activeTabId = activeTabId;
      else if (!known.has(state.activeTabId)) state.activeTabId = merged[0]?.tabId;
      const active = activeTab();
      if (navigationToken === 0 && active?.kind === "application" && active.standalone)
        layout.expanded = true;
      if (active && active.kind !== "conversation") {
        companionTabId = active.tabId;
      }
      const display = applicationTab();
      if (display) await mount(display);
      render();
    },

    /**
     * Open a tab for a conversation the person is composing.
     *
     * It is the strip's answer to 新对话: a conversation is a tab from the
     * moment it is asked for, so the row cannot go on highlighting the previous
     * one while the composer writes a different one.
     */
    openDraftConversation() {
      beginNavigation();
      if (!state.tabs.some((tab) => tab.draft)) state.tabs = [...state.tabs, draftConversationTab()];
      state.activeTabId = DRAFT_TAB_ID;
      layout.expanded = false;
      // The draft exists only here, so the server cannot be told to activate
      // it — but it does have to hear that the editor is no longer in front,
      // or the next poll reports that tab as active and puts it straight back
      // over the composer the person just asked for.
      void persistSelection();
      render();
    },

    /** Remove the draft, once its first message has made it a real conversation. */
    dropDraft() {
      if (!state.tabs.some((tab) => tab.draft)) return;
      state.tabs = state.tabs.filter((tab) => !tab.draft);
      if (state.activeTabId === DRAFT_TAB_ID) {
        beginNavigation();
        state.activeTabId = undefined;
      }
      render();
    },

    /**
     * Route a server event to the tabs that own the resource.
     *
     * Resource identity routes shared edits across conversations. Resolve only
     * after the adapter has observed the change; false lets revision checks retry.
     */
    async handleEvent(event) {
      if (!event || typeof event.type !== "string" || !event.type.startsWith("resource.")) return false;
      const deliveries = [];
      for (const [tabId, entry] of mounted) {
        const tab = state.tabs.find((candidate) => candidate.tabId === tabId);
        // Document tabs are shared across conversations; route by resource id.
        if (!tab || !tab.resourceId || tab.resourceId !== event.resourceId) continue;
        deliveries.push(
          Promise.resolve(entry).then(async (controller) => {
            try {
              if (!controller) return false;
              return (await controller?.handleResourceEvent?.(event)) !== false;
            } catch (error) {
              onError?.(ui`应用事件处理失败：${error.message}`);
              return false;
            }
          })
        );
      }
      return deliveries.length > 0 && (await Promise.all(deliveries)).every(Boolean);
    },

    /**
     * Step away from every application without closing anything.
     *
     * Needed when the user asks to work in a conversation that has no tab yet —
     * a brand-new one. The editors stay mounted and keep their drafts; only
     * what is in front changes.
     */
    async showConversation({ navigation = beginNavigation(), persist = true } = {}) {
      if (navigation !== navigationToken) return;
      state.activeTabId = undefined;
      collapsed = true;
      layout.expanded = false;
      // Recorded server-side, or the next poll returns the old tab and puts
      // the application back in front.
      if (persist) await persistSelection();
      if (navigation !== navigationToken) return;
      if (conversationElement) conversationElement.hidden = false;
      root.classList.remove("has-app-open");
      document.body.classList.remove("app-fullbleed");
      for (const element of root.querySelectorAll("[data-app-mount]")) element.hidden = true;
      render();
    },

    activate,
    close,
    async prepareTab(tabId) {
      try {
        const controller = await mounted.get(tabId);
        return controller?.canClose ? await controller.canClose() : !drafts.get(tabId);
      } catch {
        return false;
      }
    },
    async prepareClose() {
      for (const entry of mounted.values()) {
        const controller = await entry;
        try {
          if (controller?.canClose && !(await controller.canClose())) return false;
        } catch {
          return false;
        }
      }
      return ![...drafts.values()].some(Boolean);
    },
    hasDrafts() {
      return [...drafts.values()].some(Boolean);
    },
    async destroy() {
      beginNavigation();
      layout.destroy();
      window.removeEventListener("resize", revealActiveTab);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      for (const tabId of [...mounted.keys()]) await unmount(tabId);
      state = { tabs: [], activeTabId: undefined };
      if (conversationElement) conversationElement.hidden = false;
      root.classList.remove("has-app-open");
      document.body.classList.remove("app-fullbleed");
      const strip = root.querySelector("[data-tab-strip]");
      if (strip) strip.innerHTML = "";
      if (rail) {
        rail.hidden = true;
        rail.innerHTML = "";
      }
      for (const element of root.querySelectorAll("[data-app-mount]")) element.remove();
    }
  };
}
