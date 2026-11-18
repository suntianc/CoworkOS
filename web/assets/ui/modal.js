import { focusedControl } from "./focus.js";
import { reducedMotion } from "./motion.js";

/** Keep focus inside a shell dialog and return it to the control that opened it. */
const openPanels = [];

export function createModal(panel, closeButton, { onClose = () => {} } = {}) {
  let previousFocus;
  const controls = () =>
    [
      ...panel.querySelectorAll(
        'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]'
      )
    ].filter((node) => node.getClientRects().length);
  const close = ({ restoreFocus = true } = {}) => {
    if (panel.hidden) return;
    panel.hidden = true;
    panel.style.removeProperty("z-index");
    const index = openPanels.indexOf(panel);
    if (index >= 0) openPanels.splice(index, 1);
    document.removeEventListener("keydown", keys, true);
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus();
    onClose();
  };
  const keys = (event) => {
    if (panel.hidden || openPanels.at(-1) !== panel || event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      const options = controls(),
        first = options[0],
        last = options.at(-1);
      if (!options.includes(document.activeElement)) {
        // A pending operation can disable the focused control. Its next Tab
        // must stay in the dialog rather than move into the background shell.
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };
  closeButton.addEventListener("click", close);
  panel.addEventListener("click", (event) => {
    if (event.target === panel) close();
  });
  return {
    open() {
      if (openPanels.includes(panel)) return;
      previousFocus = focusedControl();
      panel.hidden = false;
      openPanels.push(panel);
      panel.style.zIndex = String(1000 + openPanels.length);
      // Disabling a focused button can move focus to body, so the panel alone
      // cannot receive the next Tab or Escape. Listen while this dialog is open.
      document.addEventListener("keydown", keys, true);
      controls()[0]?.focus();
      // The backdrop fades in and the card rises a little as it grows to size.
      // Closing stays instant, so focus returns at once.
      if (!reducedMotion()) {
        panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
        panel.querySelector('[role="dialog"], .modal-card')?.animate(
          [
            { opacity: 0, transform: "translateY(6px) scale(0.97)" },
            { opacity: 1, transform: "none" }
          ],
          { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" }
        );
      }
    },
    close
  };
}
