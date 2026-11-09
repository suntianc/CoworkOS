import { test, expect } from "@playwright/test";
import { startConfiguredDashboard } from "../test/dashboard-fixture.mjs";
import { createTask } from "./p45-work-helpers.js";

/**
 * A connection that the page can no longer use, and a catalog with no project,
 * both bring the guide back: the surface follows the data instead of a stored
 * "onboarding finished" flag.
 */
test("a model connection that is no longer usable returns the guide and locks sending", async ({ page }) => {
  const dashboard = await startConfiguredDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator(".new-session-start")).toBeVisible();
    await expect(page.locator(".first-use")).toHaveCount(0);

    await page.route("**/api/models", (route) =>
      route.fulfill({ json: { configured: false, current: null, models: [] } })
    );
    await page.reload();

    const modelStep = page.locator('.first-use-step[data-step="model"]');
    await expect(page.locator(".first-use")).toBeVisible();
    await expect(modelStep).toHaveAttribute("data-state", "current");
    await expect(page.locator('.first-use-step[data-step="project"]')).toHaveAttribute("data-state", "done");
    await expect(page.locator("#composer-input")).toHaveAttribute("placeholder", "连接模型后即可开始…");
    await expect(page.locator("#send-button")).toBeDisabled();

    const before = (await (await page.request.get(`${dashboard.base}/api/tasks`)).json()).tasks.length;
    await page.locator("#composer-input").fill("连接失效时不应发送");
    await page.locator("#composer-input").press("Enter");
    await expect(page.locator("#send-button")).toBeDisabled();
    expect(await page.locator('[role="dialog"]:visible').count()).toBe(0);
    const after = (await (await page.request.get(`${dashboard.base}/api/tasks`)).json()).tasks.length;
    expect(after).toBe(before);
  } finally {
    await dashboard.stop();
  }
});

test("removing every project returns the empty sidebar and the guide, and the projects restore it", async ({
  page
}) => {
  const dashboard = await startConfiguredDashboard();
  try {
    await createTask(page, dashboard, {
      taskId: "kept-session",
      goal: "保留到项目回来",
      projectId: dashboard.projectId
    });
    await page.goto(dashboard.base);
    await expect(page.locator(".conversation-item[data-task=kept-session]")).toBeVisible();
    await expect(page.locator(".first-use")).toHaveCount(0);

    await page.route("**/api/tasks", async (route) => {
      const response = await route.fetch();
      const catalog = await response.json();
      await route.fulfill({ response, json: { ...catalog, projects: [], tasks: [] } });
    });

    await expect(page.locator(".first-use")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.first-use-step[data-step="model"]')).toHaveAttribute("data-state", "done");
    await expect(page.locator('.first-use-step[data-step="project"]')).toHaveAttribute(
      "data-state",
      "current"
    );
    await expect(page.locator(".sidebar-empty-state")).toHaveText("还没有项目");
    await expect(page.locator(".project-group")).toHaveCount(0);
    await expect(page.locator("#new-project")).toBeVisible();
    // The connection still works, and a message without a project starts a
    // temporary session, so only the project step is waiting on this host.
    await expect(page.locator("#send-button")).toBeEnabled();

    await page.unroute("**/api/tasks");
    await expect(page.locator(".first-use")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator(".project-group")).toHaveCount(1);
    await expect(page.locator(".sidebar-empty-state")).toHaveCount(0);
  } finally {
    await dashboard.stop();
  }
});
