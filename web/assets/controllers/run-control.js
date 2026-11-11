import { formatRunDuration, runElapsed } from "../run-overview.js";
import { requestErrorMessage } from "../request-error.js";
import { ui } from "../ui/language.js";

const ACTIVE_AGENT_STATES = new Set(["running", "waiting", "queued"]);

/**
 * The run strip on the composer's top edge.
 *
 * It says what Main is doing, or which Subagents it waits for, how many steps
 * this round has taken and for how long, all from the progress the catalog and
 * the conversation already carry. It disappears when nothing runs. Pause asks
 * the backend to stop at the next step boundary; the button stays disabled
 * until that boundary is recorded, so a second click cannot look like a new
 * request. A paused round keeps the strip, amber, with 继续 as its one action.
 *
 * Stopping lives on the composer's stop key; it is confirmed in place, because
 * the confirmation is a choice about the current run.
 */
export function createRunControl({
  state,
  $,
  api,
  showToast,
  onChanged,
  cancelRun,
  continueRun,
  isContinuing
}) {
  const root = $("#run-control");
  const confirm = $("#run-cancel-confirm");
  const pauseButton = root?.querySelector("[data-run-pause]");
  const continueButton = root?.querySelector("[data-run-continue]");
  const label = root?.querySelector("[data-run-label]");
  const detail = root?.querySelector("[data-run-detail]");
  const step = root?.querySelector("[data-run-step]");
  const time = root?.querySelector("[data-run-time]");
  let ticker;
  let busy = false;
  let stage = "";
  let confirmTrigger;

  const selectedTask = () =>
    state.detail?.task?.taskId === state.selected
      ? state.detail.task
      : state.tasks.find((task) => task.taskId === state.selected);
  // Subagent progress is part of the catalog row; the detail read omits it.
  const waitingFor = () =>
    (state.tasks.find((task) => task.taskId === state.selected)?.activity?.agents || []).filter(
      (agent) => agent.role === "subagent" && ACTIVE_AGENT_STATES.has(agent.state)
    );
  /** Model calls this round has finished: assistant turns since the user's last own message. */
  const finishedSteps = () => {
    const messages = state.detail?.task?.taskId === state.selected ? state.detail.messages || [] : [];
    let steps = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "user" && !message.interjected && message.delivery !== "steer") break;
      // A step the pause or a failure cut short is not a finished step.
      if (message.role === "assistant" && !["aborted", "error"].includes(message.stopReason)) steps += 1;
    }
    return steps;
  };

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
    confirmTrigger?.setAttribute("aria-expanded", "false");
    if (restoreFocus && confirmTrigger?.isConnected && !confirmTrigger.hidden) confirmTrigger.focus();
  }
  /** The stop key opens the confirmation instead of stopping straight away. */
  function confirmStop(trigger) {
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

  async function confirmCancel() {
    const task = selectedTask();
    closeConfirm({ restoreFocus: true });
    if (!task || task.taskId !== state.selected) return;
    await cancelRun?.(task.taskId);
  }

  function renderLabel() {
    if (!root || root.hidden) return;
    let name, text;
    if (root.dataset.state === "paused") {
      const steps = finishedSteps();
      name = ui("已暂停");
      text = steps ? ui`停在第 ${steps} 步之后` : "";
    } else {
      const agents = waitingFor();
      name = agents.length ? ui("等待子代理") : ui("Main 正在工作");
      text = agents.length
        ? agents.map((agent) => agent.name || agent.agentId).join(ui("、"))
        : stage
          ? ui(stage)
          : "";
    }
    label.textContent = name;
    detail.textContent = text;
    detail.hidden = !text;
    root.setAttribute("aria-label", text ? `${name} · ${text}` : name);
  }

  function render() {
    if (!root) return;
    const task = selectedTask();
    const current = Boolean(task) && task.taskId === state.selected;
    const running = current && task.status === "running" && Boolean(state.detail?.runtime?.active);
    const paused = current && task.status === "paused" && !state.detail?.runtime?.active;
    if (!running && !paused) {
      root.hidden = true;
      delete root.dataset.state;
      root.removeAttribute("data-run-paused");
      closeConfirm();
      stopTicker();
      return;
    }
    root.hidden = false;
    root.dataset.state = paused ? "paused" : task.pause ? "pausing" : "running";
    root.toggleAttribute("data-run-paused", paused);
    renderLabel();
    renderTime();
    if (paused) stopTicker();
    else startTicker();
    const steps = finishedSteps() + (paused ? 0 : 1);
    step.hidden = paused || steps < 1;
    step.textContent = ui`第 ${steps} 步`;
    pauseButton.hidden = paused;
    continueButton.hidden = !paused;
    if (paused) {
      continueButton.disabled = Boolean(isContinuing?.(task.taskId));
      closeConfirm();
      return;
    }
    const pausing = Boolean(task.pause);
    pauseButton.disabled = busy || pausing;
    pauseButton.title = pausing ? ui("当前步骤结束后暂停") : ui("暂停");
    pauseButton.setAttribute("aria-label", pausing ? ui("暂停中") : ui("暂停"));
  }

  pauseButton?.addEventListener("click", () => void pause());
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
  confirm?.querySelector("[data-confirm-cancel]")?.addEventListener("click", () => void confirmCancel());
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || confirm?.hidden) return;
    event.preventDefault();
    closeConfirm({ restoreFocus: true });
  });
  document.addEventListener("pointerdown", (event) => {
    if (confirm?.hidden) return;
    if (confirm.contains(event.target) || confirmTrigger?.contains(event.target)) return;
    closeConfirm();
  });

  return {
    render,
    confirmStop,
    /** The requirement panel publishes its phase after its own read settles. */
    setRequirementStage(value) {
      stage = value || "";
      renderLabel();
    },
    /** The same phase labels the title-bar control that opens the panel. */
    get stage() {
      return stage;
    },
    reset() {
      stopTicker();
      closeConfirm();
      stage = "";
    }
  };
}
