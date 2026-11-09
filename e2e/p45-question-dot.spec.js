import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { createTask, markTaskRunning, writeHumanQuestion } from "./p45-work-helpers.js";

test("a Main question marks its session and its folded project until the person answers", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await createTask(page, dashboard, {
      taskId: "question-login",
      goal: "修复登录超时",
      projectId: dashboard.projectId
    });
    await createTask(page, dashboard, {
      taskId: "question-report",
      goal: "评分汇总",
      projectId: dashboard.projectId
    });
    await markTaskRunning(dashboard, { taskId: "question-login", runId: "run-question" });
    await writeHumanQuestion(dashboard, {
      taskId: "question-login",
      runId: "run-question",
      question: "合入前需要保留旧接口吗？"
    });
    await page.goto(dashboard.base);

    const project = page.locator(`.project-group[data-project="${dashboard.projectId}"]`);
    const session = project.locator('.conversation-item[data-task="question-login"]');
    const other = project.locator('.conversation-item[data-task="question-report"]');
    await expect(session.locator(".conversation-question")).toBeVisible();
    await expect(other.locator(".conversation-question")).toHaveCount(0);

    await project.locator("[data-project-id]").click();
    await expect(project).toHaveClass(/collapsed/);
    await expect(project.locator(".project-question")).toBeVisible();
    await expect(project.locator(".project-count")).toHaveText("2");

    await project.locator("[data-project-id]").click();
    await session.click();
    const answer = page.locator("#human-questions");
    await expect(answer).toContainText("合入前需要保留旧接口吗？");
    await answer.locator("#human-answer-text").fill("保留旧接口，并补一个兼容测试");
    await answer.locator(".human-submit").click();

    await expect(session.locator(".conversation-question")).toHaveCount(0, { timeout: 15_000 });
    await project.locator("[data-project-id]").click();
    await expect(project.locator(".project-question")).toHaveCount(0);
  } finally {
    await dashboard.stop();
  }
});
