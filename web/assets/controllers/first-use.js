import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../workbench/html.js";

/**
 * The work entry before it can be used: no model connection, no project, or
 * both.
 *
 * Every step is derived from the model status and the project catalog on each
 * render, so no "guide completed" flag is stored. Losing the connection or
 * removing the last project brings the surface back by itself.
 *
 * The third step is the destination rather than an action of this surface: once
 * a connection and a project exist the guide is gone and the new-session start
 * takes over, so its button stays inactive here and only names the next move.
 */
export function createFirstUseView({
  state,
  $,
  projectCount = () => 0,
  onConnectModel = () => {},
  onAddProject = () => {}
}) {
  const STEPS = [
    { key: "model", label: () => ui("连接模型"), action: () => ui("前往设置") },
    { key: "project", label: () => ui("添加项目"), action: () => ui("添加项目") },
    { key: "session", label: () => ui("开始新会话"), action: () => ui("新会话") }
  ];
  let rendered = "";
  let locked = false;
  let previousPlaceholder = "";
  const modelReady = () => state.modelConfigured !== false;
  const projectsReady = () => projectCount() > 0;
  const active = () => !modelReady() || !projectsReady();
  /**
   * What the composer is waiting for. Only a missing connection blocks a send:
   * a message without a project still starts a temporary session.
   */
  const lockReason = () =>
    projectsReady() ? ui("连接模型后即可开始…") : ui("连接模型并添加项目后即可开始…");
  const stateOf = (index) => {
    const ready = [modelReady(), projectsReady()];
    if (ready[index]) return "done";
    return ready.indexOf(false) === index ? "current" : "pending";
  };
  function rowOf(step, index) {
    const status = stateOf(index),
      done = status === "done",
      current = status === "current";
    const badge = done
      ? `<span class="first-use-num is-done" role="img" aria-label="${esc(ui("已完成"))}">${icon("check")}</span>`
      : `<span class="first-use-num" aria-hidden="true">${index + 1}</span>`;
    const action = done
      ? ""
      : `<button class="first-use-action ${current ? "is-primary" : "is-secondary"}" type="button" data-first-use="${step.key}"${
          step.key === "session" ? " disabled" : ""
        }>${esc(step.action())}</button>`;
    return `<div class="first-use-step" data-step="${step.key}" data-state="${status}"${
      current ? ' aria-current="step"' : ""
    }>${badge}<span class="first-use-label">${esc(step.label())}</span>${action}</div>`;
  }
  function markup() {
    return `<div class="first-use"><div class="first-use-hero"><h2 class="first-use-title">${esc(
      ui("欢迎使用 Formicand")
    )}</h2></div><div class="first-use-steps">${STEPS.map(rowOf).join("")}</div></div>`;
  }
  function render() {
    if (!active()) return;
    const conversation = $("#conversation");
    const next = markup();
    // A catalog refresh can replace the container without changing this
    // surface, so the cached string alone does not prove it is still mounted.
    if (next === rendered && conversation.querySelector(".first-use")) return;
    rendered = next;
    conversation.innerHTML = next;
    conversation.querySelectorAll("[data-first-use]:not([disabled])").forEach((node) =>
      node.addEventListener("click", () => {
        if (node.dataset.firstUse === "model") onConnectModel();
        else onAddProject();
      })
    );
  }
  function sync() {
    const input = $("#composer-input");
    if (blocksSending()) {
      if (!locked) {
        previousPlaceholder = input.placeholder;
        locked = true;
      }
      input.placeholder = lockReason();
      return;
    }
    if (!locked) return;
    locked = false;
    input.placeholder = previousPlaceholder;
  }
  /**
   * The guide owns the composer only before a conversation exists, and only a
   * missing connection stops it: work without a project is a temporary session.
   */
  const blocksSending = () => !modelReady() && !state.selected;
  return {
    active,
    render,
    sync,
    lockReason,
    blocksSending
  };
}
