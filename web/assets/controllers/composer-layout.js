/**
 * Recover a detached native textarea layout without replacing its DOM node.
 * Electron has been observed reporting display:block and a visible composer,
 * but no client rects for the textarea after a conversation switch. Changing
 * field-sizing alone did not repair that state; rebuilding its layout did.
 */
export function recoverComposerLayout(input) {
  const parent = input.parentElement;
  if (!input.isConnected || input.hidden || !parent || input.getClientRects().length) return false;
  const bounds = parent.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return false;
  const style = getComputedStyle(input);
  const parentStyle = getComputedStyle(parent);
  if (
    style.display === "none" ||
    style.display === "contents" ||
    style.visibility !== "visible" ||
    parentStyle.contentVisibility === "hidden"
  )
    return false;

  const focused = input.ownerDocument.activeElement === input;
  const selection = [input.selectionStart, input.selectionEnd, input.selectionDirection];
  const scrollTop = input.scrollTop;
  const display = input.style.getPropertyValue("display");
  const priority = input.style.getPropertyPriority("display");
  const hadStyle = input.hasAttribute("style");
  input.style.setProperty("display", "none", "important");
  // Commit the hidden layout before restoring the original display declaration.
  void input.offsetHeight;
  if (display) input.style.setProperty("display", display, priority);
  else input.style.removeProperty("display");
  if (!hadStyle && !input.style.cssText) input.removeAttribute("style");
  if (focused) input.focus({ preventScroll: true });
  input.setSelectionRange(...selection);
  input.scrollTop = scrollTop;
  return true;
}

/** Observe layout transitions, including a hidden conversation becoming visible. */
export function createComposerLayout(input) {
  let frame;
  const schedule = () => {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      recoverComposerLayout(input);
    });
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(input);
  observer.observe(input.parentElement);
  window.addEventListener("focus", schedule);
  return () => {
    observer.disconnect();
    window.removeEventListener("focus", schedule);
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
}
