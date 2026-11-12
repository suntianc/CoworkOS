import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../workbench/html.js";

/**
 * The observation sidebar: three views with their counts, then one scope tree
 * — 全部, each connected node, and that node's projects beneath it.
 *
 * Exactly one row of the tree is current. 全部 shows everything; a node narrows
 * the counts and the view to that node; a project narrows them to that project
 * on its node. The filter is exposed on the observation pane as
 * `data-observe-node` and `data-observe-project` for the views to read, so no
 * view holds a node connection of its own.
 *
 * Rows are patched in place when the same rows are still listed: a catalog
 * event during a run must not replace the button the keyboard is on.
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

  const current = (nodeOrigin, projectId) =>
    filter.nodeOrigin === nodeOrigin && filter.projectId === projectId;
  const currentAttribute = (on) => (on ? ' aria-current="true"' : "");

  function allRow() {
    return `<button class="observe-item" type="button" data-observe-key="all" data-observe-all${currentAttribute(current("", ""))}>
      ${icon("layers")}
      <span class="observe-item-name">${esc(ui("全部"))}</span>
    </button>`;
  }

  function nodeRow(node) {
    const label = STATUS_LABEL[node.status];
    return `<button class="observe-item" type="button" data-observe-key="node:${esc(node.origin)}" data-observe-node="${esc(node.origin)}" title="${esc(node.name)}"${currentAttribute(current(node.origin, ""))}>
      ${icon(node.local ? "laptop" : "server")}
      <span class="observe-item-name">${esc(node.name)}</span>
      <span class="observe-item-spacer"></span>
      <span class="observe-item-state"${label ? "" : " hidden"}>${label ? esc(ui(label)) : ""}</span>
      <span class="observe-dot" aria-hidden="true"></span>
    </button>`;
  }

  function projectRow(origin, project, count) {
    return `<button class="observe-item is-nested" type="button" data-observe-key="project:${esc(origin)}|${esc(project.projectId)}" data-observe-project="${esc(project.projectId)}" data-observe-project-node="${esc(origin)}" title="${esc(project.projectName)}"${currentAttribute(current(origin, project.projectId))}>
      ${icon("folder")}
      <span class="observe-item-name">${esc(project.projectName)}</span>
      <span class="observe-item-spacer"></span>
      <span class="observe-item-count"${count > 0 ? "" : " hidden"}>${count > 0 ? esc(String(count)) : ""}</span>
    </button>`;
  }

  function markCurrent(button, on) {
    if (on) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }

  function updateNodeRow(button, node) {
    markCurrent(button, current(node.origin, ""));
    button.querySelector(".observe-item-name").textContent = node.name;
    const state = button.querySelector(".observe-item-state");
    const label = STATUS_LABEL[node.status];
    state.textContent = label ? ui(label) : "";
    state.hidden = !label;
    button.querySelector(".observe-dot").className = `observe-dot ${
      node.status === "online" ? "is-ok" : node.status === "unauthorized" ? "is-alert" : ""
    }`.trim();
  }

  function updateProjectRow(button, origin, project, count) {
    markCurrent(button, current(origin, project.projectId));
    button.querySelector(".observe-item-name").textContent = project.projectName;
    const badge = button.querySelector(".observe-item-count");
    badge.textContent = count > 0 ? String(count) : "";
    badge.hidden = count <= 0;
  }

  /** The tree rows, in order: 全部, then each node followed by its projects. */
  function treeRows() {
    const rows = [{ key: "all", markup: allRow(), update: (button) => markCurrent(button, current("", "")) }];
    for (const node of data.nodes()) {
      rows.push({
        key: `node:${node.origin}`,
        markup: nodeRow(node),
        update: (button) => updateNodeRow(button, node)
      });
      const scope = { nodeOrigin: node.origin, projectId: "" };
      const counts = data.counts(scope).projects;
      for (const project of data.scoped(scope).projects) {
        const count = counts.get(project.projectId) || 0;
        rows.push({
          key: `project:${node.origin}|${project.projectId}`,
          markup: projectRow(node.origin, project, count),
          update: (button) => updateProjectRow(button, node.origin, project, count)
        });
      }
    }
    return rows;
  }

  /**
   * Patch the tree by row key: rows still listed keep their element (and the
   * keyboard focus on it), rows gone are removed, new rows are inserted in
   * place. A node going offline drops its projects without rebuilding the tree.
   */
  function renderTree(list, rows) {
    const existing = new Map([...list.children].map((child) => [child.dataset.observeKey, child]));
    const keys = new Set(rows.map((row) => row.key));
    for (const [key, element] of existing) if (!keys.has(key)) element.remove();
    let cursor = list.firstElementChild;
    for (const row of rows) {
      let element = existing.get(row.key);
      if (element) row.update(element);
      else {
        const template = document.createElement("template");
        template.innerHTML = row.markup.trim();
        element = template.content.firstElementChild;
      }
      if (element === cursor) cursor = cursor.nextElementSibling;
      else list.insertBefore(element, cursor);
    }
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
    renderTree($("[data-observe-scope-list]"), treeRows());
    if (pane) {
      pane.dataset.observeNode = filter.nodeOrigin;
      pane.dataset.observeProject = filter.projectId;
    }
    if (cleared) data.setFilter({ ...filter });
  }

  /** One row is current: selecting it again changes nothing; 全部 clears the scope. */
  function selectScope(nodeOrigin, projectId) {
    if (current(nodeOrigin, projectId)) return;
    filter.nodeOrigin = nodeOrigin;
    filter.projectId = projectId;
    data.setFilter({ ...filter });
  }

  const onClick = (event) => {
    if (event.target.closest("[data-observe-all]")) return selectScope("", "");
    const node = event.target.closest("[data-observe-node]");
    if (node) return selectScope(node.dataset.observeNode, "");
    const project = event.target.closest("[data-observe-project]");
    if (project) return selectScope(project.dataset.observeProjectNode, project.dataset.observeProject);
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
