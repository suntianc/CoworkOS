import { ui } from "../ui/language.js";
import { icon } from "../ui/icons.js";
import { createModal } from "../ui/modal.js";
import { escapeHtml as esc } from "../workbench/html.js";

/** Project navigation, directory settings and creation do not mutate conversation drafts. */
export function createProjectController({
  state,
  $,
  api,
  storage,
  showToast,
  beginConversation,
  selectConversation,
  conversationTitle,
  stateText,
  openTaskMenu,
  taskMenuOpen,
  onRendered = () => {},
  getNavigationIdentity,
  onSelectionChanged = () => {},
  getApplicationWorkspaces = () => [],
  isContextVisible = () => true,
  isTaskVisible = () => true,
  isUnread = () => false,
  openProjectExperience = () => {},
  onUpdated = () => {}
}) {
  /** Change commands carry an operation id; the fallback keeps partial handlers working. */
  const command = (path, options) => (api.command ? api.command(path, options) : api(path, options));
  let dialog,
    dialogEpoch = 0,
    saving = false;
  const localProjects = new Map(),
    localTasks = new Map();
  const selectedKey = "atria.selected-project.v1";
  try {
    state.selectedProjectId ||= storage?.getItem(selectedKey) || null;
  } catch {
    /* optional persistence */
  }
  const projects = () => state.projects || [];
  const taskLabel = (task) =>
    `<span class="conversation-item-title"><span class="conversation-title-text">${task.pinned ? "★ " : ""}${esc(conversationTitle(task))}</span>${["running", "leased", "waiting", "queued"].includes(task.status) ? `<span class="conversation-activity" data-state="${task.status}" aria-hidden="true"></span>` : ""}${isUnread(task.taskId) ? ui('<span class="conversation-unread" role="img" aria-label="未读"></span>') : ""}</span>`;
  const taskRow = (task) =>
    ui`<div class="conversation-row"><button class="conversation-item ${task.taskId === state.selected ? "active" : ""} ${isUnread(task.taskId) ? "is-unread" : ""}" data-task="${esc(task.taskId)}" title="${esc(conversationTitle(task))}" aria-description="${esc(stateText(task.status || "created"))}" ${task.taskId === state.selected ? 'aria-current="page"' : ""}>${taskLabel(task)}</button><button class="conversation-menu" type="button" data-session-menu="${esc(task.taskId)}" aria-label="会话菜单：${esc(conversationTitle(task))}" title="会话菜单" aria-haspopup="menu" aria-controls="session-menu">${icon("more")}</button></div>`;
  const visibleTask = (task) => !task.archived && isTaskVisible(task);
  const visibleProjects = () =>
    projects().filter(
      (project) =>
        !project.legacy ||
        project.hasApplications ||
        project.tasks?.some(visibleTask) ||
        getApplicationWorkspaces().some(
          (root) =>
            root &&
            (root === project.projectDirectory ||
              root === project.workspaceRoot ||
              project.tasks?.some((task) => task.storageRoot === root))
        )
    );
  const find = (id) => projects().find((project) => project.projectId === id);
  const projectForTask = (task) =>
    find(task?.projectId) ||
    projects().find((project) => project.tasks?.some((entry) => entry.taskId === task?.taskId));
  const current = () =>
    state.tasks.find((task) => task.taskId === state.selected)?.temporaryWorkspaceRoot ||
    (state.selectedProjectId === null && state.composingNew)
      ? undefined
      : visibleProjects().find((project) => project.projectId === state.selectedProjectId) ||
        projectForTask(state.tasks.find((task) => task.taskId === state.selected)) ||
        visibleProjects()[0];
  function select(id, { automatic = false } = {}) {
    const project = find(id);
    if (!project) return;
    state.selectedProjectId = project.projectId;
    try {
      storage?.setItem(selectedKey, project.projectId);
    } catch {
      /* navigation still works */
    }
    paintContext();
    if (automatic) onSelectionChanged(project);
    return project;
  }
  function paintContext() {
    const project = state.tasks.find((task) => task.taskId === state.selected)?.temporaryWorkspaceRoot
      ? undefined
      : state.selected
        ? projectForTask(state.tasks.find((task) => task.taskId === state.selected)) || current()
        : current();
    const label = $("#project-context");
    if (label) {
      label.hidden = !project || !isContextVisible();
      label.textContent = project?.projectName || "";
      label.title = project?.projectDirectory || project?.workspaceRoot || "";
    }
  }
  function render() {
    const root = $("#project-list");
    const focused = root.contains(document.activeElement) ? document.activeElement : null;
    const focusTask = focused?.dataset.task,
      focusMenu = focused?.dataset.sessionMenu;
    const focusProject = focused?.closest("[data-project]")?.dataset.project;
    const focusAction = focused?.hasAttribute("data-project-create")
      ? "[data-project-create]"
      : focused?.hasAttribute("data-project-settings")
        ? "[data-project-settings]"
        : ".project-row";
    const scrollTop = root.scrollTop;
    $("#conversation-count").textContent = state.tasks.filter(visibleTask).length;
    const selected = current();
    if (selected && !find(state.selectedProjectId)) select(selected.projectId, { automatic: true });
    const temporary = state.tasks
      .filter((task) => task.temporaryWorkspaceRoot && visibleTask(task))
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
    const temporaryMarkup = temporary.length
      ? ui`<section class="temporary-conversations"><div class="editor-empty-label">临时会话</div>${temporary.map(taskRow).join("")}</section>`
      : "";
    const markup =
      temporaryMarkup +
      (visibleProjects()
        .map((project) => {
          const id = project.projectId,
            tasks = (project.tasks || []).filter(visibleTask);
          return ui`<section class="project-group ${state.collapsedProjects.has(id) ? "collapsed" : ""} ${state.selectedProjectId === id ? "is-selected" : ""}" data-project="${esc(id)}">
        <div class="project-heading"><button class="project-row" type="button" data-project-id="${esc(id)}" aria-expanded="${!state.collapsedProjects.has(id)}" title="${esc(project.projectDirectory || project.workspaceRoot || "")}"><span class="project-disclosure" aria-hidden="true"><span class="project-folder">${icon("folder")}</span><span class="project-chevron">${icon("chevron-down")}</span></span><span class="project-name">${esc(project.projectName)}</span></button><button class="project-settings" type="button" data-project-settings="${esc(id)}" aria-label="项目设置：${esc(project.projectName)}" title="项目设置">${icon("more")}</button><button class="project-create" type="button" data-project-create="${esc(id)}" aria-label="在 ${esc(project.projectName)} 中新建会话" title="新建会话">${icon("plus")}</button></div>
        <div class="conversation-list" aria-label="${esc(project.projectName)}中的对话">${
          tasks
            .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
            .map(taskRow)
            .join("") || ui('<div class="project-empty">还没有对话</div>')
        }</div></section>`;
        })
        .join("") ||
        (temporary.length ? "" : ui('<div class="sidebar-empty">拖入文件或发送消息，开始临时协作</div>')));
    paintContext();
    if (root.conversationMarkup === markup) return;
    root.conversationMarkup = markup;
    root.innerHTML = markup;
    root.scrollTop = scrollTop;
    root.querySelectorAll("[data-task]").forEach((node) =>
      node.addEventListener("click", () => {
        const task = state.tasks.find((entry) => entry.taskId === node.dataset.task);
        const project = projectForTask(task);
        if (project) select(project.projectId);
        selectConversation(node.dataset.task);
      })
    );
    root.querySelectorAll("[data-session-menu]").forEach((node) => {
      node.addEventListener("click", () => openTaskMenu(node, node.dataset.sessionMenu));
      node.addEventListener("keydown", (event) => {
        if (["ArrowDown", "ArrowUp"].includes(event.key) && !taskMenuOpen()) {
          event.preventDefault();
          event.stopImmediatePropagation();
          openTaskMenu(node, node.dataset.sessionMenu, event.key === "ArrowUp");
        }
      });
    });
    root
      .querySelectorAll("[data-project-create]")
      .forEach((node) => node.addEventListener("click", () => beginConversation(node.dataset.projectCreate)));
    root
      .querySelectorAll("[data-project-settings]")
      .forEach((node) => node.addEventListener("click", () => openSettings(node.dataset.projectSettings)));
    root.querySelectorAll("[data-project-id]").forEach((node) =>
      node.addEventListener("click", () => {
        const id = node.dataset.projectId;
        select(id);
        if (!state.selected) beginConversation(id);
        if (state.collapsedProjects.has(id)) state.collapsedProjects.delete(id);
        else state.collapsedProjects.add(id);
        render();
      })
    );
    onRendered();
    const focusSelector = focusMenu
      ? `[data-session-menu="${CSS.escape(focusMenu)}"]`
      : focusTask
        ? `[data-task="${CSS.escape(focusTask)}"]`
        : focusProject
          ? `[data-project="${CSS.escape(focusProject)}"] ${focusAction}`
          : null;
    if (focusSelector) root.querySelector(focusSelector)?.focus({ preventScroll: true });
  }
  function upsert(project) {
    const previous = find(project.projectId);
    const merged = { ...previous, ...project, tasks: previous?.tasks || [] };
    if (previous)
      state.projects = projects().map((entry) => (entry.projectId === project.projectId ? merged : entry));
    else state.projects = [...projects(), merged];
    localProjects.set(project.projectId, project);
  }
  function openSettings(id) {
    if (saving) return;
    const project = find(id);
    let panel = $("#project-modal");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "project-modal";
      panel.className = "modal-backdrop app-dialog-backdrop";
      panel.hidden = true;
      panel.innerHTML = ui`<section class="modal-card app-dialog project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title"><h2 id="project-dialog-title"></h2><form id="project-form"><div class="project-dialog-fields"><label for="project-name">项目名称</label><input id="project-name" required maxlength="120" autocomplete="off"><label for="project-directory">工作文件夹</label><div class="project-directory-field"><input id="project-directory" required placeholder="选择已有文件夹或输入绝对路径" autocomplete="off"><button class="app-button is-secondary" id="project-directory-choose" type="button" aria-label="选择文件夹">${icon("folder")}</button></div></div><p class="dialog-error project-dialog-error" id="project-error" role="alert" hidden></p><div class="modal-actions dialog-actions"><button class="app-button is-secondary" id="project-experience-open" type="button">项目经验</button><button class="app-button is-secondary" id="project-cancel" type="button">取消</button><button class="app-button is-primary" id="project-submit" type="submit"></button></div></form></section>`;
      document.body.appendChild(panel);
      dialog = createModal(panel, $("#project-cancel"), {
        onClose: () => {
          dialogEpoch++;
        }
      });
    }
    const epoch = ++dialogEpoch,
      identity = getNavigationIdentity();
    for (const node of panel.querySelectorAll("input,button")) node.disabled = false;
    $("#project-experience-open").hidden = !project;
    $("#project-experience-open").onclick = () => {
      if (!project || saving) return;
      dialog.close();
      openProjectExperience(project);
    };
    $("#project-dialog-title").textContent = project ? ui("项目设置") : ui("新建项目");
    $("#project-name").value = project?.projectName || "";
    $("#project-directory").value = project?.projectDirectory || project?.workspaceRoot || "";
    $("#project-submit").textContent = project ? ui("保存") : ui("创建");
    $("#project-error").hidden = true;
    const error = (message) => {
      $("#project-error").textContent = message;
      $("#project-error").hidden = false;
    };
    $("#project-directory-choose").onclick = async () => {
      const button = $("#project-directory-choose");
      button.disabled = true;
      try {
        const selected = window.bookmanDesktop
          ? await window.bookmanDesktop.chooseProject()
          : (await api("/api/projects/choose-directory", { method: "POST" })).projectDirectory;
        if (epoch !== dialogEpoch || panel.hidden || !selected) return;
        $("#project-directory").value = selected;
      } catch (failure) {
        if (epoch === dialogEpoch) error(failure.message);
      } finally {
        if (epoch === dialogEpoch) button.disabled = false;
      }
    };
    $("#project-form").onsubmit = async (event) => {
      event.preventDefault();
      if (saving) return;
      const projectName = $("#project-name").value.trim(),
        projectDirectory = $("#project-directory").value.trim();
      if (!projectName || !projectDirectory) {
        error(ui("请填写项目名称并选择工作文件夹"));
        return;
      }
      saving = true;
      for (const node of panel.querySelectorAll("input,button")) node.disabled = true;
      try {
        const result = await command(
          project ? `/api/projects/${encodeURIComponent(project.projectId)}` : "/api/projects",
          {
            method: project ? "PATCH" : "POST",
            body: { projectName, projectDirectory }
          }
        );
        upsert(result.project);
        const foreground = epoch === dialogEpoch && getNavigationIdentity() === identity;
        if (epoch === dialogEpoch) dialog.close();
        if (foreground && !project) {
          select(result.project.projectId);
          state.collapsedProjects.delete(result.project.projectId);
          beginConversation(result.project.projectId);
        }
        render();
        onUpdated(result.project);
      } catch (failure) {
        if (epoch === dialogEpoch) error(failure.message);
        else showToast(failure.message);
      } finally {
        saving = false;
        for (const node of panel.querySelectorAll("input,button")) node.disabled = false;
      }
    };
    dialog.open();
    $("#project-name").focus();
  }
  $("#new-project").addEventListener("click", () => openSettings());
  return {
    paintContext,
    render,
    currentProject: current,
    async ensureProject(projectDirectory, projectName) {
      const existing = projects().find((project) => project.projectDirectory === projectDirectory);
      if (existing) return existing;
      try {
        const { project } = await command("/api/projects", {
          method: "POST",
          body: { projectName, projectDirectory }
        });
        upsert(project);
        return project;
      } catch (error) {
        if (error.status !== 409) throw error;
        const { projects: latest } = await api("/api/tasks");
        const project = latest?.find((entry) => entry.projectDirectory === projectDirectory);
        if (!project) throw error;
        upsert(project);
        return project;
      }
    },
    /** Backend switching drops this backend's optimistic rows and project selection. */
    reset() {
      localProjects.clear();
      localTasks.clear();
      state.selectedProjectId = null;
      try {
        storage?.removeItem(selectedKey);
      } catch {
        /* optional persistence */
      }
    },
    projectForWorkspace(root) {
      if (!root) return current();
      const selected = current();
      if (selected?.tasks?.some((task) => task.storageRoot === root)) return selected;
      return projects().find(
        (project) =>
          project.workspaceRoot === root ||
          project.projectDirectory === root ||
          project.tasks?.some((task) => task.storageRoot === root)
      );
    },
    select,
    selectTask(task) {
      const project = projectForTask(task);
      if (project) select(project.projectId);
      else if (task?.temporaryWorkspaceRoot) state.selectedProjectId = null;
    },
    accept(data) {
      const incoming = data.projects || [];
      for (const project of incoming) {
        const local = localProjects.get(project.projectId);
        if (local && (!local.updatedAt || project.updatedAt >= local.updatedAt))
          localProjects.delete(project.projectId);
      }
      state.tasks = data.tasks || [];
      for (const task of state.tasks) localTasks.delete(task.taskId);
      state.tasks = [...state.tasks, ...localTasks.values()];
      state.projects = incoming.map((project) => ({
        ...project,
        ...localProjects.get(project.projectId),
        tasks: state.tasks.filter(
          (task) =>
            task.projectId === project.projectId ||
            project.tasks?.some((entry) => entry.taskId === task.taskId)
        )
      }));
      for (const project of localProjects.values())
        if (!state.projects.some((entry) => entry.projectId === project.projectId))
          state.projects.push({
            ...project,
            tasks: state.tasks.filter((task) => task.projectId === project.projectId)
          });
      state.projectsLoaded = true;
      $("#new-conversation").disabled = false;
    },
    openCreate: () => openSettings(),
    addTask(task) {
      localTasks.set(task.taskId, task);
      let project = projectForTask(task);
      if (!project && task.projectId) {
        upsert({
          projectId: task.projectId,
          projectName: task.projectName || ui("项目"),
          projectDirectory: task.projectDirectory || task.workspaceRoot
        });
        project = find(task.projectId);
      }
      if (project && !project.tasks.some((entry) => entry.taskId === task.taskId))
        project.tasks.unshift(task);
    }
  };
}
