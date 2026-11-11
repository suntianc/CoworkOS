import { test, expect } from "@playwright/test";
import { startConfiguredDashboard, startDashboard } from "../test/dashboard-fixture.mjs";

async function settings(page) {
  await page.locator("#user-menu-button").click();
  const entry = page.locator("#settings-entry");
  await expect(entry).toBeVisible();
  return entry;
}

test("language switches both shell and dynamic settings, retains drafts and persists after reload", async ({
  page
}) => {
  // A configured host keeps the ordinary composer, whose placeholder the shell translates.
  const dashboard = await startConfiguredDashboard();
  try {
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("保存 · 设置 · 我的草稿");
    const overview = await settings(page);
    await expect(overview.getByLabel("界面语言", { exact: true })).toHaveValue("zh-CN");
    await overview.getByLabel("界面语言", { exact: true }).selectOption("en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("#composer-input")).toHaveValue("保存 · 设置 · 我的草稿");
    await expect(page.locator("#composer-input")).toHaveAttribute(
      "placeholder",
      "Describe what you need, for example: add --avg to summarize.sh…"
    );
    const english = await settings(page);
    await expect(english.getByLabel("Interface language", { exact: true })).toHaveValue("en");
    await page.locator('[data-settings-section="models"]').click();
    await english.getByRole("button", { name: "Add connection", exact: true }).click();
    const model = page.getByRole("dialog", { name: "Connect model", exact: true });
    await expect(model.getByRole("button", { name: "Save connection", exact: true })).toBeVisible();
    await model.getByRole("button", { name: "Back to settings", exact: true }).click();
    await expect(page.locator("#settings-entry")).toBeVisible();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const reopened = await settings(page);
    await reopened.getByLabel("Interface language", { exact: true }).selectOption("zh-CN");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(page.locator("#composer-input")).toHaveValue("保存 · 设置 · 我的草稿");
    await expect(page.getByRole("button", { name: "设置", exact: true })).toBeVisible();
  } finally {
    await dashboard.stop();
  }
});

test("English chrome preserves Chinese conversation titles and message text", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    const response = await page.request.post(dashboard.base + "/api/tasks", {
      data: { taskId: "language-content", goal: "保存" }
    });
    expect(response.ok()).toBe(true);
    const detail = await (await page.request.get(dashboard.base + "/api/tasks/language-content")).json();
    await page.route("**/api/tasks/language-content", (route) =>
      route.fulfill({
        json: {
          ...detail,
          messages: [{ role: "user", content: "保存 · 设置" }]
        }
      })
    );
    await page.addInitScript(() => localStorage.setItem("atria.language", "en"));
    await page.goto(dashboard.base + "/?task=language-content");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("#topbar-task")).toHaveText("保存");
    await expect(page.locator(".conversation-title-text").filter({ hasText: /^保存$/ })).toBeVisible();
    await expect(page.locator("#conversation")).toContainText("保存");
  } finally {
    await dashboard.stop();
  }
});

test("unavailable local storage does not reload or lose the current draft", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("保留草稿");
    const overview = await settings(page);
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === "atria.language") throw new DOMException("blocked", "QuotaExceededError");
        return original.call(this, key, value);
      };
    });
    await overview.getByLabel("界面语言", { exact: true }).selectOption("en");
    await expect(overview.locator("#language-status")).toHaveText("语言偏好无法保存，请检查本机存储空间。");
    await expect(overview.getByLabel("界面语言", { exact: true })).toHaveValue("zh-CN");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(page.locator("#composer-input")).toHaveValue("保留草稿");
  } finally {
    await dashboard.stop();
  }
});
