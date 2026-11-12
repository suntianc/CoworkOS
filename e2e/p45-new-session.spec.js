import { test, expect } from "@playwright/test";
import { startConfiguredDashboard } from "../test/dashboard-fixture.mjs";
import { createProject, createTask } from "./p45-work-helpers.js";

test("new sessions start from the sidebar, the project plus and ⌘K, and land in the chosen project", async ({
  page
}) => {
  const dashboard = await startConfiguredDashboard();
  try {
    const second = await createProject(page, dashboard, "第二个项目", `${dashboard.root}/second-project`);
    await createTask(page, dashboard, {
      taskId: "session-existing",
      goal: "已有会话",
      projectId: dashboard.projectId
    });
    await page.goto(dashboard.base);

    await page.locator("#new-conversation").click();
    await expect(page.locator("#topbar-task")).toHaveText("新会话");
    await expect(page.locator(".new-session-start")).toBeVisible();
    await expect(page.locator("#composer-project")).toContainText("测试项目");
    const recent = page.locator('[data-recent-task="session-existing"]');
    await expect(recent).toContainText("已有会话");
    await recent.click();
    await expect(page.locator("#topbar-task")).toHaveText("已有会话");
    await expect(page.locator("#composer-project")).toBeHidden();

    await page.keyboard.press("Meta+k");
    await expect(page.locator(".new-session-start")).toBeVisible();
    await expect(page.locator("#composer-project")).toContainText("测试项目");

    const secondProject = page.locator(`.project-group[data-project="${second.projectId}"]`);
    await secondProject.locator(".project-heading").hover();
    await secondProject.locator(`[data-project-create="${second.projectId}"]`).click();
    await expect(page.locator(".new-session-start")).toBeVisible();
    await expect(page.locator("#composer-project")).toContainText("第二个项目");

    await page.locator("#composer-project").click();
    const menu = page.locator("#composer-project-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator("[data-add-project]")).toHaveText("添加项目…");
    await menu.locator(`[data-project-choice="${dashboard.projectId}"]`).click();
    await expect(page.locator("#composer-project")).toContainText("测试项目");
    await page.locator("#composer-project").click();
    await menu.locator(`[data-project-choice="${second.projectId}"]`).click();
    await expect(page.locator("#composer-project")).toContainText("第二个项目");

    await page.locator("#composer-input").fill("为第二个项目写一份说明");
    await page.locator("#send-button").click();
    await expect(page.locator("#topbar-task")).toHaveText("为第二个项目写一份说明");
    await expect(
      secondProject.locator(".conversation-item", { hasText: "为第二个项目写一份说明" })
    ).toBeVisible();
    await expect(
      page
        .locator(`.project-group[data-project="${dashboard.projectId}"]`)
        .locator(".conversation-item", { hasText: "为第二个项目写一份说明" })
    ).toHaveCount(0);
  } finally {
    await dashboard.stop();
  }
});

test("the project picker opens and switches projects before any session exists", async ({ page }) => {
  const dashboard = await startConfiguredDashboard({ defaultProject: false });
  try {
    const first = await createProject(page, dashboard, "首个项目", `${dashboard.root}/first-project`);
    const second = await createProject(page, dashboard, "另一个项目", `${dashboard.root}/other-project`);
    await page.goto(dashboard.base);
    await expect(page.locator(".new-session-start")).toBeVisible();
    const chip = page.locator("#composer-project");
    await expect(chip).toBeVisible();
    await chip.click();
    const menu = page.locator("#composer-project-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator(`[data-project-choice="${first.projectId}"]`)).toBeVisible();
    await menu.locator(`[data-project-choice="${second.projectId}"]`).click();
    await expect(chip).toContainText("另一个项目");
  } finally {
    await dashboard.stop();
  }
});

test("the composer keeps one size from a new session into a conversation, and 新会话 is selected like a row", async ({
  page
}) => {
  const dashboard = await startConfiguredDashboard();
  try {
    const project = await createProject(page, dashboard, "尺寸项目", `${dashboard.root}/size-project`);
    await createTask(page, dashboard, { taskId: "size-a", goal: "已有会话", projectId: project.projectId });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${dashboard.base}/?task=size-a`);
    await expect(page.locator("#topbar-task")).toHaveText("已有会话");
    const composer = page.locator(".composer");
    const inConversation = await composer.boundingBox();

    await page.locator("#new-conversation").click();
    await expect(page.locator(".new-session-start")).toBeVisible();
    expect(await composer.boundingBox()).toEqual(inConversation);
    const title = await page.locator(".new-session-title").boundingBox();
    expect(Math.round(title.x)).toBe(Math.round(inConversation.x));

    // The selected 新会话 uses the selected-row fill, edge and shadow in both themes.
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => window.atriaAppearance.set(value), theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const [button, row] = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const read = (node) => getComputedStyle(node).backgroundColor;
        const probe = document.createElement("div");
        probe.style.background = style.getPropertyValue("--selected-fill");
        document.body.append(probe);
        const expected = read(probe);
        probe.remove();
        return [read(document.querySelector("#new-conversation")), expected];
      });
      expect(button, theme).toBe(row);
    }
  } finally {
    await dashboard.stop();
  }
});
