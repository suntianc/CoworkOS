import { ui } from "../ui/language.js";

/** Presentation only: resizing never activates, binds or saves a document. */
export function createWorkspaceLayout({ root, conversationElement, onResize }) {
  const main = root.parentElement;
  const divider = main.querySelector("[data-workspace-divider]");
  const media = window.matchMedia?.("(min-width: 1100px)");
  let expanded = false;
  let ratio = 42;
  let dragging = false;
  const setRatio = (value) => {
    ratio = Math.min(48, Math.max(28, value));
    main.style.setProperty("--chat-share", `${ratio}%`);
    divider?.setAttribute("aria-valuenow", String(Math.round(ratio)));
  };
  setRatio(ratio);
  divider?.setAttribute("aria-valuemin", "28");
  divider?.setAttribute("aria-valuemax", "48");
  const resize = () => onResize();
  media?.addEventListener("change", resize);
  const down = (event) => {
    if (event.button !== 0) return;
    dragging = true;
    divider.classList.add("is-dragging");
    divider.setPointerCapture(event.pointerId);
    document.body.classList.add("workspace-resizing");
    event.preventDefault();
  };
  const move = (event) => {
    if (!dragging) return;
    const rect = main.getBoundingClientRect();
    setRatio(((event.clientX - rect.left) / rect.width) * 100);
  };
  const finish = () => {
    dragging = false;
    divider?.classList.remove("is-dragging");
    document.body.classList.remove("workspace-resizing");
  };
  const key = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    setRatio(
      event.key === "Home" ? 28 : event.key === "End" ? 48 : ratio + (event.key === "ArrowRight" ? 2 : -2)
    );
  };
  divider?.addEventListener("pointerdown", down);
  divider?.addEventListener("pointermove", move);
  divider?.addEventListener("pointerup", finish);
  divider?.addEventListener("pointercancel", finish);
  divider?.addEventListener("lostpointercapture", finish);
  divider?.addEventListener("keydown", key);
  return {
    get wide() {
      return media?.matches ?? false;
    },
    get expanded() {
      return expanded;
    },
    set expanded(value) {
      expanded = value;
    },
    paint({ split, hasApp, showingConversation }) {
      main.classList.toggle("is-collaborating", split);
      main.classList.toggle("is-app-expanded", hasApp && expanded);
      if (divider) divider.hidden = !split;
      const expand = root.querySelector("[data-app-expand]");
      if (expand) {
        expand.hidden = !hasApp || !media?.matches;
        expand.setAttribute("aria-label", expanded ? ui("恢复并排协作") : ui("全屏编辑"));
        expand.title = expanded ? ui("恢复并排协作") : ui("全屏编辑");
        expand.setAttribute("aria-pressed", String(expanded));
      }
      root.classList.toggle("is-conversation-only", hasApp && showingConversation && !split);
    },
    destroy() {
      media?.removeEventListener("change", resize);
      finish();
      for (const [name, handler] of [
        ["pointerdown", down],
        ["pointermove", move],
        ["pointerup", finish],
        ["pointercancel", finish],
        ["lostpointercapture", finish],
        ["keydown", key]
      ])
        divider?.removeEventListener(name, handler);
      main.classList.remove("is-collaborating", "is-app-expanded");
    }
  };
}
