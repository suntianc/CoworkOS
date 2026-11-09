import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("work and observation keep their own selection, settings stays reachable and reload restores the entry", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    for (const [taskId, goal] of [
      ["entry-a", "入口验收 A"],
      ["entry-b", "入口验收 B"]
    ]) {
      const response = await page.request.post(`${dashboard.base}/api/tasks`, { data: { taskId, goal } });
      expect(response.ok()).toBe(true);
    }
    await page.goto(dashboard.base);
    await page.locator('.conversation-item[data-task="entry-b"]').click();
    await expect(page.locator("#topbar-task")).toHaveText("入口验收 B");

    const workTab = page.getByRole("tab", { name: "工作", exact: true });
    const observeTab = page.getByRole("tab", { name: "观测", exact: true });
    const settings = page.getByRole("button", { name: "设置", exact: true });
    await expect(workTab).toHaveAttribute("aria-selected", "true");
    await expect(settings).toBeVisible();

    await observeTab.click();
    await expect(observeTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#observe-entry")).toBeVisible();
    await expect(page.locator("#work-entry")).toBeHidden();
    await expect(page.locator("#observe-title")).toHaveText("总览");
    await expect(settings).toBeVisible();

    await page.locator('[data-observe-view="requirements"]').click();
    await expect(page.locator("#observe-title")).toHaveText("需求");
    await expect(page.locator('[data-observe-panel="requirements"]')).not.toHaveAttribute("hidden");
    await expect(page.locator('[data-observe-panel="overview"]')).toHaveAttribute("hidden");

    await workTab.click();
    await expect(page.locator("#work-entry")).toBeVisible();
    await expect(page.locator("#observe-entry")).toBeHidden();
    await expect(page.locator("#topbar-task")).toHaveText("入口验收 B");

    await observeTab.click();
    await expect(page.locator("#observe-title")).toHaveText("需求");
    await expect(page.locator('[data-observe-view="requirements"]')).toHaveAttribute("aria-current", "page");

    await page.reload();
    await expect(observeTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#observe-title")).toHaveText("需求");
    await expect(page.locator('[data-observe-panel="requirements"]')).not.toHaveAttribute("hidden");
    await expect(settings).toBeVisible();

    await workTab.click();
    await expect(page.locator("#topbar-task")).toHaveText("入口验收 B");
    await expect(settings).toBeVisible();
  } finally {
    await dashboard.stop();
  }
});

test("the entry switch works from the keyboard and settings opens from either entry", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    const workTab = page.getByRole("tab", { name: "工作", exact: true });
    const observeTab = page.getByRole("tab", { name: "观测", exact: true });
    await workTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(observeTab).toBeFocused();
    await expect(observeTab).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowLeft");
    await expect(workTab).toBeFocused();
    await expect(workTab).toHaveAttribute("aria-selected", "true");

    await observeTab.click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  } finally {
    await dashboard.stop();
  }
});
