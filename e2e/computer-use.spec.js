import { test, expect } from "@playwright/test";
import { startConfiguredDashboard as startDashboard } from "../test/dashboard-fixture.mjs";
import { sidebarDrawerToggle } from "./p45-work-helpers.js";

test("window access keeps desktop-only controls behind its settings row and preserves the draft", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The host's real Screen Recording / Accessibility state must not decide this check:
  // pin the execution host to one without a usable native driver.
  await page.route("**/api/computer/status", (route) =>
    route.fulfill({ json: { available: false, controlAvailable: false } })
  );
  try {
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("尚未发送的测试草稿");
    for (const width of [1440, 1280, 474, 320]) {
      await page.setViewportSize({ width, height: 800 });
      // Settings lives at the bottom of the sidebar, which is a drawer below 640.
      const drawer = await sidebarDrawerToggle(page);
      if (drawer) await drawer.click();
      await page.locator("#user-menu-button").click();
      const settings = page.locator("#settings-entry");
      await expect(settings).toBeVisible();
      await page.locator('[data-settings-section="tools"]').click();
      const access = settings.locator(".computer-setting");
      // Desktop-only controls stay behind the collapsed row until it is opened; the
      // row may open itself while it has a state to report.
      await access.locator("summary").focus();
      if (await access.evaluate((element) => element.open)) await page.keyboard.press("Enter");
      await expect(access).toHaveJSProperty("open", false);
      await page.keyboard.press("Enter");
      await expect(access).toHaveJSProperty("open", true);
      await expect(page.locator("[data-computer-state]")).toContainText("执行主机窗口访问不可用");
      await expect(settings.locator(".computer-setting button")).toHaveCount(3);
      for (const button of await settings.locator(".computer-setting button").all()) {
        await expect(button).toBeDisabled();
        await expect(button).toBeHidden();
      }
      await expect(page.locator("[data-computer-request]")).toHaveCount(0);
      await expect(
        page.locator("#computer-access-dialog, [data-computer-window], [data-computer-mode]")
      ).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const box = await settings.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await access.locator("summary").focus();
      if (await access.evaluate((element) => element.open)) await page.keyboard.press("Enter");
      await page.keyboard.press("Escape");
      await expect(settings).toBeHidden();
      // Below 640 the settings opener is inside the closed sidebar drawer; focus returns
      // to that drawer's opener instead.
      await expect(page.locator(width < 640 ? "#sidebar-toggle" : "#user-menu-button")).toBeFocused();
      await expect(page.locator("#composer-input")).toHaveValue("尚未发送的测试草稿");
    }
    await expect(page.locator("#output-pane-toggle")).toBeVisible();
    await expect(page.locator("#details-modal, #details-close")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "选择窗口", exact: true })).toHaveCount(0);
    const tasks = (await (await page.request.get(`${dashboard.base}/api/tasks`)).json()).tasks;
    expect(tasks.filter((task) => task.taskId !== "workspace")).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("native window permission actions remain available on demand without granting access on open", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.addInitScript(() => {
      window.computerOperations = [];
      window.bookmanDesktop = {
        onPrepareClose() {},
        computerUse: async (request) => {
          window.computerOperations.push(request.operation);
          return { enabled: false };
        }
      };
    });
    await page.route("**/api/computer/status", (route) =>
      route.fulfill({
        json: { available: true, screenRecording: true, accessibility: true, postEventAccess: true }
      })
    );
    await page.route("**/api/computer/access", (route) =>
      route.fulfill({ json: { policy: { enabled: false }, paused: false } })
    );
    await page.goto(dashboard.base);
    await page.locator("#user-menu-button").click();
    const settings = page.locator("#settings-entry");
    await page.locator('[data-settings-section="tools"]').click();
    const access = settings.locator(".computer-setting");
    await expect(access.getByRole("button", { name: "开启窗口访问", exact: true })).toBeHidden();
    await access.locator("summary").click();
    await expect(access.getByRole("button", { name: "开启窗口访问", exact: true })).toBeEnabled();
    await expect(access.getByRole("button", { name: "屏幕录制已开启", exact: true })).toBeDisabled();
    await expect(access.getByRole("button", { name: "辅助功能已开启", exact: true })).toBeDisabled();
    await expect(access.getByText("允许所有对话观察并操作全部应用窗口。", { exact: true })).toBeVisible();
    const operations = await page.evaluate(() => window.computerOperations);
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.every((operation) => operation === "policy-status")).toBe(true);
  } finally {
    await dashboard.stop();
  }
});
