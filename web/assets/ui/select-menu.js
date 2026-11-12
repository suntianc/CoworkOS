import { icon } from "./icons.js";

/**
 * Selects open the application's own option menu instead of the system popup,
 * so their list matches every other menu: the same popover surface, a check on
 * the current option, and the theme's colours.
 *
 * The <select> stays the control: forms read and write its value, assistive
 * technology announces it, and typing on the closed control still picks an
 * option. Only opening it is redirected, by a click or by ↓ ↑ Space Enter.
 * Choosing an option sets the value and fires `input` and `change` as the
 * system menu would. Multi-line selects (`multiple`, `size`) keep their own list.
 */

const OPEN_KEYS = new Set(["ArrowDown", "ArrowUp", " ", "Enter"]);
const GAP = 4;
const EDGE = 8;

const enhanced = (target) =>
  target instanceof HTMLSelectElement &&
  !target.multiple &&
  !(target.size > 1) &&
  !target.disabled &&
  target.closest("html[data-theme]") &&
  !target.closest("[data-native-select]");

const escapeText = (text) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export function installSelectMenus(doc = document) {
  const view = doc.defaultView;
  let current; // { select, panel }

  const options = () =>
    current ? [...current.panel.querySelectorAll('[role="option"]:not([aria-disabled="true"])')] : [];

  const close = (restoreFocus = false) => {
    if (!current) return;
    const { select, panel } = current;
    current = undefined;
    panel.remove();
    select.removeAttribute("aria-expanded");
    view.removeEventListener("keydown", keys, true);
    view.removeEventListener("resize", dismiss);
    doc.removeEventListener("scroll", scrolled, true);
    doc.removeEventListener("pointerdown", outside, true);
    if (restoreFocus && select.isConnected) select.focus({ preventScroll: true });
  };
  const dismiss = () => close();
  const scrolled = (event) => {
    if (current && !current.panel.contains(event.target)) close();
  };
  const outside = (event) => {
    if (current && !current.panel.contains(event.target) && event.target !== current.select) close();
  };

  const optionHtml = (option, index) => {
    const selected = option.selected;
    const disabled = option.disabled || option.closest("optgroup")?.disabled;
    return `<button type="button" class="select-menu-option" role="option" tabindex="-1" data-index="${index}" aria-selected="${selected}"${disabled ? ' aria-disabled="true"' : ""}><span class="select-menu-check" aria-hidden="true">${selected ? icon("check") : ""}</span><span class="select-menu-label">${escapeText(option.label || option.text)}</span></button>`;
  };

  const render = (select) => {
    const all = [...select.options];
    let html = "";
    for (const child of select.children) {
      if (child instanceof HTMLOptGroupElement) {
        html += `<div class="select-menu-group" role="presentation">${escapeText(child.label)}</div>`;
        for (const option of child.children)
          if (option instanceof HTMLOptionElement && !option.hidden)
            html += optionHtml(option, all.indexOf(option));
      } else if (child instanceof HTMLOptionElement && !child.hidden) {
        html += optionHtml(child, all.indexOf(child));
      }
    }
    return html;
  };

  const place = (select, panel) => {
    const box = select.getBoundingClientRect();
    const width = Math.min(Math.max(box.width, panel.scrollWidth), view.innerWidth - EDGE * 2);
    panel.style.minWidth = `${Math.round(box.width)}px`;
    const below = view.innerHeight - box.bottom - GAP - EDGE;
    const above = box.top - GAP - EDGE;
    const natural = panel.scrollHeight;
    const up = natural > below && above > below;
    const room = Math.max(120, up ? above : below);
    panel.style.maxHeight = `${Math.round(room)}px`;
    const height = Math.min(natural, room);
    const left = Math.min(Math.max(EDGE, box.left), view.innerWidth - EDGE - width);
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(up ? box.top - GAP - height : box.bottom + GAP)}px`;
  };

  const open = (select) => {
    if (current?.select === select) return;
    close();
    const panel = doc.createElement("div");
    panel.className = "ui-menu select-menu";
    panel.setAttribute("role", "listbox");
    const label = select.getAttribute("aria-label") || select.labels?.[0]?.textContent?.trim();
    if (label) panel.setAttribute("aria-label", label);
    panel.innerHTML = render(select);
    doc.body.append(panel);
    current = { select, panel };
    select.setAttribute("aria-expanded", "true");
    place(select, panel);
    const selected = panel.querySelector('[aria-selected="true"]') || options()[0];
    selected?.focus({ preventScroll: true });
    selected?.scrollIntoView({ block: "nearest" });
    panel.addEventListener("click", (event) => {
      const item = event.target.closest('[role="option"]');
      if (item && item.getAttribute("aria-disabled") !== "true") choose(item);
    });
    panel.addEventListener("pointermove", (event) => {
      const item = event.target.closest('[role="option"]:not([aria-disabled="true"])');
      if (item && doc.activeElement !== item) item.focus({ preventScroll: true });
    });
    view.addEventListener("keydown", keys, true);
    view.addEventListener("resize", dismiss);
    doc.addEventListener("scroll", scrolled, true);
    doc.addEventListener("pointerdown", outside, true);
  };

  const choose = (item) => {
    const { select } = current;
    const index = Number(item.dataset.index);
    close(true);
    if (select.selectedIndex === index) return;
    select.selectedIndex = index;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };

  let typed = "";
  let typedAt = 0;
  // Runs on the window in the capture phase so a dialog's own Escape and Tab
  // handling never sees keys meant for the open list.
  function keys(event) {
    if (!current || event.isComposing || event.metaKey || event.ctrlKey) return;
    const list = options();
    const index = list.indexOf(doc.activeElement);
    const move = (next) => {
      event.preventDefault();
      list[next]?.focus({ preventScroll: true });
      list[next]?.scrollIntoView({ block: "nearest" });
    };
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "ArrowDown") move(index < 0 ? 0 : Math.min(index + 1, list.length - 1));
    else if (event.key === "ArrowUp") move(index < 0 ? list.length - 1 : Math.max(index - 1, 0));
    else if (event.key === "Home" || event.key === "PageUp") move(0);
    else if (event.key === "End" || event.key === "PageDown") move(list.length - 1);
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      if (index >= 0) choose(list[index]);
    } else if (event.key.length === 1 && !event.altKey) {
      const now = Date.now();
      typed = now - typedAt > 700 ? event.key.toLowerCase() : typed + event.key.toLowerCase();
      typedAt = now;
      const start = typed.length === 1 ? index + 1 : Math.max(index, 0);
      const ordered = [...list.slice(start), ...list.slice(0, start)];
      const hit = ordered.find((item) => item.textContent.trim().toLowerCase().startsWith(typed));
      if (hit) move(list.indexOf(hit));
      else event.preventDefault();
    }
    event.stopPropagation();
  }

  doc.addEventListener(
    "mousedown",
    (event) => {
      const select = event.target;
      if (event.button !== 0 || !enhanced(select)) return;
      event.preventDefault();
      if (current?.select === select) {
        close(true);
        return;
      }
      select.focus({ preventScroll: true });
      open(select);
    },
    true
  );
  doc.addEventListener(
    "keydown",
    (event) => {
      const select = event.target;
      if (current || !enhanced(select)) return;
      if (OPEN_KEYS.has(event.key) || (event.altKey && event.key === "ArrowDown")) {
        event.preventDefault();
        open(select);
      }
    },
    true
  );

  return {
    close,
    get open() {
      return current?.select;
    }
  };
}
