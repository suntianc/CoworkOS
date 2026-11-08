import { createModal } from "../ui/modal.js";
import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../workbench/html.js";

const kindLabel = { regular: "常规", continuation: "接续" };
const originLabel = { http: "页面", worker: "后台", cli: "CLI", internal: "内部" };

/**
 * The external Main service: its quotas and what is using them.
 *
 * The page shows the running Mains and the demands waiting for a slot, because
 * "third in line" is the user-visible consequence of a full service. Saving a
 * quota that the running work or the saved sessions exceed is refused by the
 * service with a reason, which this page shows unchanged.
 */
export function createMainCapacityController({ api, state = {}, showToast = () => {} }) {
  let panel, modal, form, errorNode, runningNode, queuedNode, projectsNode;
  let view = null;
  let loading = false;
  // Set once a person edits the quota form, so an async read or a background
  // refresh cannot overwrite the numbers they are typing.
  let quotaEdited = false;

  function install() {
    if (panel) return;
    panel = document.createElement("div");
    panel.className = "modal-backdrop settings-backdrop main-capacity-backdrop";
    panel.hidden = true;
    panel.innerHTML = `<section class="modal-card settings-card main-capacity-card" role="dialog" aria-modal="true" aria-labelledby="main-capacity-title">
      <header class="settings-heading">
        <h2 id="main-capacity-title">外部容量</h2>
        <button type="button" class="settings-nav-button" data-close aria-label="关闭外部容量">${icon("close")}</button>
      </header>
      <div class="settings-scroll main-capacity-scroll">
        <form data-quota class="main-capacity-quota">
          <label class="settings-field">常驻<input name="resident" type="number" min="1" max="32" step="1" required aria-label="常驻 Main 配额"></label>
          <label class="settings-field">接续<input name="continuation" type="number" min="0" max="32" step="1" required aria-label="接续 Main 配额"></label>
          <div class="main-capacity-actions"><button type="submit" class="app-button is-primary">${ui("保存")}</button></div>
        </form>
        <p role="alert" data-error hidden></p>
        <section class="main-capacity-section" aria-labelledby="main-capacity-running">
          <h3 id="main-capacity-running">运行中</h3>
          <ul data-running class="main-capacity-list"></ul>
        </section>
        <section class="main-capacity-section" aria-labelledby="main-capacity-queued">
          <h3 id="main-capacity-queued">排队</h3>
          <ul data-queued class="main-capacity-list"></ul>
        </section>
        <section class="main-capacity-section" aria-labelledby="main-capacity-projects">
          <h3 id="main-capacity-projects">项目会话</h3>
          <ul data-projects class="main-capacity-list"></ul>
        </section>
      </div>
    </section>`;
    document.body.append(panel);
    const $ = (selector) => panel.querySelector(selector);
    form = $("[data-quota]");
    errorNode = $("[data-error]");
    runningNode = $("[data-running]");
    queuedNode = $("[data-queued]");
    projectsNode = $("[data-projects]");
    modal = createModal(panel, $("[data-close]"));
    form.addEventListener("input", () => {
      quotaEdited = true;
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void save();
    });
    queuedNode.addEventListener("click", (event) => {
      const button = event.target.closest("[data-retry]");
      if (button) void retry(button.dataset.retry);
    });
  }

  function projectName(projectId) {
    return (
      view?.projects.find((project) => project.projectId === projectId)?.projectName ??
      state.projects?.find((project) => project.projectId === projectId)?.projectName ??
      projectId ??
      ""
    );
  }

  function fail(error) {
    errorNode.textContent = error?.message || "外部容量请求失败";
    errorNode.hidden = false;
  }

  function clearError() {
    errorNode.textContent = "";
    errorNode.hidden = true;
  }

  function renderRunning() {
    const running = view?.running ?? [];
    if (!running.length) {
      runningNode.innerHTML = '<li class="main-capacity-empty">没有运行中的外部 Main</li>';
      return;
    }
    runningNode.innerHTML = running
      .map(
        (entry) => `<li>
          <strong>${esc(projectName(entry.projectId))}</strong>
          <span class="main-capacity-tags"><span>${esc(
            kindLabel[entry.kind] ?? entry.kind
          )}</span><span>${esc(entry.taskId)}</span></span>
        </li>`
      )
      .join("");
  }

  function renderQueued() {
    const queued = view?.queued ?? [];
    if (!queued.length) {
      queuedNode.innerHTML = '<li class="main-capacity-empty">没有排队的 Main</li>';
      return;
    }
    queuedNode.innerHTML = queued
      .map((entry) => {
        const state = entry.state === "failed" ? "启动失败" : entry.state === "starting" ? "启动中" : "等待";
        return `<li${entry.lastError ? ` title="${esc(entry.lastError)}"` : ""}>
          <strong>${esc(projectName(entry.projectId))}</strong>
          <span class="main-capacity-tags"><span>第 ${entry.position} 位</span><span>${esc(
            kindLabel[entry.kind] ?? entry.kind
          )}</span><span>${esc(state)}</span><span>${esc(originLabel[entry.origin] ?? entry.origin)}</span>${
            entry.state === "failed"
              ? `<button type="button" class="main-capacity-retry" data-retry="${esc(
                  entry.requestId
                )}">${ui("重试")}</button>`
              : ""
          }</span>
        </li>`;
      })
      .join("");
  }

  function renderProjects() {
    const projects = (view?.projects ?? []).filter(
      (project) => project.regular > 0 || project.continuation > 0
    );
    if (!projects.length) {
      projectsNode.innerHTML = '<li class="main-capacity-empty">没有外部会话</li>';
      return;
    }
    projectsNode.innerHTML = projects
      .map(
        (project) => `<li>
          <strong>${esc(project.projectName)}</strong>
          <span class="main-capacity-tags"><span>常规 ${project.regular}</span>${
            project.continuation ? `<span>接续 ${project.continuation}</span>` : ""
          }</span>
        </li>`
      )
      .join("");
  }

  function renderView({ syncQuota = false } = {}) {
    if (!view) return;
    // A background refresh rerenders the running/queued lists but leaves the
    // quota inputs alone; otherwise it would overwrite what a person is typing.
    if (syncQuota) {
      form.querySelector('[name="resident"]').value = String(view.settings?.resident ?? "");
      form.querySelector('[name="continuation"]').value = String(view.settings?.continuation ?? "");
    }
    form.querySelector('button[type="submit"]').disabled = loading;
    renderRunning();
    renderQueued();
    renderProjects();
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      view = await api("/api/main-capacity");
      // A partial shared read is shown as unknown, never as no sessions.
      if (view.projectsComplete === false) fail(new Error(view.projectsError || "项目会话数暂时无法读取"));
      else clearError();
      renderView();
    } catch (error) {
      fail(error);
    } finally {
      loading = false;
      renderView({ syncQuota: !quotaEdited });
    }
  }

  async function retry(requestId) {
    if (loading) return;
    loading = true;
    renderView();
    try {
      view = await api("/api/main-capacity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "retry", requestId })
      });
      clearError();
      showToast?.("已重新排队");
    } catch (error) {
      fail(error);
    } finally {
      loading = false;
      renderView();
    }
  }

  async function save() {
    if (loading) return;
    // Read the typed values before anything re-renders the form from the
    // service view; otherwise the save would submit the numbers just loaded.
    const resident = Number(form.querySelector('[name="resident"]').value);
    const continuation = Number(form.querySelector('[name="continuation"]').value);
    const submit = form.querySelector('button[type="submit"]');
    loading = true;
    submit.disabled = true;
    try {
      view = await api("/api/main-capacity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "configure", resident, continuation })
      });
      clearError();
      quotaEdited = false;
      showToast?.("外部容量已更新");
      renderView({ syncQuota: true });
    } catch (error) {
      // A refused save keeps the typed values so the reason can be corrected.
      fail(error);
    } finally {
      loading = false;
      submit.disabled = false;
    }
  }

  return {
    render() {
      if (!panel) return;
      renderView();
    },
    open() {
      install();
      quotaEdited = false;
      clearError();
      modal.open();
      void load();
    },
    close() {
      modal?.close();
    },
    isOpen: () => Boolean(panel && !panel.hidden),
    /** The last capacity view this page read, for callers that reuse it. */
    get view() {
      return view;
    }
  };
}
