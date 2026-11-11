import { test, expect } from "@playwright/test";
import { startConfiguredDashboard as startDashboard } from "../test/dashboard-fixture.mjs";
import { openSettings } from "./settings-helper.js";

for (const desktop of [false, true]) {
  test(`settings keep their rows legible at desktop and narrow widths and show the host update state in ${desktop ? "desktop" : "web"}`, async ({
    page
  }, info) => {
    const dashboard = await startDashboard();
    try {
      await page.addInitScript(() => localStorage.setItem("atria.appearance", "system"));
      if (desktop) {
        await page.addInitScript(() => {
          const update = {
            mode: "source",
            phase: "failed",
            currentVersion: "fixture",
            error: "更新暂不可用，请稍后重试"
          };
          window.bookmanDesktop = {
            onPrepareClose() {},
            updateStatus: async () => update,
            checkUpdates: async () => update,
            applyUpdate: async () => update
          };
        });
      }
      await page.goto(dashboard.base);
      for (const width of [1440, 640]) {
        await page.setViewportSize({ width, height: 760 });
        const settings = await openSettings(page);
        await expect(settings.getByRole("heading", { name: "通用", exact: true })).toBeVisible();
        if (desktop) await expect(settings.locator("[data-update-error]")).toContainText("更新暂不可用");
        expect(await settings.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        for (const row of await settings.locator(".settings-row-copy").all()) {
          const bounds = await row.boundingBox();
          if (bounds) expect(bounds.width).toBeGreaterThanOrEqual(100);
        }
        await page.screenshot({ path: info.outputPath(`overview-${width}.png`) });
        await page.locator('[data-settings-section="tools"]').click();
        await expect(settings.locator("#profile-settings-tools")).toContainText("个人记忆");
        await expect(settings.locator("#profile-settings-tools")).toContainText("联网搜索");
        await expect(settings.locator("#profile-settings-tools")).toContainText("窗口访问");
        await page.locator("#settings-back").click();
        await expect(settings).toBeHidden();
      }
    } finally {
      await dashboard.stop();
    }
  });
}
