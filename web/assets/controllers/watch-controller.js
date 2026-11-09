import { createModal } from "../ui/modal.js";
import { reconcileMarkup } from "../ui/reconcile.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
  );
const names = {
  "job-lifecycle": "程序运行",
  "metric-threshold": "指标阈值",
  "resource-version": "文件变化",
  "feed-keyword": "新内容与关键词",
  "entity-state": "对象状态",
  timer: "定时提醒"
};
const time = (value) => (value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—");
const statuses = {
  active: "监控中",
  draft: "未启用",
  paused: "已暂停",
  failed: "检查失败",
  retired: "已结束"
};
const ended = (monitor) =>
  monitor.status === "retired" ||
  monitor.programStatus === "completed" ||
  ["completed", "cancelled", "failed"].includes(monitor.taskStatus);
const interval = (seconds = 21600) => {
  if (seconds % 86400 === 0) return seconds === 86400 ? "每天" : `每 ${seconds / 86400} 天`;
  if (seconds % 3600 === 0) return `每 ${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return seconds === 60 ? "每分钟" : `每 ${seconds / 60} 分钟`;
  return `每 ${seconds} 秒`;
};
function status(monitor, scheduler) {
  if (["completed", "cancelled", "failed"].includes(monitor.taskStatus)) return "会话已结束";
  if (monitor.programStatus === "paused") return "已暂停";
  if (monitor.programStatus === "completed") return "已结束";
  if (monitor.status !== "active") return statuses[monitor.status] ?? monitor.status;
  if (monitor.state.deferredReason === "model_unconfigured") return "已捕获事件 · 等待模型连接";
  if (monitor.state.processing) return monitor.state.pollFailures ? "分析中 · 来源检查失败" : "正在分析事件";
  if (monitor.state.status === "failed")
    return monitor.state.analysisFailures
      ? "事件分析失败 · 等待重试"
      : monitor.state.deliveryFailures
        ? "事件投递失败 · 等待重试"
        : "来源检查失败 · 等待重试";
  if (monitor.state.wakeRetryAt && Date.parse(monitor.state.wakeRetryAt) > Date.now())
    return "事件已保存 · 等待投递";
  if (scheduler?.status !== "running") return "已登记 · 调度未运行";
  return "监控中";
}
const eventNames = {
  "watch.monitor_failure": "监控持续失败，需要处理",
  "watch.monitor_created": "已建立监控记录",
  "watch.monitor_updated": "监控设置已更新",
  "watch.program_event_received": "发现满足规则的变化",
  "watch.virtual_agent_completed": "事件处理完成",
  "watch.virtual_agent_failed": "事件处理失败",
  "watch.scheduled_review": "定时提醒已到达"
};
function readableSummary(monitor) {
  const text = monitor.state?.lastSummary?.split("\n[Coordinator]")[0];
  if (!text) return "已建立基线，等待变化";
  if (monitor.eventMode !== "direct") {
    const summary = text.replace(/^classification[^\n]*\n?/i, "").trim();
    return summary;
  }
  try {
    const event = JSON.parse(text.slice(text.indexOf("\n") + 1));
    const evidence = event.payload ?? event;
    if (event.type === "metric.threshold")
      return `${evidence.metric} = ${evidence.value} ${evidence.unit}，已达到${evidence.direction === "below" ? "下限" : "上限"} ${evidence.threshold}；连续 ${evidence.consecutiveSamples} 次。`;
    if (event.type === "timer.due") return `定时提醒已到达：${time(evidence.scheduledAt)}。`;
    if (monitor.templateId === "resource-version") return "文件内容已变化并通过稳定性检查。";
    if (monitor.templateId === "job-lifecycle") return "程序运行状态已变化，事件已交给当前会话处理。";
    return "已发现满足监控规则的变化，并交给会话处理。";
    // eslint-disable-next-line no-restricted-syntax -- a monitor summary is free text, not always JSON; the raw summary is shown when it does not parse
  } catch {
    return text.replace(/^classification[^\n]*\n?/i, "").slice(0, 1000);
  }
}
export function renderWatchCard(monitor, scheduler, records = "", actionError = "") {
  const state = monitor.state ?? {};
  const config = monitor.config ?? {};
  const name = monitor.scope === "background" && monitor.ownerTitle ? monitor.ownerTitle : monitor.task;
  const title = name.length > 80 ? `${name.slice(0, 80)}…` : name;
  const attention =
    actionError || monitor.ownerError || state.status === "failed" || monitor.status === "draft";
  const condition =
    monitor.templateId === "metric-threshold"
      ? `${config.metric} ${config.direction === "below" ? "≤" : "≥"} ${config.threshold}；连续 ${config.consecutiveSamples ?? 2} 次`
      : monitor.templateId === "feed-keyword"
        ? `关键词：${(config.keywords ?? []).join("、")}`
        : monitor.templateId === "entity-state"
          ? `目标状态：${(config.targetStates ?? []).join("、")}`
          : monitor.templateId === "timer"
            ? `${time(config.startAt)}${config.intervalMs ? `；每 ${config.intervalMs / 1000} 秒` : "；一次性"}`
            : monitor.templateId === "resource-version"
              ? `连续 ${config.stableChecks ?? 2} 次内容版本稳定`
              : monitor.templateId === "job-lifecycle"
                ? "运行结束、异常退出或日志停滞"
                : "按已验证的自定义规则判断变化";
  return `<article class="watch-card" data-view-key="${esc(monitor.monitorId)}" data-monitor-id="${esc(monitor.monitorId)}" data-owner-task="${esc(monitor.taskId)}">
    <details class="watch-disclosure" data-activity-key="watch-${esc(monitor.monitorId)}" name="watch-monitors">
    <summary class="watch-row"><span class="watch-row-copy"><strong title="${esc(monitor.task)}">${esc(title)}</strong><small>${monitor.scope === "background" ? "后台" : "当前会话"} · ${esc(interval(monitor.cadenceSeconds))}</small></span><span class="watch-status${attention && !ended(monitor) && monitor.status !== "paused" ? " needs-attention" : ""}" role="status">${esc(status(monitor, scheduler))}</span><svg class="ui-icon watch-chevron" aria-hidden="true"><use href="#i-chevron-right" /></svg></summary>
    <div class="watch-detail">
    ${monitor.task.length > 80 ? `<details class="watch-objective" data-activity-key="objective-${esc(monitor.monitorId)}"><summary>监控目标</summary><p>${esc(monitor.task)}</p></details>` : ""}
    <dl><div><dt>来源</dt><dd>${esc((monitor.sourcesHint ?? []).join("、"))}</dd></div><div><dt>触发条件</dt><dd>${esc(condition)}</dd></div><div><dt>最近检查</dt><dd>${esc(time(state.lastCheckedAt))}</dd></div><div><dt>下次预计检查</dt><dd>${monitor.status === "active" ? esc(time(state.pollRetryAt ?? (state.analysisRetryAt || state.wakeRetryAt || state.deliveryRetryAt ? undefined : state.retryAt) ?? state.nextCheckAt)) : "—"}</dd></div>${(state.analysisRetryAt || state.deliveryRetryAt || state.wakeRetryAt) && monitor.status === "active" ? `<div><dt>事件处理重试</dt><dd>${esc(time(state.analysisRetryAt ?? state.deliveryRetryAt ?? state.wakeRetryAt))}</dd></div>` : ""}</dl>
    ${monitor.ownerError ? '<p class="watch-error">会话处理遇到问题，可打开会话查看原因。</p>' : ""}
    <details class="watch-result" data-activity-key="result-${esc(monitor.monitorId)}" ${attention ? "open" : ""}><summary>${attention ? "查看失败原因" : "最近判断"}</summary><p class="watch-summary">${esc(readableSummary(monitor))}</p></details>
    <details class="watch-statistics" data-activity-key="statistics-${esc(monitor.monitorId)}"><summary>运行统计与限制</summary><p>检查 ${state.checkCount ?? 0} 次 · 候选事件 ${state.eventCount ?? 0} 次 · 分析 ${state.modelRunCount ?? 0} 次</p><p>每日最多分析 ${monitor.maxModelRunsPerDay ?? 24} 次、唤醒会话 ${monitor.maxWakeRequestsPerDay ?? 24} 次${monitor.expiresAt ? ` · 截止 ${esc(time(monitor.expiresAt))}` : ""}</p></details>
    <div class="watch-actions"><button type="button" data-watch-action="open">打开会话</button>${monitor.status === "active" ? '<button type="button" data-watch-action="pause">暂停</button>' : ["paused", "failed"].includes(monitor.status) ? '<button type="button" data-watch-action="resume">恢复</button>' : ""}<button type="button" data-watch-action="configure">设置</button><button type="button" data-watch-action="events">${records ? "收起记录" : "查看记录"}</button>${monitor.status !== "retired" ? '<button class="watch-retire" type="button" data-watch-action="retire">结束监控</button>' : ""}</div>
    <div class="watch-records" ${records ? "" : "hidden"}>${records}</div><p class="watch-error" role="alert">${esc(actionError)}</p>
    </div></details>
  </article>`;
}

export function createWatchController({ api: transport, state, selectTask, refresh }) {
  const api = (path, options) =>
    transport(
      path,
      options
        ? { ...options, headers: { "content-type": "application/json" }, body: JSON.stringify(options.body) }
        : undefined
    );
  const section = document.querySelector("#monitor-section");
  const recordsByMonitor = new Map();
  const actionErrors = new Map();
  const cardMarkup = (monitor, scheduler) =>
    renderWatchCard(
      monitor,
      scheduler,
      recordsByMonitor.get(monitor.monitorId),
      actionErrors.get(monitor.monitorId)
    );
  let detail,
    globalData,
    listOpen = false,
    busy = false;
  let scopeProgramId = null;
  let scopeTaskId = null,
    history = false,
    listRequest = 0;
  const listPanel = document.createElement("div");
  listPanel.className = "modal-backdrop";
  listPanel.hidden = true;
  listPanel.innerHTML =
    '<section class="modal-card watch-dialog" role="dialog" aria-modal="true" aria-labelledby="watch-list-title"><div class="watch-dialog-heading"><h2 id="watch-list-title">监控任务</h2><div class="watch-heading-actions"><button type="button" data-watch-new>新建监控</button><button class="watch-close" type="button" data-close aria-label="关闭监控任务"><svg class="ui-icon" aria-hidden="true"><use href="#i-close" /></svg></button></div></div><div class="watch-toolbar"><div class="watch-filters" role="group" aria-label="监控范围"><button type="button" data-watch-filter="current" aria-pressed="true">当前</button><button type="button" data-watch-filter="history" aria-pressed="false">历史</button></div><button type="button" data-watch-all hidden>查看全部会话</button><span data-watch-count></span></div><p class="watch-error" role="alert" data-list-error hidden></p><div data-watch-list></div><details class="watch-system"><summary>运行状态</summary><p data-scheduler></p></details></section>';
  document.body.append(listPanel);
  let listTimer;
  const listModal = createModal(listPanel, listPanel.querySelector("[data-close]"), {
    onClose: () => {
      listOpen = false;
      clearInterval(listTimer);
    }
  });
  const formPanel = document.createElement("div");
  formPanel.className = "modal-backdrop";
  formPanel.hidden = true;
  document.body.append(formPanel);
  let formModal;
  const schedulerText = (data) => {
    const scheduler = data?.scheduler;
    const health =
      scheduler?.status === "running"
        ? `后台调度正常 · 最近巡检 ${time(scheduler.lastCycleAt)}`
        : scheduler?.status === "disabled"
          ? "后台调度已禁用"
          : scheduler?.status === "failed"
            ? `后台调度异常：${scheduler.error}`
            : "后台调度准备中";
    return `${health}${scheduler && !scheduler.modelConfigured ? " · 模型未配置，触发事件后等待连接" : ""}`;
  };
  function renderList() {
    if (!globalData) return;
    const scoped = globalData.monitors.filter(
      (monitor) =>
        (!scopeTaskId || monitor.taskId === scopeTaskId) &&
        (!scopeProgramId || monitor.programId === scopeProgramId)
    );
    const visible = scoped.filter((monitor) => ended(monitor) === history);
    listPanel.querySelector("#watch-list-title").textContent = scopeTaskId ? "本会话的监控" : "监控任务";
    listPanel.querySelector("[data-watch-all]").hidden = !scopeTaskId;
    listPanel.querySelector("[data-watch-count]").textContent = `${visible.length} 项`;
    for (const button of listPanel.querySelectorAll("[data-watch-filter]"))
      button.setAttribute("aria-pressed", String((button.dataset.watchFilter === "history") === history));
    listPanel.querySelector("[data-scheduler]").textContent = schedulerText(globalData);
    reconcileMarkup(
      listPanel.querySelector("[data-watch-list]"),
      visible.length
        ? [...visible]
            .sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1))
            .map((monitor) => cardMarkup(monitor, globalData.scheduler))
            .join("")
        : `<p class="watch-empty">${history ? "暂无已结束的监控。" : "暂无监控，可从这里新建。"}</p>`
    );
  }
  async function refreshList() {
    if (!listOpen || busy) return;
    const request = ++listRequest;
    try {
      const data = await api("/api/monitors");
      if (!listOpen || busy || request !== listRequest) return;
      globalData = data;
      listPanel.querySelector("[data-list-error]").hidden = true;
      renderList();
    } catch (error) {
      if (!listOpen || request !== listRequest) return;
      const node = listPanel.querySelector("[data-list-error]");
      node.textContent = `监控列表暂时无法加载：${error.message}`;
      node.hidden = false;
    }
  }
  const fields = (template) => {
    if (template === "metric-threshold")
      return '<label>指标名称<input name="metric" required placeholder="loss"></label><label>单位<input name="unit" required placeholder="ratio"></label><label>阈值<input name="threshold" type="number" step="any" required></label><label>方向<select name="direction"><option value="above">大于等于</option><option value="below">小于等于</option></select></label><label>连续样本数<input name="consecutiveSamples" type="number" min="1" value="2" required></label>';
    if (template === "feed-keyword")
      return '<label>资讯来源格式<select name="sourceFormat"><option value="items">标准 JSON 资讯列表</option><option value="github-releases">GitHub 版本发布 API</option><option value="github-atom">GitHub 发布订阅（Atom）</option><option value="hn-search">Hacker News 搜索</option></select></label><label>关键词（用逗号分隔）<input name="keywords" required></label><p>GitHub 发布订阅地址形如 https://github.com/组织/仓库/releases.atom；其他格式填写对应的公开 API 地址。</p>';
    if (template === "entity-state")
      return '<label>对象 ID<input name="entityId" required></label><label>目标状态（用逗号分隔）<input name="targetStates" required></label><p>来源需提供 id、revision、status、observedAt。</p>';
    if (template === "job-lifecycle")
      return '<label>日志停滞阈值（秒）<input name="quietSeconds" type="number" min="1" value="600" required></label><p>来源是 Formicand 后台任务的 JSON 记录文件。</p>';
    if (template === "resource-version")
      return '<label>内容稳定检查次数<input name="stableChecks" type="number" min="1" value="2" required></label>';
    return '<label>首次提醒时间<input name="startAt" type="datetime-local" required></label><label>重复间隔（秒；0 为一次性）<input name="intervalSeconds" type="number" min="0" value="0" required></label>';
  };
  function openForm(monitor) {
    formModal?.close();
    const sessionDefault = scopeTaskId && state.selected;
    formPanel.innerHTML = `<section class="modal-card watch-dialog" role="dialog" aria-modal="true" aria-labelledby="watch-form-title"><h2 id="watch-form-title">${monitor ? "监控设置" : "新建监控"}</h2><form class="watch-form">${
      monitor
        ? ""
        : `<label>监控目标<input name="task" maxlength="4000" required></label><label>归属<select name="scope"><option value="session" ${state.selected ? "" : "disabled"} ${sessionDefault ? "selected" : ""}>当前会话</option><option value="background" ${sessionDefault ? "" : "selected"}>独立后台会话</option></select></label><label>任务类别<select name="template">${Object.entries(
            names
          )
            .map(([key, name]) => `<option value="${key}">${name}</option>`)
            .join(
              ""
            )}</select></label><label data-source-label>来源<input name="source" placeholder="本地文件的绝对路径" required></label><div data-template-fields class="watch-form"></div>`
    }<label>检查间隔（秒）<input name="cadenceSeconds" type="number" min="60" max="2592000" value="${monitor?.cadenceSeconds ?? 60}" required></label><details class="watch-advanced"><summary>更多设置</summary><div class="watch-form"><label>每日最多唤醒会话次数<input name="maxWakeRequestsPerDay" type="number" min="1" max="1000" value="${monitor?.maxWakeRequestsPerDay ?? 24}" required></label><label>每日最多分析次数<input name="maxModelRunsPerDay" type="number" min="1" max="1000" value="${monitor?.maxModelRunsPerDay ?? 24}" required></label>${monitor ? "" : '<label>截止时间（可选）<input name="expiresAt" type="datetime-local"></label>'}</div></details><p role="alert" data-error></p><div class="modal-actions"><button type="button" data-close>取消</button><button type="submit" class="is-primary">${monitor ? "保存" : "创建监控"}</button></div></form></section>`;
    formModal = createModal(formPanel, formPanel.querySelector("[data-close]"));
    const form = formPanel.querySelector("form");
    form.addEventListener(
      "invalid",
      (event) => {
        const disclosure = event.target.closest("details");
        if (disclosure) disclosure.open = true;
      },
      true
    );
    const templateSelect = form.elements.template;
    function templateFields() {
      form.querySelector("[data-template-fields]").innerHTML = fields(templateSelect.value);
      form.querySelector("[data-source-label]").hidden = templateSelect.value === "timer";
      form.elements.source.required = templateSelect.value !== "timer";
      form.elements.source.placeholder = ["feed-keyword", "entity-state"].includes(templateSelect.value)
        ? "https://example.com/data.json"
        : "本地文件的绝对路径";
    }
    if (!monitor) {
      templateFields();
      templateSelect.addEventListener("change", templateFields);
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const settings = {
          cadenceSeconds: Number(data.cadenceSeconds),
          maxModelRunsPerDay: Number(data.maxModelRunsPerDay),
          maxWakeRequestsPerDay: Number(data.maxWakeRequestsPerDay)
        };
        if (monitor)
          await api(
            `/api/tasks/${encodeURIComponent(monitor.taskId)}/monitors/${encodeURIComponent(monitor.monitorId)}/control`,
            { method: "POST", body: { action: "configure", ...settings } }
          );
        else {
          let config = {};
          if (data.template === "metric-threshold")
            config = {
              metric: data.metric,
              unit: data.unit,
              threshold: Number(data.threshold),
              direction: data.direction,
              consecutiveSamples: Number(data.consecutiveSamples)
            };
          if (data.template === "feed-keyword")
            config = {
              sourceFormat: data.sourceFormat,
              keywords: data.keywords
                .split(/[,，]/)
                .map((word) => word.trim())
                .filter(Boolean)
            };
          if (data.template === "entity-state")
            config = {
              entityId: data.entityId,
              targetStates: data.targetStates
                .split(/[,，]/)
                .map((word) => word.trim())
                .filter(Boolean)
            };
          if (data.template === "job-lifecycle") config = { quietAfterMs: Number(data.quietSeconds) * 1000 };
          if (data.template === "resource-version") config = { stableChecks: Number(data.stableChecks) };
          if (data.template === "timer")
            config = {
              startAt: new Date(data.startAt).toISOString(),
              intervalMs: Number(data.intervalSeconds) ? Number(data.intervalSeconds) * 1000 : null
            };
          const ownerTaskId = scopeProgramId ? scopeTaskId : state.selected;
          const result = await api(
            ownerTaskId ? `/api/tasks/${encodeURIComponent(ownerTaskId)}/monitors` : "/api/monitors",
            {
              method: "POST",
              body: {
                ...settings,
                ...(scopeProgramId ? { programId: scopeProgramId } : {}),
                task: data.task,
                scope: data.scope,
                template: data.template,
                source: data.source,
                config,
                ...(data.expiresAt ? { expiresAt: new Date(data.expiresAt).toISOString() } : {})
              }
            }
          );
          if (!result.activated) throw new Error(result.error ?? result.errors ?? "探针未通过；监控未启用");
          if (scopeTaskId && result.taskId !== scopeTaskId) scopeTaskId = null;
        }
        formModal.close();
        await refresh();
        await refreshList();
      } catch (error) {
        form.querySelector("[data-error]").textContent = error.message;
      } finally {
        submit.disabled = false;
        // eslint-disable-next-line no-restricted-syntax -- refreshList already writes its failure into the list error row; it must not replace the form's own save error
        await refreshList().catch(() => {});
      }
    });
    formModal.open();
  }
  async function action(event) {
    const button = event.target.closest("[data-watch-action]");
    if (!button) return;
    const card = button.closest("[data-monitor-id]");
    const { monitorId, ownerTask } = card.dataset;
    const monitor = [...(detail?.monitors ?? []), ...(globalData?.monitors ?? [])].find(
      (item) => item.monitorId === monitorId
    );
    const errorNode = card.querySelector("[role=alert]");
    actionErrors.delete(monitorId);
    button.disabled = true;
    busy = true;
    try {
      if (button.dataset.watchAction === "open") {
        listModal.close();
        await selectTask(ownerTask);
      } else if (button.dataset.watchAction === "configure") openForm(monitor);
      else if (button.dataset.watchAction === "events") {
        if (recordsByMonitor.has(monitorId)) {
          recordsByMonitor.delete(monitorId);
          return;
        }
        const result = await api(
          `/api/tasks/${encodeURIComponent(ownerTask)}/monitors/${encodeURIComponent(monitorId)}/events`
        );
        const records = result.events.length
          ? result.events
              .map(
                (entry) =>
                  `<p>${esc(time(entry.occurredAt))} · ${esc(eventNames[entry.type] ?? "监控状态已更新")}<br>${esc(entry.payload?.error ?? (entry.payload?.classification === "relevant_change" ? "重要变化，已交给会话处理" : entry.payload?.classification === "no_change" ? "变化无需进一步处理" : entry.payload?.classification === "uncertain" ? "需要进一步核实" : undefined) ?? entry.payload?.payload?.type ?? "状态已记录")}</p>`
              )
              .join("")
          : "<p>暂无事件记录</p>";
        recordsByMonitor.set(monitorId, records);
      } else {
        await api(
          `/api/tasks/${encodeURIComponent(ownerTask)}/monitors/${encodeURIComponent(monitorId)}/control`,
          { method: "POST", body: { action: button.dataset.watchAction } }
        );
        await refresh();
      }
    } catch (error) {
      actionErrors.set(monitorId, error.message);
      errorNode.textContent = error.message;
    } finally {
      busy = false;
      button.disabled = false;
      await refreshList();
    }
  }
  listPanel.addEventListener("click", action);
  listPanel.querySelector("[data-watch-new]").addEventListener("click", () => openForm());
  for (const button of listPanel.querySelectorAll("[data-watch-filter]"))
    button.addEventListener("click", () => {
      history = button.dataset.watchFilter === "history";
      renderList();
    });
  listPanel.querySelector("[data-watch-all]").addEventListener("click", () => {
    scopeTaskId = null;
    scopeProgramId = null;
    renderList();
  });
  async function openList(taskId = null, programId = null) {
    scopeTaskId = taskId;
    scopeProgramId = programId;
    history = false;
    listOpen = true;
    clearInterval(listTimer);
    // eslint-disable-next-line no-restricted-syntax -- the 3.5s list poll retries, and refreshList itself shows a failure in the list error row
    listTimer = setInterval(() => void refreshList().catch(() => {}), 3500);
    listModal.open();
    renderList();
    await refreshList();
  }
  document.querySelector("#monitors-nav")?.addEventListener("click", () => void openList());
  return {
    openList,
    update(value) {
      detail = value?.monitoring;
      const current = (detail?.monitors ?? []).filter((monitor) => !ended(monitor));
      const goals = (detail?.programs ?? []).filter(
        (program) => program.managed && program.status !== "completed"
      );
      if (section) section.hidden = !state.selected || (!current.length && !goals.length);
      const label = document.querySelector("#monitor-label");
      if (label) label.textContent = goals.length ? "长期任务" : "监控";
      const count = document.querySelector("#monitor-count");
      if (count) count.textContent = `${goals.length || current.length} 项`;
      // eslint-disable-next-line no-restricted-syntax -- a list refresh triggered by new monitor data is best-effort; refreshList reports its own failure and the poll retries
      void refreshList().catch(() => {});
    }
  };
}
