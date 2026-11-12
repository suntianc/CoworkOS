import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { openModelConnectionEditor, openSettings } from "./settings-helper.js";

test("model settings no longer offer an image-analysis role or its fields", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    const saved = await page.request.post(`${dashboard.base}/api/model-settings`, {
      data: {
        profileName: "主连接",
        baseUrl: "https://chat.example/v1",
        model: "chat-fixture",
        api: "openai-completions",
        apiKey: "local-fixture-key",
        supportsImages: false
      }
    });
    expect(saved.ok()).toBe(true);
    const status = await (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
    expect(status).not.toHaveProperty("visionProfileId");
    expect(status.profiles[0]).not.toHaveProperty("vision");

    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    const settings = await openSettings(page, "models");
    await expect(settings.getByRole("heading", { name: "模型与角色" })).toBeVisible();
    await expect(settings).not.toContainText("图片分析");
    await expect(settings.locator('[name="vision"]')).toHaveCount(0);
    expect(await page.evaluate(() => document.body.textContent.includes("图片分析"))).toBe(false);

    const dialog = await openModelConnectionEditor(page);
    await expect(dialog.locator('[name="supportsImages"]')).toHaveCount(1);
    await expect(dialog.locator('[name="vision"]')).toHaveCount(0);
    await expect(dialog).not.toContainText("图片分析");
    await dialog.locator("[data-model-close]").click();
  } finally {
    await dashboard.stop();
  }
});
