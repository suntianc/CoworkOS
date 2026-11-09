import { agentDisplayName } from "../agent-names.js";
import {
  REQUIREMENT_TABS,
  requirementProgress,
  requirementTab,
  requirementTabCounts
} from "../requirement-stages.js";
import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { createModal } from "../ui/modal.js";
import { formatStamp } from "../ui/time-format.js";
import { createVisiblePoll } from "../ui/visible-poll.js";
import { escapeHtml as esc } from "../workbench/html.js";

/**
 * The observation requirement view: every connected node's requirements in one
 * list, with one requirement's recorded facts in the detail beside it.
 *
 * The view is read-only and reads only through the observation data port, so a
 * node's session and token never leave that node and a node that stops
 * answering only empties its own rows. The phase comes from the shared mapping
 * the work panel uses, so both surfaces name the same phase the same way.
 *
 * Two reads build a row: the project's Main sessions and board, which the port
 * aggregates per project, and one delivery view per requirement — the same
 * record set the work panel renders. A requirement without a development has
 * no view and keeps the phase its ledger and board records describe.
 */

const enc = encodeURIComponent;
const SOURCE_LABELS = { internal: "内部", external: "看板", legacy: "历史" };
const LEDGER_STATUS = { open: "有效", delivered: "已记录交付", withdrawn: "已撤回" };
const ROUTE_LABELS = { quick: "快速", direct: "直接", full: "Full" };
const REVIEW_LABEL = {
  in_review: "审查中",
  passed: "独立审查通过",
  failed: "审查未通过",
  drifted: "候选已变化"
};
const FINDING_LABEL = { open: "待处理", fix_claimed: "已声明修复", fixed: "已修复", dismissed: "已驳回" };
const PROJECT_READ_MS = 15_000;
const VIEW_READ_MS = 15_000;
const READ_CONCURRENCY = 4;

const shortCommit = (value) => (typeof value === "string" ? value.slice(0, 8) : "");
const projectPath = (projectId, suffix = "") => `/api/projects/${enc(projectId)}${suffix}`;
const readError = (error) => error?.message || ui("读取失败");

/** Run the reads in a few lanes so one slow node does not open a request per row. */
async function inLanes(items, limit, run) {
  let index = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await run(item);
    }
  });
  await Promise.all(lanes);
}

/**
 * @param {object} options
 * @param {HTMLElement} options.pane       the observation panel
 * @param {HTMLElement} options.detail     the detail column beside it
 * @param {HTMLElement} options.layout     the shell, which sizes the detail column
 * @param {object} options.data            the read-only observation port
 * @param {(message: string) => void} [options.showToast]
 * @param {() => Date} [options.now]
 */
export function createObserveRequirements({
  pane,
  detail,
  layout,
  data,
  showToast = () => {},
  now = () => new Date()
}) {
  const body = pane?.querySelector("[data-observe-requirements-list]");
  if (!body || !detail) return { render() {}, applyEntry() {}, refresh() {}, dispose() {} };
  const $ = (selector) => pane.querySelector(selector);
  const actions = $("[data-observe-requirements-actions]");
  const tabsNode = $("[data-observe-requirements-tabs]");
  const search = $("[data-observe-search]");
  const publishButton = $("[data-observe-publish]");

  /** projectId → { origin, sessions, board, at } */
  const projects = new Map();
  /** origin|projectId|requirementId → { view, at, absent } */
  const views = new Map();
  const pending = new Set();
  const publishRequests = new Map();
  let tab = "all";
  let query = "";
  let selected = null;
  let refreshTimer;

  const viewKey = (row) => `${row.origin}|${row.projectId}|${row.requirementId}`;
  const active = () => !pane.hidden;

  /* ------------------------------------------------------------------ reads */

  function scopeProjects() {
    return data.scoped({ ...data.filter(), projectId: "" }).projects;
  }

  function projectEntry(projectId, origin) {
    const cached = projects.get(projectId);
    if (cached?.origin === origin) return cached;
    const entry = { origin, sessions: [], board: [], at: 0 };
    projects.set(projectId, entry);
    return entry;
  }

  async function loadProject(project, force) {
    const origin = project.origins?.[0] ?? project.origin;
    const entry = projectEntry(project.projectId, origin);
    if (!force && entry.at && now().valueOf() - entry.at < PROJECT_READ_MS) return;
    const [sessions, board] = await Promise.all([
      data
        .read(origin, projectPath(project.projectId, "/main-sessions"))
        .then((result) => (Array.isArray(result?.sessions) ? result.sessions : []))
        // A node that cannot list its sessions still names the project's board
        // and requirements; only the handling session column stays empty.
        // eslint-disable-next-line no-restricted-syntax -- 读不到会话列表只少一列，项目的其余记录仍然要显示
        .catch(() => []),
      data
        .read(origin, projectPath(project.projectId, "/board"))
        .then((result) => (Array.isArray(result?.entries) ? result.entries : []))
        // eslint-disable-next-line no-restricted-syntax -- 读不到看板只影响归属与看板阶段，台账需求仍然要显示
        .catch(() => [])
    ]);
    entry.sessions = sessions;
    entry.board = board;
    entry.at = now().valueOf();
  }

  async function loadView(row, force) {
    const key = viewKey(row);
    const cached = views.get(key);
    if (pending.has(key)) return;
    if (!force && cached && now().valueOf() - cached.at < VIEW_READ_MS) return;
    pending.add(key);
    try {
      const result = await data.read(row.origin, projectPath(row.projectId, "/deliveries"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "view", requirementId: row.requirementId })
      });
      views.set(key, { view: result?.view, at: now().valueOf() });
    } catch (error) {
      // 404 is the documented "no development yet": the ledger and board still
      // describe the phase, so this is not a failure to show.
      if (error?.status === 404) views.set(key, { view: undefined, at: now().valueOf(), absent: true });
      else views.set(key, { view: cached?.view, at: cached?.at ?? 0, failed: readError(error) });
    } finally {
      pending.delete(key);
    }
  }

  async function refresh({ force = false } = {}) {
    const rows = data.scoped(data.filter()).requirements;
    const targets = new Map();
    for (const row of rows) {
      const project = targets.get(row.projectId);
      if (!project) targets.set(row.projectId, { projectId: row.projectId, origins: [row.origin] });
      else if (!project.origins.includes(row.origin)) project.origins.push(row.origin);
    }
    await Promise.all([...targets.values()].map((project) => loadProject(project, force)));
    const stale = rows.filter((row) => {
      const cached = views.get(viewKey(row));
      return force || !cached || now().valueOf() - cached.at >= VIEW_READ_MS;
    });
    await inLanes(stale, READ_CONCURRENCY, (row) => loadView(row, force));
    render();
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (active()) void refresh();
    }, 300);
  }

  /* ------------------------------------------------------------------- rows */

  function indexBy(list, key) {
    const index = new Map();
    for (const item of list) if (item?.[key]) index.set(item[key], item);
    return index;
  }

  function sessionFor(row, project) {
    const sessions = project?.sessions ?? [];
    return (
      sessions.find((session) => session.currentRequirementId === row.requirementId) ??
      sessions.find((session) => session.taskId === views.get(viewKey(row))?.view?.development?.taskId)
    );
  }

  function mergeFor(view, board, delivery) {
    const merged = [...(view?.merges ?? [])].reverse().find((entry) => entry?.state === "merged");
    if (merged)
      return { branch: merged.targetBranch, commit: merged.mergeCommit ?? merged.candidate?.commit };
    if (delivery) return { branch: delivery.targetBranch, commit: delivery.mergedCommit };
    if (board?.delivery) return { branch: "", commit: board.delivery.mergedCommit };
    return undefined;
  }

  /**
   * Who owns the requirement.
   *
   * A board need names its own assignee, and an unclaimed one has none. A need
   * recorded inside a project belongs to the person working this machine, so it
   * reads 我 instead of an empty cell.
   */
  function ownerFor(board, requirement) {
    const assignment = board?.assignment;
    if (!assignment) return requirement?.source?.kind === "internal" ? ui("我") : "";
    if (assignment.kind !== "main") return ui("我");
    const actor = assignment.actorId ?? "";
    return actor && !actor.startsWith("session:") ? agentDisplayName(actor) : ui("Main");
  }

  function rows() {
    const scope = data.filter();
    const tasks = indexBy(data.scoped(scope).tasks, "taskId");
    const projectNames = indexBy(data.scoped({ ...scope, projectId: "" }).projects, "projectId");
    return data
      .scoped(scope)
      .requirements.map((requirement) => {
        const project = projects.get(requirement.projectId);
        const board = (project?.board ?? []).find(
          (entry) => entry.requirementId === requirement.requirementId
        );
        const view = views.get(viewKey(requirement))?.view;
        const session = sessionFor(requirement, project);
        const facts = {
          requirement,
          board,
          development: view?.development,
          plan: view?.plan,
          reviews: view?.reviews,
          merges: view?.merges,
          delivery: view?.delivery,
          roles: view?.roles,
          waitingForReply: Boolean(session?.taskId && tasks.get(session.taskId)?.pendingQuestion)
        };
        const progress = requirementProgress(facts);
        return {
          ...requirement,
          key: viewKey(requirement),
          projectName: projectNames.get(requirement.projectId)?.projectName ?? "",
          facts,
          progress,
          tab: requirementTab(facts),
          source: SOURCE_LABELS[requirement.source?.kind] ?? requirement.source?.kind ?? "",
          session: session?.title ?? "",
          owner: ownerFor(board, requirement),
          merge: mergeFor(view, board, view?.delivery),
          view,
          at: requirement.updatedAt
        };
      })
      .sort((left, right) => String(right.at ?? "").localeCompare(String(left.at ?? "")));
  }

  function matching(list) {
    const text = query.trim().toLowerCase();
    if (!text) return list;
    return list.filter((row) =>
      [row.title, row.content, row.projectName].some((value) =>
        String(value ?? "")
          .toLowerCase()
          .includes(text)
      )
    );
  }

  /* ----------------------------------------------------------------- markup */

  function stamp(value) {
    return formatStamp(value, window.atriaPreferences?.format() ?? "relative", now().valueOf());
  }

  function tabMarkup(counts, current) {
    return REQUIREMENT_TABS.map(
      (entry) =>
        `<button type="button" role="tab" class="or-tab" data-observe-tab="${entry.id}" aria-selected="${
          entry.id === current
        }" tabindex="${entry.id === current ? 0 : -1}"><span class="or-tab-label">${esc(
          ui(entry.label)
        )}</span><span class="or-tab-count">${counts[entry.id] ?? 0}</span></button>`
    ).join("");
  }

  function rowMarkup(row, current) {
    const dash = (value) => (value ? esc(value) : "—");
    return `<div class="or-row${row.key === current ? " is-current" : ""}" role="row" data-observe-requirement="${esc(
      row.key
    )}" tabindex="0"${row.key === current ? ' aria-current="true"' : ""}>
      <span class="or-cell or-cell-title" role="cell"><span class="or-title">${esc(row.title)}</span>${
        row.source ? `<span class="or-source">${esc(ui(row.source))}</span>` : ""
      }</span>
      <span class="or-cell or-col-stage" role="cell"><span class="or-pill" data-stage="${esc(
        row.progress.stage
      )}"${row.progress.waiting ? ' data-waiting="true"' : ""}>${esc(ui(row.progress.label))}</span></span>
      <span class="or-cell or-col-session" role="cell" title="${esc(row.session)}">${dash(row.session)}</span>
      <span class="or-cell or-col-owner" role="cell">${dash(row.owner)}</span>
      <span class="or-cell or-col-commit" role="cell">${dash(row.merge?.commit ? shortCommit(row.merge.commit) : "")}</span>
      <span class="or-cell or-col-updated" role="cell">${esc(stamp(row.at))}</span>
    </div>`;
  }

  function setTitle() {
    const scope = data.filter();
    const project = scope.projectId
      ? data.scoped(scope).projects.find((entry) => entry.projectId === scope.projectId)
      : undefined;
    const title = pane.querySelector("#observe-title");
    if (title)
      title.textContent = project?.projectName ? ui`${ui("需求")} · ${project.projectName}` : ui("需求");
  }

  function focusedKey() {
    const focused = document.activeElement;
    return focused && body.contains(focused)
      ? focused.closest("[data-observe-requirement]")?.dataset.observeRequirement
      : undefined;
  }

  function render() {
    const all = matching(rows());
    const counts = requirementTabCounts(all.map((row) => row.facts));
    if (selected && !all.some((row) => row.key === selected)) selected = null;
    if (!pane.hidden) setTitle();
    if (tabsNode) tabsNode.innerHTML = tabMarkup(counts, tab);
    if (publishButton) publishButton.disabled = !scopeProjects().length;
    const visible = tab === "all" ? all : all.filter((row) => row.tab === tab);
    const restore = focusedKey();
    body.innerHTML = `<div class="or-table" role="table" aria-label="${esc(ui("需求"))}">
      <div class="or-row or-head" role="row">
        <span class="or-cell or-cell-title" role="columnheader">${esc(ui("需求"))}</span>
        <span class="or-cell or-col-stage" role="columnheader">${esc(ui("阶段"))}</span>
        <span class="or-cell or-col-session" role="columnheader">${esc(ui("处理会话"))}</span>
        <span class="or-cell or-col-owner" role="columnheader">${esc(ui("归属"))}</span>
        <span class="or-cell or-col-commit" role="columnheader">${esc(ui("合入"))}</span>
        <span class="or-cell or-col-updated" role="columnheader">${esc(ui("更新"))}</span>
      </div>${
        visible.length
          ? visible.map((row) => rowMarkup(row, selected)).join("")
          : `<div class="or-empty" role="row"><span class="or-cell" role="cell">${esc(
              ui(query.trim() ? "没有匹配的需求" : "没有需求")
            )}</span></div>`
      }</div>`;
    renderDetail(all.find((row) => row.key === selected) ?? null);
    if (restore) body.querySelector(`[data-observe-requirement="${CSS.escape(restore)}"]`)?.focus();
  }

  /* ----------------------------------------------------------------- detail */

  function detailTags(row) {
    const values = [row.progress.label];
    if (row.source) values.push(row.source);
    if (row.view?.development?.route)
      values.push(ROUTE_LABELS[row.view.development.route] ?? row.view.development.route);
    return values
      .map(
        (value, index) =>
          `<span class="or-tag"${
            index
              ? ""
              : ` data-stage="${esc(row.progress.stage)}"${
                  row.progress.waiting ? ' data-waiting="true"' : ""
                }`
          }>${esc(ui(value))}</span>`
      )
      .join("");
  }

  /** The five steps with the connector between each pair, as the design draws them. */
  function stepperMarkup(row) {
    return `<div class="or-stepper" role="list" data-stage="${esc(row.progress.stage)}" aria-label="${esc(
      ui("需求阶段")
    )}">${row.progress.steps
      .map((step, index) => {
        const node =
          step.state === "done"
            ? `<span class="or-step-node is-done">${icon("check")}</span>`
            : step.state === "pending"
              ? '<span class="or-step-node is-pending"></span>'
              : `<span class="or-step-node is-current"${step.state === "blocked" ? ' data-blocked="true"' : ""}></span>`;
        const connector =
          index === row.progress.steps.length - 1
            ? ""
            : `<span class="or-step-connector" aria-hidden="true"><span class="or-step-line" data-state="${esc(
                step.state
              )}"></span></span>`;
        return `<div class="or-step" role="listitem" data-step="${esc(step.id)}" data-state="${esc(step.state)}"${
          step.state === "current" || step.state === "blocked" ? ' aria-current="step"' : ""
        }><span class="or-step-rail">${node}</span><span class="or-step-label">${esc(ui(step.label))}</span></div>${connector}`;
      })
      .join("")}</div>`;
  }

  function factRow(key, value, { mono = false } = {}) {
    return `<div class="or-fact"><span class="or-fact-key">${esc(ui(key))}</span><span class="or-fact-value${
      mono ? " is-mono" : ""
    }">${esc(value || "—")}</span></div>`;
  }

  function criteriaSection(row) {
    const criteria = row.progress.criteria;
    if (!criteria.length) return "";
    const checked = criteria.filter((entry) => entry.checked).length;
    return `<section class="or-section" data-or-section="criteria"><h3 class="or-label">${esc(
      ui`完成标准 ${checked}/${criteria.length}`
    )}</h3><ul class="or-checks">${criteria
      .map(
        (entry) =>
          `<li data-checked="${entry.checked}">${icon("circle-check")}<span>${esc(entry.text)}</span></li>`
      )
      .join("")}</ul></section>`;
  }

  function reviewSection(row) {
    const review = [...(row.facts.reviews ?? [])].at(-1);
    if (!review) return "";
    const findings = review.findings ?? [];
    const outOfScope = findings.filter(
      (finding) => finding.ruling?.decision === "dismiss" && finding.ruling?.category === "out_of_scope"
    ).length;
    const conclusion = `<span class="or-review-text">${esc(ui(REVIEW_LABEL[review.state] ?? review.state))}</span>`;
    const head = findings.length
      ? `<button type="button" class="or-review" data-observe-review aria-expanded="false" aria-controls="or-review-findings">${icon(
          "shield-check"
        )}${conclusion}<span class="or-spacer"></span>${
          outOfScope ? `<span class="or-review-findings">${esc(ui`${outOfScope} 项范围外`)}</span>` : ""
        }${icon("chevron-right", "or-chevron")}</button>`
      : `<div class="or-review">${icon("shield-check")}${conclusion}</div>`;
    const list = findings.length
      ? `<ul class="or-findings" id="or-review-findings" hidden>${findings
          .map(
            (finding) =>
              `<li data-finding-state="${esc(finding.state)}"><span>${esc(
                finding.title
              )}</span><span class="or-spacer"></span><span class="or-finding-state">${esc(
                ui(FINDING_LABEL[finding.state] ?? finding.state)
              )}</span></li>`
          )
          .join("")}</ul>`
      : "";
    return `<section class="or-section" data-or-section="review"><h3 class="or-label">${esc(
      ui("审查")
    )}</h3>${head}${list}</section>`;
  }

  function changeSection(row) {
    const files = row.view?.diff?.files;
    if (!files?.length) return "";
    return `<section class="or-section" data-or-section="change"><h3 class="or-label">${esc(
      ui("改动")
    )}</h3>${files
      .map(
        (file) =>
          `<div class="or-file">${icon("file-code")}<span class="or-file-name" title="${esc(file.path)}">${esc(
            file.path
          )}</span><span class="or-spacer"></span><span class="or-add">+${
            Number(file.additions) || 0
          }</span><span class="or-del">−${Number(file.deletions) || 0}</span></div>`
      )
      .join("")}</section>`;
  }

  function renderDetail(row) {
    if (layout) layout.dataset.observeDetail = row ? "open" : "closed";
    detail.hidden = !row;
    if (!row) {
      detail.replaceChildren();
      return;
    }
    const merge = row.merge;
    detail.innerHTML = `<header class="or-detail-head"><span class="or-crumb">${esc(
      ui("需求详情")
    )}</span><span class="or-spacer"></span><button type="button" class="or-close" data-observe-detail-close aria-label="${esc(
      ui("关闭需求详情")
    )}">${icon("close")}</button></header>
      <div class="or-detail-body">
        <section class="or-identity">
          <h2 class="or-detail-title">${esc(row.title)}</h2>
          <div class="or-tags">${detailTags(row)}</div>
        </section>
        ${stepperMarkup(row)}
        <div class="or-facts">
          ${factRow("处理会话", row.session)}
          ${factRow("归属人", row.owner)}
          ${factRow(
            "合入",
            merge ? [merge.branch, shortCommit(merge.commit)].filter(Boolean).join(" · ") : "—",
            {
              mono: Boolean(merge?.commit)
            }
          )}
          ${factRow("台账", `v${row.revision} · ${ui(LEDGER_STATUS[row.status] ?? row.status ?? "")}`)}
        </div>
        ${criteriaSection(row)}
        ${reviewSection(row)}
        ${changeSection(row)}
      </div>`;
  }

  /* ---------------------------------------------------------------- actions */

  function select(key) {
    selected = key;
    render();
    body.querySelector(`[data-observe-requirement="${CSS.escape(key)}"]`)?.focus();
  }

  function chooseTab(id) {
    if (!REQUIREMENT_TABS.some((entry) => entry.id === id)) return;
    tab = id;
    render();
    tabsNode?.querySelector(`[data-observe-tab="${id}"]`)?.focus();
  }

  function openPublish() {
    const projects = scopeProjects();
    if (!projects.length) return;
    const scope = data.filter();
    const preferred = projects.find((project) => project.projectId === scope.projectId) ?? projects[0];
    const panel = document.createElement("div");
    panel.className = "modal-backdrop app-dialog-backdrop";
    panel.hidden = true;
    panel.innerHTML = `<section class="modal-card app-dialog or-publish" role="dialog" aria-modal="true" aria-labelledby="or-publish-title">
      <h2 id="or-publish-title">${esc(ui("发布到看板"))}</h2>
      <form novalidate>
        ${
          projects.length > 1
            ? `<label class="dialog-field">${esc(ui("项目"))}<select name="projectId">${projects
                .map(
                  (project) =>
                    `<option value="${esc(project.projectId)}"${
                      project.projectId === preferred.projectId ? " selected" : ""
                    }>${esc(project.projectName)}</option>`
                )
                .join("")}</select></label>`
            : ""
        }
        <label class="dialog-field">${esc(ui("标题"))}<input name="title" maxlength="200" required autocomplete="off"></label>
        <label class="dialog-field">${esc(
          ui("需求")
        )}<textarea name="content" rows="4" maxlength="20000" required></textarea></label>
        <p class="dialog-error" role="alert" data-error hidden></p>
        <div class="dialog-actions"><button class="app-button is-secondary" type="button" data-close>${esc(
          ui("取消")
        )}</button><button class="app-button is-primary" type="submit">${esc(ui("发布"))}</button></div>
      </form>
    </section>`;
    document.body.append(panel);
    const modal = createModal(panel, panel.querySelector("[data-close]"), { onClose: () => panel.remove() });
    const error = panel.querySelector("[data-error]");
    panel.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      void publish(panel, modal, error);
    });
    modal.open();
  }

  async function publish(panel, modal, error) {
    const form = panel.querySelector("form");
    const title = form.querySelector('[name="title"]').value.trim();
    const content = form.querySelector('[name="content"]').value.trim();
    const projects = scopeProjects();
    const wanted = form.querySelector('[name="projectId"]')?.value ?? data.filter().projectId;
    const project = projects.find((entry) => entry.projectId === wanted) ?? projects[0];
    if (!project || !title || !content) {
      error.textContent = ui("标题与需求内容不能为空");
      error.hidden = false;
      return;
    }
    // One publish is one board entry even if the click is repeated, so the
    // request id is kept per project until the call is answered.
    if (!publishRequests.has(project.projectId))
      publishRequests.set(
        project.projectId,
        globalThis.crypto?.randomUUID?.() ?? `publish-${now().valueOf()}-${project.projectId}`
      );
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    const origin = project.origins?.[0] ?? project.origin;
    try {
      await data.read(origin, projectPath(project.projectId, "/board"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "publish",
          requestId: publishRequests.get(project.projectId),
          title,
          content,
          source: { kind: "external" }
        })
      });
      publishRequests.delete(project.projectId);
      modal.close();
      showToast(ui("需求已发布"));
      await data.refreshRequirements(origin);
      await refresh({ force: true });
    } catch (failure) {
      submit.disabled = false;
      error.textContent = readError(failure);
      error.hidden = false;
    }
  }

  /* ----------------------------------------------------------------- events */

  const onClick = (event) => {
    if (event.target.closest("[data-observe-publish]")) {
      openPublish();
      return;
    }
    const tabButton = event.target.closest("[data-observe-tab]");
    if (tabButton) {
      chooseTab(tabButton.dataset.observeTab);
      return;
    }
    const row = event.target.closest("[data-observe-requirement]");
    if (row) select(row.dataset.observeRequirement);
  };
  pane.addEventListener("click", onClick);

  // A row is a focusable cell group, so Enter and Space open it like a button.
  const onKeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("[data-observe-requirement]");
    if (!row || event.target.closest("button")) return;
    event.preventDefault();
    select(row.dataset.observeRequirement);
  };
  pane.addEventListener("keydown", onKeydown);

  const onTabsKeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const index = REQUIREMENT_TABS.findIndex((entry) => entry.id === tab);
    if (index < 0) return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : REQUIREMENT_TABS.length - 1;
    chooseTab(REQUIREMENT_TABS[(index + step) % REQUIREMENT_TABS.length].id);
  };
  tabsNode?.addEventListener("keydown", onTabsKeydown);

  search?.addEventListener("input", () => {
    query = search.value;
    render();
  });

  const onDetailClick = (event) => {
    if (event.target.closest("[data-observe-detail-close]")) {
      selected = null;
      render();
      return;
    }
    const review = event.target.closest("[data-observe-review]");
    if (!review) return;
    const list = detail.querySelector(".or-findings");
    if (!list) return;
    const expanded = review.getAttribute("aria-expanded") === "true";
    review.setAttribute("aria-expanded", String(!expanded));
    review.querySelector(".or-chevron")?.classList.toggle("is-open", !expanded);
    list.hidden = expanded;
  };
  detail.addEventListener("click", onDetailClick);

  const unsubscribe = data.subscribe(() => {
    if (!active()) return;
    render();
    scheduleRefresh();
  });

  const poll = createVisiblePoll({
    run: () => refresh({ force: true }),
    intervalMs: VIEW_READ_MS,
    active: false
  });

  render();

  return {
    /** The entry or view changed: read only while the requirements view is shown. */
    applyEntry({ mode, observeView } = {}) {
      const shown = mode === "observe" && observeView === "requirements";
      // The panel's chrome belongs to this view, so the view decides when it is
      // shown instead of the entry controller hiding everything but one layer.
      if (actions) actions.hidden = !shown;
      if (tabsNode) tabsNode.hidden = !shown;
      poll.setActive(Boolean(shown) && active());
      if (!shown) return;
      render();
      void refresh();
    },
    render,
    refresh,
    dispose() {
      clearTimeout(refreshTimer);
      poll.dispose();
      unsubscribe?.();
      pane.removeEventListener("click", onClick);
      pane.removeEventListener("keydown", onKeydown);
      tabsNode?.removeEventListener("keydown", onTabsKeydown);
      detail.removeEventListener("click", onDetailClick);
    }
  };
}
