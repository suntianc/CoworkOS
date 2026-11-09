import { ui, language } from "./ui/language.js";
/** Read models for the goal workspace. No requests or DOM ownership here. */
import { renderMarkdown } from "./markdown.js";
export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
  );
export const title = (program) =>
  program.goal?.brief.title ??
  Array.from(program.objective?.split("\n")[0] ?? program.subject?.name ?? ui("持续跟进"))
    .slice(0, 60)
    .join("");
export const identity = (program) => `${program.taskId}/${program.programId}`;
export const date = (value) =>
  value
    ? new Date(value).toLocaleString(language, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      })
    : ui("尚未安排");
export function stateOf(program) {
  if (program.status === "completed") return { label: ui("已结束"), tone: "quiet" };
  if (program.status === "paused") return { label: ui("已暂停"), tone: "quiet" };
  if (["failed", "cancelled"].includes(program.taskStatus ?? program.task?.status))
    return { label: ui("需要检查"), tone: "attention" };
  if (program.goal?.disposition === "needs_input" && program.decision?.status !== "answered")
    return { label: ui("等你决定"), tone: "attention" };
  if (program.goal?.disposition === "needs_input" && program.decision?.status === "answered")
    return { label: ui("等待继续跟进"), tone: "waiting" };
  if (program.ownerError || program.task?.lastError) return { label: ui("需要检查"), tone: "attention" };
  if (program.status === "review_required") return { label: ui("需要检查"), tone: "attention" };
  if (program.goal?.pendingCommand || program.goal?.progressPending)
    return (program.taskStatus ?? program.task?.status) === "running"
      ? { label: ui("正在规划"), tone: "working" }
      : { label: ui("等待规划"), tone: "waiting" };
  return program.goal?.disposition === "wait"
    ? { label: ui("持续关注中"), tone: "waiting" }
    : { label: ui("正在跟进"), tone: "working" };
}
export const badge = (program) => {
  const state = stateOf(program);
  return `<span class="goal-status ${state.tone}"><i aria-hidden="true"></i>${esc(state.label)}</span>`;
};
export const icon = (name) => `<svg class="ui-icon" aria-hidden="true"><use href="#i-${name}" /></svg>`;
export const empty = (heading, copy, action = "") =>
  `<div class="goal-empty">${icon("bell")}<h3>${esc(heading)}</h3>${copy ? `<p>${esc(copy)}</p>` : ""}${action}</div>`;
const sourceLinks = (sources = []) =>
  sources
    .map((source) => {
      try {
        const url = new URL(source.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
        return `<a class="goal-source-link" href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(source.title || url.hostname)} ↗</a>`;
        // eslint-disable-next-line no-restricted-syntax -- 来源地址来自模型产出，可能不是合法绝对 URL，此时不渲染该来源链接
      } catch {
        return "";
      }
    })
    .join("");
export function card(program) {
  const state = stateOf(program);
  return `<button type="button" class="goal-item" data-view-key="goal-${esc(identity(program))}" data-goal-id="${esc(program.programId)}" data-goal-task="${esc(program.taskId)}"><div class="goal-item-top">${badge(program)}${program.unreadCount ? ui('<span class="goal-new-dot" aria-label="有未读动态"></span>') : ""}</div><h3>${esc(title(program))}</h3><p>${esc(program.goal?.waitingFor && state.tone === "attention" ? program.goal.waitingFor : (program.goal?.summary ?? program.objective))}</p><span class="goal-item-foot">${program.goal ? (state.tone === "attention" ? ui("查看并处理") : ui("查看进展")) : ui("查看监控")}${icon("chevron-right")}</span></button>`;
}
export function overview(data, { history, scope }) {
  const items = data.goals.filter(
    (goal) => (!scope || goal.taskId === scope) && (goal.status === "completed") === history
  );
  const attention = items.filter((goal) => stateOf(goal).tone === "attention");
  const paused = items.filter((goal) => goal.status === "paused");
  const following = items.filter((goal) => !attention.includes(goal) && !paused.includes(goal));
  const group = (name, goals) =>
    goals.length
      ? `<section class="goal-group"><div class="goal-group-heading"><h2>${name}</h2><span>${goals.length}</span></div><div class="goal-card-grid">${goals.map(card).join("")}</div></section>`
      : "";
  return ui`<h1 class="sr-only">长期任务</h1><div class="goal-list-toolbar"><div class="goal-segments" role="group" aria-label="目标范围"><button type="button" data-goal-filter="current" aria-pressed="${!history}">进行中</button><button type="button" data-goal-filter="history" aria-pressed="${history}">已结束</button></div><div class="goal-toolbar-actions">${scope ? ui('<button class="goal-text-button" type="button" data-goal-all>查看全部会话</button>') : ""}<button class="goal-primary" type="button" data-goal-new>${icon("plus")}新建目标</button></div></div><div data-goal-list>${group(ui("需要你处理"), attention)}${group(history ? ui("已结束的目标") : ui("正在替你关注"), following)}${paused.length ? ui`<details class="goal-paused-group" data-activity-key="paused-goals" ${following.length || attention.length ? "" : "open"}><summary>已暂停 <span>${paused.length}</span></summary><div class="goal-card-grid">${paused.map(card).join("")}</div></details>` : ""}${!items.length ? empty(history ? ui("暂无已结束的目标") : ui("暂无目标"), "") : ""}</div>`;
}
function readable(value, key) {
  const text = String(value ?? "");
  const html = renderMarkdown(text, { linkify: true });
  const body = `<div class="goal-markdown markdown-body">${html}</div>`;
  if (text.length <= 1200) return body;
  // Derive a plain preview from complete rendered blocks; slicing Markdown
  // itself can split links, code fences or emphasis markers.
  const preview = html
    .replace(/<[^>]*>/g, " ")
    .replace(
      /&(?:amp|lt|gt|quot|#39);/g,
      (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[entity]
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return ui`<details class="goal-readable" data-activity-key="body-${esc(key)}"><summary><span>${esc(preview)}…</span><small>完整内容</small></summary>${body}</details>`;
}
export function notice(entry, { global = false, updates = [], goal: program } = {}) {
  const ref = program ?? entry;
  const sources =
    entry.sources ??
    updates
      .filter((update) => entry.updateIds?.includes(update.updateId))
      .flatMap((update) => update.sources ?? []);
  const unique = [...new Map(sources.map((source) => [source.url, source])).values()];
  const kind =
    { decision: ui("需要决定"), important: ui("重要进展"), digest: ui("定期摘要"), routine: ui("新进展") }[
      entry.kind
    ] ?? ui("进展");
  return `<article class="goal-notice ${entry.readAt ? "" : "is-unread"}" data-view-key="notice-${esc(identity(ref))}-${esc(entry.notificationId)}" data-notice-id="${esc(entry.notificationId)}"><div class="goal-notice-meta"><span>${esc(global ? entry.goalTitle : kind)}</span><time datetime="${esc(entry.createdAt)}">${esc(date(entry.createdAt))}</time>${!entry.readAt ? ui('<span class="goal-new-dot" aria-label="未读"></span>') : ""}</div><h3>${esc(entry.title)}</h3>${readable(entry.summary, `${identity(ref)}-${entry.notificationId}`)}${unique.length ? `<div class="goal-evidence">${sourceLinks(unique)}</div>` : ""}<div class="goal-notice-actions">${global ? `<button type="button" class="goal-text-button" data-goal-id="${esc(ref.programId)}" data-goal-task="${esc(ref.taskId)}">${entry.kind === "decision" && !entry.readAt ? ui("查看并回答") : ui("查看目标")} →</button>` : ""}${!entry.readAt ? ui`<button type="button" class="goal-text-button" data-notice-read="${esc(entry.notificationId)}" data-goal-owner="${esc(ref.taskId)}" data-goal-program="${esc(ref.programId)}">标为已读</button>` : ""}</div></article>`;
}
export function activity(feed, unreadOnly) {
  return ui`<h1 class="sr-only">任务动态</h1><div class="goal-list-toolbar"><div class="goal-segments" role="group" aria-label="动态范围"><button type="button" data-feed-filter="all" aria-pressed="${!unreadOnly}">全部动态</button><button type="button" data-feed-filter="unread" aria-pressed="${unreadOnly}">未读${feed?.unreadCount ? ` · ${feed.unreadCount}` : ""}</button></div></div><div class="goal-activity-feed">${!feed ? ui('<p class="goal-loading" role="status">正在读取动态…</p>') : feed.notifications.length ? feed.notifications.map((entry) => notice(entry, { global: true })).join("") : empty(unreadOnly ? ui("暂无未读动态") : ui("暂无动态"), "")}${feed && feed.notifications.length < feed.total ? ui('<button type="button" class="goal-load-more" data-feed-more>加载更早动态</button>') : ""}</div>`;
}
function progress(program) {
  const goal = program.goal;
  const paused = program.status === "paused",
    closed = program.status === "completed";
  const notices = program.activity?.notifications ?? [];
  const question = goal.disposition === "needs_input" && !closed && program.decision?.status !== "answered";
  const decision = question
    ? ui`<section class="goal-decision"><span class="goal-eyebrow">需要你决定</span><h2>${esc(goal.waitingFor)}</h2><form data-goal-answer><label for="goal-answer">你的决定</label><textarea id="goal-answer" name="answer" placeholder="告诉 CoworkOS 你的选择…" maxlength="10000" required ${paused ? "disabled" : ""}></textarea><button type="submit" class="goal-primary" ${paused ? "disabled" : ""}>提交回答</button>${paused ? ui("<small>恢复目标后即可回答。</small>") : ""}</form></section>`
    : program.decision?.status === "answered"
      ? ui('<p class="goal-answer-saved" role="status">回答已保存，CoworkOS 将据此继续跟进。</p>')
      : "";
  const summary = `<div class="goal-progress"><span class="goal-eyebrow">${closed ? ui("跟进结果") : ui("目前进展")}</span>${readable(goal.summary, `progress-${program.programId}`)}${goal.progressAt ? ui`<time>更新于 ${esc(date(goal.progressAt))}</time>` : ""}</div>`;
  const next = !closed
    ? `<section class="goal-next"><span class="goal-eyebrow">${paused ? ui("恢复后") : ui("接下来")}</span><p>${esc(goal.waitingFor && !question ? goal.waitingFor : (goal.nextAction ?? ui("等待新的进展")))}</p>${goal.nextReviewAt ? ui`<small>下次复盘 ${esc(date(goal.nextReviewAt))}</small>` : ""}${goal.nextDigestAt ? ui`<small>下次摘要 ${esc(date(goal.nextDigestAt))} · ${esc(goal.brief.digest?.timeZone)}</small>` : ""}</section>`
    : "";
  return ui`${decision}${summary}${next}<section class="goal-notices"><div class="goal-section-heading"><h2>最近动态</h2></div>${
    notices.length
      ? notices
          .slice(0, 10)
          .map((entry) => notice(entry, { goal: program, updates: program.activity.updates }))
          .join("")
      : ui('<p class="goal-muted">暂无需要打扰你的新进展。</p>')
  }${notices.length > 10 ? ui('<button type="button" class="goal-text-button" data-goal-tab="records">查看全部动态 →</button>') : ""}</section>`;
}

function plan(goal) {
  return ui`<section class="goal-plan"><div class="goal-section-heading"><h2>如何推进这件事</h2><span>${goal.steps.filter((step) => step.status === "completed").length} / ${goal.steps.length}</span></div>${goal.steps.length ? `<ol>${goal.steps.map((step) => `<li class="${esc(step.status)}" data-view-key="step-${esc(step.id)}"><span class="goal-step-mark" aria-label="${esc({ pending: ui("待办"), active: ui("进行中"), completed: ui("已完成"), blocked: ui("受阻") }[step.status])}">${step.status === "completed" ? "✓" : step.status === "active" ? "•" : step.status === "blocked" ? "!" : ""}</span><div><p>${esc(step.description)}</p>${step.evidence ? ui`<details data-activity-key="evidence-${esc(step.id)}"><summary>查看依据</summary><p>${esc(step.evidence)}</p></details>` : ""}</div></li>`).join("")}</ol>` : empty(ui("正在整理跟进计划"), ui("CoworkOS 会按你的要求建立观察来源与下一步，规划完成后会显示在这里。"))}</section>${goal.facts.length ? ui`<section class="goal-facts"><h2>已经确认的事</h2><ul>${goal.facts.map((fact) => `<li>${esc(fact)}</li>`).join("")}</ul></section>` : ""}`;
}
function settings(program) {
  const goal = program.goal;
  const issues = (program.monitors ?? []).filter(
    (monitor) =>
      monitor.state?.pollError ||
      monitor.state?.analysisError ||
      monitor.state?.deliveryError ||
      ["draft", "failed"].includes(monitor.status)
  );
  return ui`<section class="goal-settings"><div class="goal-section-heading"><h2>跟进要求</h2>${program.status !== "completed" && !["failed", "cancelled", "completed"].includes(program.task?.status) ? ui('<button type="button" class="goal-text-button" data-goal-action="edit">修改要求 →</button>') : ""}</div><p class="goal-objective">${esc(goal.brief.objective)}</p><dl class="goal-setting-facts"><div><dt>跟进位置</dt><dd>${program.scope === "session" ? ui("在原对话中继续") : ui("独立后台跟进")}</dd></div><div><dt>什么时候告诉你</dt><dd>${esc({ important_only: ui("有重要变化或需要你决定时"), digest: ui("重要变化及时告知，普通内容每周摘要"), all: ui("每次有意义的更新") }[goal.brief.notificationPolicy])}</dd></div>${goal.brief.digest ? ui`<div><dt>摘要时间</dt><dd>每周${[ui("日"), ui("一"), ui("二"), ui("三"), ui("四"), ui("五"), ui("六")][goal.brief.digest.dayOfWeek]} ${String(goal.brief.digest.hour).padStart(2, "0")}:${String(goal.brief.digest.minute).padStart(2, "0")} · ${esc(goal.brief.digest.timeZone)}</dd></div>` : ""}</dl>${goal.brief.preferences.length ? ui`<h3>你的偏好</h3><ul>${goal.brief.preferences.map((value) => `<li>${esc(value)}</li>`).join("")}</ul>` : ""}<h3>何时算完成</h3><ul>${goal.brief.completionCriteria.map((value) => `<li>${esc(value)}</li>`).join("") || ui("<li>持续关注，直到你结束目标。</li>")}</ul></section><section class="goal-source-settings"><div class="goal-section-heading"><h2>观察来源</h2><span>${program.monitors?.length ?? 0} 项</span></div>${issues.length ? ui`<p class="watch-error">${issues.length} 项来源需要检查</p>` : ""}<ul>${
    (program.monitors ?? [])
      .map((monitor) => {
        const issue =
          monitor.state?.pollError ??
          monitor.state?.analysisError ??
          monitor.state?.deliveryError ??
          (["draft", "failed"].includes(monitor.status) ? monitor.state?.lastSummary : undefined);
        return `<li><span>${esc(monitor.task)}</span><small>${esc(program.status === "paused" ? ui("已暂停") : program.status === "completed" ? ui("已结束") : ({ active: ui("观察中"), paused: ui("已暂停"), retired: ui("已结束"), draft: ui("未通过验收"), failed: ui("需要检查") }[monitor.status] ?? monitor.status))}</small>${issue ? `<p class="watch-error">${esc(issue)}</p>` : ""}</li>`;
      })
      .join("") || ui('<li class="goal-muted">还没有登记观察来源。</li>')
  }</ul><button type="button" class="goal-text-button" data-goal-action="sources">来源设置与检查记录 →</button></section>`;
}
function records(program) {
  return ui`<section class="goal-notices"><h2>全部动态</h2>${program.activity.notifications.map((entry) => notice(entry, { goal: program, updates: program.activity.updates })).join("") || ui('<p class="goal-muted">暂无动态。</p>')}</section><details data-activity-key="goal-history"><summary>查看内部跟进记录 · ${program.activity.totalUpdates}</summary><div data-goal-records>${program.activity.updates.map((update) => `<article class="goal-record" data-view-key="record-${esc(update.updateId)}"><h3>${esc(update.title)}</h3><time>${esc(date(update.updatedAt))}</time>${readable(update.summary, `record-${update.updateId}`)}<div class="goal-evidence">${sourceLinks(update.sources)}</div></article>`).join("") || ui('<p class="goal-muted">暂无记录。</p>')}</div></details>${program.activity.totalUpdates > program.activity.updates.length || program.activity.totalNotifications > program.activity.notifications.length ? ui('<button type="button" class="goal-load-more" data-goal-more>加载更早记录</button>') : ""}`;
}
export function detailView(program, tab, { confirming = false } = {}) {
  const goal = program.goal;
  const open =
    program.status !== "completed" && !["failed", "cancelled", "completed"].includes(program.task?.status);
  const navigation = ui`<button type="button" class="goal-back goal-text-button" data-goal-back>${icon("chevron-left")}所有目标</button>`;
  if (!goal)
    return ui`${navigation}<header class="goal-detail-heading"><h1>${esc(title(program))}</h1>${badge(program)}</header><p class="goal-objective">${esc(program.objective)}</p><p class="goal-muted">这个目标沿用已有的监控设置。</p><button type="button" class="goal-primary" data-goal-action="sources">查看监控设置</button>`;
  const sourceIssues = (program.monitors ?? []).filter(
    (monitor) =>
      monitor.state?.pollError ||
      monitor.state?.analysisError ||
      monitor.state?.deliveryError ||
      ["draft", "failed"].includes(monitor.status)
  ).length;
  return ui`<div class="goal-detail">${navigation}<header class="goal-detail-heading"><div><h1>${esc(title(program))}</h1>${badge(program)}</div><div class="goal-detail-actions"><button type="button" class="goal-text-button" data-goal-action="open">打开对话 ↗</button>${open ? ui`<button type="button" class="goal-subtle-button" data-goal-action="${program.status === "paused" ? "resume" : "pause"}">${program.status === "paused" ? ui("恢复") : ui("暂停")}</button><details class="goal-menu" data-activity-key="goal-menu"><summary aria-label="更多目标操作">···</summary><div><button type="button" data-goal-action="edit">修改要求</button><button class="goal-danger" type="button" data-goal-action="confirm-complete">结束目标</button></div></details>` : ""}</div></header>${confirming ? ui('<div class="goal-end-confirm" role="alert"><p>结束后将停止跟进，已有结果会保留。</p><button type="button" class="goal-danger" data-goal-action="complete">确认结束</button><button type="button" data-goal-action="cancel-complete">继续保留</button></div>') : ""}${sourceIssues && tab !== "settings" ? ui`<div class="goal-health-banner"><span>${sourceIssues} 项观察来源需要检查。</span><button class="goal-text-button" type="button" data-goal-tab="settings">查看原因</button></div>` : ""}<div class="goal-detail-tabs" role="tablist" aria-label="目标详情">${[
    ["progress", ui("进展")],
    ["plan", ui("计划")],
    ["settings", ui("设置")],
    ["records", ui("全部动态")]
  ]
    .map(
      ([value, label]) =>
        `<button type="button" role="tab" id="goal-tab-${value}" aria-controls="goal-tab-content" aria-selected="${tab === value}" data-goal-tab="${value}" tabindex="${tab === value ? 0 : -1}">${label}</button>`
    )
    .join(
      ""
    )}</div><div id="goal-tab-content" role="tabpanel" aria-labelledby="goal-tab-${tab}" data-view-key="goal-tab-${esc(tab)}">${tab === "plan" ? plan(goal) : tab === "settings" ? settings(program) : tab === "records" ? records(program) : progress(program)}</div></div>`;
}
