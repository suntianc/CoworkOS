import { formatRunDuration, runElapsed } from "../run-overview.js";
import { requestErrorMessage } from "../request-error.js";
import { ui } from "../ui/language.js";

/**
 * The running Main's own controls above the composer.
 *
 * Pause asks the backend to stop at the next step boundary; the button stays
 * disabled until that boundary is recorded, so a second click cannot look like
 * a new request. Cancel is confirmed in place, because the confirmation is a
 * choice about the current run, not a separate settings surface.
 */
export function createRunControl({ state, $, api, showToast, onChanged, cancelRun }) {
  const root = $("#run-control");
  const confirm = $("#run-cancel-confirm");
  const pauseButton = root?.querySelector("[data-run-pause]");
  const cancelButton = root?.querySelector("[data-run-cancel]");
  const label = root?.querySelector("[data-run-label]");
  const time = root?.querySelector("[data-run-time]");
  let ticker;
  let busy = false;
  let stage = "";

  const selectedTask = () =>
    state.detail?.task?.taskId === state.selected
      ? state.detail.task
      : state.tasks.find((task) => task.taskId === state.selected);

  const stopTicker = () => {
    if (ticker === undefined) return;
    clearInterval(ticker);
    ticker = undefined;
  };
  const startTicker = () => {
    if (ticker !== undefined) return;
    ticker = setInterval(renderTime, 1000);
  };
  function renderTime() {
    if (!root || root.hidden) return;
    const elapsed = runElapsed(state.detail?.statistics);
    time.textContent = Number.isFinite(elapsed) ? formatRunDuration(elapsed) : "";
  }

  function closeConfirm({ restoreFocus = false } = {}) {
    if (!confirm || confirm.hidden) return;
    confirm.hidden = true;
    if (restoreFocus) cancelButton?.focus();
  }
  function openConfirm() {
    if (!confirm || !cancelButton) return;
    confirm.hidden = false;
    confirm.querySelector("[data-confirm-continue]")?.focus();
  }

  async function pause() {
    const task = selectedTask();
    if (busy || !task || task.taskId !== state.selected || task.pause) return;
    busy = true;
    pauseButton.disabled = true;
    pauseButton.setAttribute("aria-busy", "true");
    try {
      await api(`/api/tasks/${encodeURIComponent(task.taskId)}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pause" })
      });
      await onChanged?.(task.taskId);
    } catch (error) {
      showToast(requestErrorMessage(error));
    } finally {
      busy = false;
      pauseButton.removeAttribute("aria-busy");
      render();
    }
  }

  async function confirmCancel() {
    const task = selectedTask();
    closeConfirm({ restoreFocus: true });
    if (!task || task.taskId !== state.selected) return;
    await cancelRun?.(task.taskId);
  }

  function renderStage() {
    if (root?.hidden) return;
    const name = ui("Main 正在工作");
    label.textContent = stage ? `${name} · ${ui(stage)}` : name;
  }

  function render() {
    if (!root) return;
    const task = selectedTask();
    const active =
      Boolean(task) &&
      task.taskId === state.selected &&
      task.status === "running" &&
      Boolean(state.detail?.runtime?.active);
    if (!active) {
      root.hidden = true;
      closeConfirm();
      stopTicker();
      return;
    }
    root.hidden = false;
    root.dataset.state = task.pause ? "pausing" : "running";
    renderStage();
    renderTime();
    startTicker();
    const pausing = Boolean(task.pause);
    pauseButton.disabled = busy || pausing;
    pauseButton.title = pausing ? ui("当前步骤结束后暂停") : ui("暂停");
    pauseButton.setAttribute("aria-label", pausing ? ui("暂停中") : ui("暂停"));
    cancelButton.disabled = busy;
  }

  pauseButton?.addEventListener("click", () => void pause());
  cancelButton?.addEventListener("click", () => {
    if (confirm?.hidden) openConfirm();
    else closeConfirm();
  });
  confirm
    ?.querySelector("[data-confirm-continue]")
    ?.addEventListener("click", () => closeConfirm({ restoreFocus: true }));
  confirm?.querySelector("[data-confirm-cancel]")?.addEventListener("click", () => void confirmCancel());
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || confirm?.hidden) return;
    event.preventDefault();
    closeConfirm({ restoreFocus: true });
  });
  document.addEventListener("pointerdown", (event) => {
    if (confirm?.hidden) return;
    if (confirm.contains(event.target) || cancelButton?.contains(event.target)) return;
    closeConfirm();
  });

  return {
    render,
    /** The requirement panel publishes its phase after its own read settles. */
    setRequirementStage(value) {
      stage = value || "";
      renderStage();
    },
    reset() {
      stopTicker();
      closeConfirm();
      stage = "";
    }
  };
}
