import { ui } from "../ui/language.js";
import { reconcileMarkup } from "../ui/reconcile.js";
import { createGoalForm } from "./goal-form.js";
import { activity, date, detailView, empty, esc, identity, overview } from "../goal-view.js";
const path = (goal) =>
  `/api/tasks/${encodeURIComponent(goal.taskId)}/goals/${encodeURIComponent(goal.programId)}`;
const same = (a, b) => a && b && identity(a) === identity(b);
const tabs = new Set(["progress", "plan", "settings", "records"]);

/** A navigable workspace; dialogs are reserved for brief editing. */
export function createGoalController({
  api: transport,
  state,
  selectTask,
  watchView,
  refresh,
  openRecentActivity
}) {
  const api = (url, options) =>
    transport(
      url,
      options
        ? { ...options, headers: { "content-type": "application/json" }, body: JSON.stringify(options.body) }
        : undefined
    );
  let data = { goals: [] },
    detail = null,
    feed = null,
    scope = null,
    history = false,
    unreadOnly = false;
  let busy = false,
    generation = 0,
    confirming = false,
    route = null,
    failure = "",
    pageKey = "";
  let backWasDisabled = true;
  let awaitingPageFocus = false;
  const decisionDrafts = new Map();
  const pendingLoads = new Set();
  let routeEpoch = 0,
    changeTimer;
  let feedPages = 1,
    recordPages = 1;
  const workspace = document.createElement("section");
  workspace.className = "goal-workspace goal-dialog";
  workspace.hidden = true;
  workspace.setAttribute("aria-label", ui("长期任务"));
  workspace.innerHTML = ui(
    `<header class="goal-workspace-header"><div class="goal-workspace-brand"><span class="goal-orbit" aria-hidden="true">◌</span><span>长期任务</span></div><nav class="goal-workspace-nav" aria-label="长期任务页面"><button type="button" data-goal-page="goals" aria-current="page">目标</button><button type="button" data-goal-page="activity">动态<span data-activity-count hidden></span></button></nav><button type="button" class="goal-text-button goal-return" data-goal-close>返回对话 ↗</button></header><div class="goal-scroll"><div class="goal-page-width"><div data-goal-banner></div><p class="watch-error" role="alert" data-goal-error hidden></p><main data-goal-content></main><footer class="goal-workspace-footer"><details class="goal-system"><summary>运行与监控设置</summary><p data-goal-health></p><button class="goal-text-button" id="monitors-nav" type="button">高级监控设置 →</button></details><button type="button" class="goal-text-button" data-goal-recent>最近会话 ↗</button></footer></div></div>`
  );
  document.querySelector(".app-layout").append(workspace);
  const content = workspace.querySelector("[data-goal-content]");
  const form = createGoalForm({
    api,
    state,
    onBusy: (value) => {
      busy = value;
      if (value) {
        generation++;
        routeEpoch++;
      }
      if (!value) void load();
    },
    onSaved: async (saved) => {
      detail = saved;
      scope = null;
      history = false;
      navigate({ view: "detail", taskId: saved.taskId, programId: saved.programId, tab: "progress" });
      await refresh();
    }
  });

  function parseHash() {
    try {
      const parts = location.hash.slice(1).split("/").map(decodeURIComponent);
      if (parts[0] !== "goals") return null;
      if (parts[1] === "activity") return { view: "activity" };
      if (parts.length >= 3 && parts[1] && parts[2])
        return {
          view: "detail",
          taskId: parts[1],
          programId: parts[2],
          tab: tabs.has(parts[3]) ? parts[3] : "progress"
        };
      return { view: "goals" };
    } catch {
      return { view: "goals" };
    }
  }
  function routeHash(next) {
    return next.view === "detail"
      ? `#goals/${encodeURIComponent(next.taskId)}/${encodeURIComponent(next.programId)}/${next.tab ?? "progress"}`
      : next.view === "activity"
        ? "#goals/activity"
        : "#goals";
  }
  function navigate(next) {
    const hash = routeHash(next);
    if (location.hash === hash) {
      syncRoute();
      return;
    }
    window.history.pushState(null, "", hash);
    syncRoute();
  }
  function close() {
    if (!route) return;
    window.history.pushState(null, "", location.pathname + location.search);
    syncRoute();
    const opener = document.querySelector("#goals-nav");
    (opener?.getClientRects().length
      ? opener
      : document.querySelector(ui('[aria-label="切换侧栏"]'))
    )?.focus();
  }
  function header() {
    const unread = data.goals.reduce((sum, goal) => sum + (goal.unreadCount ?? 0), 0);
    for (const node of [
      document.querySelector("#goals-unread"),
      workspace.querySelector("[data-activity-count]")
    ]) {
      if (!node) continue;
      node.hidden = !unread;
      node.textContent = unread > 99 ? "99+" : String(unread);
    }
    document
      .querySelector(ui('.sidebar-icon[title="任务动态"]'))
      ?.classList.toggle("goal-has-updates", unread > 0);
    const nav = document.querySelector("#goals-nav");
    nav?.setAttribute("aria-current", route ? "page" : "false");
    for (const button of workspace.querySelectorAll("[data-goal-page]"))
      button.setAttribute(
        "aria-current",
        (button.dataset.goalPage === "activity") === (route?.view === "activity") ? "page" : "false"
      );
    if (route) {
      document.querySelector("#topbar-task").textContent = ui("长期任务");
      const back = document.querySelector(ui('[aria-label="后退"]'));
      if (back) {
        back.disabled = false;
        back.classList.remove("disabled");
      }
    }
    const health = data.scheduler;
    workspace.querySelector("[data-goal-health]").textContent =
      ui`${health?.status === "running" ? ui`后台运行中 · 最近检查 ${date(health.lastCycleAt)}` : health?.status === "disabled" ? ui("后台调度已禁用") : health?.status === "failed" ? ui`后台异常：${health.error}` : ui("正在连接后台")}${health && !health.modelConfigured ? ui(" · 模型尚未配置") : ""}。自动跟进需要本机后台服务保持运行。`;
    const hasActive = data.goals.some((goal) => !["paused", "completed"].includes(goal.status));
    workspace.querySelector("[data-goal-banner]").innerHTML =
      hasActive && health && (health.status !== "running" || !health.modelConfigured)
        ? ui`<div class="goal-health-banner" role="status">${esc(!health.modelConfigured ? ui("连接模型后，CoworkOS 才能规划和处理新进展。") : health.status === "disabled" ? ui("后台调度已关闭，目标暂不会自动跟进。") : health.status === "failed" ? ui("后台运行遇到问题，请查看运行设置。") : ui("后台正在连接，目标会在就绪后继续。"))}<button type="button" class="goal-text-button" data-show-health>查看运行状态</button></div>`
        : "";
  }
  function render() {
    header();
    if (!route) return;
    const key = routeHash(route);
    const focusWasTab =
      content.contains(document.activeElement) && document.activeElement?.getAttribute("role") === "tab";
    if (pageKey !== key) {
      awaitingPageFocus = true;
      content.replaceChildren();
      workspace.querySelector(".goal-scroll").scrollTop = 0;
      pageKey = key;
    }
    const errorNode = workspace.querySelector("[data-goal-error]");
    errorNode.hidden = !failure;
    errorNode.textContent = failure;
    const markup =
      route.view === "goals"
        ? overview(data, { history, scope })
        : route.view === "activity"
          ? activity(feed, unreadOnly)
          : same(route, detail)
            ? detailView(detail, route.tab, { confirming })
            : failure
              ? empty(
                  ui("暂时无法打开这个目标"),
                  ui("你可以返回所有目标，或稍后重试。"),
                  ui('<button type="button" data-goal-back>返回所有目标</button>')
                )
              : ui('<p class="goal-loading" role="status">正在读取跟进进展…</p>');
    reconcileMarkup(content, markup);
    if (awaitingPageFocus) {
      const target = focusWasTab
        ? content.querySelector('[role="tab"][aria-selected="true"]')
        : content.querySelector("h1");
      if (target) {
        target.tabIndex = focusWasTab ? 0 : -1;
        target.focus({ preventScroll: true });
        awaitingPageFocus = false;
      }
    }
    if (same(route, detail)) {
      const answer = content.querySelector("[data-goal-answer] textarea");
      const key = `${identity(detail)}:${detail.goal?.decisionRequestId}`;
      if (answer && decisionDrafts.has(key)) answer.value = decisionDrafts.get(key);
    }
  }
  function syncRoute() {
    generation++;
    routeEpoch++;
    clearTimeout(changeTimer);
    changeTimer = undefined;
    const next = parseHash();
    if (next && !route) backWasDisabled = document.querySelector(ui('[aria-label="后退"]'))?.disabled ?? true;
    if (!next && route) {
      const back = document.querySelector(ui('[aria-label="后退"]'));
      if (back) {
        back.disabled = backWasDisabled;
        back.classList.toggle("disabled", backWasDisabled);
      }
      document.querySelector("#topbar-task").textContent = state.detail?.task?.title ?? ui("新对话");
    }
    if (!next || next.view !== "detail" || !same(next, route)) {
      confirming = false;
      recordPages = 1;
    }
    route = next;
    document.body.classList.toggle("goal-workspace-open", Boolean(route));
    workspace.hidden = !route;
    if (route) {
      document.body.classList.remove("sidebar-mobile-open");
      failure = "";
      render();
      void load();
    } else header();
  }
  async function load() {
    if (busy || document.hidden) return;
    const loadKey = `${routeEpoch}:${unreadOnly}:${feedPages}`;
    if (pendingLoads.has(loadKey)) return;
    pendingLoads.add(loadKey);
    const currentRoute = route && { ...route },
      id = ++generation;
    try {
      const result = await api("/api/goals");
      let nextDetail, nextFeed;
      if (currentRoute?.view === "detail") {
        nextDetail = await api(path(currentRoute));
        if (recordPages > 1 && same(nextDetail, detail)) {
          for (const [field, key] of [
            ["updates", "updateId"],
            ["notifications", "notificationId"]
          ])
            nextDetail.activity[field] = [
              ...new Map(
                [...nextDetail.activity[field], ...detail.activity[field].slice(100)].map((entry) => [
                  entry[key],
                  entry
                ])
              ).values()
            ];
        }
      } else if (currentRoute?.view === "activity") {
        nextFeed = await fetchFeed(feedPages);
      }
      if (id !== generation || busy) return;
      data = result;
      if (failure.startsWith(ui("加载失败："))) failure = "";
      if (nextDetail) detail = nextDetail;
      if (nextFeed) feed = nextFeed;
      render();
    } catch (error) {
      if (id === generation && route) {
        failure = ui`加载失败：${error.message}`;
        render();
      }
    } finally {
      pendingLoads.delete(loadKey);
    }
  }
  async function fetchFeed(pages) {
    const entries = [];
    let result;
    for (let index = 0; index < pages; index++) {
      result = await api(
        `/api/goals/activity?offset=${index * 30}&unread=${unreadOnly ? "1" : "0"}${scope ? `&taskId=${encodeURIComponent(scope)}` : ""}`
      );
      entries.push(...result.notifications);
      if (entries.length >= result.total) break;
    }
    return { ...result, notifications: entries };
  }
  /** A lifecycle change is a command: the id makes a lost response reconcile, not repeat. */
  const change = (url, options) => (api.command ? api.command(url, options) : api(url, options));
  async function control(current, action) {
    // A revision retry is a new command: same operation id with different
    // content would be refused as an operation conflict.
    const write = (revision) =>
      change(`${path(current)}/control`, { method: "POST", body: { action, revision } });
    try {
      return await write(current.goal.revision);
    } catch (error) {
      if (error.status !== 409) throw error;
      return write((await api(path(current))).goal.revision);
    }
  }
  async function operate(button, action) {
    if (busy) return;
    const current = detail;
    const menu = button.closest(".goal-menu");
    if (menu) menu.open = false;
    if (action === "edit") {
      form.open(current);
      return;
    }
    if (action === "open") {
      close();
      await selectTask(current.taskId);
      return;
    }
    if (action === "sources") {
      close();
      await watchView.openList(current.taskId, current.programId);
      return;
    }
    if (action === "confirm-complete" || action === "cancel-complete") {
      confirming = action === "confirm-complete";
      render();
      workspace
        .querySelector(confirming ? '[data-goal-action="cancel-complete"]' : ".goal-menu > summary")
        ?.focus();
      return;
    }
    busy = true;
    generation++;
    routeEpoch++;
    button.disabled = true;
    failure = "";
    try {
      if (button.dataset.noticeRead) {
        const ref = { taskId: button.dataset.goalOwner, programId: button.dataset.goalProgram };
        await api(`${path(ref)}/notifications/${encodeURIComponent(button.dataset.noticeRead)}/read`, {
          method: "POST",
          body: {}
        });
      } else {
        detail = await control(current, action);
        confirming = false;
        await refresh();
      }
    } catch (error) {
      failure = error.message;
    } finally {
      busy = false;
      button.disabled = false;
      await load();
    }
  }
  workspace.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || busy) return;
    if (button.hasAttribute("data-goal-close")) {
      close();
      return;
    }
    if (button.hasAttribute("data-goal-new")) {
      form.open();
      return;
    }
    if (button.hasAttribute("data-goal-back")) {
      navigate({ view: "goals" });
      return;
    }
    if (button.dataset.goalPage) {
      navigate({ view: button.dataset.goalPage });
      return;
    }
    if (button.dataset.goalTab) {
      navigate({ ...route, tab: button.dataset.goalTab });
      return;
    }
    if (button.dataset.goalId) {
      failure = "";
      recordPages = 1;
      navigate({
        view: "detail",
        taskId: button.dataset.goalTask,
        programId: button.dataset.goalId,
        tab: "progress"
      });
      return;
    }
    if (button.dataset.goalFilter) {
      history = button.dataset.goalFilter === "history";
      render();
      return;
    }
    if (button.hasAttribute("data-goal-all")) {
      scope = null;
      render();
      return;
    }
    if (button.dataset.feedFilter) {
      unreadOnly = button.dataset.feedFilter === "unread";
      feedPages = 1;
      feed = null;
      render();
      await load();
      return;
    }
    if (button.hasAttribute("data-feed-more")) {
      feedPages++;
      await load();
      return;
    }
    if (button.hasAttribute("data-show-health")) {
      const node = workspace.querySelector(".goal-system");
      node.open = true;
      node.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    if (button.hasAttribute("data-goal-recent")) {
      openRecentActivity?.();
      return;
    }
    if (button.id === "monitors-nav") {
      close();
      await watchView.openList();
      return;
    }
    if (button.hasAttribute("data-goal-more")) {
      busy = true;
      generation++;
      routeEpoch++;
      button.disabled = true;
      const current = detail;
      try {
        const offset = Math.max(current.activity.updates.length, current.activity.notifications.length);
        const older = await api(`${path(current)}/activity?offset=${offset}`);
        if (same(current, route)) {
          current.activity.updates.push(...older.updates);
          current.activity.notifications.push(...older.notifications);
          recordPages++;
        }
      } catch (error) {
        failure = error.message;
      } finally {
        busy = false;
        button.disabled = false;
        render();
      }
      return;
    }
    if (button.dataset.goalAction || button.dataset.noticeRead)
      await operate(button, button.dataset.goalAction);
  });
  workspace.addEventListener("input", (event) => {
    if (event.target.matches("[data-goal-answer] textarea") && detail)
      decisionDrafts.set(`${identity(detail)}:${detail.goal?.decisionRequestId}`, event.target.value);
  });
  workspace.addEventListener("submit", async (event) => {
    if (!event.target.matches("[data-goal-answer]")) return;
    event.preventDefault();
    if (busy) return;
    const node = event.target,
      current = detail;
    busy = true;
    generation++;
    routeEpoch++;
    const button = node.querySelector("button");
    button.disabled = true;
    failure = "";
    try {
      await change(`${path(current)}/control`, {
        method: "POST",
        body: { action: "respond", answer: node.elements.answer.value }
      });
      const answeredNotice = current.activity?.notifications.find(
        (notice) =>
          notice.kind === "decision" && !notice.readAt && notice.summary === current.goal?.waitingFor
      );
      if (answeredNotice)
        await api(
          `${path(current)}/notifications/${encodeURIComponent(answeredNotice.notificationId)}/read`,
          { method: "POST", body: {} }
        ).catch(() => {});
      decisionDrafts.delete(`${identity(current)}:${current.goal?.decisionRequestId}`);
      node.elements.answer.value = "";
    } catch (error) {
      failure = error.message;
    } finally {
      busy = false;
      button.disabled = false;
      await load();
    }
  });
  workspace.addEventListener("keydown", (event) => {
    const current = event.target.closest('[role="tab"]');
    if (!current || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const options = [...workspace.querySelectorAll('[role="tab"]')];
    const index = options.indexOf(current);
    const next =
      options[
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : -1) + options.length) % options.length
      ];
    event.preventDefault();
    navigate({ ...route, tab: next.dataset.goalTab });
    setTimeout(() => workspace.querySelector(`#${next.id}`)?.focus(), 0);
  });
  function open(taskId = null, view = "goals") {
    scope = taskId;
    history = false;
    navigate({ view });
  }
  window.addEventListener("hashchange", syncRoute);
  document.querySelector("#goals-nav")?.addEventListener("click", () => open());
  document.querySelector("#monitor-manage")?.addEventListener("click", () => {
    if ((state.detail?.monitoring?.programs ?? []).some((program) => program.managed)) open(state.selected);
    else void watchView.openList(state.selected);
  });
  document.addEventListener(
    "click",
    (event) => {
      if (
        route &&
        event.target.closest(
          "#project-list [data-task], [data-activity-task], #new-conversation, .sidebar-nav .nav-item:not(#apps-nav):not(#goals-nav)"
        )
      )
        close();
    },
    true
  );
  document.querySelector(ui('[aria-label="后退"]'))?.addEventListener(
    "click",
    (event) => {
      if (!route) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      if (route.view === "detail") navigate({ view: "goals" });
      else close();
    },
    true
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && route && !form.isOpen && !event.defaultPrevented) {
      event.preventDefault();
      const menu = workspace.querySelector(".goal-menu[open]");
      if (menu) {
        menu.open = false;
        menu.querySelector("summary")?.focus();
      } else close();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void load();
  });
  setInterval(() => void load(), 15000);
  syncRoute();
  if (!route) void load();
  return {
    open,
    update() {
      if (route) {
        header();
        if (!changeTimer)
          changeTimer = setTimeout(() => {
            changeTimer = undefined;
            void load();
          }, 1000);
      }
    }
  };
}
