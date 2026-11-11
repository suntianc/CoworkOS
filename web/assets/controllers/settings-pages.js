import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../workbench/html.js";
import { createModal } from "../ui/modal.js";
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
const NODE_STATE = {
  online: { label: "在线", tone: "is-ok" },
  connecting: { label: "连接中", tone: "is-muted" },
  offline: { label: "离线", tone: "is-muted" },
  unauthorized: { label: "未授权", tone: "is-alert" },
  failed: { label: "不可用", tone: "is-alert" },
  disconnected: { label: "已断开", tone: "is-muted" }
};

export function createSettingsPages({
  root,
  app,
  api,
  nodes = () => [],
  members = () => [],
  mcp = () => [],
  addNode,
  renameNode,
  reauthorizeNode,
  reconnectNode,
  disconnectNode,
  removeNode,
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
  let nodeMenu;
  let nodeMenuTrigger;
  let nodeDialog;
  let nodeDialogModal;
  let nodeRefreshPending = false;
  let nodeDialogMode = "add";
  let nodeDialogOrigin;

  const $ = (selector) => root.querySelector(selector);
  const sectionButtons = () => [...root.querySelectorAll("[data-settings-section]")];
  const panels = () => [...root.querySelectorAll("[data-settings-panel]")];

  const localNode = () => {
    const listed = (Array.isArray(nodes()) ? nodes() : []).find((node) => node && node.local);
    return (
      listed ?? {
        origin: location.origin,
        name: ui("本机"),
        role: "internal",
        address: location.host,
        local: true,
        status: "online"
      }
    );
  };
  const remoteNodes = () => (Array.isArray(nodes()) ? nodes() : []).filter((node) => node && !node.local);
  const capacityNodes = () => remoteNodes().filter((node) => node.role === "external");
  const nodeStatus = (node) => node.status ?? "online";
  const nodeState = (node) => NODE_STATE[nodeStatus(node)] ?? NODE_STATE.offline;
  const nodeAddress = (node) => {
    if (node.address) return node.address;
    try {
      return new URL(node.origin).host;
      // eslint-disable-next-line no-restricted-syntax -- a stored record always passed the origin check; a value that cannot be parsed is shown as recorded
    } catch {
      return node.origin;
    }
  };

  /* ---------------------------------------------------------------- nodes */

  function nodeRow(node) {
    const status = nodeStatus(node);
    const state = nodeState(node);
    const retry = !node.local && ["offline", "failed", "disconnected"].includes(status);
    const lastSeen = status === "offline" && node.lastSeen ? ` · ${formatStamp(node.lastSeen)}` : "";
    return `<div class="settings-row"${node.local ? " data-local-node" : ""} data-node="${esc(node.origin)}">
      <span class="settings-icon-box">${icon(node.local ? "laptop" : "server")}</span>
      <span class="settings-row-text">
        <span class="settings-row-line"><span class="settings-row-name">${esc(node.name)}</span><span class="settings-role">${ui(ROLE_LABEL[node.role] ?? ROLE_LABEL.internal)}</span></span>
        <span class="settings-row-meta is-mono">${esc(nodeAddress(node))}</span>
      </span>
      <span class="settings-row-spacer"></span>
      <span class="settings-dot ${state.tone}" aria-hidden="true"></span>
      <span class="settings-row-state">${esc(ui(state.label))}${esc(lastSeen)}</span>
      ${
        retry
          ? `<button class="settings-retry" type="button" data-node-reconnect="${esc(node.origin)}">${ui("重连")}</button>`
          : ""
      }
      ${
        node.local
          ? `<span class="settings-info" title="${esc(ui("只在这台机器上运行，不对外提供 Main"))}">${icon("info")}</span>`
          : `<button class="settings-icon-button" type="button" data-node-menu="${esc(node.origin)}" aria-label="${esc(ui("节点操作"))}" aria-haspopup="menu" aria-expanded="false">${icon("more")}</button>`
      }
    </div>`;
  }

  function renderNodes({ force = false } = {}) {
    const localBox = $("#settings-node-local");
    const remoteBox = $("#settings-node-remote");
    // A row control keeps focus while a status notify arrives; the next
    // focusout (or section open) brings the rows up to date.
    if (!force && remoteBox.contains(document.activeElement)) return;
    const localMarkup = nodeRow(localNode());
    const local = localBox.querySelector("[data-local-node]");
    // The host appends its backend-switcher row here, so replace only this
    // row instead of rewriting the box.
    if (local) local.outerHTML = localMarkup;
    else localBox.insertAdjacentHTML("afterbegin", localMarkup);
    const remote = remoteNodes();
    $("#settings-node-remote-group").hidden = !remote.length && !addNode;
    remoteBox.hidden = !remote.length;
    remoteBox.innerHTML = remote.map(nodeRow).join("");
    $("#settings-node-add").hidden = !addNode;
    if (!$("#settings-node-data").childElementCount)
      $("#settings-node-data").innerHTML = `<div class="settings-row">
        <span class="settings-icon-box">${icon("database")}</span>
        <span class="settings-row-text">
          <span class="settings-row-name">${ui("共享台账与看板")}</span>
          <span class="settings-row-meta">${ui("SQLite · 由本机提供")}</span>
        </span>
        <span class="settings-row-spacer"></span>
        <span class="settings-info" title="${esc(ui("项目数据保存在本机，连接的节点读取同一份共享记录"))}">${icon("info")}</span>
      </div>`;
  }

  function currentMenuNode() {
    return remoteNodes().find((node) => node.origin === nodeMenuTrigger?.dataset.nodeMenu);
  }

  function closeNodeMenu({ restoreFocus = false } = {}) {
    if (!nodeMenu || nodeMenu.hidden) return;
    nodeMenu.hidden = true;
    nodeMenuTrigger?.setAttribute("aria-expanded", "false");
    const previous = nodeMenuTrigger;
    const origin = previous?.dataset.nodeMenu;
    nodeMenuTrigger = undefined;
    if (nodeRefreshPending) {
      nodeRefreshPending = false;
      if (opened && section === "nodes") renderNodes();
    }
    if (!restoreFocus) return;
    const target = origin ? root.querySelector(`[data-node-menu="${CSS.escape(origin)}"]`) : previous;
    if (target?.isConnected) target.focus();
  }

  function positionNodeMenu() {
    if (!nodeMenu || nodeMenu.hidden || !nodeMenuTrigger) return;
    const anchor = nodeMenuTrigger.getBoundingClientRect();
    const row = nodeMenuTrigger.closest(".settings-row")?.getBoundingClientRect();
    const width = nodeMenu.offsetWidth;
    const height = nodeMenu.offsetHeight;
    // The board aligns the menu's right edge with the node rows and its top
    // with the pressed ellipsis, so it overlaps the row beneath.
    const right = row?.right ?? anchor.right;
    const left = Math.max(8, Math.min(right - width, innerWidth - width - 8));
    const top = Math.max(8, Math.min(anchor.top, innerHeight - height - 8));
    nodeMenu.style.left = `${left}px`;
    nodeMenu.style.top = `${top}px`;
  }

  function nodeMenuItems() {
    return [...nodeMenu.querySelectorAll("button:not(:disabled)")].filter((item) => !item.hidden);
  }

  function ensureNodeMenu() {
    if (nodeMenu) return nodeMenu;
    nodeMenu = document.createElement("div");
    nodeMenu.className = "settings-node-menu";
    nodeMenu.setAttribute("role", "menu");
    nodeMenu.setAttribute("aria-label", ui("节点操作"));
    nodeMenu.hidden = true;
    nodeMenu.innerHTML = `<button type="button" role="menuitem" data-node-action="rename">${icon("pencil")}<span>${ui("重命名")}</span></button>
      <button type="button" role="menuitem" data-node-action="reauthorize">${icon("key-round")}<span>${ui("重新授权")}</span></button>
      <button type="button" role="menuitem" data-node-action="disconnect">${icon("unplug")}<span>${ui("断开")}</span></button>
      <button type="button" role="menuitem" data-node-action="remove" class="is-danger">${icon("trash")}<span>${ui("移除节点")}</span></button>`;
    root.append(nodeMenu);
    nodeMenu.addEventListener("click", (event) => {
      const button = event.target.closest("[data-node-action]");
      if (!button) return;
      const origin = nodeMenuTrigger?.dataset.nodeMenu;
      closeNodeMenu();
      if (!origin) return;
      void runNodeAction(button.dataset.nodeAction, origin);
    });
    nodeMenu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeNodeMenu({ restoreFocus: true });
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = nodeMenuItems();
      const index = items.indexOf(document.activeElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    });
    document.addEventListener("pointerdown", (event) => {
      if (nodeMenu.hidden || nodeMenu.contains(event.target) || nodeMenuTrigger?.contains(event.target))
        return;
      closeNodeMenu();
    });
    return nodeMenu;
  }

  function openNodeMenu(triggerButton) {
    const origin = triggerButton.dataset.nodeMenu;
    ensureNodeMenu();
    closeNodeMenu();
    nodeMenuTrigger = root.querySelector(`[data-node-menu="${CSS.escape(origin)}"]`) ?? triggerButton;
    nodeMenuTrigger.setAttribute("aria-expanded", "true");
    const node = currentMenuNode();
    nodeMenu.querySelector('[data-node-action="disconnect"]').disabled = nodeStatus(node) === "disconnected";
    nodeMenu.hidden = false;
    positionNodeMenu();
    nodeMenuItems()[0]?.focus();
  }

  function ensureNodeDialog() {
    if (nodeDialog) return nodeDialog;
    const panel = document.createElement("div");
    panel.id = "node-dialog";
    panel.className = "modal-backdrop app-dialog-backdrop";
    panel.hidden = true;
    panel.innerHTML = ui`<section class="modal-card app-dialog node-dialog" role="dialog" aria-modal="true" aria-labelledby="node-dialog-title">
      <h2 id="node-dialog-title">添加节点</h2>
      <form id="node-form">
        <div class="project-dialog-fields">
          <label for="node-address" data-node-address-field>地址</label>
          <input id="node-address" data-node-address-field required placeholder="http://127.0.0.1:3880" autocomplete="off" spellcheck="false">
          <label for="node-name">名称</label>
          <input id="node-name" maxlength="80" autocomplete="off">
          <span class="node-dialog-label" id="node-role-label" data-node-role-field>范围</span>
          <div class="settings-segmented" role="radiogroup" aria-labelledby="node-role-label" data-node-role-field>
            <button type="button" role="radio" data-node-role="internal" aria-checked="true">对内</button>
            <button type="button" role="radio" data-node-role="external" aria-checked="false">对外</button>
          </div>
        </div>
        <p class="dialog-error" id="node-error" role="alert" hidden></p>
        <div class="modal-actions dialog-actions">
          <button class="app-button is-secondary" id="node-cancel" type="button">取消</button>
          <button class="app-button is-primary" id="node-submit" type="submit">连接节点</button>
        </div>
      </form>
    </section>`;
    document.body.append(panel);
    nodeDialog = panel;
    nodeDialogModal = createModal(panel, panel.querySelector("#node-cancel"));
    panel
      .querySelector("[data-node-role]")
      .closest("[role=radiogroup]")
      .addEventListener("click", (event) => {
        const button = event.target.closest("[data-node-role]");
        if (!button) return;
        for (const option of panel.querySelectorAll("[data-node-role]"))
          option.setAttribute("aria-checked", String(option === button));
      });
    panel.querySelector("#node-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void submitNodeDialog();
    });
    return nodeDialog;
  }

  function nodeDialogError(message) {
    const error = nodeDialog.querySelector("#node-error");
    error.textContent = message;
    error.hidden = !message;
  }

  function nodeDialogRole() {
    return nodeDialog.querySelector('[data-node-role][aria-checked="true"]')?.dataset.nodeRole ?? "internal";
  }

  async function submitNodeDialog() {
    const address = nodeDialog.querySelector("#node-address").value.trim();
    const name = nodeDialog.querySelector("#node-name").value.trim();
    if (nodeDialogMode === "add" && !address) {
      nodeDialogError(ui("请填写节点地址"));
      nodeDialog.querySelector("#node-address").focus();
      return;
    }
    const controls = [...nodeDialog.querySelectorAll("input, button")];
    for (const control of controls) control.disabled = true;
    nodeDialogError("");
    try {
      if (nodeDialogMode === "rename") {
        renameNode(nodeDialogOrigin, name);
      } else {
        await addNode({ baseUrl: address, name, role: nodeDialogRole() });
      }
      nodeDialogModal.close();
    } catch (error) {
      nodeDialogError(ui(error?.message || "连接失败"));
    } finally {
      for (const control of controls) control.disabled = false;
    }
  }

  function openNodeDialog({ origin } = {}) {
    ensureNodeDialog();
    nodeDialogMode = origin ? "rename" : "add";
    nodeDialogOrigin = origin;
    const node = origin ? remoteNodes().find((entry) => entry.origin === origin) : undefined;
    nodeDialog.querySelector("#node-dialog-title").textContent = origin ? ui("重命名节点") : ui("添加节点");
    nodeDialog.querySelector("#node-submit").textContent = origin ? ui("保存") : ui("连接节点");
    if (!origin) nodeDialog.querySelector("#node-address").value = "";
    nodeDialog.querySelector("#node-name").value = node?.name ?? "";
    nodeDialog.querySelector("#node-address").required = !origin;
    for (const field of nodeDialog.querySelectorAll("[data-node-address-field], [data-node-role-field]"))
      field.hidden = Boolean(origin);
    for (const option of nodeDialog.querySelectorAll("[data-node-role]"))
      option.setAttribute("aria-checked", String(!origin && option.dataset.nodeRole === "internal"));
    nodeDialogError("");
    nodeDialogModal.open();
    (origin ? nodeDialog.querySelector("#node-name") : nodeDialog.querySelector("#node-address")).focus();
  }

  async function runNodeAction(action, origin) {
    const node = remoteNodes().find((entry) => entry.origin === origin);
    try {
      if (action === "rename") {
        openNodeDialog({ origin });
        return;
      }
      if (action === "reauthorize") await reauthorizeNode?.(origin);
      else if (action === "disconnect") disconnectNode?.(origin);
      else if (action === "remove") removeNode?.(origin);
    } catch (error) {
      showToast(ui(error?.message || "节点操作未完成"));
      return;
    }
    // A user action owns the row it changed, so it updates even while that
    // row's control holds focus.
    if (opened && section === "nodes") renderNodes({ force: true });
    if (action === "remove") {
      const add = $("#settings-node-add");
      (add.hidden ? root.querySelector('[data-settings-section="nodes"]') : add)?.focus();
    } else if (node) root.querySelector(`[data-node-menu="${CSS.escape(origin)}"]`)?.focus();
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
    const online = nodeStatus(node) === "online";
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
    closeNodeMenu();
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
    closeNodeMenu();
    root.hidden = true;
    if (app) app.hidden = false;
    trigger?.setAttribute("aria-expanded", "false");
    if (!restoreFocus) return;
    if (previousFocus?.isConnected) previousFocus.focus();
    // Below 640 the opener sits in the sidebar drawer, which closed on the way in:
    // hand focus to the drawer's own opener instead of losing it.
    if (document.activeElement !== previousFocus)
      [...document.querySelectorAll(".sidebar-toggle")].find((toggle) => toggle.checkVisibility())?.focus();
  }

  function setSection(next) {
    if (!SETTINGS_SECTIONS.includes(next) || next === section) return;
    closeNodeMenu();
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

  // Actions only render when their host provides one; the settings page owns
  // the chooser while the observation data port owns the connection.
  $("#settings-node-add").addEventListener("click", () => openNodeDialog());
  $("#settings-node-remote").addEventListener("click", (event) => {
    const menu = event.target.closest("[data-node-menu]");
    if (menu) {
      if (nodeMenuTrigger === menu && !nodeMenu.hidden) closeNodeMenu({ restoreFocus: true });
      else openNodeMenu(menu);
      return;
    }
    const retry = event.target.closest("[data-node-reconnect]");
    if (retry)
      void reconnectNode?.(retry.dataset.nodeReconnect)
        .then(() => {
          if (opened && section === "nodes") renderNodes({ force: true });
        })
        .catch((error) => showToast(ui(error?.message || "节点操作未完成")));
  });
  $("#settings-mcp-add").addEventListener("click", () => addMcp?.());

  // Rows paused a notify while one of their controls held focus; bring them
  // up to date as soon as focus leaves.
  $("#settings-node-remote").addEventListener("focusout", (event) => {
    if ($("#settings-node-remote").contains(event.relatedTarget)) return;
    if (opened && section === "nodes") refresh();
  });

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

  // A timestamp already on screen follows the format preference immediately.
  window.atriaPreferences?.onChange?.(() => {
    if (section === "nodes") renderNodes();
    if (section === "members") renderMembers();
  });

  renderNodes();
  renderMembers();
  renderMcp();

  /** Re-render the open section after a live node change. */
  function refresh() {
    if (!opened) return;
    if (section === "nodes") {
      // An open action menu belongs to the row it was opened from; re-rendering
      // would replace that row under the pointer. Refresh once it closes.
      if (nodeMenu && !nodeMenu.hidden) nodeRefreshPending = true;
      else renderNodes();
    } else if (section === "members") renderMembers();
    else if (section === "tools") renderMcp();
  }

  /** Open the node section's chooser; the observation sidebar shares it. */
  function addNodeDialog() {
    open("nodes");
    openNodeDialog();
  }

  /** Register work that has to run when its section is shown. */
  function onSection(name, handler) {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name).add(handler);
    return () => handlers.get(name)?.delete(handler);
  }

  return {
    open,
    close,
    refresh,
    addNodeDialog,
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
