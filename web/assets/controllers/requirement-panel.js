import { agentDisplayName } from "../agent-names.js";
import { artifactRequestUrls, artifactVersion } from "../artifacts.js";
import { requirementProgress } from "../requirement-stages.js";
import { formatRunDuration, runElapsed } from "../run-overview.js";
import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../workbench/html.js";

const SOURCE_LABELS = { internal: "内部", external: "外部", legacy: "遗留" };
const ROUTE_LABELS = { quick: "快速", direct: "直接", full: "Full" };
const REFRESH_MS = 4_000;

const enc = encodeURIComponent;

function compactTokens(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const tokens = Number(value);
  // The panel reads out in the design's units: millions once a value is large.
  if (tokens >= 100_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

const shortCommit = (commit) => (typeof commit === "string" ? commit.slice(0, 8) : "");
const baseName = (path) =>
  String(path || "")
    .split("/")
    .filter(Boolean)
    .at(-1) || String(path || "");

/**
 * The requirement panel: one conversation's requirement, its phase, criteria,
 * change, attachments and usage.
 *
 * The panel reads the records the backend keeps — the Main session's
 * requirement, the ledger requirement, the delivery view and the published
 * artifacts — and renders the phase through the shared mapping, so it never
 * invents progress the records do not show. Reads are keyed to the selected
 * Task and dropped when the selection moves; a refresh keeps the previous
 * records on screen until new ones arrive.
 */
export function createRequirementPanel({
  state,
  $,
  api,
  onCollapse,
  openArtifact,
  openResource,
  openPreview,
  iconForDocument,
  onRendered = () => {}
}) {
  let loaded = null;
  let loading = null;
  let epoch = 0;
  let expanded = false;
  let bodySignature;
  let usageSignature;

  const selectedProjectId = () => {
    const detail = state.detail;
    return detail?.projectId ?? detail?.task?.projectId ?? null;
  };

  /** The workbench names sprite symbols with their `i-` prefix; the icon helper adds it. */
  const documentIcon = (row) => icon(String(iconForDocument(row) || "i-file").replace(/^i-/, ""));

  /** The records behind the selected conversation, or what is missing to show. */
  async function readRecords(taskId, projectId) {
    let sessions;
    try {
      sessions = await api(`/api/projects/${enc(projectId)}/main-sessions`, { cache: "no-store" });
    } catch (error) {
      // A directory that is not a shared project has no requirement records;
      // the conversation's attachments and usage still apply.
      if (error?.status === 404) return {};
      throw error;
    }
    const session = (sessions.sessions || []).find((entry) => entry.taskId === taskId);
    let requirementId = session?.currentRequirementId;
    if (!requirementId) {
      // A conversation that predates sessions still records its development.
      // The Task-scoped list is a project read, so the Task itself decides.
      const developments = await api(`/api/tasks/${enc(taskId)}/developments`, { cache: "no-store" });
      requirementId = (developments.developments || []).find(
        (entry) => entry.taskId === taskId
      )?.requirementId;
    }
    if (!requirementId) return { session };
    const requirement = (
      await api(`/api/projects/${enc(projectId)}/ledger/${enc(requirementId)}`, { cache: "no-store" })
    ).requirement;
    let view;
    try {
      view = (
        await api(`/api/projects/${enc(projectId)}/deliveries`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "view", requirementId })
        })
      ).view;
    } catch (error) {
      // 没有开发记录是正常状态；其它读取失败交由外层显示重试，不能当成“还没有开发”。
      if (error?.status !== 404) throw error;
    }
    return { session, requirement, view };
  }

  function start(taskId) {
    const projectId = selectedProjectId();
    const current = ++epoch;
    loading = (async () => {
      try {
        const records = await readRecords(taskId, projectId);
        if (current !== epoch) return;
        loaded = { taskId, projectId, at: Date.now(), ...records };
      } catch (error) {
        if (current !== epoch) return;
        loaded = { taskId, projectId, at: Date.now(), error: error.message };
      } finally {
        if (current === epoch) {
          loading = null;
          render();
        }
      }
    })();
  }

  function ensure(taskId) {
    if (loaded?.taskId !== taskId || loaded.projectId !== selectedProjectId()) {
      loaded = null;
      bodySignature = undefined;
      usageSignature = undefined;
      start(taskId);
      return;
    }
    if (loading || Date.now() - loaded.at < REFRESH_MS) return;
    const current = ++epoch;
    loading = (async () => {
      try {
        const records = await readRecords(taskId, selectedProjectId());
        if (current !== epoch || state.selected !== taskId) return;
        loaded = { taskId, projectId: selectedProjectId(), at: Date.now(), ...records };
        render();
        // eslint-disable-next-line no-restricted-syntax -- 一次刷新失败保留上一次记录，面板不因轮询失败清空
      } catch {
        /* keep the last records */
      } finally {
        if (current === epoch) loading = null;
      }
    })();
  }

  function reset() {
    epoch += 1;
    loading = null;
    loaded = null;
    bodySignature = undefined;
    usageSignature = undefined;
    expanded = false;
  }

  function progressOf() {
    const view = loaded?.view;
    return requirementProgress({
      requirement: loaded?.requirement,
      board: view?.board,
      development: view?.development,
      plan: view?.plan,
      reviews: view?.reviews,
      merges: view?.merges,
      delivery: view?.delivery,
      roles: view?.roles,
      waitingForReply: (state.detail?.humanRequests || []).some((request) => request.status === "pending")
    });
  }

  // ---- rendering -------------------------------------------------------------

  function tagValues(requirement, view, session) {
    const values = [];
    const source = requirement.source?.kind;
    if (source) values.push(ui(SOURCE_LABELS[source] ?? source));
    const route = view?.development?.route;
    if (route) values.push(ui(ROUTE_LABELS[route] ?? route));
    const owner = view?.board?.assignment;
    if (owner?.kind === "user") values.push(ui("归属 我"));
    else if (owner?.actorId) values.push(ui`归属 ${agentDisplayName(owner.actorId)}`);
    if (!owner && session?.kind === "continuation") values.push(ui("接续"));
    return values;
  }

  function renderStepper(progress) {
    return `<ol class="rp-stepper" data-stage="${esc(progress.stage)}" aria-label="${ui("需求阶段")}">${progress.steps
      .map((step) => {
        const node =
          step.state === "done"
            ? `<span class="rp-node">${icon("check")}</span>`
            : step.state === "pending"
              ? '<span class="rp-node is-pending"></span>'
              : '<span class="rp-node is-current"><span class="rp-pulse"></span></span>';
        const current = step.state === "current" || step.state === "blocked";
        return `<li class="rp-step" data-step="${esc(step.id)}" data-state="${esc(
          step.state
        )}"${current ? ' aria-current="step"' : ""}><span class="rp-rail">${node}</span><span class="rp-step-text"><span class="rp-step-label">${esc(
          ui(step.label)
        )}</span><span class="rp-spacer"></span><span class="rp-step-meta">${esc(step.meta)}</span></span></li>`;
      })
      .join("")}</ol>`;
  }

  function renderCriteria(criteria) {
    if (!criteria.length) return "";
    return `<section class="rp-section"><h3 class="rp-label">${ui("完成标准")}</h3><ul class="rp-checks">${criteria
      .map(
        (entry) =>
          `<li class="rp-check" data-checked="${entry.checked}">${icon("circle-check")}<span>${esc(entry.text)}</span></li>`
      )
      .join("")}</ul></section>`;
  }

  function renderChanges(view) {
    const diff = view?.diff;
    const merge = [...(view?.merges || [])].reverse().find((entry) => entry.state === "merged");
    if (!diff && !merge) return "";
    const commit = shortCommit(diff?.candidateCommit ?? merge?.candidate?.commit);
    const files = diff?.files || [];
    return `<section class="rp-section"><h3 class="rp-label">${ui("改动")}</h3><div class="rp-diff-card">${
      commit
        ? `<div class="rp-diff-commit">${icon("git-commit")}<span>${ui`候选 ${commit}`}</span><span class="rp-spacer"></span>${
            files.length
              ? `<button type="button" class="rp-link" data-open-diff>${ui("查看 diff")}</button>`
              : ""
          }</div>`
        : ""
    }${files
      .map(
        (file) =>
          `<button type="button" class="rp-diff-file" data-open-file="${esc(file.path)}"><span class="rp-file">${documentIcon(
            { relativePath: file.path, mimeType: "" }
          )}<span class="rp-file-name">${esc(file.path)}</span></span><span class="rp-spacer"></span><span class="rp-add">+${Number(
            file.additions
          )}</span><span class="rp-del">−${Number(file.deletions)}</span></button>`
      )
      .join("")}</div></section>`;
  }

  function attachmentRows() {
    const detail = state.detail || {};
    const artifacts = detail.artifacts || [];
    const rows = detail.applications?.deliverables ?? artifacts;
    return rows.map((row) => {
      const isResource = row.kind === "resource";
      const path = isResource ? row.files?.[0]?.relativePath : row.relativePath;
      const artifact = artifacts.find((entry) => entry.relativePath === path) || { relativePath: path };
      // Published files carry their friendly name on the artifact record; a
      // resource row names itself. The path is only the last fallback.
      const name = row.name || row.displayName || artifact.displayName || baseName(path);
      const href = path
        ? artifactRequestUrls(state.selected, path, artifactVersion(artifact)).downloadUrl
        : "";
      return `<span class="rp-attachment" role="button" tabindex="0" ${
        isResource ? `data-resource-row="${esc(row.resourceId)}"` : `data-artifact="${esc(path)}"`
      } title="${esc(path || name)}">${
        isResource ? icon("layers") : documentIcon(artifact)
      }<span class="rp-attachment-name">${esc(name)}</span><span class="rp-spacer"></span>${
        href
          ? `<a class="rp-download" href="${esc(href)}" download="${esc(name)}" aria-label="${ui`下载 ${name}`}" title="${ui`下载 ${name}`}">${icon("download")}</a>`
          : ""
      }</span>`;
    });
  }

  function renderAttachments() {
    const rows = attachmentRows();
    if (!rows.length) return "";
    return `<section class="rp-section"><h3 class="rp-label">${ui("附件")}</h3><div class="rp-attachments" id="output-list">${rows.join(
      ""
    )}</div></section>`;
  }

  function bodyMarkup() {
    if (!state.selected) return "";
    // Files published by the conversation are its own records, so they stay
    // reachable even when no requirement is linked to it.
    const attachments = renderAttachments();
    if (!loaded) return attachments;
    if (loaded.error)
      return `<p class="rp-error" role="alert">${esc(loaded.error)}<button type="button" class="rp-link" data-retry>${ui("重试")}</button></p>${attachments}`;
    if (!loaded.requirement) return attachments;
    const progress = progressOf();
    const values = tagValues(loaded.requirement, loaded.view, loaded.session);
    return `<div class="rp-identity"><h3 class="rp-title" title="${esc(loaded.requirement.title)}">${esc(
      loaded.requirement.title
    )}</h3>${
      values.length
        ? `<div class="rp-tags">${values.map((value) => `<span class="rp-tag">${esc(value)}</span>`).join("")}</div>`
        : ""
    }</div>${renderStepper(progress)}${renderCriteria(progress.criteria)}${renderChanges(loaded.view)}${attachments}`;
  }

  function modelName() {
    const model = state.detail?.runtime?.model;
    return model ? String(model).split("/").pop() : "";
  }

  function usageModel() {
    const statistics = state.detail?.statistics;
    const view = loaded?.view;
    const agents = statistics?.agents || [];
    const roleAgent = (role) => {
      const entry = (view?.roles || []).find((candidate) => candidate.role === role);
      return { entry, agent: entry ? agents.find((agent) => agent.agentId === entry.agentId) : undefined };
    };
    const main = agents.find((agent) => agent.agentId === "main");
    const executor = roleAgent("executor");
    const reviewer = roleAgent("reviewer");
    const roles = [
      { id: "main", name: ui("Main"), agent: modelName(), usage: main?.usage?.totalTokens ?? null },
      {
        id: "executor",
        name: ui("Executor"),
        agent: executor.entry ? agentDisplayName(executor.entry.agentId) : "",
        usage: executor.agent?.usage?.totalTokens ?? null
      },
      {
        id: "reviewer",
        name: ui("Reviewer"),
        agent: reviewer.entry ? agentDisplayName(reviewer.entry.agentId) : "",
        usage: reviewer.agent?.usage?.totalTokens ?? null
      }
    ].filter((role) => role.id === "main" || role.agent);
    const largest = Math.max(1, ...roles.map((role) => Number(role.usage) || 0));
    const activityAgents = state.detail?.task?.activity?.agents || [];
    const toolCalls = activityAgents.reduce(
      (sum, agent) =>
        sum + (agent.samples || []).reduce((count, sample) => count + (sample.toolCalls || 0), 0),
      0
    );
    const subagents = agents.filter((agent) => agent.agentId !== "main").length;
    const reworks = (view?.reviews || []).reduce((count, review) => count + (review.reworks?.length || 0), 0);
    const workspace = view?.development?.workspace?.directory;
    return {
      available: Boolean(statistics),
      total: statistics?.usage?.totalTokens ?? null,
      elapsed: formatRunDuration(runElapsed(statistics)),
      roles,
      largest,
      details: [
        { label: ui("工具调用"), value: toolCalls ? ui`${toolCalls} 次` : "—" },
        {
          label: ui("子 Agent"),
          value: subagents ? ui`${subagents} 个` : "—",
          note: reworks ? ui`${reworks} 次返修` : ""
        },
        { label: ui("工作目录"), value: workspace || "—", title: workspace },
        { label: ui("会话标识"), value: loaded?.session?.sessionId ?? "—", title: loaded?.session?.sessionId }
      ]
    };
  }

  function usageText(model) {
    const tokens = model.total === null ? ui("Token 未知") : `${compactTokens(model.total)} tokens`;
    return `${model.elapsed} · ${tokens}`;
  }

  function renderUsage(model) {
    if (!model.available) return "";
    const head = `<button type="button" class="rp-usage-head" data-usage-toggle aria-expanded="${expanded}" aria-controls="requirement-usage-detail">${icon(
      "gauge"
    )}<span class="rp-usage-label">${ui("用量")}</span><span class="rp-spacer"></span><span class="rp-usage-value">${esc(
      usageText(model)
    )}</span>${icon(expanded ? "chevron-down" : "chevron-right")}</button>`;
    if (!expanded) return `<div class="rp-usage" data-expanded="false">${head}</div>`;
    return `<div class="rp-usage" data-expanded="true">${head}<div class="rp-usage-body" id="requirement-usage-detail">${model.roles
      .map(
        (role) =>
          `<div class="rp-role" data-role="${esc(role.id)}"><div class="rp-role-top"><span class="rp-role-name">${esc(
            role.name
          )}</span><span class="rp-role-agent">${esc(role.agent)}</span><span class="rp-spacer"></span><span class="rp-role-value">${esc(
            compactTokens(role.usage)
          )}</span></div><div class="rp-role-track"><div class="rp-role-fill" style="width:${Math.round(
            ((Number(role.usage) || 0) / model.largest) * 100
          )}%"></div></div></div>`
      )
      .join("")}<div class="rp-divider"></div><div class="rp-exec"><div class="rp-exec-title">${ui(
      "执行细节"
    )}</div>${model.details
      .map(
        (detail) =>
          `<div class="rp-kv"><span>${esc(detail.label)}</span><span class="rp-spacer"></span><span title="${esc(
            detail.title ?? detail.value
          )}">${esc(detail.value)}${detail.note ? ` · ${esc(detail.note)}` : ""}</span></div>`
      )
      .join("")}</div></div></div>`;
  }

  function bindBody() {
    const body = $("[data-requirement-body]");
    if (!body) return;
    body.querySelector("[data-retry]")?.addEventListener("click", () => {
      loaded = null;
      bodySignature = undefined;
      epoch += 1;
      render();
    });
    body.querySelector("[data-open-diff]")?.addEventListener("click", () => openPreview({ tab: "diff" }));
    for (const node of body.querySelectorAll("[data-open-file]"))
      node.addEventListener("click", () => openPreview({ tab: "file", path: node.dataset.openFile }));
    const activate = (node, run) => {
      const open = (event) => {
        if (event.target.closest(".rp-download")) return;
        run();
      };
      node.addEventListener("click", open);
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open(event);
        }
      });
    };
    for (const node of body.querySelectorAll("[data-artifact]"))
      activate(node, () => openArtifact(node.dataset.artifact));
    for (const node of body.querySelectorAll("[data-resource-row]"))
      activate(node, () => void openResource(node.dataset.resourceRow));
  }

  function bindUsage() {
    const toggle = $("[data-requirement-usage] [data-usage-toggle]");
    toggle?.addEventListener("click", () => {
      expanded = !expanded;
      usageSignature = undefined;
      render();
      $("[data-requirement-usage] [data-usage-toggle]")?.focus();
    });
  }

  function render() {
    if (!$("[data-requirement-panel]")) return;
    // The selected requirement's phase also labels the run bar, so the records
    // are read even while the panel itself is collapsed. The panel keeps its
    // last rendering for the moment it reopens.
    // A temporary workspace belongs to no project, so it has no requirement
    // records to read; the conversation's own usage still applies.
    if (state.selected && selectedProjectId()) ensure(state.selected);
    onRendered(loaded?.requirement ? progressOf().label : "");
    if (document.body.classList.contains("output-collapsed")) return;
    const body = $("[data-requirement-body]");
    const usage = $("[data-requirement-usage]");
    if (!body || !usage) return;
    const model = usageModel();
    const signature = JSON.stringify([
      state.selected,
      loaded?.error ?? null,
      loaded?.session ?? null,
      loaded?.requirement ?? null,
      loaded?.view
        ? [
            loaded.view.stage,
            loaded.view.diff,
            loaded.view.reviews,
            loaded.view.merges,
            loaded.view.roles,
            loaded.view.development?.route,
            loaded.view.board?.assignment
          ]
        : null,
      (state.detail?.applications?.deliverables ?? state.detail?.artifacts ?? []).map((row) => [
        row.relativePath,
        row.resourceId,
        row.name,
        row.files?.map((file) => file.relativePath),
        artifactVersion(row)
      ])
    ]);
    if (signature !== bodySignature) {
      bodySignature = signature;
      const scrollTop = body.scrollTop;
      body.innerHTML = bodyMarkup();
      body.scrollTop = scrollTop;
      bindBody();
    }
    const nextUsage = JSON.stringify([
      model.available,
      expanded,
      model.roles,
      model.details.map((detail) => detail.label)
    ]);
    if (nextUsage !== usageSignature) {
      usageSignature = nextUsage;
      usage.innerHTML = renderUsage(model);
      bindUsage();
    }
    const value = usage.querySelector(".rp-usage-value");
    if (value) value.textContent = usageText(model);
  }

  return {
    render,
    reset,
    /** The records the panel already read, for the caller that opens the preview drawer. */
    records: () => loaded,
    progress: () => (loaded?.requirement ? progressOf() : null),
    /** Re-read after the conversation's records changed outside polling. */
    reload() {
      if (!state.selected) return;
      loaded = null;
      bodySignature = undefined;
      epoch += 1;
      render();
    },
    setExpanded(value) {
      expanded = Boolean(value);
      usageSignature = undefined;
      render();
    },
    collapse: () => onCollapse()
  };
}
