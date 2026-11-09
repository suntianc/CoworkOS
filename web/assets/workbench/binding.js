import { ui, applicationLabel } from "../ui/language.js";
import { icon } from "../ui/icons.js";
import { applicationIconName } from "./application-icons.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
  );

/** The composer selects agent context independently of the visible editor.
 * The controller supplies only instances from the conversation's workspace.
 */
export const UNBOUND = "__unbound__";

export function bindingModel({ instances = [], boundResourceId, loadedInstanceId } = {}) {
  const options = instances
    .filter((instance) => instance && instance.status !== "closed")
    .map((instance) => ({
      appInstanceId: instance.appInstanceId,
      // What identifies this option. A document is named by itself, so one
      // file is one row however many conversations reference it.
      value: instance.appInstanceId ?? instance.resourceId,
      title: instance.title || ui("未命名"),
      appType: instance.appType,
      resourceId: instance.resourceId ?? instance.resourceIds?.[0],
      // An editor opened on its own belongs to no conversation yet. It is still
      // offered here, because binding it *is* how it gets one — filtering it
      // out left the user with a window they could not attach to anything.
      standalone: instance.standalone === true,
      // Legacy presentation metadata; an instance itself belongs to a workspace.
      elsewhere: instance.elsewhere === true,
      taskGoal: instance.taskGoal,
      taskId: instance.taskId,
      // Whether this window's own tools are available to the Agent. A server
      // that failed to start is worth saying out loud: the application still
      // works, but the Agent has fewer ways to help with it.
      mcp: instance.mcp
    }));
  const selected = options.find((option) =>
    loadedInstanceId
      ? option.appInstanceId === loadedInstanceId
      : boundResourceId && option.resourceId === boundResourceId
  )?.value;
  return {
    options,
    selected,
    // The control is always present once the workbench is on. Hiding it when no
    // application happens to be open removes the only affordance for binding
    // one, which leaves the feature unreachable exactly when the user wants it.
    available: true,
    hasOptions: options.length > 0,
    label: selected
      ? options.find((option) => option.value === selected).title
      : options.length > 0
        ? ui("未加载应用")
        : ui("没有打开的应用"),
    // Loading adds a reference; it never moves or copies the instance.
    hasStandalone: options.some((option) => option.standalone)
  };
}

export function renderBindingMenu(model, { appLabels = {} } = {}) {
  const row = (checked, value, title, glyph, description = "", warning = "") =>
    `<button type="button" class="model-option ${checked ? "active" : ""}" role="option" aria-selected="${checked}" data-bind-instance="${esc(value)}" title="${esc([title, warning].filter(Boolean).join(" · "))}"${description ? ` aria-description="${esc(description)}"` : ""}>
      ${icon(glyph, "binding-option-icon")}
      <span class="model-option-name">${esc(title)}</span>
      <span class="model-option-check" aria-hidden="true">${checked ? icon("check") : ""}</span>
    </button>`;
  if (!model.hasOptions)
    return ui`<div class="binding-menu-empty" role="status">当前工作区没有打开的应用</div>`;
  return [
    ...model.options.map((option) => {
      const warning = option.mcp && option.mcp.state !== "running" ? ui("专用工具不可用") : "";
      const description = [appLabels[option.appType] || option.appType, warning].filter(Boolean).join("，");
      return row(
        option.value === model.selected,
        option.value,
        option.title,
        applicationIconName(option.appType).replace(/^i-/, ""),
        description,
        warning
      );
    }),
    '<div class="model-menu-divider"></div>',
    row(!model.selected, UNBOUND, ui("不加载应用"), "chat")
  ].join("");
}

export function createBindingControl({
  button,
  menu,
  label,
  api,
  getTaskId,
  getContext = getTaskId,
  onSelect,
  onError,
  onPendingChange,
  onRefresh
}) {
  let model = bindingModel();
  let appLabels = {};
  let pending = false;
  let refreshing = false;
  let opening = 0;
  let modelContext;
  let openingContext;
  let hasSnapshot = false;
  const view = menu.ownerDocument?.defaultView;
  const observer = view?.ResizeObserver ? new view.ResizeObserver(position) : undefined;

  function position() {
    const parent = menu.offsetParent;
    if (menu.hidden || !parent) return;
    const bounds = parent.getBoundingClientRect();
    const anchor = button.getBoundingClientRect();
    const width = menu.getBoundingClientRect().width;
    const left = anchor.right - bounds.left - parent.clientLeft - width;
    menu.style.left = `${Math.max(0, Math.min(parent.clientWidth - width, left))}px`;
    menu.style.bottom = `${bounds.top + parent.clientTop + parent.clientHeight - anchor.top + 8}px`;
    menu.style.maxHeight = `${Math.max(0, Math.min(360, anchor.top - 16))}px`;
  }

  function reveal() {
    menu.hidden = false;
    menu.setAttribute("aria-busy", String(refreshing));
    button.setAttribute("aria-expanded", "true");
    position();
    view?.addEventListener("resize", position);
    for (const node of new Set([button, button.parentElement, menu, menu.offsetParent]))
      if (node) observer?.observe(node);
  }

  const close = () => {
    opening++;
    refreshing = false;
    menu.hidden = true;
    menu.removeAttribute("aria-busy");
    button.setAttribute("aria-expanded", "false");
    observer?.disconnect();
    view?.removeEventListener("resize", position);
  };

  function paint() {
    button.hidden = false;
    button.disabled = pending;
    button.setAttribute("aria-busy", String(pending));
    label.textContent = pending ? ui("正在切换…") : model.label;
    button.classList.toggle("is-bound", Boolean(model.selected));
    button.classList.toggle("is-empty", !model.hasOptions);
    button.title = model.selected
      ? ui`本轮对话加载「${model.label}」，Formicand 会收到它的选区和改动`
      : model.hasOptions
        ? ui("未加载应用：Formicand 只收到你的消息。点击选择要加载的应用。")
        : ui("这个对话还没有打开的应用");
  }

  return {
    /** Follow the server's view of the binding, including via a tab switch. */
    update({ instances, boundResourceId, loadedInstanceId, applications }) {
      if (applications)
        appLabels = Object.fromEntries(
          applications.map((entry) => [
            entry.appType,
            applicationLabel(entry.appType, entry.displayName || entry.appType)
          ])
        );
      model = bindingModel({ instances, boundResourceId, loadedInstanceId });
      modelContext = getContext();
      hasSnapshot = true;
      paint();
      if (!menu.hidden) {
        if (openingContext !== modelContext) return close();
        this.render();
      }
    },

    open() {
      if (pending) return;
      const version = ++opening;
      const taskId = getTaskId();
      const context = getContext();
      openingContext = context;
      if (!onRefresh) return this.render();
      refreshing = true;
      if (hasSnapshot && modelContext === context) this.render();
      else {
        menu.innerHTML = ui('<div class="binding-menu-empty" role="status">加载中…</div>');
        reveal();
      }
      return (async () => {
        try {
          await onRefresh();
          if (version !== opening || menu.hidden) return;
          if (getTaskId() !== taskId || getContext() !== context) return close();
          refreshing = false;
          this.render();
        } catch (error) {
          if (version !== opening || menu.hidden) return;
          if (getTaskId() !== taskId || getContext() !== context) return close();
          if (!hasSnapshot || modelContext !== context) close();
          onError?.(ui`无法刷新打开的应用：${error.message}`);
        } finally {
          if (version === opening) {
            refreshing = false;
            if (!menu.hidden) menu.setAttribute("aria-busy", "false");
          }
        }
      })();
    },

    render() {
      if (pending) return;
      const html = renderBindingMenu(model, { appLabels });
      const activeElement = menu.ownerDocument?.activeElement;
      const focused =
        activeElement && menu.contains(activeElement) ? activeElement.dataset.bindInstance : undefined;
      const scrollTop = menu.scrollTop;
      // Polls with unchanged data must not replace the focused option. When the
      // catalog changes, keep the same document and scroll position reachable.
      if (menu.innerHTML !== html) {
        menu.innerHTML = html;
        menu.querySelectorAll("[data-bind-instance]").forEach((node) =>
          node.addEventListener("click", async () => {
            if (pending) return;
            const value = node.dataset.bindInstance;
            const chosen = model.options.find((option) => option.value === value);
            const taskId = getTaskId();
            close();
            pending = true;
            paint();
            onPendingChange?.(true);
            try {
              if (value === UNBOUND) {
                if (!taskId) return;
                await api.unbind(taskId);
                // A late response must not switch the conversation opened since
                // the click, or make its binding appear to have been removed.
                if (getTaskId() === taskId) await onSelect?.(undefined, undefined, { taskId });
              } else {
                await onSelect?.(value, chosen, { taskId });
              }
            } catch (error) {
              onError?.(ui`切换加载失败：${error.message}`);
            } finally {
              pending = false;
              paint();
              onPendingChange?.(false);
            }
          })
        );
        if (focused)
          [...menu.querySelectorAll("[data-bind-instance]")]
            .find((node) => node.dataset.bindInstance === focused)
            ?.focus();
        menu.scrollTop = scrollTop;
      }
      reveal();
    },

    toggle() {
      return menu.hidden ? this.open() : close();
    },
    close,
    get isOpen() {
      return !menu.hidden;
    }
  };
}
