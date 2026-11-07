import { test, expect } from "@playwright/test";
import { startConfiguredDashboard as startDashboard } from "../test/dashboard-fixture.mjs";

for (const desktop of [false, true]) {
  test(`settings overview groups preferences and connections with learning on demand in ${desktop ? "desktop" : "web"}`, async ({
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
      const dialog = page.getByRole("dialog", { name: "设置", exact: true });
      for (const theme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: theme });
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        for (const width of [1440, 320]) {
          await page.setViewportSize({ width, height: 760 });
          const opener = page.getByRole("button", { name: "设置", exact: true });
          if (!(await opener.isVisible()))
            await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
          await opener.click();
          await expect(dialog.getByRole("heading", { name: "通用", exact: true })).toBeVisible();
          await expect(dialog.locator("#profile-settings-general [data-memory-use]")).toBeVisible();
          await expect(
            dialog
              .locator("#profile-settings-connections")
              .getByRole("button", { name: "管理模型连接", exact: true })
          ).toBeVisible();
          await expect(
            dialog
              .locator("#profile-settings-tools")
              .getByRole("button", { name: "管理科学环境", exact: true })
          ).toBeVisible();
          await expect(dialog.locator("#settings-about-group")).toBeVisible({ visible: desktop });
          await expect(dialog.getByRole("checkbox", { name: "自动学习", exact: true })).toBeHidden();
          const learning = dialog.locator(".user-memory-learning-options");
          await learning.locator("summary").click();
          await expect(learning.getByRole("checkbox", { name: "自动学习", exact: true })).toBeDisabled();
          await learning.getByRole("textbox", { name: "后台模型", exact: true }).fill("保留设置草稿");
          await learning.locator("summary").click();
          await expect(learning.getByRole("textbox", { name: "后台模型", exact: true })).toBeHidden();
          await learning.locator("summary").click();
          await expect(learning.getByRole("textbox", { name: "后台模型", exact: true })).toHaveValue(
            "保留设置草稿"
          );
          await learning.locator("summary").click();
          await dialog.locator(".settings-scroll").evaluate((node) => (node.scrollTop = 0));
          const geometry = await dialog.boundingBox();
          expect(geometry.x).toBeGreaterThanOrEqual(0);
          expect(geometry.x + geometry.width).toBeLessThanOrEqual(width);
          expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
          for (const row of await dialog.locator(".settings-row-copy").all()) {
            const bounds = await row.boundingBox();
            if (bounds) expect(bounds.width).toBeGreaterThanOrEqual(100);
          }
          if (desktop) await expect(dialog.locator("[data-update-error]")).toContainText("更新暂不可用");
          await page.screenshot({ path: info.outputPath(`overview-${theme}-${width}.png`) });
          await dialog.getByRole("button", { name: "管理模型连接", exact: true }).click();
          const connection = page.getByRole("dialog", { name: "连接模型", exact: true });
          await expect(connection).toBeVisible();
          await connection.getByRole("button", { name: "返回设置", exact: true }).click();
          await expect(dialog.getByRole("button", { name: "管理模型连接", exact: true })).toBeFocused();
          await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
        }
      }
    } finally {
      await dashboard.stop();
    }
  });
}
