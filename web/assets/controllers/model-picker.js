import { escapeHtml as esc } from "../workbench/html.js";
import { icon } from "../ui/icons.js";
import { language, ui } from "../ui/language.js";

/**
 * The composer's model and reasoning control (#27). One button opens a
 * popover whose first page sets the reasoning effort on a rail of the
 * levels this model accepts, and whose second page picks the model. Choices
 * apply at once and the popover stays open; Esc or a click outside closes it.
 */

/** Pi's levels, low to high: the order the rail runs in. */
export const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Offered when nothing says which levels a model accepts. */
export const DEFAULT_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"];

export const LEVEL_LABELS = {
  // As a level 关闭 reads Off, not the Close of a window.
  off: language === "en" ? "Off" : "关闭",
  minimal: ui("最少"),
  low: ui("低"),
  medium: ui("中"),
  high: ui("高"),
  xhigh: ui("极高"),
  max: ui("最大")
};

/** The accepted level nearest to `level`; a tie goes to the lower, cheaper one. */
export function nearestLevel(level, levels) {
  if (!level || levels.includes(level) || !levels.length) return level;
  const at = LEVEL_ORDER.indexOf(level);
  return levels.reduce((best, next) =>
    Math.abs(LEVEL_ORDER.indexOf(next) - at) < Math.abs(LEVEL_ORDER.indexOf(best) - at) ? next : best
  );
}

/**
 * `view()` returns what to draw: { model, defaultModel, models, levels,
 * chosen (a level or null for the connection's default), fallback (the level
 * used when nothing is chosen), notice }.
 */
export function createModelPicker({ panel, view, chooseModel, chooseLevel }) {
  let page = "effort";

  const effortPage = () => {
    const { model, levels, chosen, fallback, notice } = view();
    const level = chosen || fallback;
    const at = Math.max(0, levels.indexOf(level));
    const label = LEVEL_LABELS[level] || level || ui("自动");
    const foot =
      notice ||
      (chosen
        ? ui("只影响这个会话。")
        : fallback
          ? ui`默认跟随 Main 连接的设置（${LEVEL_LABELS[fallback] || fallback}），只影响这个会话。`
          : ui("默认跟随 Main 连接的设置，只影响这个会话。"));
    return `<div class="effort-head">
        <span class="effort-level">${esc(label)}${chosen ? "" : `<small>${esc(ui("默认"))}</small>`}</span>
        <button type="button" class="effort-reset" data-effort-reset${chosen ? "" : " hidden"}>${icon("rotate-ccw")}<span>${esc(ui("恢复默认"))}</span></button>
        <button type="button" class="effort-model" data-picker-page="models" aria-label="${esc(ui`选择模型，当前 ${model}`)}"><span>${esc(model)}</span>${icon("chevron-right")}</button>
      </div>
      <div class="effort-rail" role="slider" tabindex="0" aria-label="${esc(ui("推理强度"))}" aria-valuemin="0" aria-valuemax="${levels.length - 1}" aria-valuenow="${at}" aria-valuetext="${esc(label)}" style="--steps: ${levels.length}; --at: ${at}">
        <span class="effort-fill" aria-hidden="true"></span>
        ${levels.map((_, index) => `<span class="effort-notch${index < at ? " is-passed" : ""}" style="--i: ${index}" aria-hidden="true"></span>`).join("")}
        <span class="effort-knob" aria-hidden="true"></span>
      </div>
      <div class="effort-labels" style="--steps: ${levels.length}">
        ${levels.map((value, index) => `<button type="button" data-thinking-level="${esc(value)}" style="--i: ${index}" aria-pressed="${value === level}" tabindex="-1">${esc(LEVEL_LABELS[value] || value)}</button>`).join("")}
      </div>
      <p class="effort-foot" role="status">${esc(foot)}</p>`;
  };

  const modelsPage = () => {
    const { model, defaultModel, models } = view();
    return `<div class="picker-head">
        <button type="button" class="picker-back" data-picker-page="effort" aria-label="${esc(ui("返回推理强度"))}">${icon("chevron-left")}</button>
        <span class="picker-title">${esc(ui("选择模型"))}</span>
      </div>
      <div class="picker-models" role="listbox" aria-label="${esc(ui("选择模型"))}">
        ${models
          .map(
            (id) =>
              `<button type="button" class="model-option${id === model ? " active" : ""}" data-model="${esc(id)}" role="option" aria-selected="${id === model}"><span class="model-option-name">${esc(id)}</span>${id === defaultModel ? `<small>${esc(ui("默认"))}</small>` : ""}<span class="model-option-check">${id === model ? icon("check") : ""}</span></button>`
          )
          .join("")}
      </div>`;
  };

  function render({ focus = false } = {}) {
    panel.dataset.page = page;
    panel.innerHTML = page === "effort" ? effortPage() : modelsPage();
    if (!focus) return;
    const target =
      page === "effort"
        ? panel.querySelector(".effort-rail")
        : panel.querySelector(".model-option.active") || panel.querySelector(".model-option");
    target?.focus();
  }

  const levels = () => view().levels;
  const indexAt = (rail, clientX) => {
    const box = rail.getBoundingClientRect();
    const knob = box.height;
    const share = (clientX - box.left - knob / 2) / Math.max(1, box.width - knob);
    return Math.round(Math.min(1, Math.max(0, share)) * (levels().length - 1));
  };
  // While dragging only the rail moves; the choice is made when the pointer lets go.
  const preview = (rail, index) => {
    rail.style.setProperty("--at", String(index));
    rail
      .querySelectorAll(".effort-notch")
      .forEach((notch, at) => notch.classList.toggle("is-passed", at < index));
  };
  const commit = (index) => {
    const level = levels()[index];
    if (level) chooseLevel(level);
  };

  panel.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target || !panel.contains(target)) return;
    if (target.dataset.pickerPage) {
      page = target.dataset.pickerPage;
      render({ focus: true });
    } else if (target.dataset.model) {
      chooseModel(target.dataset.model);
      page = "effort";
      render({ focus: true });
    } else if (target.dataset.thinkingLevel) chooseLevel(target.dataset.thinkingLevel);
    else if (target.hasAttribute("data-effort-reset")) chooseLevel(null);
  });

  panel.addEventListener("pointerdown", (event) => {
    const rail = event.target.closest(".effort-rail");
    if (!rail || event.button !== 0) return;
    event.preventDefault();
    rail.focus();
    rail.setPointerCapture(event.pointerId);
    rail.classList.add("is-dragging");
    let index = indexAt(rail, event.clientX);
    preview(rail, index);
    const move = (next) => {
      index = indexAt(rail, next.clientX);
      preview(rail, index);
    };
    const done = () => {
      rail.removeEventListener("pointermove", move);
      rail.classList.remove("is-dragging");
      commit(index);
    };
    rail.addEventListener("pointermove", move);
    rail.addEventListener("lostpointercapture", done, { once: true });
  });

  panel.addEventListener("keydown", (event) => {
    if (
      event.key === "ArrowLeft" &&
      panel.dataset.page === "models" &&
      !event.target.closest(".effort-rail")
    ) {
      event.preventDefault();
      page = "effort";
      render({ focus: true });
      return;
    }
    const rail = event.target.closest(".effort-rail");
    if (!rail) return;
    const count = levels().length;
    const at = Number(rail.getAttribute("aria-valuenow"));
    const next = {
      ArrowLeft: at - 1,
      ArrowDown: at - 1,
      ArrowRight: at + 1,
      ArrowUp: at + 1,
      Home: 0,
      End: count - 1
    }[event.key];
    if (next === undefined) return;
    // The menu's own keys (on this same panel, added after this one) move between
    // items; on the rail they move the level, so the menu never sees them.
    event.preventDefault();
    event.stopImmediatePropagation();
    commit(Math.min(count - 1, Math.max(0, next)));
  });

  return {
    render,
    open(start = "effort") {
      page = start;
      render({ focus: true });
    },
    get page() {
      return page;
    }
  };
}
