import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { createProject, createTask, markTaskRunning } from "./p45-work-helpers.js";

test("projects hold their Main sessions and Subagents, folds persist, and no stage label leaks into the tree", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    const second = await createProject(page, dashboard, "第二个项目", `${dashboard.root}/second-project`);
    const projectId = dashboard.projectId;
    await createTask(page, dashboard, {
      taskId: "tree-rating",
      goal: "评分汇总验收",
      projectId
    });
    await createTask(page, dashboard, { taskId: "tree-timeout", goal: "修复登录超时", projectId });
    await createTask(page, dashboard, {
      taskId: "tree-docs",
      goal: "文档整理",
      projectId: second.projectId
    });
    await markTaskRunning(dashboard, {
      taskId: "tree-rating",
      runId: "run-tree",
      subagents: [
        { agentId: "subagent_1", role: "executor" },
        { agentId: "subagent_2", role: "reviewer" }
      ]
    });
    await page.goto(dashboard.base);

    const first = page.locator(`.project-group[data-project="${projectId}"]`);
    const secondProject = page.locator(`.project-group[data-project="${second.projectId}"]`);
    await expect(first.locator(".project-name")).toHaveText("测试项目");
    await expect(secondProject.locator(".project-name")).toHaveText("第二个项目");

    const rating = first.locator('.conversation-item[data-task="tree-rating"]');
    await expect(rating).toHaveText("评分汇总验收");
    await expect(rating).not.toHaveAttribute("aria-description");
    await expect(first.locator(".conversation-activity")).toHaveCount(0);
    await expect(rating).toHaveAttribute("data-status", "running");

    const subagents = first.locator(".subagent-row");
    await expect(subagents).toHaveCount(2);
    await expect(subagents.nth(0)).toContainText("Ara");
    await expect(subagents.nth(0)).toContainText("Executor");
    await expect(subagents.nth(1)).toContainText("Norma");
    await expect(subagents.nth(1)).toContainText("Reviewer");
    await expect(secondProject.locator(".subagent-row")).toHaveCount(0);

    await first.locator('[data-session-toggle="tree-rating"]').click();
    await expect(first.locator(".subagent-row")).toHaveCount(0);
    await expect(first.locator('[data-session-toggle="tree-rating"]')).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    await first.locator('[data-session-toggle="tree-rating"]').click();
    await expect(first.locator(".subagent-row")).toHaveCount(2);

    await first.locator("[data-project-id]").click();
    await expect(first).toHaveClass(/collapsed/);
    await expect(first.locator(".project-count")).toHaveText("2");
    await expect(first.locator(".subagent-row").first()).toBeHidden();

    await page.reload();
    const reloaded = page.locator(`.project-group[data-project="${projectId}"]`);
    await expect(reloaded).toHaveClass(/collapsed/);
    await expect(reloaded.locator(".project-count")).toHaveText("2");
    await expect(reloaded.locator('.conversation-item[data-task="tree-rating"]')).toBeHidden();
    await reloaded.locator("[data-project-id]").click();
    await expect(reloaded.locator('.conversation-item[data-task="tree-rating"]')).toBeVisible();
    await expect(reloaded.locator(".subagent-row")).toHaveCount(2);
  } finally {
    await dashboard.stop();
  }
});
