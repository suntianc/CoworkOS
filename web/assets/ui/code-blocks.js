import { ui } from "./language.js";

/** Writes text to the clipboard; false when the browser refuses. */
export async function copyText(text) {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
    // eslint-disable-next-line no-restricted-syntax -- the browser refuses clipboard writes outside a secure context or without permission; the caller reports that copy is unavailable
  } catch {
    return false;
  }
}

/** A copy button says 已复制 for a moment, then returns to its label. */
export function confirmCopied(button, label) {
  const target = label || button;
  const previous = button.dataset.copyLabel ?? target.textContent;
  button.dataset.copyLabel = previous;
  button.classList.add("is-copied");
  if (label) target.textContent = ui("已复制");
  clearTimeout(Number(button.dataset.copyTimer));
  button.dataset.copyTimer = String(
    setTimeout(() => {
      button.classList.remove("is-copied");
      if (label) target.textContent = previous;
      delete button.dataset.copyLabel;
      delete button.dataset.copyTimer;
    }, 1500)
  );
}

/**
 * Behaviour for the code blocks rendered Markdown carries: copy its source and
 * switch long lines between scrolling and wrapping. One listener serves every
 * block, wherever Markdown was rendered.
 */
export function installCodeBlockActions(root, { showToast }) {
  root.addEventListener("click", async (event) => {
    const button = event.target.closest?.("[data-code-copy], [data-code-wrap]");
    const block = button?.closest(".code-block");
    if (!block) return;
    if (button.hasAttribute("data-code-wrap")) {
      const wrapped = block.classList.toggle("is-wrapped");
      button.setAttribute("aria-pressed", String(wrapped));
      return;
    }
    if (await copyText(block.querySelector("code")?.textContent ?? ""))
      confirmCopied(button, button.querySelector("[data-code-copy-label]"));
    else showToast(ui("当前环境不支持复制"));
  });
}
