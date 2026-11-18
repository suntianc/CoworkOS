import { formatRunDuration, runElapsed } from "../run-overview.js";
import { requestErrorMessage } from "../request-error.js";
import { runPhase } from "../run-phase.js";
import { ui } from "../ui/language.js";

/**
 * The status line above the composer.
 *
 * It names only the round's coarse state and how long it has run: Main 工作中,
 * Main 在等子助手 · N 个在工作, Main 在问你, 模型重连中, 已暂停. What exactly
 * is happening is the transcript's to say. It disappears when nothing runs.
 * With a question or queued messages it is the first row of the tray they
 * share on the composer's top edge.
 *
 * While Main works its one action is stop (Esc); while it waits for its
 * Subagents the composer stays a send box, so pause and stop sit here. Pause
 * asks the backend to stop at the next step boundary; the button stays
 * disabled until that boundary is recorded. A paused round offers 继续.
 * Stopping is confirmed in place, because it ends the current round.
 */
export function createRunControl({
  state,
  $,
  api,
  showToast,
  onChanged,
  interruptRun,
  continueRun,
  isContinuing
}) {
  const root = $("#run-control");
  const confirm = $("#run-interrupt-confirm");
  const pauseButton = root?.querySelector("[data-run-pause]");
  const stopButton = root?.querySelector("[data-run-stop]");
  const continueButton = root?.querySelector("[data-run-continue]");
  const label = root?.querySelector("[data-run-label]");
  const detail = root?.querySelector("[data-run-detail]");
  const time = root?.querySelector("[data-run-time]");
  let ticker;
  let busy = false;
  let confirmTrigger;

  const selectedTask = () =>
    state.detail?.task?.taskId === state.selected
      ? state.detail.task
      : state.tasks.find((task) => task.taskId === state.selected);
  /** The selected conversation's coarse state; Subagent progress is part of the catalog row. */
  const phase = () =>
    runPhase({
      task: selectedTask(),
      detail: state.detail,
      agents: state.tasks.find((task) => task.taskId === state.selected)?.activity?.agents || []
    });

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
    time.textContent = Number.isFinite(elapsed) ? `· ${formatRunDuration(elapsed)}` : "";
  }

  function closeConfirm({ restoreFocus = false } = {}) {
    if (!confirm || confirm.hidden) return;
    confirm.hidden = true;
    confirmTrigger?.setAttribute("aria-expanded", "false");
    if (restoreFocus && confirmTrigger?.isConnected && !confirmTrigger.hidden) confirmTrigger.focus();
  }
  /** The stop key opens the confirmation instead of interrupting straight away. */
  function confirmInterrupt(trigger) {
    if (!confirm) return;
    if (!confirm.hidden) return closeConfirm({ restoreFocus: true });
    confirmTrigger = trigger;
    confirmTrigger?.setAttribute("aria-expanded", "true");
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

  async function applyInterrupt() {
    const task = selectedTask();
    closeConfirm({ restoreFocus: true });
    if (!task || task.taskId !== state.selected) return;
    await interruptRun?.(task.taskId);
  }

  const LABELS = {
    working: () => ui("Main 工作中"),
    pausing: () => ui("正在暂停"),
    waiting: (current) =>
      current.agents ? ui`Main 在等子助手 · ${current.agents} 个在工作` : ui("Main 在等子助手"),
    asking: () => ui("Main 在问你"),
    retrying: () => ui("模型重连中"),
    // Main paused its Subagents before itself; the line says so by name.
    paused: (current) =>
      current.names?.length ? ui`已暂停 · ${current.names.join(ui("、"))} 也已暂停` : ui("已暂停")
  };

  function render() {
    if (!root) return;
    const task = selectedTask();
    const current = phase();
    if (!current) {
      root.hidden = true;
      delete root.dataset.state;
      root.removeAttribute("data-run-paused");
      closeConfirm();
      stopTicker();
      return;
    }
    const paused = current.kind === "paused";
    root.hidden = false;
    root.dataset.state = current.kind;
    root.toggleAttribute("data-run-paused", paused);
    const name = LABELS[current.kind](current);
    label.textContent = name;
    detail.hidden = true;
    root.setAttribute("aria-label", name);
    renderTime();
    if (paused) stopTicker();
    else startTicker();
    continueButton.hidden = !paused;
    if (paused) {
      pauseButton.hidden = true;
      stopButton.hidden = true;
      continueButton.disabled = Boolean(isContinuing?.(task.taskId));
      closeConfirm();
      return;
    }
    // Waiting for Subagents leaves the composer a send box, so stop is a
    // button here; while Main works the composer's own key stops it (Esc).
    const waiting = current.kind === "waiting";
    stopButton.hidden = current.kind === "asking";
    stopButton.classList.toggle("is-hint", !waiting);
    stopButton.querySelector("[data-run-stop-key]").hidden = waiting;
    pauseButton.hidden = current.kind === "asking";
    const pausing = current.kind === "pausing";
    pauseButton.disabled = busy || pausing;
    pauseButton.title = pausing ? ui("当前步骤结束后暂停") : ui("暂停，当前步骤结束后生效");
    pauseButton.setAttribute("aria-label", pausing ? ui("暂停中") : ui("暂停"));
  }

  pauseButton?.addEventListener("click", () => void pause());
  stopButton?.addEventListener("click", () => confirmInterrupt(stopButton));
  continueButton?.addEventListener("click", async () => {
    const task = selectedTask();
    if (!task) return;
    continueButton.disabled = true;
    await continueRun?.(task.taskId);
    render();
  });
  confirm
    ?.querySelector("[data-confirm-continue]")
    ?.addEventListener("click", () => closeConfirm({ restoreFocus: true }));
  confirm?.querySelector("[data-confirm-interrupt]")?.addEventListener("click", () => void applyInterrupt());
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (!confirm?.hidden) {
      event.preventDefault();
      closeConfirm({ restoreFocus: true });
      return;
    }
    // Esc stops a working Main from the composer or the page itself, never
    // from inside a menu, dialog or field that has its own Escape.
    const focus = document.activeElement;
    const fromComposer = !focus || focus === document.body || focus.id === "composer-input";
    const kind = phase()?.kind;
    if (!fromComposer || !root || root.hidden || !["working", "retrying", "waiting"].includes(kind)) return;
    if (
      document.querySelector(
        '[role="dialog"]:not([hidden]):not(#run-interrupt-confirm), [role="menu"]:not([hidden])'
      )
    )
      return;
    event.preventDefault();
    confirmInterrupt(stopButton);
  });
  document.addEventListener("pointerdown", (event) => {
    if (confirm?.hidden) return;
    if (confirm.contains(event.target) || confirmTrigger?.contains(event.target)) return;
    closeConfirm();
  });

  return {
    render,
    confirmInterrupt,
    /** Whether Main is waiting on its Subagents rather than working itself. */
    waiting: () => phase()?.kind === "waiting",
    reset() {
      stopTicker();
      closeConfirm();
    }
  };
}
