import { ui } from "../ui/language.js";

/**
 * The narrow-window shell.
 *
 * The stylesheet owns the breakpoints; this keeps the one piece of behaviour
 * they cannot express: on a web phone-sized window the navigation is a
 * fullscreen drawer, so it needs an opener, a way back, and a close whenever a
 * row in it navigates. Above 640 the drawer does not exist and the class is
 * dropped, so a resized window never leaves the shell with a hidden sidebar.
 */
export function createResponsiveShell({
  body = document.body,
  toggles = [],
  closeButton,
  sidebar,
  navigation = "[data-entry-mode], [data-task], [data-project-create], #new-conversation, #new-project, #user-menu-button, #recover-drafts"
} = {}) {
  if (!toggles.length || !sidebar) return { open() {}, close() {}, destroy() {} };
  const narrow = window.matchMedia?.("(max-width: 639px)") ?? { matches: false };
  // The drawer covers the work and observation panels, so they leave the tab
  // order and the accessibility tree while it is open.
  const covered = [...document.querySelectorAll("#work-entry, #observe-entry")];
  let opener;

  const isOpen = () => body.classList.contains("sidebar-drawer-open");

  function paint() {
    for (const toggle of toggles) {
      toggle.setAttribute("aria-expanded", String(isOpen()));
      toggle.setAttribute("aria-label", ui(isOpen() ? "关闭侧栏" : "打开侧栏"));
      toggle.title = ui(isOpen() ? "关闭侧栏" : "打开侧栏");
    }
    for (const panel of covered) panel.inert = isOpen();
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

  const onToggle = () => (isOpen() ? close() : open());
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
    get expanded() {
      return isOpen();
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
