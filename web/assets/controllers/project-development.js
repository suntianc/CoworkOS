import { createModal } from "../ui/modal.js";
import { icon } from "../ui/icons.js";
import { escapeHtml as esc } from "../workbench/html.js";

const routeLabel = { quick: "Quick", direct: "Direct", full: "Full" };
const statusLabel = { active: "进行中" };
const workspaceLabel = { ready: "现场就绪", failed: "现场未就绪" };

const shortCommit = (commit) => (typeof commit === "string" ? commit.slice(0, 8) : "");

/**
 * The requirement development view.
 *
 * It names a project in the URL and reads one project at a time; the Main tool
 * uses a Task-scoped path instead, so the two clients never share a project
 * parameter. A late load keeps its project and is dropped after a switch.
 */
export function createProjectDevelopmentController({ api, state, showToast = () => {} }) {
  let panel, modal, list, detail, errorNode, projectSelect;
  let epoch = 0;
  let activeProject = null;
  let activeDevelopment = null;
  let developments = [];
  let projectsSignature = "";

  const endpoint = (projectId, developmentId) =>
    `/api/projects/${encodeURIComponent(projectId)}/developments${
      developmentId ? `/${encodeURIComponent(developmentId)}` : ""
    }`;
  const visible = (projectId) => panel && !panel.hidden && activeProject?.projectId === projectId;

  function install() {
    if (panel) return;
    panel = document.createElement("div");
    panel.className = "modal-backdrop settings-backdrop ledger-backdrop development-backdrop";
    panel.hidden = true;
    panel.innerHTML = `<section class="modal-card settings-card ledger-card" role="dialog" aria-modal="true" aria-labelledby="development-title">
      <header class="settings-heading">
        <h2 id="development-title">需求现场</h2>
        <label class="ledger-project"><select data-project aria-label="开发记录项目"></select></label>
        <button type="button" class="settings-nav-button" data-close aria-label="关闭需求现场">${icon("close")}</button>
      </header>
      <div class="settings-scroll ledger-scroll">
        <p role="alert" data-error hidden></p>
        <div class="ledger-columns">
          <ul data-list class="ledger-list" aria-label="开发记录列表"></ul>
          <article data-detail class="ledger-detail" hidden></article>
        </div>
      </div>
    </section>`;
    document.body.append(panel);
    const $ = (selector) => panel.querySelector(selector);
    list = $("[data-list]");
    detail = $("[data-detail]");
    errorNode = $("[data-error]");
    projectSelect = $("[data-project]");
    modal = createModal(panel, $("[data-close]"), {
      onClose() {
        epoch += 1;
      }
    });
    projectSelect.addEventListener("change", () => {
      activeProject = state.projects?.find((project) => project.projectId === projectSelect.value) ?? null;
      activeDevelopment = null;
      detail.hidden = true;
      void load();
    });
    list.addEventListener("click", (event) => {
      const button = event.target.closest("[data-development]");
      if (button) void select(button.dataset.development);
    });
    detail.addEventListener("click", (event) => {
      if (event.target.closest("[data-continue]")) void continueWorkspace();
    });
  }

  function pickProject(projectId) {
    for (const option of projectSelect.children) {
      if (option.value === projectId) option.setAttribute("selected", "");
      else option.removeAttribute("selected");
    }
  }

  function renderProjects() {
    const projects = state.projects ?? [];
    const signature = projects
      .map((project) => `${project.projectId}\u0000${project.projectName}`)
      .join("\u0001");
    if (signature === projectsSignature) return;
    projectsSignature = signature;
    const options = projects.map((project) => {
      const option = document.createElement("option");
      option.value = project.projectId;
      option.textContent = project.projectName;
      return option;
    });
    projectSelect.replaceChildren(...options);
    const preferred =
      projects.find((project) => project.projectId === activeProject?.projectId) ||
      projects.find((project) => project.projectId === state.selectedProjectId) ||
      projects[0];
    pickProject(preferred?.projectId);
    if (preferred) activeProject = preferred;
    projectSelect.disabled = projects.length === 0;
  }

  function fail(error) {
    errorNode.textContent = error?.message || "开发记录请求失败";
    errorNode.hidden = false;
  }

  function clearError() {
    errorNode.textContent = "";
    errorNode.hidden = true;
  }

  async function load() {
    if (!activeProject) return;
    const projectId = activeProject.projectId;
    const current = ++epoch;
    clearError();
    try {
      const result = await api(endpoint(projectId));
      if (current !== epoch || !visible(projectId)) return;
      developments = result.developments ?? [];
      renderList();
      if (activeDevelopment) await select(activeDevelopment);
    } catch (error) {
      if (current === epoch && visible(projectId)) fail(error);
    }
  }

  function renderList() {
    if (!developments.length) {
      list.innerHTML = `<li class="ledger-empty">还没有开发记录</li>`;
      return;
    }
    list.innerHTML = developments
      .map(
        (development) => `<li><button type="button" data-development="${esc(development.developmentId)}" ${
          development.developmentId === activeDevelopment ? 'aria-current="true"' : ""
        }>
          <strong>${esc(development.requirementTitle || development.goal)}</strong>
          <span class="ledger-tags"><span>${esc(
            routeLabel[development.route] ?? development.route
          )}</span><span>${esc(statusLabel[development.status] ?? development.status)}</span><span>v${esc(
            development.revision
          )}</span><span>${esc(workspaceLabel[development.workspace?.state] ?? "尚未准备")}</span></span>
        </button></li>`
      )
      .join("");
  }

  async function select(developmentId) {
    if (!activeProject) return;
    const projectId = activeProject.projectId;
    const current = ++epoch;
    try {
      const result = await api(endpoint(projectId, developmentId));
      if (current !== epoch || !visible(projectId)) return;
      activeDevelopment = developmentId;
      renderDetail(result.development);
      renderList();
    } catch (error) {
      if (current === epoch && visible(projectId)) fail(error);
    }
  }

  function renderDetail(development) {
    if (!development) {
      detail.hidden = true;
      return;
    }
    activeDevelopment = development.developmentId;
    const workspace = development.workspace;
    detail.hidden = false;
    detail.innerHTML = `<header><strong>${esc(
      development.requirementTitle || development.goal
    )}</strong><span class="ledger-tags"><span>${esc(
      routeLabel[development.route] ?? development.route
    )}</span><span>${esc(statusLabel[development.status] ?? development.status)}</span><span>v${esc(
      development.revision
    )}</span></span></header>
      <p class="ledger-content">${esc(development.goal)}</p>
      <h3>完成标准</h3>
      <ul class="development-criteria">${(development.completionCriteria ?? [])
        .map((criterion) => `<li>${esc(criterion)}</li>`)
        .join("")}</ul>
      <h3>基线</h3>
      <p class="ledger-source">${esc(development.baseline?.branch ?? "")} @ ${esc(
        shortCommit(development.baseline?.commit)
      )}</p>
      <h3>现场</h3>
      ${
        workspace
          ? `<p class="ledger-source">${esc(workspaceLabel[workspace.state] ?? workspace.state)} · ${esc(
              workspace.branch
            )}</p><p class="ledger-source">${esc(workspace.directory)}</p>${
              workspace.error ? `<p class="development-error" role="alert">${esc(workspace.error)}</p>` : ""
            }`
          : `<p class="ledger-source">尚未准备</p>`
      }
      <div class="ledger-actions"><button type="button" class="app-button" data-continue>继续现场</button></div>`;
  }

  async function continueWorkspace() {
    if (!activeProject || !activeDevelopment) return;
    const projectId = activeProject.projectId;
    const developmentId = activeDevelopment;
    const current = ++epoch;
    clearError();
    try {
      const result = await api(endpoint(projectId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "ensure_workspace", developmentId })
      });
      if (current !== epoch || !visible(projectId)) return;
      renderDetail(result.development);
      developments = developments.map((entry) =>
        entry.developmentId === result.development.developmentId ? result.development : entry
      );
      renderList();
      showToast(result.development.workspace?.state === "ready" ? "现场已就绪" : "现场未就绪");
    } catch (error) {
      if (current === epoch && visible(projectId)) fail(error);
    }
  }

  return {
    /** Keep the project options in step; a project that disappeared reloads the view. */
    render() {
      if (!panel) return;
      const previous = activeProject?.projectId;
      renderProjects();
      if (!panel.hidden && activeProject && activeProject.projectId !== previous) void load();
    },
    open(projectId) {
      install();
      renderProjects();
      if (projectId) {
        const project = state.projects?.find((entry) => entry.projectId === projectId);
        if (project) {
          activeProject = project;
          pickProject(project.projectId);
        }
      }
      activeDevelopment = null;
      detail.hidden = true;
      modal.open();
      void load();
    },
    close() {
      modal?.close();
    },
    isOpen: () => Boolean(panel && !panel.hidden),
    selectDevelopment: select
  };
}
