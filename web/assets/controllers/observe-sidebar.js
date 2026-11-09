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
 */

const STATUS_LABEL = {
  connecting: "连接中",
  offline: "离线",
  unauthorized: "未授权",
  failed: "不可用",
  disconnected: "已断开"
};

export function createObserveSidebar({ root, pane, data, addNode, addProject } = {}) {
  if (!root) return { render() {}, dispose() {} };
  const filter = { nodeOrigin: "", projectId: "" };
  const $ = (selector) => root.querySelector(selector);

  function nodeRow(node) {
    const online = node.status === "online";
    const label = STATUS_LABEL[node.status];
    return `<button class="observe-item" type="button" data-observe-node="${esc(node.origin)}" aria-pressed="${filter.nodeOrigin === node.origin}">
      ${icon(node.local ? "laptop" : "server")}
      <span class="observe-item-name">${esc(node.name)}</span>
      <span class="observe-item-spacer"></span>
      ${label ? `<span class="observe-item-state">${esc(ui(label))}</span>` : ""}
      <span class="observe-dot ${online ? "is-ok" : node.status === "unauthorized" ? "is-alert" : ""}" aria-hidden="true"></span>
    </button>`;
  }

  function projectRow(project, count) {
    return `<button class="observe-item" type="button" data-observe-project="${esc(project.projectId)}" aria-pressed="${filter.projectId === project.projectId}">
      ${icon("folder")}
      <span class="observe-item-name">${esc(project.projectName)}</span>
      <span class="observe-item-spacer"></span>
      ${count > 0 ? `<span class="observe-item-count">${esc(String(count))}</span>` : ""}
    </button>`;
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
    $("[data-observe-node-list]").innerHTML = data.nodes().map(nodeRow).join("");
    const listCounts = data.counts({ nodeOrigin: filter.nodeOrigin, projectId: "" }).projects;
    const projects = data.scoped({ nodeOrigin: filter.nodeOrigin, projectId: "" }).projects;
    $("[data-observe-project-list]").innerHTML = projects
      .map((project) => projectRow(project, listCounts.get(project.projectId) || 0))
      .join("");
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
    else if (event.target.closest("[data-observe-add-project]")) addProject?.();
  };
  root.addEventListener("click", onClick);

  const addProjectButton = root.querySelector("[data-observe-add-project]");
  if (addProjectButton) {
    addProjectButton.hidden = !addProject;
  }
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
