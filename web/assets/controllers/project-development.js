import { createModal } from "../ui/modal.js";
import { icon } from "../ui/icons.js";
import { escapeHtml as esc } from "../workbench/html.js";

const routeLabel = { quick: "Quick", direct: "Direct", full: "Full" };
const statusLabel = { active: "进行中" };
const workspaceLabel = { ready: "现场就绪", failed: "现场未就绪" };
const channelLabel = { self: "Main 自检", independent: "独立审查", combined: "组合审查" };
const reviewStateLabel = { in_review: "审查中", passed: "通过", failed: "未通过", drifted: "漂移" };
const mergeStateLabel = {
  waiting: "等待合入",
  applying: "待同步",
  merged: "已合入",
  conflict: "合入冲突",
  check_failed: "检查未通过",
  failed: "合入失败"
};
const findingStateLabel = { open: "待裁定", fix_claimed: "待修复", fixed: "已修复", dismissed: "不采纳" };
const dismissalLabel = { false_positive: "误报", out_of_scope: "范围外", other: "其他" };
const reasonLabel = {
  review_plan_missing: "缺通道判断",
  review_checks_missing: "缺检查记录",
  review_missing: "缺独立审查",
  review_in_review: "审查未完成",
  review_failed: "审查未通过",
  review_drifted: "审查内容漂移",
  review_kind_mismatch: "缺组合审查",
  self_check_stale: "自检版本已变化",
  review_started: "审查已开始",
  candidate_changed: "候选已变化",
  candidate_workspace_dirty: "现场有未提交改动",
  findings_open: "有未处理发现"
};

const shortCommit = (commit) => (typeof commit === "string" ? commit.slice(0, 8) : "");
const shortCall = (callId) => (typeof callId === "string" ? callId.slice(-8) : "");

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
  let activeReview = { plan: null, reviews: [], qualification: null, merges: [] };
  let projectsSignature = "";

  const endpoint = (projectId, developmentId) =>
    `/api/projects/${encodeURIComponent(projectId)}/developments${
      developmentId ? `/${encodeURIComponent(developmentId)}` : ""
    }`;
  const reviewEndpoint = (projectId, developmentId) =>
    `/api/projects/${encodeURIComponent(projectId)}/reviews?developmentId=${encodeURIComponent(
      developmentId
    )}`;
  const mergeEndpoint = (projectId, developmentId) =>
    `/api/projects/${encodeURIComponent(projectId)}/merges?developmentId=${encodeURIComponent(
      developmentId
    )}`;
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
      const reviews = await api(reviewEndpoint(projectId, developmentId)).catch(() => ({}));
      if (current !== epoch || !visible(projectId)) return;
      const merges = await api(mergeEndpoint(projectId, developmentId)).catch(() => ({}));
      if (current !== epoch || !visible(projectId)) return;
      activeDevelopment = developmentId;
      activeReview = {
        plan: reviews.plan ?? null,
        reviews: reviews.reviews ?? [],
        qualification: reviews.qualification ?? null,
        merges: merges.merges ?? []
      };
      renderDetail(result.development, activeReview);
      renderList();
    } catch (error) {
      if (current === epoch && visible(projectId)) fail(error);
    }
  }

  function checksHtml(checks, label) {
    if (!checks?.length) return "";
    return `<ul class="development-checks" aria-label="${esc(label)}">${checks
      .map(
        (check) =>
          `<li><span>${esc(check.name)}</span><span>${
            check.exitCode === undefined ? "未运行" : `exit ${esc(check.exitCode)}`
          }</span>${check.command ? `<code>${esc(check.command)}</code>` : ""}</li>`
      )
      .join("")}</ul>`;
  }

  function findingsHtml(findings) {
    if (!findings?.length) return "";
    return `<ul class="development-findings">${findings
      .map((finding) => {
        const ruling = finding.ruling;
        return `<li data-finding="${esc(finding.findingId)}">
          <header><strong>${esc(finding.title)}</strong><span class="ledger-tags"><span>${esc(
            findingStateLabel[finding.state] ?? finding.state
          )}</span></span></header>
          <p class="ledger-source">${esc(finding.location ?? "")}${
            finding.fixedCommit
              ? ` · ${esc(shortCommit(finding.candidateCommit))} → ${esc(shortCommit(finding.fixedCommit))}`
              : ` · ${esc(shortCommit(finding.candidateCommit))}`
          }</p>
          ${checksHtml(finding.checks, "发现检查")}
          ${finding.rawFailure ? `<pre class="development-raw">${esc(finding.rawFailure)}</pre>` : ""}
          ${
            ruling
              ? `<p class="ledger-source">裁定：${
                  ruling.decision === "fix"
                    ? "修复"
                    : `不采纳（${esc(dismissalLabel[ruling.category] ?? ruling.category ?? "")}）`
                } · ${esc(ruling.basis)}</p>`
              : ""
          }
        </li>`;
      })
      .join("")}</ul>`;
  }

  function mergeHtml(merge) {
    if (!merge) return `<p class="ledger-source">未申请合入</p>`;
    const merged = merge.mergeCommit ? ` → ${esc(shortCommit(merge.mergeCommit))}` : "";
    return `<article class="development-merge" data-merge="${esc(merge.mergeId)}" data-state="${esc(
      merge.state
    )}">
      <header><strong>${esc(mergeStateLabel[merge.state] ?? merge.state)}</strong><span class="ledger-tags"><span>${esc(
        merge.targetBranch
      )}</span><span>${esc(shortCommit(merge.candidate?.commit))}${merged}</span></span></header>
      ${
        merge.combinedBase
          ? `<p class="ledger-source">组合版本 ${esc(shortCommit(merge.combinedBase))}</p>`
          : ""
      }
      ${checksHtml(merge.checks, "合入检查")}
      ${merge.detail ? `<p class="development-error" role="alert">${esc(merge.detail)}</p>` : ""}
    </article>`;
  }

  function reviewHtml(review) {
    return `<article class="development-review" data-review="${esc(review.reviewId)}">
      <header><strong>${esc(channelLabel[review.kind] ?? review.kind)}</strong><span class="ledger-tags"><span>${esc(
        reviewStateLabel[review.state] ?? review.state
      )}</span><span>${esc(shortCommit(review.candidate?.commit))}</span></span></header>
      <p class="ledger-source">${
        review.reviewer
          ? `审查者 ${esc(review.reviewer.agentId)} · 现场 ${esc(review.reviewer.workspace)}`
          : "尚未绑定独立审查会话"
      }</p>
      ${review.previousReviewId ? `<p class="ledger-source">复审 ${esc(shortCall(review.previousReviewId))} · 改动 ${esc((review.changedPaths ?? []).join("、") || "无")}</p>` : ""}
      ${findingsHtml(review.findings)}
      ${(review.reworks ?? [])
        .map(
          (rework) =>
            `<p class="ledger-source">返修 ${esc(shortCall(rework.fromCallId))} → ${esc(
              shortCall(rework.continuationCallId)
            )} · ${esc(rework.findingIds.map(shortCall).join("、"))}</p>`
        )
        .join("")}
      ${review.verdict ? `<p class="ledger-source">结论：${esc(review.verdict.summary)}</p>` : ""}
      ${checksHtml(review.verdict?.checks, "复审检查")}
      ${review.drift ? `<p class="development-error" role="alert">${esc(review.drift)}</p>` : ""}
    </article>`;
  }

  function renderDetail(development, review = activeReview) {
    if (!development) {
      detail.hidden = true;
      return;
    }
    activeDevelopment = development.developmentId;
    const workspace = development.workspace;
    const plan = review?.plan;
    const qualification = review?.qualification;
    const reviews = review?.reviews ?? [];
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
      <h3>自检</h3>
      ${
        plan
          ? `<p class="ledger-source">${esc(channelLabel[plan.channel] ?? plan.channel)} · ${esc(
              plan.basis
            )} · ${esc(shortCommit(plan.candidate?.commit))}</p>${checksHtml(plan.checks, "自检记录")}`
          : `<p class="ledger-source">未记录审查通道</p>`
      }
      <h3>独立审查</h3>
      ${reviews.length ? reviews.map(reviewHtml).join("") : `<p class="ledger-source">未冻结候选</p>`}
      <h3>交付</h3>
      <p class="ledger-source" data-qualification>${
        qualification
          ? qualification.eligible
            ? `可交付 · ${esc(shortCommit(qualification.approved?.commit))}`
            : (qualification.reasons ?? [])
                .map((reason) => reasonLabel[reason] ?? reason)
                .map((label) => esc(label))
                .join(" · ")
          : "尚不可判定"
      }</p>
      <h3>合入</h3>
      ${mergeHtml((review?.merges ?? []).at(-1))}
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
