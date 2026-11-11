import { ui } from "../ui/language.js";
import { animateLayout } from "../ui/motion.js";

const COLLAPSED_KEY = "formicand.sidebar-collapsed";

/**
 * The sidebar toggle in the title row.
 *
 * The stylesheet owns the breakpoints; this keeps the behaviour they cannot
 * express. On a phone-sized window the navigation is a fullscreen drawer, so the
 * toggle opens it, the drawer has a way back, and it closes whenever a row in it
 * navigates. Above 640 the toggle collapses and restores the sidebar instead,
 * and that choice is remembered; the drawer class is dropped on the way up, so
 * a resized window never leaves the shell with a hidden drawer.
 */
export function createResponsiveShell({
  body = document.body,
  toggles = [],
  closeButton,
  sidebar,
  storage = globalThis.localStorage,
  navigation = "[data-entry-mode], [data-task], [data-project-create], #new-conversation, #new-project, #user-menu-button, #recover-drafts"
} = {}) {
  if (!toggles.length || !sidebar) return { open() {}, close() {}, destroy() {} };
  const narrow = window.matchMedia?.("(max-width: 639px)") ?? { matches: false };
  // The drawer covers the work and observation panels, so they leave the tab
  // order and the accessibility tree while it is open.
  const covered = [...document.querySelectorAll("#work-entry, #observe-entry")];
  let opener;

  const isOpen = () => body.classList.contains("sidebar-drawer-open");
  const isCollapsed = () => body.classList.contains("sidebar-collapsed");
  const remember = (collapsed) => {
    try {
      storage?.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
      // eslint-disable-next-line no-restricted-syntax -- 存储被禁用或配额耗尽时 setItem 抛出，折叠状态只保留在本次会话
    } catch {
      /* Keep the choice for this session only. */
    }
  };
  try {
    body.classList.toggle("sidebar-collapsed", storage?.getItem(COLLAPSED_KEY) === "1");
    // eslint-disable-next-line no-restricted-syntax -- 受限浏览器读取 localStorage 会抛出，侧栏按默认展开
  } catch {
    /* The sidebar starts expanded. */
  }

  function paint() {
    const label = narrow.matches
      ? isOpen()
        ? "关闭侧栏"
        : "打开侧栏"
      : isCollapsed()
        ? "展开侧栏"
        : "收起侧栏";
    const expanded = narrow.matches ? isOpen() : !isCollapsed();
    for (const toggle of toggles) {
      toggle.dataset.sidebarMode = narrow.matches ? "drawer" : "collapse";
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.setAttribute("aria-label", ui(label));
      toggle.title = ui(label);
    }
    // A collapsed sidebar keeps its grid track at zero width; it must also
    // leave the tab order and the accessibility tree.
    sidebar.inert = !narrow.matches && isCollapsed();
    for (const panel of covered) panel.inert = isOpen();
  }

  function setCollapsed(collapsed) {
    if (collapsed === isCollapsed()) return;
    if (collapsed && sidebar.contains(document.activeElement)) toggles[0]?.focus();
    animateLayout(() => body.classList.toggle("sidebar-collapsed", collapsed), { part: "sidebar", body });
    remember(collapsed);
    paint();
  }

  function open() {
    if (isOpen() || !narrow.matches) return;
    opener = document.activeElement;
    body.classList.add("sidebar-drawer-open");
    paint();
    const first = closeButton ?? sidebar.querySelector("button");
    first?.focus();
  }

  function close({ restoreFocus = true } = {}) {
    if (!isOpen()) return;
    body.classList.remove("sidebar-drawer-open");
    paint();
    if (restoreFocus && opener?.isConnected) opener.focus();
  }

  const onToggle = () => {
    if (narrow.matches) isOpen() ? close() : open();
    else setCollapsed(!isCollapsed());
  };
  const onClose = () => close();
  const onKey = (event) => {
    if (event.key !== "Escape" || !isOpen()) return;
    event.preventDefault();
    close();
  };
  // A row that navigates has answered the drawer's question: show its result.
  const onSidebarClick = (event) => {
    if (isOpen() && event.target.closest(navigation)) close({ restoreFocus: false });
  };
  const onWidthChange = () => {
    if (!narrow.matches) close({ restoreFocus: false });
    paint();
  };

  for (const toggle of toggles) toggle.addEventListener("click", onToggle);
  closeButton?.addEventListener("click", onClose);
  document.addEventListener("keydown", onKey);
  sidebar.addEventListener("click", onSidebarClick);
  narrow.addEventListener?.("change", onWidthChange);
  paint();

  return {
    open,
    close,
    setCollapsed,
    get expanded() {
      return isOpen();
    },
    get collapsed() {
      return isCollapsed();
    },
    destroy() {
      for (const toggle of toggles) toggle.removeEventListener("click", onToggle);
      closeButton?.removeEventListener("click", onClose);
      document.removeEventListener("keydown", onKey);
      sidebar.removeEventListener("click", onSidebarClick);
      narrow.removeEventListener?.("change", onWidthChange);
    }
  };
}
