/**
 * Back and forward through the conversations opened in this window.
 *
 * Every conversation that becomes the selected one is a visit. Going back or
 * forward reopens an earlier visit without recording a new one; opening a
 * conversation after going back drops the forward entries, as a browser does.
 * Conversations that no longer exist are skipped and forgotten.
 */
export function createConversationHistory({ back, forward, exists, open, limit = 50 }) {
  let entries = [],
    index = -1;

  const prune = () => {
    const current = entries[index];
    entries = entries.filter((taskId, position) => position === index || exists(taskId));
    index = entries.indexOf(current);
  };
  const target = (step) => {
    for (let next = index + step; next >= 0 && next < entries.length; next += step)
      if (exists(entries[next])) return next;
    return -1;
  };

  function paint() {
    if (back) back.disabled = target(-1) < 0;
    if (forward) forward.disabled = target(1) < 0;
  }

  /** Records the selected conversation; repeated or empty selections change nothing. */
  function visit(taskId) {
    if (!taskId || entries[index] === taskId) return paint();
    entries = [...entries.slice(0, index + 1), taskId].slice(-limit);
    index = entries.length - 1;
    paint();
  }

  function go(step) {
    const next = target(step);
    if (next < 0) return false;
    index = next;
    prune();
    paint();
    open(entries[index]);
    return true;
  }

  const onKey = (event) => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey) return;
    if (!(event.metaKey || event.ctrlKey) || !["[", "]"].includes(event.key)) return;
    if (event.target.closest?.("input, textarea, select, [contenteditable='true'], .modal-backdrop")) return;
    if (go(event.key === "[" ? -1 : 1)) event.preventDefault();
  };

  back?.addEventListener("click", () => go(-1));
  forward?.addEventListener("click", () => go(1));
  document.addEventListener("keydown", onKey);
  paint();

  return {
    visit,
    back: () => go(-1),
    forward: () => go(1),
    refresh: paint,
    get entries() {
      return [...entries];
    },
    get index() {
      return index;
    }
  };
}
