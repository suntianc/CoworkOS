import { ui } from "./ui/language.js";
import { agentName } from "./agent-room.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
  );
const number = (value) => Number(value).toLocaleString("en-US");

export function formatRunDuration(value) {
  if (!Number.isFinite(value)) return "—";
  const seconds = Math.floor(Math.max(0, value) / 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
    : `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

export function runElapsed(statistics, now = Date.now()) {
  if (!Number.isFinite(statistics?.elapsedMs)) return null;
  const observedAt = Date.parse(statistics.observedAt);
  return (
    statistics.elapsedMs +
    (statistics.active && Number.isFinite(observedAt) ? Math.max(0, now - observedAt) : 0)
  );
}

function tokenLabel(usage) {
  if (usage?.totalTokens == null) return "—";
  return number(usage.totalTokens);
}

function cacheLabel(usage, field) {
  const coverage = usage?.[`${field}Coverage`];
  if (coverage === "complete") return number(usage[field]);
  if (coverage === "partial") return ui`${number(usage[field])} <small>已报告 · 部分未知</small>`;
  // Older API responses also cannot establish whether a zero was reported.
  return coverage === undefined && usage?.[field] > 0
    ? ui`${number(usage[field])} <small>已报告 · 部分未知</small>`
    : ui("未报告");
}

function agentUsageRow(agent) {
  const current = agent.current !== false;
  const tag = current ? "button" : "div";
  return `<${tag} ${current ? ui`type="button" data-usage-agent="${esc(agent.callId || agent.agentId)}" title="查看 ${esc(agentName(agent))} 当前轮次的执行轨迹"` : ui('title="历史轮次的累计用量"')} class="run-agent-row${current ? "" : " historical"}"><span>${agent.agentId === "main" ? '<svg class="avatar-mark" aria-hidden="true"><use href="#i-formicand-mark-small" /></svg>' : '<svg class="ui-icon"><use href="#i-team"/></svg>'}<strong>${esc(agentName(agent))}</strong>${current ? "" : ui("<small>历史</small>")}</span><span title="${agent.usage.totalTokens == null ? ui("累计 Token") : `${number(agent.usage.totalTokens)} Token`}">${tokenLabel(agent.usage)}${current ? "<small>↗</small>" : ""}</span></${tag}>`;
}

export function renderRunOverview(statistics, now = Date.now()) {
  if (!statistics)
    return ui(
      '<div class="run-overview-empty"><svg class="ui-icon"><use href="#i-activity"/></svg><p>开始任务后，在这里查看运行时长和 Token 消耗。</p></div>'
    );
  const usage = statistics.usage;
  const reported = usage?.totalTokens != null;
  const agents = statistics.agents || [];
  const tokenTitle = reported ? `${number(usage.totalTokens)} Token` : ui("累计 Token");
  const cumulative = statistics.scope === "conversation";
  return ui`<div class="run-metrics" role="group" aria-label="${cumulative ? ui("整个会话累计") : ui("本轮累计")}">
    <div class="run-metric"><span>${cumulative ? ui("累计运行时长") : ui("运行时长")}</span><strong data-run-elapsed title="累加每轮模型、工具执行和等待协作的时间，不含轮次间的空闲时间">${formatRunDuration(runElapsed(statistics, now))}</strong></div>
    <div class="run-metric run-token-metric"><span>累计 Token</span><strong title="${esc(tokenTitle)}">${tokenLabel(usage)}</strong></div>
  </div>
  <dl class="run-token-breakdown">
    <div><dt title="包含缓存用量">输入</dt><dd>${reported ? number(usage.input + usage.cacheRead + usage.cacheWrite) : "—"}</dd></div>
    <div><dt title="包含推理用量">输出</dt><dd>${reported ? number(usage.output) : "—"}</dd></div>
    <div class="run-cache-row"><dt>输入缓存命中</dt><dd>${cacheLabel(usage, "cacheRead")}</dd></div>
    <div class="run-cache-row"><dt>缓存写入</dt><dd>${cacheLabel(usage, "cacheWrite")}</dd></div>
  </dl>
  <div class="run-participation"><span><svg class="ui-icon"><use href="#i-team"/></svg>${agents.length} 位智能体</span><span>${cumulative ? ui`${statistics.runCount} 轮 · ` : ""}${number(usage.responses)} 次模型响应</span></div>
  <details class="run-agent-usage" data-usage-breakdown><summary>智能体用量<span>⌄</span></summary><div class="run-agent-rows">${agents.map(agentUsageRow).join("")}</div></details>
  ${statistics.timingPartial ? ui('<p class="run-usage-note">部分旧轮次缺少计时记录，时长仅含可恢复部分。</p>') : ""}`;
}
