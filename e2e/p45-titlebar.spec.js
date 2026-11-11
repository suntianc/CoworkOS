import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { createProject, createTask } from "./p45-work-helpers.js";
import { seedRequirement } from "./p45-requirement-fixture.js";

test("the title row names the project, the requirement and walks back and forward through conversations", async ({
  page
}, testInfo) => {
  const dashboard = await startDashboard();
  try {
    const project = await createProject(page, dashboard, "顶栏项目", testInfo.outputPath("titlebar-project"));
    const seeded = await seedRequirement(page, dashboard, project, {
      title: "按分数文件汇总总分",
      phase: "review"
    });
    await createTask(page, dashboard, {
      taskId: "titlebar-b",
      goal: "第二个会话",
      projectId: project.projectId
    });
    await page.goto(`${dashboard.base}/?task=${encodeURIComponent(seeded.session.taskId)}`);
    const back = page.locator("#history-back");
    const forward = page.locator("#history-forward");
    const title = page.locator("#topbar-task");

    // Where the conversation lives and what it is working on.
    await expect(page.locator("#topbar-project")).toBeVisible();
    await expect(page.locator("[data-topbar-project-name]")).toHaveText("顶栏项目");
    const chip = page.locator("#topbar-requirement");
    await expect(chip).toHaveText("需求 · 按分数文件汇总总分");
    await expect(back).toBeDisabled();
    await expect(forward).toBeDisabled();
    const first = await title.textContent();

    // The chip opens the requirement panel it summarises.
    await expect(page.locator("#agent-pane")).toBeHidden();
    await chip.click();
    await expect(page.locator("#agent-pane")).toBeVisible();
    await page.locator("#output-pane-toggle").click();

    await page.locator('.conversation-item[data-task="titlebar-b"]').click();
    await expect(title).toHaveText("第二个会话");
    await expect(chip).toBeHidden();
    await expect(back).toBeEnabled();
    await expect(forward).toBeDisabled();

    await back.click();
    await expect(title).toHaveText(first);
    await expect(forward).toBeEnabled();
    await expect(back).toBeDisabled();
    await forward.click();
    await expect(title).toHaveText("第二个会话");

    // The same history answers ⌘[ and ⌘] outside text fields.
    await page.locator("#topbar-task").click();
    await page.keyboard.press("Meta+BracketLeft");
    await expect(title).toHaveText(first);
    await page.keyboard.press("Meta+BracketRight");
    await expect(title).toHaveText("第二个会话");
    // Inside the composer the keys stay with the text.
    await page.locator("#composer-input").focus();
    await page.keyboard.press("Meta+BracketLeft");
    await expect(title).toHaveText("第二个会话");

    // Search and new session sit in the title row.
    await page.locator("#titlebar-new-session").click();
    // Without a model the new-session page is the first-use guide.
    await expect(title).toHaveText(/^(新会话|开始使用)$/);
    await expect(page).not.toHaveURL(/[?&]task=/);
    await expect(page.locator("[data-topbar-project-name]")).toHaveText("顶栏项目");
    await page.locator("#titlebar-search").click();
    await expect(page.getByRole("dialog", { name: "搜索对话" })).toBeVisible();
    await page.keyboard.press("Escape");
  } finally {
    await dashboard.stop();
  }
});

test("the sidebar toggle collapses the sidebar on a wide window and remembers it", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.request.post(`${dashboard.base}/api/tasks`, {
      data: { taskId: "collapse-a", goal: "收起侧栏" }
    });
    await page.goto(dashboard.base);
    const toggle = page.locator("#sidebar-toggle");
    const sidebar = page.locator("#conversation-sidebar");
    await expect(toggle).toHaveAttribute("data-sidebar-mode", "collapse");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#work-entry")).toHaveJSProperty("offsetLeft", 258);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveAttribute("aria-label", "展开侧栏");
    await expect(sidebar).toBeHidden();
    await expect(sidebar).toHaveJSProperty("inert", true);
    await expect.poll(async () => Math.round((await page.locator("#work-entry").boundingBox()).x)).toBe(10);
    // The navigation stays put in the title row.
    expect(Math.round((await toggle.boundingBox()).x)).toBe(12);

    await page.reload();
    await expect(page.locator("#sidebar-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(sidebar).toBeHidden();

    // A rail-width window collapses the rail the same way; a phone window uses the drawer.
    await page.setViewportSize({ width: 800, height: 800 });
    await expect(sidebar).toBeHidden();
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.locator("#sidebar-toggle")).toHaveAttribute("data-sidebar-mode", "drawer");
    await page.locator("#sidebar-toggle").click();
    await expect(sidebar).toBeVisible();
    await page.locator("#sidebar-drawer-close").click();
    await expect(sidebar).toBeHidden();

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator("#sidebar-toggle").click();
    await expect(sidebar).toBeVisible();
    await expect(page.locator("#sidebar-toggle")).toHaveAttribute("aria-expanded", "true");
  } finally {
    await dashboard.stop();
  }
});
