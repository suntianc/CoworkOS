import { ui } from "../ui/language.js";
import { icon } from "../ui/icons.js";

/** One anchored menu manages its captured conversation, including during sidebar refreshes. */
export function createConversationMenu({
  trigger,
  panel,
  getTask,
  getContext = () => "",
  isTaskActive = () => false,
  isTaskStopping = () => false,
  isUnread = () => false,
  onAction
}) {
  let currentTrigger = trigger,
    currentTaskId,
    currentTask,
    context,
    copyOpen = false;

  const row = (action, label, symbol) =>
    `<button type="button" role="menuitem" data-session-action="${action}" data-menu-key="${action}">${icon(symbol)}<span data-menu-label>${label}</span></button>`;
  panel.classList.add("conversation-context-menu");
  panel.setAttribute("role", "menu");
  panel.setAttribute("aria-label", ui("会话操作"));
  panel.tabIndex = -1;
  panel.innerHTML = ui`<div class="session-menu-main">
    ${row("rename", ui("重命名会话"), "pencil")}
    ${row("pin", ui("置顶会话"), "pin")}
    ${row("unread", ui("标记为未读"), "eye")}
    <div class="session-menu-separator" role="separator"></div>
    <button type="button" role="menuitem" data-session-submenu="copy" data-menu-key="copy-menu" aria-haspopup="menu" aria-expanded="false" aria-controls="${panel.id}-copy">${icon("copy")}<span data-menu-label>复制</span>${icon("chevron-right", "session-menu-chevron")}</button>
    ${row("export", ui("导出 Markdown"), "download")}
    ${row("open", ui("在新标签页中打开"), "external")}
    <div class="session-menu-separator" role="separator"></div>
    ${row("stop", ui("停止任务"), "stop")}
    ${row("archive", ui("归档会话"), "archive")}
    ${row("delete", ui("删除会话"), "trash")}
  </div><div class="session-menu-copy" id="${panel.id}-copy" data-session-submenu-panel="copy" role="menu" aria-label="复制" hidden>
    <button type="button" role="menuitem" data-session-back data-menu-key="back">${icon("chevron-left")}<span>返回会话菜单</span></button>
    ${row("copy-title", ui("复制会话标题"), "text")}
    ${row("copy", ui("复制会话 ID"), "code")}
    ${row("copy-link", ui("复制会话链接"), "link")}
    ${row("copy-content", ui("复制对话内容"), "chat")}
  </div>`;

  const main = panel.querySelector(".session-menu-main"),
    submenu = panel.querySelector("[data-session-submenu-panel]"),
    copyTrigger = panel.querySelector("[data-session-submenu]"),
    back = panel.querySelector("[data-session-back]");
  const visible = (node) => !node.hidden && Boolean(node.getClientRects().length);
  const items = (scope) => [...scope.querySelectorAll("button:not(:disabled)")].filter(visible);
  const focusItem = (scope, last = false) => {
    const options = items(scope);
    (last ? options.at(-1) : options[0])?.focus();
    if (!options.length) panel.focus();
  };

  function setTrigger(next) {
    if (currentTrigger !== next) {
      currentTrigger?.setAttribute("aria-expanded", "false");
      currentTrigger?.removeEventListener("keydown", triggerKeys);
      currentTrigger = next;
      currentTrigger.addEventListener("keydown", triggerKeys);
    }
    currentTrigger.setAttribute("aria-haspopup", "menu");
    currentTrigger.setAttribute("aria-controls", panel.id);
    currentTrigger.setAttribute("aria-expanded", String(!panel.hidden));
  }

  function sync() {
    currentTask = getTask(currentTaskId);
    const task = currentTask;
    panel.querySelectorAll("[data-session-action]").forEach((button) => {
      button.disabled = !task;
    });
    copyTrigger.disabled = !task;
    const label = (action, value) => {
      panel.querySelector(`[data-session-action="${action}"] [data-menu-label]`).textContent = value;
    };
    label("pin", task?.pinned ? ui("取消置顶") : ui("置顶会话"));
    label("unread", isUnread(currentTaskId, task) ? ui("标记为已读") : ui("标记为未读"));
    label("archive", task?.archived ? ui("恢复会话") : ui("归档会话"));
    const stop = panel.querySelector('[data-session-action="stop"]');
    stop.hidden = !task || !isTaskActive(currentTaskId, task);
    stop.disabled = !task || isTaskStopping(currentTaskId, task);
    if (!task && copyOpen) closeCopy();
  }

  function positionCopy() {
    if (!copyOpen || panel.hidden) return;
    const inline = needsInlineCopy();
    panel.classList.toggle("has-inline-submenu", inline);
    main.hidden = inline;
    back.hidden = !inline;
    submenu.style.removeProperty("left");
    submenu.style.removeProperty("top");
    submenu.style.removeProperty("max-height");
    if (inline) return;
    const root = panel.getBoundingClientRect(),
      anchor = copyTrigger.getBoundingClientRect(),
      width = submenu.offsetWidth,
      height = submenu.offsetHeight;
    const left =
      root.right + width + 4 <= innerWidth - 8 ? root.right + 4 : Math.max(8, root.left - width - 4);
    submenu.style.left = `${left}px`;
    submenu.style.top = `${Math.max(8, Math.min(anchor.top - 5, innerHeight - height - 8))}px`;
    submenu.style.maxHeight = `${innerHeight - 16}px`;
  }

  function mainPosition() {
    const width = panel.offsetWidth,
      height = panel.offsetHeight,
      anchor = currentTrigger.getBoundingClientRect(),
      sidebarRow = currentTrigger.closest(".conversation-row")?.getBoundingClientRect(),
      beside = sidebarRow && sidebarRow.right + width + 16 <= innerWidth,
      below = anchor.bottom + 4,
      above = anchor.top - height - 4;
    return {
      left: beside
        ? sidebarRow.right + 8
        : Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8)),
      top: beside
        ? Math.max(8, Math.min(sidebarRow.top, innerHeight - height - 8))
        : below + height <= innerHeight - 8
          ? below
          : above >= 8
            ? above
            : Math.max(8, innerHeight - height - 8)
    };
  }

  function needsInlineCopy() {
    const width = panel.offsetWidth,
      { left } = mainPosition(),
      copyWidth = submenu.offsetWidth || 216;
    return innerWidth < 510 || Math.max(left - 8, innerWidth - left - width - 8) < copyWidth + 4;
  }

  function reposition() {
    if (panel.hidden) return;
    if (getContext() !== context || !currentTrigger?.getClientRects().length) return close();
    // Resolve inline state first so the main panel's measured height matches what is visible.
    if (copyOpen) {
      const inline = needsInlineCopy();
      panel.classList.toggle("has-inline-submenu", inline);
      main.hidden = inline;
      back.hidden = !inline;
    }
    const position = mainPosition();
    panel.style.right = "auto";
    panel.style.left = `${position.left}px`;
    panel.style.top = `${position.top}px`;
    positionCopy();
    if (panel.contains(document.activeElement) && !visible(document.activeElement))
      focusItem(copyOpen ? submenu : main);
  }

  function closeCopy(restoreFocus = false) {
    copyOpen = false;
    submenu.hidden = true;
    main.hidden = false;
    panel.classList.remove("has-inline-submenu");
    copyTrigger.setAttribute("aria-expanded", "false");
    if (!panel.hidden) reposition();
    if (restoreFocus && !copyTrigger.disabled) copyTrigger.focus();
  }

  function openCopy(focus = true) {
    if (copyTrigger.disabled) return;
    copyOpen = true;
    submenu.hidden = false;
    copyTrigger.setAttribute("aria-expanded", "true");
    reposition();
    if (focus) focusItem(submenu);
  }

  function close(restoreFocus = false) {
    if (panel.hidden) return;
    panel.hidden = true;
    closeCopy();
    // Restore focus first: the narrow rail shows a row's tree while its menu is
    // open, and that is what makes the trigger focusable when the menu closes.
    if (restoreFocus && currentTrigger?.isConnected) currentTrigger.focus();
    currentTrigger?.setAttribute("aria-expanded", "false");
  }

  function open(nextTrigger, taskId, { last = false } = {}) {
    if (!nextTrigger?.getClientRects().length) return;
    if (!panel.hidden && currentTrigger === nextTrigger && currentTaskId === taskId) return close(true);
    close();
    setTrigger(nextTrigger);
    currentTaskId = taskId;
    context = getContext();
    sync();
    panel.hidden = false;
    currentTrigger.setAttribute("aria-expanded", "true");
    reposition();
    focusItem(main, last);
  }

  function rebind(nextTrigger) {
    if (panel.hidden) return;
    setTrigger(nextTrigger);
    sync();
    reposition();
    if (panel.hidden) return;
    if (
      panel.contains(document.activeElement) &&
      (!visible(document.activeElement) || document.activeElement.disabled)
    )
      focusItem(copyOpen ? submenu : main);
  }

  function triggerKeys(event) {
    if (event.isComposing) return;
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      // The host's click handler resolves the currently selected conversation for topbar menus.
      if (panel.hidden) currentTrigger.click();
      if (!panel.hidden) focusItem(copyOpen ? submenu : main, event.key === "ArrowUp");
    } else if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault();
      close(true);
    }
  }

  function keys(event) {
    if (panel.hidden || event.isComposing) return;
    const inCopy = submenu.contains(event.target);
    if (event.key === "Escape" || (event.key === "ArrowLeft" && copyOpen)) {
      event.preventDefault();
      event.stopPropagation();
      if (copyOpen) closeCopy(true);
      else close(true);
    } else if (event.key === "Tab") {
      close(true);
    } else if (event.key === "ArrowRight" && event.target === copyTrigger) {
      event.preventDefault();
      openCopy();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const options = items(inCopy ? submenu : main),
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
    if (button === copyTrigger) return openCopy();
    if (button === back) return closeCopy(true);
    const action = button.dataset.sessionAction,
      taskId = currentTaskId,
      task = currentTask;
    if (!action || !task) return;
    close(true);
    onAction(action, taskId, task);
  });
  // Sidebar sorting can move the menu under a stationary pointer. Boundary events from
  // that layout change must not dismiss the submenu currently being used by keyboard.
  main.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch" || innerWidth < 510) return;
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    if (button === copyTrigger) openCopy(false);
    else if (copyOpen) closeCopy();
    if (panel.contains(document.activeElement) && !visible(document.activeElement))
      button.focus({ preventScroll: true });
  });
  document.addEventListener("pointerdown", (event) => {
    if (!panel.hidden && !panel.contains(event.target) && !currentTrigger.contains(event.target)) close();
  });
  currentTrigger.addEventListener("keydown", triggerKeys);
  setTrigger(currentTrigger);

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
