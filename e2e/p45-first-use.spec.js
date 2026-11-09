import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

/**
 * A fresh data directory: no model connection and no project.
 *
 * The three steps are derived from those two facts, so this walks the same path
 * a person takes: connect the model from settings, add a project from the
 * guide, then start the first session.
 */
test("a fresh data directory walks the guide from the model to a working session", async ({ page }) => {
  const dashboard = await startDashboard({ defaultProject: false });
  const projectDirectory = join(dashboard.root, "first-project");
  try {
    await mkdir(projectDirectory);
    await page.goto(dashboard.base);

    const guide = page.locator(".first-use");
    const modelStep = page.locator('.first-use-step[data-step="model"]');
    const projectStep = page.locator('.first-use-step[data-step="project"]');
    const sessionStep = page.locator('.first-use-step[data-step="session"]');
    await expect(guide).toBeVisible();
    await expect(page.locator(".first-use-title")).toHaveText("欢迎使用 Formicand");
    await expect(page.locator("#topbar-task")).toHaveText("开始使用");
    await expect(modelStep).toHaveAttribute("data-state", "current");
    await expect(modelStep).toHaveAttribute("aria-current", "step");
    await expect(projectStep).toHaveAttribute("data-state", "pending");
    await expect(sessionStep).toHaveAttribute("data-state", "pending");
    await expect(page.locator(".sidebar-empty-state")).toHaveText("还没有项目");
    await expect(page.locator("#send-button")).toBeDisabled();
    await expect(page.locator("#composer-project")).toBeHidden();
    await expect(page.locator("#composer-input")).toHaveAttribute(
      "placeholder",
      "连接模型并添加项目后即可开始…"
    );

    // Step 1 sends the person to the models section, where the connection is saved.
    await modelStep.getByRole("button", { name: "前往设置" }).click();
    await expect(page.locator("#settings-entry")).toBeVisible();
    await expect(page.locator('[data-settings-panel="models"]')).toBeVisible();
    await page.locator("#settings-model-add").click();
    const dialog = page.getByRole("dialog", { name: "连接模型" });
    await expect(dialog).toBeVisible();
    await dialog.locator('[name="profileName"]').fill("本地夹具");
    await dialog.getByRole("textbox", { name: "模型 ID", exact: true }).fill("first-use-fixture");
    await dialog.getByRole("textbox", { name: "API 地址", exact: true }).fill("http://127.0.0.1:1/v1");
    await dialog.locator('[name="apiKey"]').fill("local-fixture");
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog).toBeHidden();

    await page.locator("#settings-back").click();
    await expect(page.locator("#app-layout")).toBeVisible();

    // The saved connection completes the first step and makes adding a project current.
    await expect(modelStep).toHaveAttribute("data-state", "done");
    await expect(modelStep.locator(".first-use-num")).toHaveAttribute("aria-label", "已完成");
    await expect(projectStep).toHaveAttribute("data-state", "current");
    // Without a project a message still starts a temporary session, so the
    // composer is free again as soon as a usable connection exists.
    await expect(page.locator("#send-button")).toBeEnabled();

    // Step 2 opens the add-project dialog from #04 and lands on the start surface.
    await projectStep.getByRole("button", { name: "添加项目" }).click();
    const addProject = page.getByRole("dialog", { name: "添加项目", exact: true });
    await expect(addProject).toBeVisible();
    await addProject.locator("#add-project-name").fill("首个项目");
    await addProject.locator("#add-project-directory").fill(projectDirectory);
    await addProject.getByRole("button", { name: "添加项目", exact: true }).click();
    await expect(addProject).toBeHidden();

    await expect(guide).toHaveCount(0);
    await expect(page.locator(".new-session-start")).toBeVisible();
    await expect(page.locator("#composer-project")).toContainText("首个项目");
    await expect(page.locator("#topbar-task")).toHaveText("新会话");
    await expect(page.locator("#send-button")).toBeEnabled();
    await expect(page.locator(".sidebar-empty-state")).toHaveCount(0);
    await expect(page.locator(".project-group")).toHaveCount(1);

    // Step 3 starts the session: the conversation replaces the start surface and
    // the guide does not come back, including after a reload.
    await page.locator("#composer-input").fill("首个项目的第一个需求");
    await page.locator("#send-button").click();
    await expect(page.locator("#topbar-task")).toHaveText("首个项目的第一个需求");
    await expect(page.locator(".conversation-item", { hasText: "首个项目的第一个需求" })).toBeVisible();
    await expect(guide).toHaveCount(0);

    await page.reload();
    await expect(page.locator("#topbar-task")).toHaveText("首个项目的第一个需求");
    await expect(guide).toHaveCount(0);
  } finally {
    await dashboard.stop();
  }
});

test("the guide offers no session action until a project exists", async ({ page }) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    await page.goto(dashboard.base);
    const sessionStep = page.locator('.first-use-step[data-step="session"]');
    await expect(sessionStep).toHaveAttribute("data-state", "pending");
    await expect(sessionStep.getByRole("button", { name: "新会话" })).toBeDisabled();
    await expect(page.locator(".first-use-step").getByRole("button")).toHaveCount(3);
  } finally {
    await dashboard.stop();
  }
});
