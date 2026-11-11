import { ui } from "../ui/language.js";
import { icon } from "../ui/icons.js";

/**
 * The conversation context menu.
 *
 * It opens from a sidebar row by right click, Shift+F10 or the Menu key, sits
 * at the pointer (or beside the row from the keyboard), and keeps the captured
 * conversation while the sidebar re-renders underneath it.
 */
export function createConversationMenu({
  panel,
  getTask,
  getContext = () => "",
  isTaskActive = () => false,
  isTaskStopping = () => false,
  isUnread = () => false,
  onAction
}) {
  let currentTrigger = null,
    currentTaskId,
    currentTask,
    context,
    point = null;

  const row = (action, label, symbol) =>
    `<button type="button" role="menuitem" data-session-action="${action}" data-menu-key="${action}">${icon(symbol)}<span data-menu-label>${label}</span></button>`;
  panel.classList.add("conversation-context-menu");
  panel.setAttribute("role", "menu");
  panel.setAttribute("aria-label", ui("会话操作"));
  panel.tabIndex = -1;
  panel.innerHTML = ui`<div class="session-menu-main">
    ${row("rename", ui("重命名"), "pencil")}
    ${row("pin", ui("置顶"), "pin")}
    ${row("unread", ui("标记为未读"), "eye")}
    <div class="session-menu-separator" role="separator"></div>
    ${row("stop", ui("停止任务"), "stop")}
    ${row("archive", ui("归档"), "archive")}
    ${row("delete", ui("删除"), "trash")}
  </div>`;

  const visible = (node) => !node.hidden && Boolean(node.getClientRects().length);
  const items = () => [...panel.querySelectorAll("button:not(:disabled)")].filter(visible);
  const focusItem = (last = false) => {
    const options = items();
    (last ? options.at(-1) : options[0])?.focus();
    if (!options.length) panel.focus();
  };

  function setTrigger(next) {
    if (currentTrigger !== next) currentTrigger?.setAttribute("aria-expanded", "false");
    currentTrigger = next;
    currentTrigger.setAttribute("aria-expanded", String(!panel.hidden));
  }

  function sync() {
    currentTask = getTask(currentTaskId);
    const task = currentTask;
    panel.querySelectorAll("[data-session-action]").forEach((button) => {
      button.disabled = !task;
    });
    const label = (action, value) => {
      panel.querySelector(`[data-session-action="${action}"] [data-menu-label]`).textContent = value;
    };
    label("pin", task?.pinned ? ui("取消置顶") : ui("置顶"));
    label("unread", isUnread(currentTaskId, task) ? ui("标记为已读") : ui("标记为未读"));
    label("archive", task?.archived ? ui("恢复") : ui("归档"));
    // Stopping is offered only while the conversation runs; it is the one way
    // to stop a run whose composer is hidden behind a question or not open.
    const stop = panel.querySelector('[data-session-action="stop"]');
    stop.hidden = !task || !isTaskActive(currentTaskId, task);
    stop.disabled = !task || isTaskStopping(currentTaskId, task);
  }

  function position() {
    const { width, height } = panel.getBoundingClientRect(),
      anchor = currentTrigger.getBoundingClientRect();
    // From the pointer the menu opens where the click was; from the keyboard
    // it opens beside the row, inside the window either way.
    const left = point ? point.x : anchor.right + 8 + width <= innerWidth ? anchor.right + 8 : anchor.left;
    const top = point ? point.y : anchor.top;
    return {
      left: Math.max(8, Math.min(left, innerWidth - width - 8)),
      top: Math.max(8, Math.min(top, innerHeight - height - 8))
    };
  }

  function reposition() {
    if (panel.hidden) return;
    if (getContext() !== context || !currentTrigger?.getClientRects().length) return close();
    const { left, top } = position();
    panel.style.right = "auto";
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function close(restoreFocus = false) {
    if (panel.hidden) return;
    panel.hidden = true;
    currentTrigger?.closest(".conversation-row")?.classList.remove("has-menu");
    if (restoreFocus && currentTrigger?.isConnected) currentTrigger.focus();
    currentTrigger?.setAttribute("aria-expanded", "false");
  }

  /** `at` is the pointer position for a right click; omit it for the keyboard. */
  function open(nextTrigger, taskId, { at = null, last = false } = {}) {
    if (!nextTrigger?.getClientRects().length) return;
    close();
    setTrigger(nextTrigger);
    currentTrigger.closest(".conversation-row")?.classList.add("has-menu");
    currentTaskId = taskId;
    point = at;
    context = getContext();
    sync();
    panel.hidden = false;
    currentTrigger.setAttribute("aria-expanded", "true");
    reposition();
    focusItem(last);
  }

  function rebind(nextTrigger) {
    if (panel.hidden) return;
    setTrigger(nextTrigger);
    currentTrigger.closest(".conversation-row")?.classList.add("has-menu");
    sync();
    reposition();
    if (panel.hidden) return;
    if (
      panel.contains(document.activeElement) &&
      (!visible(document.activeElement) || document.activeElement.disabled)
    )
      focusItem();
  }

  function keys(event) {
    if (panel.hidden || event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      close(true);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const options = items(),
        current = options.indexOf(document.activeElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      options[next]?.focus();
    }
  }

  panel.addEventListener("keydown", keys);
  panel.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    const action = button.dataset.sessionAction,
      taskId = currentTaskId,
      task = currentTask;
    if (!action || !task) return;
    close(true);
    onAction(action, taskId, task);
  });
  panel.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    const button = event.target.closest("button");
    if (button && !button.disabled && panel.contains(document.activeElement))
      button.focus({ preventScroll: true });
  });
  document.addEventListener("pointerdown", (event) => {
    if (!panel.hidden && !panel.contains(event.target)) close();
  });

  return {
    open,
    close,
    reposition,
    rebind,
    get taskId() {
      return currentTaskId;
    },
    get trigger() {
      return currentTrigger;
    },
    get context() {
      return context;
    },
    get isOpen() {
      return !panel.hidden;
    }
  };
}
