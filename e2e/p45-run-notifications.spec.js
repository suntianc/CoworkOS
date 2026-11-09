import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { createTask, markTaskRunning, writeHumanQuestion } from "./p45-work-helpers.js";

const toast = (page, text) => page.locator(".toast-card").filter({ hasText: text }).last();

test("switching conversations, a Main question and a node reconnect each notify once", async ({
  page
}, testInfo) => {
  test.setTimeout(90_000);
  const dashboard = await startDashboard();
  try {
    await createTask(page, dashboard, {
      taskId: "notice-report",
      goal: "评分汇总验收",
      projectId: dashboard.projectId
    });
    await createTask(page, dashboard, {
      taskId: "notice-login",
      goal: "修复登录超时",
      projectId: dashboard.projectId
    });
    await markTaskRunning(dashboard, { taskId: "notice-report", runId: "run-report" });
    await markTaskRunning(dashboard, { taskId: "notice-login", runId: "run-login" });
    await page.goto(`${dashboard.base}?task=notice-report`);
    await page.locator('.conversation-item[data-task="notice-report"]').click();
    await page.locator('.conversation-item[data-task="notice-login"]').click();
    const switched = toast(page, "已切换到");
    await expect(switched).toBeVisible();
    await expect(switched).toContainText("修复登录超时");
    await expect(switched).toContainText("评分汇总验收");
    await expect(switched).toContainText("仍在后台运行");
    expect(
      (await (await page.request.get(`${dashboard.base}/api/tasks/notice-report`)).json()).task.status
    ).toBe("running");

    await writeHumanQuestion(dashboard, {
      taskId: "notice-report",
      runId: "run-report",
      question: "合入前需要保留旧接口吗？"
    });
    const question = toast(page, "Main 有问题等你回答");
    await expect(question).toBeVisible({ timeout: 15_000 });
    await expect(question).toContainText("评分汇总验收");

    await page.route("**/api/tasks", (route) => route.abort());
    const offline = toast(page, "本机节点连接中断");
    await expect(offline).toBeVisible({ timeout: 15_000 });
    await expect(offline).toContainText("正在重连");
    await page.screenshot({ path: testInfo.outputPath("run-notifications-1440.png") });
    // A conversation created while the page cannot read the catalog appears
    // only if the recovered read adopts the backend's current state.
    const added = await page.request.post(`${dashboard.base}/api/tasks`, {
      data: { taskId: "notice-offline", goal: "断线期间新增", projectId: dashboard.projectId }
    });
    expect(added.ok()).toBe(true);

    await page.unroute("**/api/tasks");
    const online = toast(page, "本机节点已重新连接");
    await expect(online).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.conversation-item[data-task="notice-offline"]')).toBeVisible({
      timeout: 15_000
    });
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await dashboard.stop();
  }
});
