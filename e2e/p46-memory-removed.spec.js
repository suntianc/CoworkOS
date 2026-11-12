import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

/**
 * P4.6 #01: the settings and work pages carry no memory or project-experience
 * entry, section or explanatory copy. The retired surfaces used to live in the
 * settings tools section and the project row menu.
 */

const retiredSelectors = [
  ".user-memory-settings",
  ".user-memory-setting",
  ".user-memory-editor",
  ".user-memory-compose",
  ".project-experience-settings",
  ".project-experience-editor",
  "#project-experience-open"
];
const retiredWording = /记忆|项目经验|自动学习/;

test("settings and the work page offer no memory or experience entry", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    // A project row only renders with a conversation, and its ⋯ menu is one of
    // the places the retired experience entry used to live.
    const created = await page.request.post(`${dashboard.base}/api/tasks`, {
      data: { taskId: "p46-shell", goal: "界面入口检查", projectId: dashboard.projectId }
    });
    expect(created.status()).toBe(201);
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    await expect(page.locator(".work-sidebar").first()).toBeVisible();

    for (const selector of retiredSelectors) await expect(page.locator(selector)).toHaveCount(0);
    await expect(page.locator("#app-layout")).not.toContainText(retiredWording);

    // The project row menu keeps only the two commands that survive.
    const group = page.locator(".project-group").first();
    await expect(group).toBeVisible();
    const trigger = group.locator("[data-project-settings]");
    await trigger.locator("..").hover();
    await trigger.click();
    const menu = page.locator(".project-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator("[data-project-action]")).toHaveCount(2);
    await expect(menu).not.toContainText(retiredWording);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    await page.locator("#user-menu-button").click();
    await expect(page.locator("#settings-entry")).toBeVisible();
    for (const name of ["general", "nodes", "models", "capacity", "members", "tools"]) {
      await page.locator(`[data-settings-section="${name}"]`).click();
      const panel = page.locator(`[data-settings-panel="${name}"]`);
      await expect(panel).toBeVisible();
      await expect(panel).not.toContainText(retiredWording);
      for (const selector of retiredSelectors) await expect(panel.locator(selector)).toHaveCount(0);
    }

    // The retired routes are unreachable from the page as well as on the wire.
    expect((await page.request.get(`${dashboard.base}/api/user-memory`)).status()).toBe(404);
    expect(
      (await page.request.get(`${dashboard.base}/api/projects/${dashboard.projectId}/experience`)).status()
    ).toBe(404);
  } finally {
    await dashboard.stop();
  }
});
