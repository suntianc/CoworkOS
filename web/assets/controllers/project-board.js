import { createModal } from "../ui/modal.js";
import { icon } from "../ui/icons.js";
import { escapeHtml as esc } from "../workbench/html.js";

const stateLabel = {
  pending: "待认领",
  claimed: "已认领",
  in_progress: "处理中",
  paused: "暂停",
  cancelled: "已取消"
};
const ownerLabel = (assignment) => {
  if (!assignment) return "";
  if (assignment.kind === "main") return `Main · ${assignment.handler?.taskId ?? ""}`;
  return "用户";
};

/**
 * The shared demand board view.
 *
 * Board facts are read from the serving backend, which may be the authority or
 * a secondary backend reading the same service. Internal ledger needs never
 * appear here: only external publishes create entries. Selection and the
 * publish draft belong to one backend and one project, so a switch or a late
 * response never moves them onto another selection.
 */
export function createProjectBoardController({ api, state, getBackend = () => "", showToast = () => {} }) {
  let panel, modal, list, detail, errorNode, projectSelect, publishForm;
  let epoch = 0;
  let activeProject = null;
  let activeEntry = null;
  let entries = [];
  let projectsSignature = "";
  let currentKey = null;
  const views = new Map();

  const keyFor = (projectId) => `${getBackend() || "default"}\u0000${projectId ?? ""}`;
  const endpoint = (projectId, boardId) =>
    `/api/projects/${encodeURIComponent(projectId)}/board${boardId ? `/${encodeURIComponent(boardId)}` : ""}`;
  const visible = (key) => Boolean(panel && !panel.hidden && currentKey === key);
  const viewFor = (key) => {
    let view = views.get(key);
    if (!view) {
      view = { boardId: null, publish: { title: "", content: "", reference: "" }, publishRequestId: null };
      views.set(key, view);
    }
    return view;
  };

  function install() {
    if (panel) return;
    panel = document.createElement("div");
    panel.className = "modal-backdrop settings-backdrop board-backdrop";
    panel.hidden = true;
    panel.innerHTML = `<section class="modal-card settings-card board-card" role="dialog" aria-modal="true" aria-labelledby="board-title">
      <header class="settings-heading">
        <h2 id="board-title">需求看板</h2>
        <label class="board-project"><select data-project aria-label="看板项目"></select></label>
        <button type="button" class="settings-nav-button" data-close aria-label="关闭需求看板">${icon("close")}</button>
      </header>
      <div class="settings-scroll board-scroll">
        <form data-publish class="board-publish">
          <label class="settings-field">标题<input name="title" aria-label="看板需求标题" maxlength="200" required></label>
          <label class="settings-field">需求<textarea name="content" aria-label="看板需求内容" rows="3" maxlength="20000" required placeholder="要解决的问题与约束"></textarea></label>
          <label class="settings-field">来源<input name="reference" aria-label="外部来源" maxlength="300" placeholder="渠道或会话"></label>
          <div class="board-actions"><button type="submit" class="app-button is-primary">发布需求</button></div>
        </form>
        <p role="alert" data-error hidden></p>
        <div class="board-columns">
          <ul data-list class="board-list" aria-label="看板需求列表"></ul>
          <article data-detail class="board-detail" hidden></article>
        </div>
      </div>
    </section>`;
    document.body.append(panel);
    const $ = (selector) => panel.querySelector(selector);
    list = $("[data-list]");
    detail = $("[data-detail]");
    errorNode = $("[data-error]");
    projectSelect = $("[data-project]");
    publishForm = $("[data-publish]");
    modal = createModal(panel, $("[data-close]"), {
      onClose() {
        epoch += 1;
      }
    });
    projectSelect.addEventListener("change", () => {
      activeProject = state.projects?.find((project) => project.projectId === projectSelect.value) ?? null;
      activeEntry = null;
      detail.hidden = true;
      enterKey(keyFor(activeProject?.projectId));
      void load();
    });
    publishForm.addEventListener("input", () => saveDraft());
    publishForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void publish();
    });
    list.addEventListener("click", (event) => {
      const button = event.target.closest("[data-board]");
      if (button) void select(button.dataset.board);
    });
    detail.addEventListener("click", (event) => {
      const button = event.target.closest("[data-board-action]");
      if (button) void act(button.dataset.boardAction);
    });
  }

  function saveDraft() {
    if (!currentKey) return;
    const view = viewFor(currentKey);
    view.publish = {
      title: publishForm.querySelector('[name="title"]').value,
      content: publishForm.querySelector('[name="content"]').value,
      reference: publishForm.querySelector('[name="reference"]').value
    };
  }

  function saveView() {
    if (!currentKey) return;
    const view = viewFor(currentKey);
    if (panel) saveDraft();
    view.boardId = activeEntry?.boardId ?? view.boardId;
  }

  function restoreView(key) {
    const view = viewFor(key);
    publishForm.querySelector('[name="title"]').value = view.publish.title;
    publishForm.querySelector('[name="content"]').value = view.publish.content;
    publishForm.querySelector('[name="reference"]').value = view.publish.reference;
    activeEntry = null;
    detail.hidden = true;
    view.boardId = view.boardId ?? null;
  }

  function enterKey(key) {
    if (key === currentKey) return;
    saveView();
    currentKey = key;
    restoreView(key);
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
    projectSelect.disabled = projects.length === 0;
    publishForm.querySelector("button[type=submit]").disabled = projects.length === 0;
  }

  function chooseProject() {
    const projects = state.projects ?? [];
    const preferred =
      projects.find((project) => project.projectId === activeProject?.projectId) ||
      projects.find((project) => project.projectId === state.selectedProjectId) ||
      projects[0];
    if (preferred && preferred.projectId !== activeProject?.projectId) {
      activeProject = preferred;
      activeEntry = null;
      detail.hidden = true;
    }
    pickProject(preferred?.projectId);
    return preferred;
  }

  function fail(error) {
    errorNode.textContent = error?.message || "看板请求失败";
    errorNode.hidden = false;
  }

  function clearError() {
    errorNode.textContent = "";
    errorNode.hidden = true;
  }

  async function load() {
    if (!activeProject) {
      entries = [];
      renderList();
      return;
    }
    const key = currentKey;
    const projectId = activeProject.projectId;
    const current = ++epoch;
    clearError();
    try {
      const result = await api(endpoint(projectId));
      if (current !== epoch || key !== currentKey || !visible(key)) return;
      entries = result.entries ?? [];
      renderList();
      const wanted = viewFor(key).boardId;
      if (wanted) await select(wanted, current);
    } catch (error) {
      if (current === epoch && key === currentKey && visible(key)) fail(error);
    }
  }

  function renderList() {
    if (!entries.length) {
      list.innerHTML = `<li class="board-empty">没有看板需求</li>`;
      return;
    }
    list.innerHTML = entries
      .map((entry) => {
        const owner = ownerLabel(entry.assignment);
        return `<li><button type="button" data-board="${esc(entry.boardId)}" ${
          entry.boardId === activeEntry?.boardId ? 'aria-current="true"' : ""
        }>
          <strong>${esc(entry.title)}</strong>
          <span class="board-tags"><span>${esc(stateLabel[entry.state] ?? entry.state)}</span>${
            owner ? `<span>${esc(owner)}</span>` : ""
          }<span>v${esc(entry.revision)}</span></span>
        </button></li>`;
      })
      .join("");
  }

  async function select(boardId, parentEpoch) {
    if (!activeProject) return;
    const key = currentKey;
    const projectId = activeProject.projectId;
    const current = parentEpoch ?? ++epoch;
    try {
      const result = await api(endpoint(projectId, boardId));
      if (current !== epoch || key !== currentKey || !visible(key)) return;
      activeEntry = result.entry;
      viewFor(key).boardId = boardId;
      renderDetail(result.entry);
      renderList();
    } catch (error) {
      if (current === epoch && key === currentKey && visible(key)) fail(error);
    }
  }

  function renderDetail(entry) {
    if (!entry) {
      detail.hidden = true;
      return;
    }
    activeEntry = entry;
    const owner = ownerLabel(entry.assignment);
    const canPause = entry.state === "claimed" || entry.state === "in_progress";
    const canRelease = canPause || entry.state === "paused";
    const canCancel = canRelease || entry.state === "pending";
    detail.hidden = false;
    detail.innerHTML = `<header><strong>${esc(entry.title)}</strong><span class="board-tags"><span>${esc(
      stateLabel[entry.state] ?? entry.state
    )}</span><span>v${esc(entry.revision)}</span></span></header>
      ${entry.source?.reference ? `<p class="board-source">${esc(entry.source.reference)}</p>` : ""}
      <p class="board-content">${esc(entry.content)}</p>
      <p class="board-assignee" data-assignee>${owner ? `归属：${esc(owner)}` : "尚未认领"}</p>
      <div class="board-actions">${
        entry.state === "pending"
          ? `<button type="button" class="app-button is-primary" data-board-action="claim">认领</button>`
          : ""
      }${canPause ? `<button type="button" class="app-button" data-board-action="pause">暂停</button>` : ""}${
        canRelease ? `<button type="button" class="app-button" data-board-action="release">释放</button>` : ""
      }${
        canCancel
          ? `<button type="button" class="app-button is-danger" data-board-action="cancel" title="取消后该需求不再可认领">取消</button>`
          : ""
      }</div>`;
  }

  function requestId(action, entry) {
    return `board-${action}-${entry.boardId}-${entry.revision}`;
  }

  async function act(action) {
    if (!activeProject || !activeEntry) return;
    const key = currentKey;
    const projectId = activeProject.projectId;
    const entry = activeEntry;
    const current = ++epoch;
    try {
      const result = await api(endpoint(projectId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          boardId: entry.boardId,
          expectedRevision: entry.revision,
          requestId: requestId(action, entry)
        })
      });
      if (current !== epoch || key !== currentKey || !visible(key)) return;
      clearError();
      activeEntry = result.entry;
      viewFor(key).boardId = result.entry.boardId;
      renderDetail(result.entry);
      showToast(
        action === "claim"
          ? "已认领"
          : action === "pause"
            ? "已暂停"
            : action === "release"
              ? "已释放"
              : "已取消"
      );
      await load();
    } catch (error) {
      if (current === epoch && key === currentKey && visible(key)) {
        // A stale revision or an offline backend keeps the selected entry and
        // the draft exactly where the user left them.
        fail(error);
        renderDetail(entry);
      }
    }
  }

  async function publish() {
    if (!activeProject) return;
    const key = currentKey;
    const projectId = activeProject.projectId;
    const view = viewFor(key);
    const title = publishForm.querySelector('[name="title"]').value.trim();
    const content = publishForm.querySelector('[name="content"]').value.trim();
    const reference = publishForm.querySelector('[name="reference"]').value.trim();
    saveDraft();
    if (!title || !content) {
      fail(new Error("标题与需求内容不能为空"));
      return;
    }
    view.publishRequestId ??=
      globalThis.crypto?.randomUUID?.() ?? `publish-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const current = ++epoch;
    try {
      const result = await api(endpoint(projectId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "publish",
          requestId: view.publishRequestId,
          title,
          content,
          source: { kind: "external", ...(reference ? { reference } : {}) }
        })
      });
      if (current !== epoch || key !== currentKey || !visible(key)) return;
      clearError();
      view.publish = { title: "", content: "", reference: "" };
      view.publishRequestId = null;
      publishForm.querySelector('[name="title"]').value = "";
      publishForm.querySelector('[name="content"]').value = "";
      publishForm.querySelector('[name="reference"]').value = "";
      activeEntry = result.entry;
      view.boardId = result.entry.boardId;
      showToast("需求已发布");
      await load();
    } catch (error) {
      if (current === epoch && key === currentKey && visible(key)) fail(error);
    }
  }

  return {
    /** Track catalog and backend changes; a hidden view picks them up on open. */
    render() {
      if (!panel) return;
      renderProjects();
      const preferred = chooseProject();
      enterKey(keyFor(preferred?.projectId));
      if (!panel.hidden) void load();
    },
    open(projectId) {
      install();
      renderProjects();
      if (projectId) {
        const project = state.projects?.find((entry) => entry.projectId === projectId);
        if (project) activeProject = project;
      }
      chooseProject();
      enterKey(keyFor(activeProject?.projectId));
      activeEntry = null;
      detail.hidden = true;
      modal.open();
      void load();
    },
    close() {
      modal?.close();
    },
    isOpen: () => Boolean(panel && !panel.hidden)
  };
}
