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
  openTaskMenu,
  quickTaskAction = () => {},
  onRendered = () => {},
  getNavigationIdentity,
  onSelectionChanged = () => {},
  getApplicationWorkspaces = () => [],
  isTaskVisible = () => true,
  isUnread = () => false,
  openProjectExperience = () => {},
  openAddProject,
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
  const collapsedKey = "atria.collapsed-projects.v1";
  try {
    state.selectedProjectId ||= storage?.getItem(selectedKey) || null;
    const remembered = JSON.parse(storage?.getItem(collapsedKey) || "null");
    if (Array.isArray(remembered))
      for (const id of remembered) if (typeof id === "string") state.collapsedProjects.add(id);
    // eslint-disable-next-line no-restricted-syntax -- the remembered selection and folds are optional; blocked storage just leaves the defaults
  } catch {
    /* optional persistence */
  }
  function rememberCollapsed() {
    try {
      storage?.setItem(collapsedKey, JSON.stringify([...state.collapsedProjects]));
      // eslint-disable-next-line no-restricted-syntax -- a full or blocked storage keeps the fold for this session only
    } catch {
      /* optional persistence */
    }
  }
  // Below this width the sidebar is an icon rail, where every project shows
  // its tree only while open, so the project icon answers for its questions.
  const railWindow = window.matchMedia?.("(max-width: 1023px)") ?? { matches: false };
  const projects = () => state.projects || [];
  const subagentsOf = (task) => (task.activity?.agents || []).filter((agent) => agent.role === "subagent");
  const roleLabel = (agent) =>
    agent.workRole === "reviewer" ? "Reviewer" : agent.workRole === "executor" ? "Executor" : "";
  const subagentRow = (agent) => {
    const active = ["running", "waiting", "queued"].includes(agent.state);
    const tone = active
      ? agent.workRole === "reviewer"
        ? "is-review"
        : "is-running"
      : agent.state === "completed"
        ? "is-done"
        : "is-idle";
    const role = roleLabel(agent);
    return `<div class="subagent-row" data-agent="${esc(agent.agentId)}" data-state="${esc(agent.state)}"><span class="subagent-guide" aria-hidden="true"></span><span class="subagent-state ${tone}" aria-hidden="true">${icon(active ? "loader-circle" : "circle-check")}</span><span class="subagent-name">${esc(agent.name || agent.agentId)}</span>${role ? `<span class="subagent-role">${role}</span>` : ""}</div>`;
  };
  const taskLabel = (task) =>
    `<span class="conversation-item-title">${task.pendingQuestion ? `<span class="conversation-question" role="img" aria-label="${esc(ui("有待回答的问题"))}"></span>` : ""}<span class="conversation-title-text">${esc(conversationTitle(task))}</span>${isUnread(task.taskId) ? ui('<span class="conversation-unread" role="img" aria-label="未读"></span>') : ""}</span>`;
  const taskRow = (task) => {
    const id = esc(task.taskId),
      agents = subagentsOf(task),
      expanded = agents.length > 0 && !state.collapsedSessions?.has(task.taskId);
    const disclosure = agents.length
      ? `<button class="conversation-toggle" type="button" data-session-toggle="${id}" aria-expanded="${expanded}" aria-label="${esc(expanded ? ui("收起子 Agent") : ui("展开子 Agent"))}">${icon(expanded ? "chevron-down" : "chevron-right")}</button>`
      : '<span class="conversation-indent" aria-hidden="true"></span>';
    const subagents =
      expanded && agents.length
        ? `<div class="subagent-list" aria-label="${esc(ui`${conversationTitle(task)}的子 Agent`)}">${agents.map(subagentRow).join("")}</div>`
        : "";
    return ui`<div class="conversation-row${task.archived ? " is-archived" : ""}">${disclosure}<button class="conversation-item ${task.taskId === state.selected ? "active" : ""} ${isUnread(task.taskId) ? "is-unread" : ""}" data-task="${id}" data-status="${esc(task.status || "created")}" title="${esc(conversationTitle(task))}" aria-haspopup="menu" aria-keyshortcuts="Shift+F10" ${task.taskId === state.selected ? 'aria-current="page"' : ""}>${taskLabel(task)}</button>${task.pinned ? `<span class="conversation-pin" role="img" aria-label="${esc(ui("已置顶"))}">${icon("pin")}</span>` : ""}<span class="conversation-quick"><button type="button" data-quick-action="pin" data-quick-task="${id}" aria-label="${esc(task.pinned ? ui("取消置顶") : ui("置顶"))}" title="${esc(task.pinned ? ui("取消置顶") : ui("置顶"))}">${icon("pin")}</button><button type="button" data-quick-action="archive" data-quick-task="${id}" aria-label="${esc(ui("归档"))}" title="${esc(ui("归档"))}">${icon("archive")}</button></span></div>${subagents}`;
  };
  // An archived conversation stays listed while it is open, so its row menu
  // can restore it; it leaves the list once another conversation is selected.
  const visibleTask = (task) => (!task.archived || task.taskId === state.selected) && isTaskVisible(task);
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
      // eslint-disable-next-line no-restricted-syntax -- remembering the selection is optional; blocked or full storage must not fail the selection itself
    } catch {
      /* navigation still works */
    }
    if (automatic) onSelectionChanged(project);
    return project;
  }
  function render() {
    const root = $("#project-list");
    const focused = root.contains(document.activeElement) ? document.activeElement : null;
    const focusTask = focused?.dataset.task,
      focusQuick = focused?.dataset.quickTask
        ? [focused.dataset.quickTask, focused.dataset.quickAction]
        : null,
      focusToggle = focused?.dataset.sessionToggle;
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
            tasks = (project.tasks || []).filter(visibleTask),
            collapsed = state.collapsedProjects.has(id);
          const question = (collapsed || railWindow.matches) && tasks.some((task) => task.pendingQuestion);
          return ui`<section class="project-group ${collapsed ? "collapsed" : ""} ${state.selectedProjectId === id ? "is-selected" : ""}" data-project="${esc(id)}">
        <div class="project-heading"><button class="project-row" type="button" data-project-id="${esc(id)}" aria-expanded="${!collapsed}" title="${esc(project.projectDirectory || project.workspaceRoot || "")}"><span class="project-disclosure" aria-hidden="true"><span class="project-chevron">${icon("chevron-down")}</span><span class="project-folder">${icon(collapsed ? "folder" : "folder-open")}</span></span><span class="project-name">${esc(project.projectName)}</span>${question ? `<span class="project-question" role="img" aria-label="${esc(ui("有待回答的问题"))}"></span>` : ""}${collapsed && tasks.length ? `<span class="project-count">${tasks.length}</span>` : ""}</button><button class="project-settings" type="button" data-project-settings="${esc(id)}" aria-label="项目设置：${esc(project.projectName)}" title="项目设置">${icon("more")}</button><button class="project-create" type="button" data-project-create="${esc(id)}" aria-label="在 ${esc(project.projectName)} 中新建会话" title="在此项目新建会话">${icon("plus")}</button></div>
        <div class="conversation-list" aria-label="${esc(project.projectName)}中的对话"><div class="project-rail-head"><span class="project-rail-name">${esc(project.projectName)}</span><button class="project-rail-action" type="button" data-rail-settings="${esc(id)}" aria-label="${esc(ui("项目设置"))}" title="${esc(ui("项目设置"))}">${icon("more")}</button><button class="project-rail-action" type="button" data-rail-create="${esc(id)}" aria-label="${esc(ui("新建会话"))}" title="${esc(ui("在此项目新建会话"))}">${icon("plus")}</button></div>${
          tasks
            .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
            .map(taskRow)
            .join("") || ui('<div class="project-empty" data-project-empty>还没有对话</div>')
        }</div></section>`;
        })
        .join("") || (temporary.length ? "" : ui('<div class="sidebar-empty-state">还没有项目</div>')));
    if (root.conversationMarkup === markup) return;
    root.conversationMarkup = markup;
    root.innerHTML = markup;
    root.scrollTop = scrollTop;
    root.querySelectorAll("[data-session-toggle]").forEach((node) =>
      node.addEventListener("click", () => {
        const id = node.dataset.sessionToggle;
        if (state.collapsedSessions?.has(id)) state.collapsedSessions.delete(id);
        else state.collapsedSessions?.add(id);
        render();
      })
    );
    root.querySelectorAll("[data-task]").forEach((node) =>
      node.addEventListener("click", () => {
        const task = state.tasks.find((entry) => entry.taskId === node.dataset.task);
        const project = projectForTask(task);
        if (project) select(project.projectId);
        selectConversation(node.dataset.task);
      })
    );
    // The context menu opens from the row itself: right click at the pointer,
    // Shift+F10 or the Menu key beside the row.
    root.querySelectorAll(".conversation-item[data-task]").forEach((node) => {
      node.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openTaskMenu(node, node.dataset.task, { at: { x: event.clientX, y: event.clientY } });
      });
      node.addEventListener("keydown", (event) => {
        if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
          event.preventDefault();
          openTaskMenu(node, node.dataset.task);
        }
      });
    });
    root.querySelectorAll("[data-quick-action]").forEach((node) =>
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        quickTaskAction(node.dataset.quickAction, node.dataset.quickTask);
      })
    );
    root
      .querySelectorAll("[data-project-create]")
      .forEach((node) => node.addEventListener("click", () => beginConversation(node.dataset.projectCreate)));
    root
      .querySelectorAll("[data-project-settings]")
      .forEach((node) => node.addEventListener("click", () => openSettings(node.dataset.projectSettings)));
    // The icon rail repeats the same two project commands inside its hover tree.
    root
      .querySelectorAll("[data-rail-create]")
      .forEach((node) => node.addEventListener("click", () => beginConversation(node.dataset.railCreate)));
    root
      .querySelectorAll("[data-rail-settings]")
      .forEach((node) => node.addEventListener("click", () => openSettings(node.dataset.railSettings)));
    root.querySelectorAll("[data-project-id]").forEach((node) =>
      node.addEventListener("click", () => {
        const id = node.dataset.projectId;
        select(id);
        if (!state.selected) beginConversation(id);
        if (state.collapsedProjects.has(id)) state.collapsedProjects.delete(id);
        else state.collapsedProjects.add(id);
        rememberCollapsed();
        render();
      })
    );
    // The icon rail's hover tree is a fixed panel, so it follows the icon it
    // belongs to. Delegated, because every render replaces the rows.
    if (!root.dataset.railPinned) {
      root.dataset.railPinned = "1";
      const pin = (event) => {
        const group = event.target.closest?.(".project-group");
        const heading = group?.querySelector(".project-heading");
        if (heading)
          group.style.setProperty(
            "--rail-flyout-top",
            `${Math.round(heading.getBoundingClientRect().top)}px`
          );
      };
      root.addEventListener("pointerover", pin);
      root.addEventListener("focusin", pin);
      // A question dot belongs to the folded project in the rail and to the
      // session in a wide tree, so crossing the breakpoint re-renders the rows.
      railWindow.addEventListener?.("change", () => render());
    }
    onRendered();
    const focusSelector = focusQuick
      ? `[data-quick-task="${CSS.escape(focusQuick[0])}"][data-quick-action="${focusQuick[1]}"]`
      : focusToggle
        ? `[data-session-toggle="${CSS.escape(focusToggle)}"]`
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
  const openCreateDialog = () => (openAddProject ? openAddProject() : openSettings());
  $("#new-project").addEventListener("click", () => openCreateDialog());
  return {
    render,
    /** The projects the tree actually shows; the work entry follows the same list. */
    visibleProjects,
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
        // eslint-disable-next-line no-restricted-syntax -- clearing the remembered project is optional; a storage that refuses the removal must not fail the backend reset
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
      $("#titlebar-new-session").disabled = false;
    },
    openCreate: () => openCreateDialog(),
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
