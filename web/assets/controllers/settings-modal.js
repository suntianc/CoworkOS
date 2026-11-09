import { createModal } from "../ui/modal.js";

/** Settings pages share back navigation while closing still exits the whole surface. */
export function createSettingsModal(panel, closeButton, { host, returnFocus, onClose } = {}) {
  const dialog = createModal(panel, closeButton, { onClose });
  const back = () => {
    dialog.close();
    host.open();
    returnFocus?.();
  };
  panel.querySelector("[data-settings-back]").addEventListener("click", back);
  return {
    open() {
      if (host.close() === false) return false;
      dialog.open();
      return true;
    },
    close: dialog.close,
    back
  };
}
