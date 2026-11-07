import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { GoalManagement } from "../dist/src/runtime/goal-management.js";
const path = (goal) => `/api/tasks/${goal.taskId}/goals/${goal.programId}`;
async function seed(app, name, options = {}) {
  const manager = new GoalManagement(app.workspaceRoot);
  let goal = await manager.create(undefined, {
    brief: {
      title: name,
      objective: `测试数据：持续关注${name}，重要变化及时通知。`,
      preferences: ["只关注可靠来源"]
    },
    requestId: name,
    scope: "background"
  });
  goal = await manager.progress(goal.taskId, goal.programId, 1, {
    summary: `已建立${name}的跟进计划`,
    nextAction: "核实新变化",
    disposition: options.decision ? "needs_input" : "wait",
    waitingFor: options.decision ? "是否包含预览版本？" : "等待可靠来源的新内容",
    nextReviewAt: options.decision ? null : new Date(Date.now() + 86400000).toISOString(),
    steps: [
      { id: "source", description: "确认观察范围", status: "completed", evidence: "已确认官方来源" },
      { id: "follow", description: "跟进有意义的新变化", status: "active" }
    ],
    facts: ["一条测试事实"]
  });
  if (options.paused) goal = await manager.control(goal.taskId, goal.programId, "pause", goal.goal.revision);
  return goal;
}
async function open(page, app) {
  await page.goto(app.base);
  await page.locator("#goals-nav").click();
  await expect(page.locator(".goal-workspace")).toBeVisible();
}

test("overview prioritizes decisions, keeps paused work quiet, and reveals information in separate views", async ({
  page
}) => {
  const app = await startDashboard();
  try {
    await seed(app, "Claude Code 官方动态");
    await seed(app, "训练结果", { paused: true });
    await seed(app, "发布渠道", { decision: true });
    await open(page, app);
    await expect(page.locator(".modal-backdrop:visible")).toHaveCount(0);
    await expect(page.locator(".goal-group").first()).toContainText("需要你处理");
    await expect(page.locator(".goal-item").filter({ hasText: "训练结果" })).not.toBeVisible();
    await expect(page.locator(".goal-plan")).toHaveCount(0);
    await expect(page.locator(".goal-source-settings")).toHaveCount(0);
    await page.screenshot({ path: ".tmp/watcher-verification/goals-overview-desktop.png" });
    await page.locator(".goal-item").filter({ hasText: "Claude Code 官方动态" }).click();
    await expect(page.locator(".goal-progress")).toContainText("已建立");
    await expect(page.locator(".goal-plan")).toHaveCount(0);
    await page.getByRole("tab", { name: "计划", exact: true }).click();
    await expect(page.locator(".goal-plan")).toContainText("跟进有意义的新变化");
    await expect(page.locator(".goal-notices")).toHaveCount(0);
    await page.getByRole("tab", { name: "设置", exact: true }).click();
    await expect(page.locator(".goal-settings")).toContainText("只关注可靠来源");
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("tab", { name: "计划", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "所有目标", exact: true }).click();
    await page.locator(".goal-item").filter({ hasText: "发布渠道" }).click();
    await expect(page.locator(".goal-decision")).toContainText("是否包含预览版本");
    await page.locator('[name="answer"]').fill("仅正式发布");
    await page.getByRole("tab", { name: "计划", exact: true }).click();
    await page.getByRole("tab", { name: "进展", exact: true }).click();
    // Reading the plan must not discard an unfinished decision.
    await expect(page.locator(".goal-decision")).toBeVisible();
    await expect(page.locator('[name="answer"]')).toHaveValue("仅正式发布");
  } finally {
    await app.stop();
  }
});

test("global activity paginates across goals, preserves unread state and links to evidence", async ({
  page
}) => {
  const app = await startDashboard();
  try {
    const a = await seed(app, "官方发布"),
      b = await seed(app, "兼容性变更");
    const manager = new GoalManagement(app.workspaceRoot);
    for (let i = 0; i < 37; i++) {
      const goal = i % 2 ? a : b;
      await manager.publish(goal.taskId, goal.programId, goal.goal.revision, {
        topicKey: `fixture-${i}`,
        kind: "important",
        title: `测试进展 ${i}`,
        summary: "已核实的测试变化",
        sources: [{ title: "测试来源", url: `https://example.com/news/${i}` }]
      });
    }
    await open(page, app);
    await page.locator('[data-goal-page="activity"]').click();
    await expect(page.locator(".goal-activity-feed .goal-notice")).toHaveCount(30);
    await page.getByRole("button", { name: "加载更早动态", exact: true }).click();
    await expect(page.locator(".goal-activity-feed .goal-notice")).toHaveCount(37);
    expect(
      await page
        .locator(".goal-notice")
        .evaluateAll((nodes) => new Set(nodes.map((node) => node.dataset.noticeId)).size)
    ).toBe(37);
    await expect(page.locator(".goal-source-link").first()).toHaveAttribute("href", /example.com\/news/);
    await page.locator("[data-notice-read]").first().click();
    await expect(page.locator("#goals-unread")).toHaveText("36");
    await page.locator('[data-feed-filter="unread"]').click();
    await expect(page.locator(".goal-notice")).toHaveCount(30);
    await page.getByRole("button", { name: "加载更早动态", exact: true }).click();
    await expect(page.locator(".goal-notice")).toHaveCount(36);
    await page.screenshot({ path: ".tmp/watcher-verification/goals-activity-desktop.png" });
    await page.getByRole("button", { name: "查看目标 →", exact: true }).first().click();
    await expect(page.locator(".goal-detail-heading")).toBeVisible();
    await page.reload();
    await expect(page.locator(".goal-detail-heading")).toBeVisible();
    await expect(page.locator("#goals-unread")).toHaveText("36");
  } finally {
    await app.stop();
  }
});

test("activity renders readable Markdown and clickable evidence without marking it read", async ({
  page,
  context
}) => {
  const app = await startDashboard();
  try {
    const goal = await seed(app, "历史回放排版");
    const manager = new GoalManagement(app.workspaceRoot);
    await manager.publish(goal.taskId, goal.programId, goal.goal.revision, {
      topicKey: "markdown-fixture",
      kind: "important",
      title: "历史回放：已核实的重置消息",
      summary: [
        "## 已核实的结果",
        "**历史回放，不是新的重置。**",
        "",
        "- 原帖：[查看公告](https://example.invalid/reset)",
        "- 原始证据：https://example.invalid/$folder$/original_post?source=a_b&replay=1",
        "- 计算记录：$x_1^2$，以及 \\(a*b\\)。",
        "",
        "> 原帖发布于历史日期。",
        "",
        "| 阶段 | 结果 |",
        "| --- | --- |",
        "| 采集 | 已完成 |",
        "",
        "```text",
        "https://example.invalid/literal_code",
        "```",
        "<img src=x onerror=alert(1)> [不安全](javascript:alert(1))"
      ].join("\n")
    });
    await open(page, app);
    await page.locator('[data-goal-page="activity"]').click();
    const card = page.locator(".goal-notice");
    const body = card.locator(".goal-markdown");
    await expect(body.locator("h2")).toHaveText("已核实的结果");
    await expect(body.locator("strong")).toHaveText("历史回放，不是新的重置。");
    await expect(body.locator("li")).toHaveCount(3);
    await expect(body.locator(".katex")).toHaveCount(2);
    await expect(body.locator("a .katex")).toHaveCount(0);
    await expect(body.locator("blockquote")).toContainText("历史日期");
    await expect(body.locator("table td").last()).toHaveText("已完成");
    await expect(body.locator("a")).toHaveCount(2);
    await expect(body.locator("img, script, code a")).toHaveCount(0);
    await expect(body.locator("a").last()).toHaveAttribute(
      "href",
      "https://example.invalid/$folder$/original_post?source=a_b&replay=1"
    );
    await context.route("https://example.invalid/reset", (route) =>
      route.fulfill({ body: "Historical source fixture", contentType: "text/plain" })
    );
    const popupPromise = page.waitForEvent("popup");
    await body.getByRole("link", { name: "查看公告" }).click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL("https://example.invalid/reset");
    await popup.close();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.reload();
    await expect(page.locator("#goals-unread")).toHaveText("1");
    await expect(body.locator("h2")).toBeVisible();
  } finally {
    await app.stop();
  }
});

test("goal navigation preserves project menus, settings and a separate conversation draft", async ({
  page
}) => {
  const app = await startDashboard();
  try {
    const goal = await seed(app, "集成中的后台目标");
    const created = await page.request.post(`${app.base}/api/tasks`, {
      data: { taskId: "integration-daily", goal: "普通会话保留" }
    });
    expect(created.ok()).toBe(true);
    await page.goto(app.base);
    await page.locator('#project-list [data-task="integration-daily"]').click();
    await page.locator("#composer-input").fill("回到普通会话后继续编辑");
    await expect(page.locator("#new-project")).toBeEnabled();
    await expect(page.locator(`#project-list [data-task="${goal.taskId}"]`)).toHaveCount(0);
    await page.locator("#goals-nav").click();
    await expect(page.locator(".goal-workspace")).toBeVisible();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const overview = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(overview.getByRole("button", { name: "管理模型连接", exact: true })).toBeVisible();
    await expect(overview.getByRole("button", { name: "管理科学环境", exact: true })).toHaveCount(0);
    await overview.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(page.locator(".goal-workspace")).toBeVisible();
    await page.locator(".goal-item").filter({ hasText: "集成中的后台目标" }).click();
    await page.getByRole("button", { name: "打开对话 ↗", exact: true }).click();
    await expect(page.locator(".goal-workspace")).toBeHidden();
    await expect(page.locator(`#project-list [data-task="${goal.taskId}"]`)).toBeVisible();
    await expect(page.locator(`#project-list [data-session-menu="${goal.taskId}"]`)).toBeVisible();
    if (!(await page.locator("#agent-pane").isVisible()))
      await page.getByRole("button", { name: "切换任务面板", exact: true }).click();
    await expect(page.locator("#monitor-section")).toBeVisible();
    await expect(page.locator("#detail-body")).toHaveCount(1);
    await expect(page.locator("#run-statistics-status")).toHaveCount(1);
    await page.locator('#project-list [data-task="integration-daily"]').click();
    await expect(page.locator("#composer-input")).toHaveValue("回到普通会话后继续编辑");
    await expect(page.locator(`#project-list [data-task="${goal.taskId}"]`)).toHaveCount(0);
  } finally {
    await app.stop();
  }
});

test("opening a goal conversation supersedes an earlier tab activation while its detail is loading", async ({
  page
}) => {
  const app = await startDashboard();
  let releaseOld, releaseDetail;
  const oldGate = new Promise((resolve) => {
    releaseOld = resolve;
  });
  const detailGate = new Promise((resolve) => {
    releaseDetail = resolve;
  });
  let oldStarted = false,
    detailStarted = false;
  try {
    const goal = await seed(app, "导航竞争中的后台目标");
    for (const id of ["race-a", "race-b"]) {
      expect(
        (
          await page.request.post(`${app.base}/api/tasks`, { data: { taskId: id, goal: `普通会话 ${id}` } })
        ).ok()
      ).toBe(true);
      expect(
        (
          await page.request.post(`${app.base}/api/workbench/tabs`, {
            data: { kind: "conversation", taskId: id, activate: false }
          })
        ).ok()
      ).toBe(true);
    }
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto(app.base);
    await page.locator('#project-list [data-task="race-b"]').click();
    await expect(page.locator("#topbar-task")).toContainText("race-b");
    await expect
      .poll(async () => (await (await page.request.get(`${app.base}/api/workbench/tabs`)).json()).activeTabId)
      .toBe("conversation:race-b");
    await page.route("**/api/workbench/tabs", async (route) => {
      if (
        oldStarted ||
        route.request().method() !== "PATCH" ||
        route.request().postDataJSON().tabId !== "conversation:race-a"
      )
        return route.continue();
      const response = await route.fetch();
      oldStarted = true;
      await oldGate;
      await route.fulfill({ response });
    });
    await page.locator('[data-tab="conversation:race-a"]').click();
    await expect.poll(() => oldStarted).toBe(true);
    await page.locator("#goals-nav").click();
    await page.locator(".goal-item").filter({ hasText: "导航竞争中的后台目标" }).click();
    await page.route(`**/api/tasks/${goal.taskId}`, async (route) => {
      if (detailStarted || route.request().method() !== "GET") return route.continue();
      detailStarted = true;
      await detailGate;
      await route.continue();
    });
    await page.getByRole("button", { name: "打开对话 ↗", exact: true }).click();
    await expect.poll(() => detailStarted).toBe(true);
    const goalRow = page.locator(`#project-list [data-task="${goal.taskId}"]`);
    await expect(goalRow).toHaveClass(/active/);
    await page.locator("#composer-input").fill("后台目标的未发送草稿");
    const oldResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/workbench/tabs") &&
        response.request().method() === "PATCH" &&
        response.request().postDataJSON().tabId === "conversation:race-a"
    );
    releaseOld();
    await (await oldResponse).finished();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    await expect(goalRow).toHaveClass(/active/);
    await expect(page.locator('#project-list [data-task="race-a"]')).not.toHaveClass(/active/);
    const goalResponse = page.waitForResponse(
      (response) =>
        response.url() === `${app.base}/api/tasks/${goal.taskId}` && response.request().method() === "GET"
    );
    releaseDetail();
    await (await goalResponse).finished();
    await expect
      .poll(async () => (await (await page.request.get(`${app.base}/api/workbench/tabs`)).json()).activeTabId)
      .toBe(`conversation:${goal.taskId}`);
    await expect(goalRow).toHaveClass(/active/);
    await expect(page.locator("#composer-input")).toHaveValue("后台目标的未发送草稿");
  } finally {
    releaseOld();
    releaseDetail();
    await page.unrouteAll({ behavior: "wait" });
    await app.stop();
  }
});

test("late detail responses cannot replace another goal, and deep links preserve selected view", async ({
  page
}) => {
  const app = await startDashboard();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  try {
    const a = await seed(app, "慢速目标"),
      b = await seed(app, "当前目标");
    await open(page, app);
    await page.route(`**${path(a)}`, async (route) => {
      await gate;
      await route.continue().catch(() => {});
    });
    await page.locator(".goal-item").filter({ hasText: "慢速目标" }).click();
    await page.locator('[data-goal-page="goals"]').click();
    await page.locator(".goal-item").filter({ hasText: "当前目标" }).click();
    await expect(page.locator(".goal-detail-heading")).toContainText("当前目标");
    release();
    await page.getByRole("tab", { name: "计划", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${b.programId}/plan$`));
    await page.reload();
    await expect(page.getByRole("tab", { name: "计划", exact: true })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(page.locator(".goal-detail-heading")).toContainText("当前目标");
    await page.getByRole("button", { name: "后退", exact: true }).click();
    await expect(page.getByRole("group", { name: "目标范围", exact: true })).toBeVisible();
  } finally {
    release();
    await app.stop();
  }
});

test("natural-language creation needs no name and leaves the conversation draft intact", async ({ page }) => {
  const app = await startDashboard();
  try {
    await page.goto(app.base);
    await page.locator("#composer-input").fill("保留我的原对话草稿");
    await page.locator("#goals-nav").click();
    await page.getByRole("button", { name: "新建目标", exact: true }).click();
    await expect(page.locator('[name="title"]')).not.toBeVisible();
    await page.locator('[name="objective"]').fill("只关注 Claude Code 的重要安全更新");
    await page.screenshot({ path: ".tmp/watcher-verification/goals-create-desktop.png" });
    await page.getByRole("button", { name: "开始跟进", exact: true }).click();
    await expect(page.locator(".goal-detail-heading")).toContainText("只关注 Claude Code");
    await page.getByRole("button", { name: "返回对话 ↗", exact: true }).click();
    await expect(page.locator("#composer-input")).toHaveValue("保留我的原对话草稿");
    await expect(page.locator(".goal-workspace")).not.toBeVisible();
  } finally {
    await app.stop();
  }
});

test("mobile goals and decisions remain reachable without horizontal overflow or a modal stack", async ({
  page
}) => {
  const app = await startDashboard();
  try {
    await seed(app, "关注 Claude Code 官方变化");
    await seed(app, "有一个问题等你回答", { decision: true });
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto(app.base);
    await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
    await page.locator("#goals-nav").click();
    await expect(page.getByRole("group", { name: "目标范围", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "新建目标", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator(".modal-backdrop:visible")).toHaveCount(0);
    await page.screenshot({ path: ".tmp/watcher-verification/goals-overview-mobile.png" });
    await page.locator(".goal-item").filter({ hasText: "有一个问题等你回答" }).click();
    await expect(page.locator(".goal-decision")).toBeVisible();
    await expect(page.locator('[name="answer"]')).toBeEditable();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(
      await page.locator(".goal-workspace").evaluate((node) => node.scrollWidth <= node.clientWidth)
    ).toBe(true);
    await page.screenshot({ path: ".tmp/watcher-verification/goals-decision-mobile.png" });
    await page.keyboard.press("Escape");
    await expect(page.locator("#composer-input")).toBeVisible();
  } finally {
    await app.stop();
  }
});

test("the sidebar activity entry has one destination and recent conversations stay available", async ({
  page
}) => {
  const app = await startDashboard();
  try {
    await seed(app, "后台继续跟进");
    await fetch(`${app.base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: "recent-source", goal: "日常开发" })
    });
    await page.goto(app.base);
    const nav = page.locator(".sidebar-nav");
    expect(
      await nav.locator(":scope > button").evaluateAll((buttons) => buttons.map((button) => button.id))
    ).toEqual(["", "apps-nav", "goals-nav"]);
    await expect(page.locator(".sidebar-bottom #goals-nav")).toHaveCount(0);
    await page.locator("#goals-nav").click();
    await expect(page.locator("#goals-nav")).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("group", { name: "目标范围", exact: true })).toBeVisible();
    // Reopening from a goal detail must not close/reopen the workspace through
    // the generic sidebar navigation capture handler.
    await page.locator(".goal-item").click();
    await page.locator("#goals-nav").click();
    await expect(page.getByRole("group", { name: "目标范围", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "任务动态", exact: true }).click();
    await expect(page.locator(".goal-workspace")).toBeVisible();
    await expect(page.locator('[data-goal-page="activity"]')).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".modal-backdrop:visible")).toHaveCount(0);
    await page.getByRole("button", { name: "最近会话 ↗", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("最近会话");
    await expect(page.getByRole("dialog")).not.toContainText("后台继续跟进");
    await page.locator('[data-activity-task="recent-source"]').click();
    await expect(page.locator(".goal-workspace")).not.toBeVisible();
    await expect(page.locator("#topbar-task")).toContainText("日常开发");
  } finally {
    await app.stop();
  }
});

test("a stale poll finishing after pause cannot revert the user's visible state", async ({ page }) => {
  const app = await startDashboard();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  try {
    const goal = await seed(app, "暂停状态竞争");
    await open(page, app);
    await page.locator(".goal-item").click();
    await expect(page.locator(".goal-detail-heading")).toContainText("持续关注中");
    const stale = await (await fetch(`${app.base}${path(goal)}`)).json();
    let held = false;
    await page.route(`**${path(goal)}`, async (route) => {
      if (held) return route.continue();
      held = true;
      await gate;
      await route
        .fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(stale) })
        .catch(() => {});
    });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => held).toBe(true);
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(page.locator(".goal-detail-heading")).toContainText("已暂停");
    const completed = page.waitForResponse((response) => response.url() === `${app.base}${path(goal)}`);
    release();
    await completed;
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    await expect(page.locator(".goal-detail-heading")).toContainText("已暂停");
  } finally {
    release();
    await app.stop();
  }
});

test("saving requirements keeps the editor open until refresh completes, then resume works on the first click", async ({
  page
}) => {
  const app = await startDashboard();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  try {
    const goal = await seed(app, "保存后恢复", { paused: true });
    await open(page, app);
    await page.locator(".goal-item").click();
    await page.locator(".goal-menu > summary").click();
    await page.getByRole("button", { name: "修改要求", exact: true }).click();
    await page.locator('[name="preferences"]').fill("只关注官方来源，不自动恢复");
    let held = false;
    await page.route("**/api/tasks", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      held = true;
      await gate;
      await route.continue().catch(() => {});
    });
    await page.getByRole("button", { name: "保存要求", exact: true }).click();
    await expect.poll(() => held).toBe(true);
    await expect(page.locator(".goal-form-dialog")).toBeVisible();
    await expect(page.getByRole("button", { name: "保存要求", exact: true })).toBeDisabled();
    release();
    await expect(page.locator(".goal-form-dialog")).not.toBeVisible();
    await page.getByRole("button", { name: "恢复", exact: true }).click();
    await expect(page.locator(".goal-detail-heading")).not.toContainText("已暂停");
    const current = await (await fetch(`${app.base}${path(goal)}`)).json();
    expect(current.status).not.toBe("paused");
    expect(current.goal.brief.preferences).toEqual(["只关注官方来源，不自动恢复"]);
  } finally {
    release();
    await app.stop();
  }
});

test("long reports stay compact until opened and their disclosure survives refresh", async ({ page }) => {
  const app = await startDashboard();
  try {
    const goal = await seed(app, "长报告");
    const manager = new GoalManagement(app.workspaceRoot);
    await manager.publish(goal.taskId, goal.programId, goal.goal.revision, {
      topicKey: "long-report",
      kind: "important",
      title: "测试：完整版本变化",
      summary: "经过核实的变化。".repeat(300) + "结尾证据已确认"
    });
    await open(page, app);
    await page.locator(".goal-item").click();
    const report = page.locator(".goal-readable");
    await expect(report).toBeVisible();
    await expect(report.locator("p")).not.toBeVisible();
    await report.locator("summary").click();
    await expect(report.locator("p")).toContainText("结尾证据已确认");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(report).toHaveAttribute("open", "");
    await expect(report.locator("p")).toBeVisible();
  } finally {
    await app.stop();
  }
});
