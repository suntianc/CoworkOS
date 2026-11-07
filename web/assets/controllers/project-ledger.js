import { createModal } from "../ui/modal.js";
import { icon } from "../ui/icons.js";
import { escapeHtml as esc } from "../workbench/html.js";

const sourceLabel = { internal: "内部", external: "外部", legacy: "历史" };
const statusLabel = { open: "进行中", delivered: "已交付", withdrawn: "已撤回" };
const DECISION_RETRACT = "撤回";
const DECISION_RESTORE = "恢复";

/**
 * The project ledger view.
 *
 * It names a project in the URL and reads one project at a time; the Main tool
 * uses a Task-scoped path instead, so the two clients never share a project
 * parameter. Late loads keep their project and are dropped after a switch.
 */
export function createProjectLedgerController({ api, state, showToast = () => {} }) {
  let panel, modal, list, detail, errorNode, projectSelect, queryInput, form;
  let epoch = 0;
  let activeProject = null;
  let activeRequirement = null;
  let activeRevision = null;
  let requirements = [];
  let projectsSignature = "";
  let searchTimer;

  const endpoint = (projectId, requirementId) =>
    `/api/projects/${encodeURIComponent(projectId)}/ledger${
      requirementId ? `/${encodeURIComponent(requirementId)}` : ""
    }`;
  const visible = (projectId) => panel && !panel.hidden && activeProject?.projectId === projectId;

  function install() {
    if (panel) return;
    panel = document.createElement("div");
    panel.className = "modal-backdrop settings-backdrop ledger-backdrop";
    panel.hidden = true;
    panel.innerHTML = `<section class="modal-card settings-card ledger-card" role="dialog" aria-modal="true" aria-labelledby="ledger-title">
      <header class="settings-heading">
        <h2 id="ledger-title">需求台账</h2>
        <label class="ledger-project"><select data-project aria-label="台账项目"></select></label>
        <button type="button" class="settings-nav-button" data-close aria-label="关闭需求台账">${icon("close")}</button>
      </header>
      <div class="settings-scroll ledger-scroll">
        <form data-create class="ledger-create">
          <label class="settings-field">标题<input name="title" aria-label="需求标题" maxlength="200" required></label>
          <label class="settings-field">需求<textarea name="content" aria-label="需求内容" rows="3" maxlength="20000" required placeholder="要解决的问题与约束"></textarea></label>
          <div class="ledger-actions"><button type="submit" class="app-button is-primary">记录需求</button></div>
        </form>
        <input data-query type="search" aria-label="查询台账" placeholder="查询" autocomplete="off">
        <p role="alert" data-error hidden></p>
        <div class="ledger-columns">
          <ul data-list class="ledger-list" aria-label="需求列表"></ul>
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
    queryInput = $("[data-query]");
    form = $("[data-create]");
    modal = createModal(panel, $("[data-close]"), {
      onClose() {
        epoch += 1;
        clearTimeout(searchTimer);
      }
    });
    projectSelect.addEventListener("change", () => {
      activeProject = state.projects?.find((project) => project.projectId === projectSelect.value) ?? null;
      activeRequirement = null;
      void load();
    });
    queryInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => void load(), 200);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void create();
    });
    list.addEventListener("click", (event) => {
      const button = event.target.closest("[data-requirement]");
      if (button) void select(button.dataset.requirement);
    });
    detail.addEventListener("click", (event) => {
      const button = event.target.closest("[data-decide]");
      if (button) void toggleDecision(button.dataset.decide, button.dataset.effective === "true");
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
      projects.find((project) => project.tasks?.some((task) => task.taskId === state.selected)) ||
      projects[0];
    pickProject(preferred?.projectId);
    if (preferred) activeProject = preferred;
    projectSelect.disabled = projects.length === 0;
    form.querySelector("button[type=submit]").disabled = !preferred;
  }

  function fail(error) {
    errorNode.textContent = error?.message || "台账请求失败";
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
      const text = queryInput.value.trim();
      const result = await api(endpoint(projectId) + (text ? `?q=${encodeURIComponent(text)}` : ""));
      if (current !== epoch || !visible(projectId)) return;
      requirements = result.requirements ?? [];
      renderList();
      if (activeRequirement) await select(activeRequirement);
    } catch (error) {
      if (current === epoch && visible(projectId)) fail(error);
    }
  }

  function renderList() {
    if (!requirements.length) {
      list.innerHTML = `<li class="ledger-empty">没有需求</li>`;
      return;
    }
    list.innerHTML = requirements
      .map(
        (requirement) => `<li><button type="button" data-requirement="${esc(requirement.requirementId)}" ${
          requirement.requirementId === activeRequirement ? 'aria-current="true"' : ""
        }>
          <strong>${esc(requirement.title)}</strong>
          <span class="ledger-tags"><span>${esc(sourceLabel[requirement.source?.kind] ?? requirement.source?.kind ?? "")}</span><span>${esc(
            statusLabel[requirement.status] ?? requirement.status
          )}</span><span>v${esc(requirement.revision)}</span></span>
        </button></li>`
      )
      .join("");
  }

  async function select(requirementId) {
    if (!activeProject) return;
    const projectId = activeProject.projectId;
    const current = ++epoch;
    try {
      const result = await api(endpoint(projectId, requirementId));
      if (current !== epoch || !visible(projectId)) return;
      activeRequirement = requirementId;
      renderDetail(result.requirement);
      renderList();
    } catch (error) {
      if (current === epoch && visible(projectId)) fail(error);
    }
  }

  function renderDetail(requirement) {
    if (!requirement) {
      detail.hidden = true;
      return;
    }
    activeRevision = requirement.revision;
    activeRequirement = requirement.requirementId;
    const decisions = requirement.decisions ?? [];
    detail.hidden = false;
    detail.innerHTML = `<header><strong>${esc(requirement.title)}</strong><span class="ledger-tags"><span>${esc(
      sourceLabel[requirement.source?.kind] ?? requirement.source?.kind ?? ""
    )}</span><span>${esc(statusLabel[requirement.status] ?? requirement.status)}</span></span></header>
      ${
        requirement.source?.reference
          ? `<p class="ledger-source">${esc(requirement.source.reference)}</p>`
          : ""
      }
      <p class="ledger-content">${esc(requirement.content)}</p>
      <h3>决定</h3>
      <ul class="ledger-decisions">${
        decisions.length
          ? decisions
              .map(
                (decision) => `<li${decision.effective ? "" : ' class="is-retracted"'}>
                  <span>${esc(decision.text)}</span>
                  <button type="button" class="ledger-text-button" data-decide="${esc(
                    decision.decisionId
                  )}" data-effective="${decision.effective}">${
                    decision.effective ? DECISION_RETRACT : DECISION_RESTORE
                  }</button>
                </li>`
              )
              .join("")
          : '<li class="ledger-empty">没有决定</li>'
      }</ul>
      <h3>修订</h3>
      <ol class="ledger-revisions">${(requirement.revisions ?? [])
        .slice()
        .reverse()
        .map(
          (revision) =>
            `<li><span>v${esc(revision.revision)}</span><span>${esc(revision.createdAt)}</span>${
              revision.note ? `<span>${esc(revision.note)}</span>` : ""
            }</li>`
        )
        .join("")}</ol>`;
  }

  async function create() {
    if (!activeProject) return;
    const title = form.querySelector('[name="title"]').value;
    const content = form.querySelector('[name="content"]').value;
    const projectId = activeProject.projectId;
    try {
      const result = await api(endpoint(projectId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "create",
          title,
          content,
          source: { kind: "internal" }
        })
      });
      if (!visible(projectId)) return;
      form.querySelector('[name="title"]').value = "";
      form.querySelector('[name="content"]').value = "";
      activeRequirement = result.requirement?.requirementId ?? null;
      showToast("需求已记录");
      await load();
    } catch (error) {
      if (visible(projectId)) fail(error);
    }
  }

  async function toggleDecision(decisionId, effective) {
    if (!activeProject || !activeRequirement) return;
    const projectId = activeProject.projectId;
    try {
      const result = await api(endpoint(projectId, activeRequirement), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "set_decision_effective",
          requirementId: activeRequirement,
          decisionId,
          expectedRevision: activeRevision,
          effective: !effective
        })
      });
      if (!visible(projectId)) return;
      renderDetail(result.requirement);
    } catch (error) {
      if (visible(projectId)) fail(error);
    }
  }

  return {
    /** Keep the project options in step; a project that disappeared reloads the view. */
    render() {
      if (!panel) return;
      const previous = activeProject?.projectId;
      renderProjects();
      // A project that disappeared from the catalog moves the view to the next
      // one; a hidden view only picks it up when it is opened again.
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
      activeRequirement = null;
      detail.hidden = true;
      modal.open();
      void load();
    },
    close() {
      modal?.close();
    },
    isOpen: () => Boolean(panel && !panel.hidden),
    selectRequirement: select
  };
}
