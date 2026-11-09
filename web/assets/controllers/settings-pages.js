import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../workbench/html.js";
import { formatStamp } from "../ui/time-format.js";

/**
 * The settings surface: one page with a left navigation, replacing the old
 * overview dialog.
 *
 * The page owns navigation and the node-shaped sections (connections, capacity,
 * members). Feature controllers render their own rows into a section container
 * and register a refresh hook, so model, tool and update settings keep their
 * existing save semantics and identity checks.
 */
export const SETTINGS_SECTIONS = ["general", "nodes", "models", "capacity", "members", "tools"];

const CAPACITY_LIMIT = 32;
const ROLE_LABEL = { internal: "对内", external: "对外" };

export function createSettingsPages({
  root,
  app,
  api,
  nodes = () => [],
  members = () => [],
  mcp = () => [],
  addNode,
  addMember,
  addMcp,
  showToast = () => {}
} = {}) {
  let section = "general";
  let opened = false;
  let previousFocus;
  const handlers = new Map();
  const capacity = new Map();
  const trigger = document.querySelector("#user-menu-button");

  const $ = (selector) => root.querySelector(selector);
  const sectionButtons = () => [...root.querySelectorAll("[data-settings-section]")];
  const panels = () => [...root.querySelectorAll("[data-settings-panel]")];

  const localNode = () => ({
    origin: location.origin,
    name: ui("本机"),
    role: "internal",
    address: location.host,
    local: true
  });
  const remoteNodes = () => (Array.isArray(nodes()) ? nodes() : []).filter((node) => node && !node.local);
  const capacityNodes = () => remoteNodes().filter((node) => node.role === "external");

  /* ---------------------------------------------------------------- nodes */

  function nodeRow(node) {
    const online = node.local || node.state !== "offline";
    const state = online
      ? ui("在线")
      : `${ui("离线")}${node.lastSeen ? ` · ${formatStamp(node.lastSeen)}` : ""}`;
    return `<div class="settings-row" data-node="${esc(node.origin)}">
      <span class="settings-icon-box">${icon(node.local ? "laptop" : "server")}</span>
      <span class="settings-row-text">
        <span class="settings-row-line"><span class="settings-row-name">${esc(node.name)}</span><span class="settings-role">${ui(ROLE_LABEL[node.role] ?? ROLE_LABEL.internal)}</span></span>
        <span class="settings-row-meta is-mono">${esc(node.address || node.origin)}</span>
      </span>
      <span class="settings-row-spacer"></span>
      <span class="settings-dot ${online ? "is-ok" : "is-muted"}" aria-hidden="true"></span>
      <span class="settings-row-state">${esc(state)}</span>
      <span class="settings-info" title="${esc(node.local ? "只在这台机器上运行，不对外提供 Main" : "通过授权连接的另一台节点")}">${icon("info")}</span>
    </div>`;
  }

  function renderNodes() {
    // The local node never changes, and the host-provided backend row lives in
    // the same box: render the row once so a section switch keeps both.
    const local = $("#settings-node-local");
    if (!local.childElementCount) local.innerHTML = nodeRow(localNode());
    const remote = remoteNodes();
    $("#settings-node-remote-group").hidden = !remote.length;
    $("#settings-node-remote").innerHTML = remote.map(nodeRow).join("");
    $("#settings-node-add").hidden = !addNode;
    if (!$("#settings-node-data").childElementCount)
      $("#settings-node-data").innerHTML = `<div class="settings-row">
        <span class="settings-icon-box">${icon("database")}</span>
        <span class="settings-row-text">
          <span class="settings-row-name">${ui("共享台账与看板")}</span>
          <span class="settings-row-meta">${ui("SQLite · 由本机提供")}</span>
        </span>
        <span class="settings-row-spacer"></span>
        <span class="settings-info" title="项目数据保存在本机，连接的节点读取同一份共享记录">${icon("info")}</span>
      </div>`;
  }

  /* ---------------------------------------------------------------- members */

  function renderMembers() {
    const list = Array.isArray(members()) ? members() : [];
    $("#settings-member-rows").innerHTML = list
      .map(
        (member) => `<div class="settings-row" data-member="${esc(member.id)}">
        <span class="settings-avatar">${esc(String(member.name || "?").slice(0, 1))}</span>
        <span class="settings-row-name">${esc(member.name)}</span>
        ${member.owner ? `<span class="settings-chip is-accent">${ui("负责人")}</span>` : ""}
        <span class="settings-row-spacer"></span>
        ${
          member.channel
            ? `<span class="settings-chip">${esc(member.channel)}</span>`
            : `<span class="settings-warn">${icon("triangle-alert")}<span>${ui("未设置通道")}</span></span>`
        }
      </div>`
      )
      .join("");
  }

  /* ---------------------------------------------------------------- tools */

  function renderMcp() {
    const list = Array.isArray(mcp()) ? mcp() : [];
    $("#settings-mcp-group").hidden = !list.length;
    $("#settings-mcp-add").hidden = !addMcp;
    $("#settings-mcp-rows").innerHTML = list
      .map(
        (server) => `<div class="settings-row" data-mcp="${esc(server.name)}">
        <span class="settings-icon-box">${icon("plug")}</span>
        <span class="settings-row-text">
          <span class="settings-row-name">${esc(server.name)}</span>
          ${server.detail ? `<span class="settings-row-meta">${esc(server.detail)}</span>` : ""}
        </span>
        <span class="settings-row-spacer"></span>
        <span class="settings-row-state ${server.failed ? "is-warn" : "is-ok"}">${esc(server.state)}</span>
      </div>`
      )
      .join("");
  }

  /* ---------------------------------------------------------------- capacity */

  function usedSlots(view, kind) {
    const running = (view?.running ?? []).filter((entry) => entry.kind === kind).length;
    const queued = (view?.queued ?? []).filter((entry) => entry.kind === kind).length;
    return running + queued;
  }

  function capacityBar(limit, used, tone) {
    const slots = Math.min(Math.max(limit, 1), 8);
    const filled = Math.min(used, slots);
    return Array.from(
      { length: slots },
      (_, index) => `<span class="settings-capacity-seg${index < filled ? ` ${tone}` : ""}"></span>`
    ).join("");
  }

  function capacityValue(origin, kind) {
    return root.querySelector(`[data-capacity-node="${CSS.escape(origin)}"] [data-capacity-value="${kind}"]`);
  }

  function capacityRow(origin, kind, quota, used) {
    const resident = kind === "regular";
    const label = resident ? ui("常驻 Main") : ui("接续 Main");
    const hint = resident ? "同时运行的常驻 Main 数量上限" : "同时运行的接续 Main 数量上限";
    const minimum = resident ? 1 : 0;
    return `<div class="settings-row" data-capacity-kind="${kind}">
      <span class="settings-row-line"><span class="settings-row-label">${label}</span><span class="settings-info" title="${esc(hint)}">${icon("info")}</span></span>
      <span class="settings-row-spacer"></span>
      <span class="settings-capacity-usage">
        <span class="settings-capacity-bar" data-capacity-bar="${kind}">${capacityBar(quota, used, resident ? "is-accent" : "is-warn")}</span>
        <span class="settings-row-meta" data-capacity-used="${kind}">${ui`使用中 ${used}`}</span>
      </span>
      <span class="settings-stepper">
        <button type="button" data-capacity-step="-1" aria-label="${esc(`减少${label}`)}"${quota <= minimum ? " disabled" : ""}>
          ${icon("minus")}
        </button>
        <span class="settings-stepper-value" data-capacity-value="${kind}" role="status">${quota}</span>
        <button type="button" data-capacity-step="1" aria-label="${esc(`增加${label}`)}"${quota >= CAPACITY_LIMIT ? " disabled" : ""}>
          ${icon("plus")}
        </button>
      </span>
    </div>`;
  }

  function capacityGroup(node) {
    const state = capacity.get(node.origin);
    if (!state?.draft) return "";
    const online = node.state !== "offline";
    return `<div class="settings-group" data-capacity-node="${esc(node.origin)}">
      <div class="settings-group-head">
        ${icon("server")}<h2 class="settings-group-title">${esc(node.name)}</h2>
        <span class="settings-dot ${online ? "is-ok" : "is-muted"}" aria-hidden="true"></span>
        <span class="settings-group-spacer"></span>
      </div>
      <div class="settings-rows">
        ${capacityRow(node.origin, "regular", state.draft.resident, usedSlots(state.view, "regular"))}
        ${capacityRow(node.origin, "continuation", state.draft.continuation, usedSlots(state.view, "continuation"))}
      </div>
      <div class="settings-error" role="alert" data-capacity-error hidden>${
        state.error ? esc(state.error) : ""
      }</div>
      <div class="settings-actions">
        <button type="button" class="settings-text-button" data-capacity-reset>${ui("还原")}</button>
        <button type="button" class="settings-primary-button" data-capacity-save>${ui("保存")}</button>
      </div>
    </div>`;
  }

  function renderCapacity() {
    $("#settings-capacity-nodes").innerHTML = capacityNodes()
      .map((node) => capacityGroup(node))
      .join("");
  }

  async function refreshCapacity() {
    const targets = capacityNodes();
    if (!targets.length) {
      $("#settings-capacity-nodes").innerHTML = "";
      return;
    }
    // The connected node answers for every group until per-node clients exist;
    // #09 addresses each node's own service.
    try {
      const view = await api("/api/main-capacity");
      for (const node of targets) {
        const state = capacity.get(node.origin) ?? {};
        state.view = view;
        state.saved = {
          resident: view.settings?.resident ?? 1,
          continuation: view.settings?.continuation ?? 0
        };
        // A read that lands after a person changed the numbers must not undo it.
        if (!state.dirty) state.draft = { ...state.saved };
        state.draft ??= { ...state.saved };
        delete state.error;
        capacity.set(node.origin, state);
      }
    } catch (error) {
      for (const node of targets) {
        const state = capacity.get(node.origin) ?? {};
        state.error = error?.message || ui("无法读取运行名额");
        state.saved ??= { resident: 1, continuation: 0 };
        state.draft ??= { ...state.saved };
        capacity.set(node.origin, state);
      }
    }
    renderCapacity();
  }

  async function saveCapacity(node) {
    const state = capacity.get(node.origin);
    if (!state?.draft) return;
    const group = root.querySelector(`[data-capacity-node="${CSS.escape(node.origin)}"]`);
    const error = group?.querySelector("[data-capacity-error]");
    if (error) error.hidden = true;
    for (const button of group?.querySelectorAll("[data-capacity-save], [data-capacity-reset]") ?? [])
      button.disabled = true;
    try {
      const view = await api("/api/main-capacity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(state.draft)
      });
      const next = capacity.get(node.origin) ?? {};
      next.view = view;
      next.saved = {
        resident: view.settings?.resident ?? next.draft.resident,
        continuation: view.settings?.continuation ?? next.draft.continuation
      };
      next.draft = { ...next.saved };
      next.dirty = false;
      delete next.error;
      capacity.set(node.origin, next);
      renderCapacity();
      root.querySelector(`[data-capacity-node="${CSS.escape(node.origin)}"] [data-capacity-save]`)?.focus();
      showToast(ui`${node.name} 的运行名额已保存`);
    } catch (failure) {
      const next = capacity.get(node.origin) ?? {};
      next.error = failure?.message || ui("保存未完成，请稍后重试");
      capacity.set(node.origin, next);
      const current = root.querySelector(`[data-capacity-node="${CSS.escape(node.origin)}"]`);
      if (current) {
        current.outerHTML = capacityGroup(node);
        const restored = root.querySelector(`[data-capacity-node="${CSS.escape(node.origin)}"]`);
        for (const value of restored?.querySelectorAll("[data-capacity-save], [data-capacity-reset]") ?? [])
          value.disabled = false;
        restored?.querySelector("[data-capacity-save]")?.focus();
      }
      showToast(next.error);
    }
  }

  function stepCapacity(node, kind, delta) {
    const state = capacity.get(node.origin);
    if (!state?.draft) return;
    const key = kind === "regular" ? "resident" : "continuation";
    const minimum = key === "resident" ? 1 : 0;
    const value = Math.min(CAPACITY_LIMIT, Math.max(minimum, state.draft[key] + delta));
    state.draft = { ...state.draft, [key]: value };
    state.dirty = true;
    const field = capacityValue(node.origin, kind);
    if (field) field.textContent = String(value);
    const row = root.querySelector(
      `[data-capacity-node="${CSS.escape(node.origin)}"] [data-capacity-kind="${kind}"]`
    );
    const steps = [...(row?.querySelectorAll("[data-capacity-step]") ?? [])];
    if (steps[0]) steps[0].disabled = value <= minimum;
    if (steps[1]) steps[1].disabled = value >= CAPACITY_LIMIT;
    const bar = row?.querySelector(`[data-capacity-bar="${kind}"]`);
    if (bar)
      bar.innerHTML = capacityBar(
        value,
        usedSlots(state.view, kind),
        kind === "regular" ? "is-accent" : "is-warn"
      );
    const error = root.querySelector(
      `[data-capacity-node="${CSS.escape(node.origin)}"] [data-capacity-error]`
    );
    if (error) error.hidden = true;
  }

  function resetCapacity(node) {
    const state = capacity.get(node.origin);
    if (!state?.saved) return;
    state.draft = { ...state.saved };
    state.dirty = false;
    delete state.error;
    const group = root.querySelector(`[data-capacity-node="${CSS.escape(node.origin)}"]`);
    if (group) {
      group.outerHTML = capacityGroup(node);
      root.querySelector(`[data-capacity-node="${CSS.escape(node.origin)}"] [data-capacity-reset]`)?.focus();
    }
  }

  /* ---------------------------------------------------------------- navigation */

  function paint() {
    for (const button of sectionButtons()) {
      const selected = button.dataset.settingsSection === section;
      if (selected) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    for (const panel of panels()) panel.hidden = panel.dataset.settingsPanel !== section;
  }

  function runSection() {
    if (section === "nodes") renderNodes();
    if (section === "members") renderMembers();
    if (section === "tools") renderMcp();
    if (section === "capacity") void refreshCapacity();
    for (const handler of handlers.get(section) ?? []) handler();
  }

  function open(next) {
    if (!root) return;
    if (!opened) {
      previousFocus = document.activeElement;
      opened = true;
    }
    if (next && SETTINGS_SECTIONS.includes(next)) section = next;
    if (app) app.hidden = true;
    root.hidden = false;
    trigger?.setAttribute("aria-expanded", "true");
    paint();
    runSection();
    sectionButtons()
      .find((button) => button.dataset.settingsSection === section)
      ?.focus({ preventScroll: true });
  }

  function close({ restoreFocus = true } = {}) {
    if (!root || root.hidden) return;
    root.hidden = true;
    if (app) app.hidden = false;
    trigger?.setAttribute("aria-expanded", "false");
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus();
  }

  function setSection(next) {
    if (!SETTINGS_SECTIONS.includes(next) || next === section) return;
    section = next;
    paint();
    runSection();
  }

  /* ---------------------------------------------------------------- wiring */

  $("#settings-back").addEventListener("click", () => close());
  for (const button of sectionButtons())
    button.addEventListener("click", () => setSection(button.dataset.settingsSection));
  $(".settings-nav-items").addEventListener("keydown", (event) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const buttons = sectionButtons();
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
    setSection(buttons[next].dataset.settingsSection);
  });
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    close();
  });
  trigger?.addEventListener("click", () => open());

  // Node, member and MCP actions arrive with the surfaces that follow, so an
  // action is only rendered when its host provides one.
  $("#settings-node-add").addEventListener("click", () => addNode?.());
  $("#settings-mcp-add").addEventListener("click", () => addMcp?.());

  $("#settings-capacity-nodes").addEventListener("click", (event) => {
    const group = event.target.closest("[data-capacity-node]");
    if (!group) return;
    const node = capacityNodes().find((entry) => entry.origin === group.dataset.capacityNode);
    if (!node) return;
    if (event.target.closest("[data-capacity-save]")) void saveCapacity(node);
    else if (event.target.closest("[data-capacity-reset]")) resetCapacity(node);
    else {
      const step = event.target.closest("[data-capacity-step]");
      const row = event.target.closest("[data-capacity-kind]");
      if (step && row) stepCapacity(node, row.dataset.capacityKind, Number(step.dataset.capacityStep));
    }
  });

  renderNodes();
  renderMembers();
  renderMcp();

  /** Register work that has to run when its section is shown. */
  function onSection(name, handler) {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name).add(handler);
    return () => handlers.get(name)?.delete(handler);
  }

  return {
    open,
    close,
    setSection,
    onSection,
    section: () => section,
    state: () => ({ open: opened, section }),
    /** A sub-page steps back to the page it was opened from, never closing it. */
    host: {
      open: () => open(),
      close: () => true,
      onSection
    }
  };
}
