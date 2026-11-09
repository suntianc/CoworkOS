import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../workbench/html.js";

const statusLabel = {
  created: "未开始",
  running: "开发中",
  waiting: "开发中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

/**
 * The empty work pane for a conversation that does not exist yet.
 *
 * It names the project the new Main session will belong to, offers the recent
 * sessions that can be continued, and keeps the project choice on the composer
 * so sending a message creates the session where the person expects it.
 */
export function createNewSessionView({
  state,
  $,
  titleFor = (task) => task.title || task.goal || task.taskId,
  onOpenTask = () => {},
  onSelectProject = () => {},
  onAddProject = () => {}
}) {
  let rendered = "";
  let menuOpen = false;
  const newSessionPlaceholder = ui("描述需求，例如：给 summarize.sh 增加 --avg 参数…");
  const defaultPlaceholder = $("#composer-input").placeholder;
  const projectName = (projectId) =>
    (state.projects || []).find((project) => project.projectId === projectId)?.projectName || "";
  const currentProject = () =>
    (state.projects || []).find((project) => project.projectId === state.selectedProjectId);
  function recentTasks() {
    return (state.tasks || [])
      .filter(
        (task) =>
          !task.archived &&
          !task.temporaryWorkspaceRoot &&
          task.kind !== "workspace" &&
          task.monitoring?.scope !== "background"
      )
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, 2);
  }
  function recentMarkup() {
    const tasks = recentTasks();
    if (!tasks.length) return "";
    return ui`<div class="new-session-recent"><div class="new-session-label">继续最近的需求</div>${tasks
      .map((task) => {
        const project = projectName(task.projectId) || task.projectName || "";
        const status = task.pendingQuestion ? ui("等你回答") : ui(statusLabel[task.status] || "继续");
        return `<button class="new-session-recent-row" type="button" data-recent-task="${esc(task.taskId)}">${icon("history")}<span class="new-session-recent-title">${esc(titleFor(task))}</span><span class="new-session-recent-meta">${esc(project)}${project ? " · " : ""}${esc(status)}</span></button>`;
      })
      .join("")}</div>`;
  }
  function render() {
    if (state.selected) return;
    const conversation = $("#conversation");
    const markup = ui`<div class="new-session-start"><div class="new-session-hero"><h2 class="new-session-title">想在哪个项目里做什么？</h2></div>${recentMarkup()}</div>`;
    // A conversation or a catalog re-render can replace this container; the
    // cached string alone does not prove the start surface is still mounted.
    if (markup === rendered && conversation.querySelector(".new-session-start")) return;
    rendered = markup;
    conversation.innerHTML = markup;
    conversation
      .querySelectorAll("[data-recent-task]")
      .forEach((node) => node.addEventListener("click", () => onOpenTask(node.dataset.recentTask)));
  }
  function renderMenu() {
    const projects = state.projects || [];
    const selected = state.selectedProjectId;
    $("#composer-project-menu").innerHTML = ui`${projects
      .map(
        (project) =>
          `<button class="composer-project-option" type="button" role="option" data-project-choice="${esc(project.projectId)}" aria-selected="${project.projectId === selected}">${icon("folder")}<span>${esc(project.projectName)}</span>${project.projectId === selected ? `<span class="composer-project-check">${icon("check")}</span>` : ""}</button>`
      )
      .join(
        ""
      )}<div class="composer-project-divider" role="separator"></div><button class="composer-project-option is-add" type="button" data-add-project>${icon("plus")}<span>添加项目…</span></button>`;
  }
  function closeMenu({ focus = false } = {}) {
    if (!menuOpen) return;
    menuOpen = false;
    $("#composer-project-menu").hidden = true;
    $("#composer-project").setAttribute("aria-expanded", "false");
    if (focus) $("#composer-project").focus();
  }
  function openMenu() {
    if (state.selected) return;
    renderMenu();
    menuOpen = true;
    $("#composer-project-menu").hidden = false;
    $("#composer-project").setAttribute("aria-expanded", "true");
    $("#composer-project-menu").querySelector('[role="option"][aria-selected="true"]')?.focus();
  }
  function sync() {
    const composing = !state.selected;
    $("#conversation-pane").classList.toggle("is-new-session", composing);
    $("#new-conversation").classList.toggle("is-current", composing);
    const input = $("#composer-input");
    if (composing) input.placeholder = newSessionPlaceholder;
    else if (input.placeholder === newSessionPlaceholder) input.placeholder = defaultPlaceholder;
    const chip = $("#composer-project");
    chip.hidden = !composing;
    if (!composing) return closeMenu();
    const project = currentProject();
    $(".composer-project-name").textContent = project?.projectName || ui("选择项目");
    chip.title = project ? ui`会话项目：${project.projectName}` : ui("选择项目");
  }
  $("#composer-project").addEventListener("click", () => {
    if (menuOpen) return closeMenu();
    openMenu();
  });
  $("#composer-project").addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    openMenu();
  });
  $("#composer-project-menu").addEventListener("click", (event) => {
    const option = event.target.closest("[data-project-choice]");
    if (option) {
      closeMenu();
      onSelectProject(option.dataset.projectChoice);
      return;
    }
    if (event.target.closest("[data-add-project]")) {
      closeMenu();
      onAddProject();
    }
  });
  $("#composer-project-menu").addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu({ focus: true });
    }
  });
  document.addEventListener("click", (event) => {
    if (!menuOpen) return;
    if (event.target.closest("#composer-project, #composer-project-menu")) return;
    closeMenu();
  });
  return {
    render,
    sync,
    closeMenu,
    isMenuOpen: () => menuOpen
  };
}
