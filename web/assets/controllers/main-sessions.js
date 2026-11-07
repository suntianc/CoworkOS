import { createModal } from "../ui/modal.js";
import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../workbench/html.js";

const entryLabel = { internal: "内部", external: "外部" };
const kindLabel = { regular: "常规", continuation: "接续" };

/**
 * The project's Main sessions.
 *
 * A session is one continuing conversation; this view lists the selected
 * project's sessions and lets a person create, continue or switch to one. It
 * names a project in the URL and captures it before every request, so a load
 * that returns after a project switch is dropped instead of replacing the page
 * the person is now looking at.
 */
export function createMainSessionsController({ api, state, openSession = () => {} }) {
  let panel, modal, list, projectSelect, form, errorNode;
  let epoch = 0;
  let activeProject = null;
  let sessions = [];
  let projectsSignature = "";

  const endpoint = (projectId) => `/api/projects/${encodeURIComponent(projectId)}/main-sessions`;
  const visible = (projectId) => panel && !panel.hidden && activeProject?.projectId === projectId;

  function install() {
    if (panel) return;
    panel = document.createElement("div");
    panel.className = "modal-backdrop settings-backdrop main-session-backdrop";
    panel.hidden = true;
    panel.innerHTML = `<section class="modal-card settings-card main-session-card" role="dialog" aria-modal="true" aria-labelledby="main-session-title">
      <header class="settings-heading">
        <h2 id="main-session-title">Main 会话</h2>
        <label class="main-session-project"><select data-project aria-label="会话项目"></select></label>
        <button type="button" class="settings-nav-button" data-close aria-label="关闭 Main 会话">${icon("close")}</button>
      </header>
      <div class="settings-scroll main-session-scroll">
        <form data-create class="main-session-create">
          <label class="settings-field">新会话<input name="title" aria-label="新会话名称" maxlength="120" required></label>
          <div class="main-session-actions"><button type="submit" class="app-button is-primary">${ui("新建会话")}</button></div>
        </form>
        <p role="alert" data-error hidden></p>
        <ul data-sessions class="main-session-list" aria-label="Main 会话列表"></ul>
      </div>
    </section>`;
    document.body.append(panel);
    const $ = (selector) => panel.querySelector(selector);
    list = $("[data-sessions]");
    projectSelect = $("[data-project]");
    form = $("[data-create]");
    errorNode = $("[data-error]");
    modal = createModal(panel, $("[data-close]"), {
      onClose() {
        epoch += 1;
      }
    });
    projectSelect.addEventListener("change", () => {
      activeProject = state.projects?.find((project) => project.projectId === projectSelect.value) ?? null;
      sessions = [];
      void load();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void create();
    });
    list.addEventListener("click", (event) => {
      const button = event.target.closest("[data-session]");
      if (button) select(button.dataset.session);
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
    if (signature !== projectsSignature) {
      projectsSignature = signature;
      projectSelect.replaceChildren(
        ...projects.map((project) => {
          const option = document.createElement("option");
          option.value = project.projectId;
          option.textContent = project.projectName;
          return option;
        })
      );
    }
    const preferred =
      projects.find((project) => project.projectId === activeProject?.projectId) ||
      projects.find((project) => project.projectId === state.selectedProjectId) ||
      projects.find((project) => project.tasks?.some((task) => task.taskId === state.selected)) ||
      projects[0];
    if (preferred) {
      activeProject = preferred;
      pickProject(preferred.projectId);
    }
    projectSelect.disabled = projects.length === 0;
    form.querySelector("button[type=submit]").disabled = !preferred;
    return preferred;
  }

  function fail(error) {
    errorNode.textContent = error?.message || "Main 会话请求失败";
    errorNode.hidden = false;
  }

  function clearError() {
    errorNode.textContent = "";
    errorNode.hidden = true;
  }

  function renderList() {
    if (!sessions.length) {
      list.innerHTML = '<li class="main-session-empty">还没有会话</li>';
      return;
    }
    list.innerHTML = sessions
      .map((session) => {
        const current = session.projectId === state.selectedProjectId && session.taskId === state.selected;
        return `<li><button type="button" data-session="${esc(session.sessionId)}" data-local="${
          session.local
        }" ${current ? 'aria-current="true"' : ""}>
          <strong>${esc(session.title || session.taskId)}</strong>
          <span class="main-session-tags"><span>${esc(
            entryLabel[session.entryKind] ?? session.entryKind
          )}</span><span>${esc(kindLabel[session.kind] ?? session.kind)}</span>${
            session.currentRequirementTitle
              ? `<span class="main-session-requirement">${esc(session.currentRequirementTitle)}</span>`
              : ""
          }${session.local ? "" : `<span>${ui("另一台后端")}</span>`}</span>
        </button></li>`;
      })
      .join("");
  }

  async function load() {
    if (!activeProject) return;
    const projectId = activeProject.projectId;
    const current = ++epoch;
    clearError();
    try {
      const result = await api(endpoint(projectId));
      if (current !== epoch || !visible(projectId)) return;
      sessions = result.sessions ?? [];
      renderList();
    } catch (error) {
      if (current === epoch && visible(projectId)) fail(error);
    }
  }

  async function create() {
    if (!activeProject) return;
    const projectId = activeProject.projectId;
    const title = form.querySelector('[name="title"]').value.trim();
    if (!title) return;
    const current = ++epoch;
    try {
      const result = await api(endpoint(projectId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "create", title })
      });
      if (current !== epoch || !visible(projectId)) return;
      form.querySelector('[name="title"]').value = "";
      sessions = [
        result.session,
        ...sessions.filter((entry) => entry.sessionId !== result.session.sessionId)
      ];
      renderList();
      select(result.session.sessionId);
    } catch (error) {
      if (current === epoch && visible(projectId)) fail(error);
    }
  }

  function select(sessionId) {
    const session = sessions.find((entry) => entry.sessionId === sessionId);
    if (!session) return;
    if (!session.local) {
      fail(new Error("该会话的历史在这台设备之外，不能在这里继续"));
      return;
    }
    modal.close();
    openSession({ projectId: session.projectId, sessionId: session.sessionId, taskId: session.taskId });
  }

  return {
    render() {
      if (!panel) return;
      const previous = activeProject?.projectId;
      renderProjects();
      if (!panel.hidden && activeProject && activeProject.projectId !== previous) void load();
    },
    open(projectId) {
      install();
      if (projectId) {
        const project = state.projects?.find((entry) => entry.projectId === projectId);
        if (project) activeProject = project;
      }
      renderProjects();
      clearError();
      modal.open();
      void load();
    },
    close() {
      modal?.close();
    },
    isOpen: () => Boolean(panel && !panel.hidden)
  };
}
