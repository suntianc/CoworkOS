import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../workbench/html.js";

/**
 * The observation sidebar: three views with their counts, the connected nodes
 * and the projects each view can narrow to.
 *
 * It renders only what the data port reports. Selecting a node narrows the
 * projects, the counts and the view; selecting a project narrows the view to
 * that project. The filter is exposed on the observation pane as
 * `data-observe-node` and `data-observe-project` for the views to read, so no
 * view holds a node connection of its own.
 *
 * Rows are patched in place when the same nodes/projects are still listed: a
 * catalog event during a run must not replace the button the keyboard is on.
 */

const STATUS_LABEL = {
  connecting: "连接中",
  offline: "离线",
  unauthorized: "未授权",
  failed: "不可用",
  disconnected: "已断开"
};

export function createObserveSidebar({ root, pane, data, addNode } = {}) {
  if (!root) return { render() {}, dispose() {} };
  const filter = { nodeOrigin: "", projectId: "" };
  const $ = (selector) => root.querySelector(selector);

  function nodeRow(node) {
    const label = STATUS_LABEL[node.status];
    return `<button class="observe-item" type="button" data-observe-node="${esc(node.origin)}" title="${esc(node.name)}" aria-pressed="${filter.nodeOrigin === node.origin}">
      ${icon(node.local ? "laptop" : "server")}
      <span class="observe-item-name">${esc(node.name)}</span>
      <span class="observe-item-spacer"></span>
      <span class="observe-item-state"${label ? "" : " hidden"}>${label ? esc(ui(label)) : ""}</span>
      <span class="observe-dot" aria-hidden="true"></span>
    </button>`;
  }

  function updateNodeRow(button, node) {
    button.setAttribute("aria-pressed", String(filter.nodeOrigin === node.origin));
    button.querySelector(".observe-item-name").textContent = node.name;
    const state = button.querySelector(".observe-item-state");
    const label = STATUS_LABEL[node.status];
    state.textContent = label ? ui(label) : "";
    state.hidden = !label;
    button.querySelector(".observe-dot").className = `observe-dot ${
      node.status === "online" ? "is-ok" : node.status === "unauthorized" ? "is-alert" : ""
    }`.trim();
  }

  function projectRow(project, count) {
    return `<button class="observe-item" type="button" data-observe-project="${esc(project.projectId)}" title="${esc(project.projectName)}" aria-pressed="${filter.projectId === project.projectId}">
      ${icon("folder")}
      <span class="observe-item-name">${esc(project.projectName)}</span>
      <span class="observe-item-spacer"></span>
      <span class="observe-item-count"${count > 0 ? "" : " hidden"}>${count > 0 ? esc(String(count)) : ""}</span>
    </button>`;
  }

  function updateProjectRow(button, project, count) {
    button.setAttribute("aria-pressed", String(filter.projectId === project.projectId));
    button.querySelector(".observe-item-name").textContent = project.projectName;
    const badge = button.querySelector(".observe-item-count");
    badge.textContent = count > 0 ? String(count) : "";
    badge.hidden = count <= 0;
  }

  /** The listed identities still match, so rows can be patched without a rebuild. */
  function sameRows(list, keys, attribute) {
    return (
      list.children.length === keys.length &&
      [...list.children].every((child, index) => child.dataset[attribute] === keys[index])
    );
  }

  function renderList(list, rows, keys, attribute, update) {
    if (!sameRows(list, keys, attribute)) {
      list.innerHTML = rows.map((row) => row.markup).join("");
      return;
    }
    rows.forEach((row, index) => update(list.children[index], row.value));
  }

  function setCount(view, value) {
    const node = root.querySelector(`[data-observe-count="${view}"]`);
    if (!node) return;
    node.textContent = value > 0 ? String(value) : "";
    node.hidden = value <= 0;
  }

  function clearStale() {
    const nodes = data.nodes();
    if (filter.nodeOrigin && !nodes.some((node) => node.origin === filter.nodeOrigin)) {
      filter.nodeOrigin = "";
      filter.projectId = "";
      return true;
    }
    if (filter.projectId) {
      const projects = data.scoped({ nodeOrigin: filter.nodeOrigin, projectId: "" }).projects;
      if (!projects.some((project) => project.projectId === filter.projectId)) {
        filter.projectId = "";
        return true;
      }
    }
    return false;
  }

  function render() {
    const cleared = clearStale();
    const counts = data.counts(filter);
    setCount("requirements", counts.requirements);
    setCount("runs", counts.runs);
    const nodes = data.nodes();
    renderList(
      $("[data-observe-node-list]"),
      nodes.map((node) => ({ markup: nodeRow(node), value: node })),
      nodes.map((node) => node.origin),
      "observeNode",
      updateNodeRow
    );
    const listCounts = data.counts({ nodeOrigin: filter.nodeOrigin, projectId: "" }).projects;
    const projects = data.scoped({ nodeOrigin: filter.nodeOrigin, projectId: "" }).projects;
    renderList(
      $("[data-observe-project-list]"),
      projects.map((project) => ({
        markup: projectRow(project, listCounts.get(project.projectId) || 0),
        value: project
      })),
      projects.map((project) => project.projectId),
      "observeProject",
      (button, project) => updateProjectRow(button, project, listCounts.get(project.projectId) || 0)
    );
    if (pane) {
      pane.dataset.observeNode = filter.nodeOrigin;
      pane.dataset.observeProject = filter.projectId;
    }
    if (cleared) data.setFilter({ ...filter });
  }

  function selectNode(origin) {
    filter.nodeOrigin = filter.nodeOrigin === origin ? "" : origin;
    if (filter.projectId) {
      const projects = data.scoped({ nodeOrigin: filter.nodeOrigin, projectId: "" }).projects;
      if (!projects.some((project) => project.projectId === filter.projectId)) filter.projectId = "";
    }
    data.setFilter({ ...filter });
  }

  function selectProject(projectId) {
    filter.projectId = filter.projectId === projectId ? "" : projectId;
    data.setFilter({ ...filter });
  }

  const onClick = (event) => {
    const node = event.target.closest("[data-observe-node]");
    if (node) {
      selectNode(node.dataset.observeNode);
      return;
    }
    const project = event.target.closest("[data-observe-project]");
    if (project) {
      selectProject(project.dataset.observeProject);
      return;
    }
    if (event.target.closest("[data-observe-add-node]")) addNode?.();
  };
  root.addEventListener("click", onClick);

  const addNodeButton = root.querySelector("[data-observe-add-node]");
  if (addNodeButton) addNodeButton.hidden = !addNode;

  render();

  return {
    render,
    dispose() {
      root.removeEventListener("click", onClick);
    }
  };
}
