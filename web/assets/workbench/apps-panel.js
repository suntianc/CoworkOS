import { ui, applicationLabel } from "../ui/language.js";
import { applicationProjectLabel } from "./workspace-scope.js";
import { icon } from "../ui/icons.js";
import { applicationIcon, applicationIconName } from "./application-icons.js";
import { openResourcePicker } from "./resource-picker.js";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
  );

/**
 * The sidebar "应用" entry: how a person opens an application themselves.
 *
 * The list of what is available comes from `GET /api/applications`, so
 * registering a CAD Adapter makes it appear here with no change to this file.
 * Nothing below names a resource kind or an operation — the same property the
 * platform core has to hold.
 *
 * Only applications with an editable resource are offered here.
 */

export function appsPanelModel({ applications = [], resources = [], openResourceIds = [] } = {}) {
  const open = new Set(openResourceIds);
  const byType = new Map();
  for (const resource of resources) {
    byType.set(resource.appType, (byType.get(resource.appType) || 0) + 1);
  }
  const available = applications
    .filter(
      (application) =>
        application.catalogVisibility !== "compatibility" &&
        application.capabilities?.includes("edit") &&
        application.resourceKinds?.length
    )
    .map((application) => ({
      appType: application.appType,
      displayName: applicationLabel(application.appType, application.displayName || application.appType),
      kinds: application.resourceKinds,
      defaultKind: application.resourceKinds[0],
      icon: applicationIconName(application.appType),
      resourceCount: byType.get(application.appType) || 0,
      available: true
    }));
  return {
    available,
    resources: resources.map((resource) => ({
      resourceId: resource.resourceId,
      ...(resource.accessTaskId ? { accessTaskId: resource.accessTaskId } : {}),
      title: resource.title,
      appType: resource.appType,
      revision: resource.revision,
      alreadyOpen: open.has(resource.resourceId)
    }))
  };
}

export function renderAppsPanel(model, { appLabels = {} } = {}) {
  const tileContent = (entry) =>
    ui`<button class="app-tile" type="button" data-toggle-instances="${esc(entry.appType)}" title="${esc(entry.displayName)}" aria-label="展开${esc(entry.displayName)}的实例" aria-expanded="false">
        <span class="app-tile-icon">${applicationIcon(entry.appType, entry.icon)}</span>
        <span class="app-tile-copy"><strong>${esc(entry.displayName)}</strong></span>
      <span class="app-tile-count" hidden></span></button><button type="button" class="app-instance-create" data-create-app="${esc(entry.appType)}" aria-label="新建${esc(entry.displayName)}实例" title="新建${esc(entry.displayName)}实例">${icon("plus")}</button>`;
  const tile = (entry) =>
    `<div class="app-instance-group">${tileContent(entry)}<div data-app-instances="${esc(entry.appType)}" hidden></div></div>`;
  const resources = model.resources.length
    ? ui`<div class="apps-group-heading"><span class="apps-group-label">文件</span><span class="apps-file-count">${model.resources.length}</span></div>${model.resources
        .slice(0, 5)
        .map(
          (
            entry
          ) => `<button class="app-resource ${entry.alreadyOpen ? "is-open" : ""}" type="button" data-open-resource="${esc(entry.resourceId)}" ${entry.accessTaskId ? `data-resource-access="${esc(entry.accessTaskId)}"` : ""} aria-label="${esc(entry.title)}，${esc(appLabels[entry.appType] || entry.appType)}${entry.alreadyOpen ? ui("，已打开") : ""}" title="${esc(entry.title)}">
        ${applicationIcon(entry.appType)}<span class="app-resource-copy"><strong>${esc(entry.title)}</strong></span>${entry.alreadyOpen ? ui('<small class="app-resource-open">已打开</small>') : ""}
      </button>`
        )
        .join(
          ""
        )}${model.resources.length > 5 ? ui`<button class="apps-all-files" type="button" data-all-resources>查看全部文件 ${icon("chevron-right")}</button>` : ""}`
    : "";
  return `<div class="app-tiles">${model.available.map(tile).join("")}</div><div class="apps-files">${resources}</div>`;
}

/**
 * Wire the sidebar apps panel.
 *
 * Creating goes through the same `POST /resources` the Agent's tool uses, so a
 * user-created and an Agent-created resource are indistinguishable afterwards.
 */
/** The selected conversation is used only to list and reopen its existing resources. */
export function createAppsPanel({
  navButton,
  panel,
  api,
  getTaskId,
  getOpenResourceIds,
  getOpenApplications = () => [],
  supportsApplication = () => true,
  onOpenInstance,
  onCloseInstance,
  getProjects = () => [],
  getWorkspaceRoot = () => undefined,
  captureNavigation = () => ({ current: () => true }),
  getNavigationContext = () => undefined,
  onOpened,
  onError
}) {
  const taskForReading = async () => (await getTaskId({ create: false })) ?? null;
  let applications;
  let catalogRequest;
  let catalogError;
  let open = false;
  let opening;
  let readSequence = 0;
  let resourcePicker;
  let resourceContext;
  let fileView;
  let repaint;
  let tilesMarkup;
  let filesMarkup;
  const expanded = new Set();
  const closing = new Set();
  const renderedLists = new WeakMap();

  function syncContext() {
    if (resourcePicker && resourceContext !== getNavigationContext())
      resourcePicker.close({ restoreFocus: false });
  }
  window.addEventListener("popstate", () => resourcePicker?.close({ restoreFocus: false }));

  function updateInstances() {
    syncContext();
    if (!open) return;
    const instances = getOpenApplications();
    for (const list of panel.querySelectorAll("[data-app-instances]")) {
      const type = list.dataset.appInstances;
      const entries = instances.filter((entry) => entry.appType === type);
      if (!entries.length) expanded.delete(type);
      list.hidden = !entries.length || !expanded.has(type);
      const group = list.parentElement;
      const toggle = group.querySelector("[data-toggle-instances]");
      toggle.hidden = false;
      toggle.setAttribute("aria-expanded", String(!list.hidden));
      toggle.setAttribute(
        "aria-label",
        ui`${list.hidden ? ui("展开") : ui("收起")}${applicationLabel(type, applications?.find((app) => app.appType === type)?.displayName || type)}的实例`
      );
      let count = group.querySelector(".app-tile-count");
      if (!count) {
        count = document.createElement("span");
        count.className = "app-tile-count";
      }
      if (count.parentElement !== toggle) toggle.append(count);
      count.textContent = String(entries.length);
      count.hidden = !entries.length;
      const markup = entries.length
        ? entries
            .map(
              (entry) =>
                ui`<div class="app-instance-row"><button type="button" data-open-instance="${esc(entry.tabId)}" title="${esc(applicationProjectLabel(entry, getProjects()))} · ${esc(entry.title)}">${esc(entry.title || ui("未命名"))}<small class="app-instance-workspace">${esc(applicationProjectLabel(entry, getProjects()))}</small></button><button type="button" data-close-instance="${esc(entry.tabId)}" aria-label="关闭 ${esc(entry.title)}" ${closing.has(entry.tabId) ? "disabled" : ""}>${icon("close")}</button></div>`
            )
            .join("")
        : "";
      if (renderedLists.get(list) === markup) continue;
      renderedLists.set(list, markup);
      const focused = document.activeElement;
      const hadFocus = list.contains(focused);
      const id = focused?.dataset?.closeInstance || focused?.dataset?.openInstance;
      const selector = focused?.dataset?.closeInstance ? "data-close-instance" : "data-open-instance";
      const index = [...list.querySelectorAll(`[${selector}]`)].indexOf(focused);
      list.innerHTML = markup;
      if (hadFocus) {
        const buttons = [...list.querySelectorAll(`[${selector}]`)];
        (
          buttons.find((button) => button.getAttribute(selector) === id) ??
          buttons[Math.min(Math.max(index, 0), buttons.length - 1)] ??
          (toggle.hidden ? group.querySelector("[data-create-app]") : toggle)
        ).focus();
      }
    }
  }

  panel.addEventListener("click", async (event) => {
    if (event.target.closest("[data-retry-apps]")) {
      void show();
      return;
    }
    const appType = event.target.closest("[data-create-app]")?.dataset.createApp;
    if (appType) {
      void openApplication(appType);
      return;
    }
    const resource = event.target.closest("[data-open-resource]");
    if (resource) {
      if (fileView?.context !== getNavigationContext()) void show();
      else void reopen(resource.dataset.openResource, resource.dataset.resourceAccess);
      return;
    }
    if (event.target.closest("[data-all-resources]")) {
      openAllFiles();
      return;
    }
    const type = event.target.closest("[data-toggle-instances]")?.dataset.toggleInstances;
    if (type) {
      expanded.has(type) ? expanded.delete(type) : expanded.add(type);
      updateInstances();
      return;
    }
    const closeId = event.target.closest("[data-close-instance]")?.dataset.closeInstance;
    const openId = event.target.closest("[data-open-instance]")?.dataset.openInstance;
    try {
      if (closeId && !closing.has(closeId)) {
        closing.add(closeId);
        updateInstances();
        try {
          await onCloseInstance?.(closeId);
        } finally {
          closing.delete(closeId);
          updateInstances();
        }
      } else if (openId) await onOpenInstance?.(openId);
    } catch (error) {
      onError?.(ui`应用操作失败：${error.message}`);
    }
  });

  function paintNav() {
    navButton.classList.toggle("active", open);
    navButton.setAttribute("aria-expanded", String(open));
    panel.hidden = !open;
  }

  const close = () => {
    resourcePicker?.close({ restoreFocus: false });
    readSequence += 1;
    open = false;
    paintNav();
    panel.innerHTML = "";
    panel.removeAttribute("aria-busy");
    tilesMarkup = filesMarkup = fileView = repaint = undefined;
  };

  function paintOpening() {
    for (const node of panel.querySelectorAll("[data-create-app], [data-open-resource]")) {
      node.disabled = Boolean(opening);
      const selected =
        opening &&
        ((opening.appType && node.dataset.createApp === opening.appType) ||
          (opening.resourceId && node.dataset.openResource === opening.resourceId));
      if (selected) node.setAttribute("aria-busy", "true");
      else node.removeAttribute("aria-busy");
    }
  }

  function beginOpening(entry) {
    if (opening) return false;
    opening = entry;
    navButton.setAttribute("aria-busy", "true");
    paintOpening();
    return true;
  }

  function finishOpening() {
    opening = undefined;
    navButton.removeAttribute("aria-busy");
    repaint?.();
    paintOpening();
  }

  function openAllFiles() {
    if (!fileView || fileView.context !== getNavigationContext()) {
      void show();
      return;
    }
    const { resources, appLabels, context } = fileView;
    const navigation = captureNavigation();
    resourceContext = context;
    resourcePicker = openResourcePicker({
      resources,
      appLabels,
      appIcons: Object.fromEntries(resources.map((entry) => [entry.appType, applicationIcon(entry.appType)])),
      onOpen: (entry) => {
        if (context === getNavigationContext() && navigation.current())
          void reopen(entry.resourceId, entry.accessTaskId, navigation);
      },
      onClose: ({ restoreFocus = true } = {}) => {
        resourcePicker = undefined;
        if (restoreFocus && open && context === getNavigationContext())
          (panel.querySelector("[data-all-resources]") || navButton).focus();
      }
    });
  }

  /**
   * Open the application itself, with no document in it.
   *
   * Asking for a filename here made "open the editor" and "create a file" the
   * same act, so a person who only wanted to look at the editor was met with a
   * prompt. The application opens empty, the way any editor does, and naming
   * happens when there is something to name.
   */
  async function openApplication(appType) {
    if (!beginOpening({ appType })) return;
    const navigation = captureNavigation();
    const context = getNavigationContext();
    try {
      const opened = await api.openStandaloneApplication(appType);
      await onOpened?.({
        appInstanceId: opened.appInstance?.appInstanceId,
        taskId: opened.taskId,
        navigation
      });
      if (context === getNavigationContext()) close();
    } catch (error) {
      if (navigation.current()) onError?.(ui`打开失败：${error.message}`);
    } finally {
      finishOpening();
    }
  }

  async function reopen(resourceId, accessTaskId, navigation = captureNavigation()) {
    if (!beginOpening({ resourceId })) return;
    const context = getNavigationContext();
    try {
      const taskId = accessTaskId || (await taskForReading());
      if (!taskId || !navigation.current()) return;
      await api.openResource(taskId, resourceId);
      if (!navigation.current()) return;
      // Keyed by the document, and `bindTo` says whose next message it is
      // about — one file is one tab however many conversations reference it.
      await api.openTab?.({ kind: "application", resourceId, activate: false });
      if (!navigation.current()) return;
      await onOpened?.({ resourceId, taskId, navigation });
      if (navigation.current() && context === getNavigationContext()) close();
    } catch (error) {
      if (navigation.current()) onError?.(ui`打开失败：${error.message}`);
    } finally {
      finishOpening();
    }
  }

  async function show() {
    const sequence = ++readSequence;
    const context = getNavigationContext();
    syncContext();
    const current = () => open && sequence === readSequence && context === getNavigationContext();
    open = true;
    paintNav();
    panel.setAttribute("aria-busy", "true");
    let resources = fileView && fileView.context === context ? fileView.resources : [];
    let filesError;
    if (!applications && !catalogRequest) catalogError = undefined;
    const paint = () => {
      if (!current()) return;
      const model = appsPanelModel({
        applications: (applications ?? []).filter((application) => supportsApplication(application.appType)),
        resources,
        openResourceIds: getOpenResourceIds?.() || []
      });
      const appLabels = Object.fromEntries(
        (applications ?? []).map((entry) => [
          entry.appType,
          applicationLabel(entry.appType, entry.displayName || entry.appType)
        ])
      );
      const content = document.createElement("div");
      content.innerHTML = renderAppsPanel(model, { appLabels });
      const nextTiles = content.querySelector(".app-tiles");
      const nextFiles = content.querySelector(".apps-files");
      if (catalogError)
        nextTiles.innerHTML = ui(
          '<button class="app-resource" type="button" data-retry-apps aria-label="应用读取失败，重试" title="应用读取失败">重试加载应用</button>'
        );
      if (filesError)
        nextFiles.insertAdjacentHTML(
          "beforeend",
          ui(
            '<button class="app-resource" type="button" data-retry-apps aria-label="文件读取失败，重试" title="文件读取失败">重试加载文件</button>'
          )
        );
      // Catalog and files arrive independently. Retain live application controls
      // so a file response cannot steal focus or erase a pending launch.
      if (tilesMarkup !== nextTiles.innerHTML) {
        tilesMarkup = nextTiles.innerHTML;
        const previous = panel.querySelector(".app-tiles");
        if (previous) previous.replaceWith(nextTiles);
        else panel.prepend(nextTiles);
      }
      if (!opening?.resourceId || fileView?.context !== context) {
        fileView = { resources: model.resources, appLabels, context };
        if (filesMarkup !== nextFiles.innerHTML) {
          filesMarkup = nextFiles.innerHTML;
          const previous = panel.querySelector(".apps-files");
          if (previous) previous.replaceWith(nextFiles);
          else panel.append(nextFiles);
        }
      }
      updateInstances();
      paintOpening();
    };
    repaint = paint;
    paint();
    // File discovery must not gate the independent application catalog. Share
    // an in-flight catalog read when the person closes and reopens the panel.
    if (!applications && !catalogRequest) {
      catalogRequest = Promise.resolve()
        .then(() => api.listApplications())
        .then((result) => {
          applications = result.applications || [];
        })
        // A failed catalog is retryable on the next opening.
        .catch((error) => {
          catalogError = error;
        })
        .finally(() => {
          catalogRequest = undefined;
        });
    }
    const catalogRead = Promise.resolve(catalogRequest).then(paint);
    const taskRead = taskForReading().then(async (taskId) => {
      const { resources: entries = [] } = taskId ? await api.listResources(taskId) : {};
      return entries.map((entry) => ({ ...entry, accessTaskId: entry.accessTaskId || taskId }));
    });
    const temporaryRead = Promise.resolve().then(() => api.listTemporaryResources?.());
    const filesRead = Promise.all([taskRead, temporaryRead])
      .then(([taskResources, temporary]) => {
        resources = [
          ...new Map(
            [...(temporary?.resources || []), ...taskResources].map((entry) => [entry.resourceId, entry])
          ).values()
        ];
      })
      .catch((error) => {
        filesError = error;
      })
      .then(paint);
    await Promise.all([catalogRead, filesRead]);
    if (current()) panel.removeAttribute("aria-busy");
  }

  return {
    toggle() {
      return open ? close() : show();
    },
    /** Re-read the panel if it is open, e.g. after a resource was created elsewhere. */
    refresh() {
      return open ? show() : undefined;
    },
    updateInstances,
    syncContext,
    close,
    get isOpen() {
      return open;
    }
  };
}
