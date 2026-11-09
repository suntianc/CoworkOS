/**
 * The two product entries and what each one remembers.
 *
 * Work and observation keep independent selections: work keeps the conversation
 * the page is already showing, observation keeps its last view. The entry itself
 * is restored after a reload so a person returns where they left off.
 */
export const ENTRY_MODES = ["work", "observe"];
export const OBSERVE_VIEWS = ["overview", "requirements", "runs"];
export const ENTRY_STORAGE_KEY = "atria.entry.v1";

const OBSERVE_TITLES = { overview: "总览", requirements: "需求", runs: "运行" };

function restore(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(ENTRY_STORAGE_KEY) || "null");
    return {
      mode: ENTRY_MODES.includes(parsed?.mode) ? parsed.mode : "work",
      observeView: OBSERVE_VIEWS.includes(parsed?.observeView) ? parsed.observeView : "overview"
    };
    // eslint-disable-next-line no-restricted-syntax -- a blocked or corrupt preference must not stop the shell from mounting; the default entry is a working one
  } catch {
    return { mode: "work", observeView: "overview" };
  }
}

export function createEntryController({ root, storage, onChange } = {}) {
  let state = restore(storage);
  const persist = () => {
    try {
      storage?.setItem(ENTRY_STORAGE_KEY, JSON.stringify(state));
      // eslint-disable-next-line no-restricted-syntax -- saving the entry is optional; a full or blocked store must not undo the switch the person just made
    } catch {
      /* The switch stays in memory. */
    }
  };
  const paint = () => {
    if (!root) return;
    root.dataset.entry = state.mode;
    for (const panel of root.querySelectorAll("[data-entry-panel]"))
      panel.hidden = panel.dataset.entryPanel !== state.mode;
    for (const button of root.querySelectorAll("[data-entry-mode]")) {
      const selected = button.dataset.entryMode === state.mode;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    root.dataset.observeViewName = state.observeView;
    for (const panel of root.querySelectorAll("[data-observe-panel]"))
      panel.hidden = panel.dataset.observePanel !== state.observeView;
    for (const button of root.querySelectorAll("[data-observe-view]")) {
      const selected = button.dataset.observeView === state.observeView;
      if (selected) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    const title = root.querySelector("#observe-title");
    if (title) title.textContent = OBSERVE_TITLES[state.observeView];
  };
  const commit = (next) => {
    if (next.mode === state.mode && next.observeView === state.observeView) return;
    state = next;
    paint();
    persist();
    onChange?.(state);
  };
  paint();
  return {
    /** @returns {{mode: "work" | "observe", observeView: "overview" | "requirements" | "runs"}} */
    state: () => ({ ...state }),
    setMode: (mode) => {
      if (!ENTRY_MODES.includes(mode)) return;
      commit({ ...state, mode });
    },
    setObserveView: (view) => {
      if (!OBSERVE_VIEWS.includes(view)) return;
      commit({ ...state, observeView: view });
    }
  };
}
