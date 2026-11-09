import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("automation workspace hides empty app controls and preserves conversation drafts and attachments", async ({
  page
}, info) => {
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    expect(
      (await (await page.request.get(`${dashboard.base}/api/applications`)).json()).applications
    ).toEqual([]);
    await expect(page.locator("#app-bind-select")).toBeHidden();
    const draft = "请自动整理附件并生成报告。";
    await page.locator("#composer-input").fill(draft);
    await page
      .locator("#file-input")
      .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("自动化测试输入") });
    await expect(page.getByRole("button", { name: "移除 notes.txt", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.locator("#composer-input")).toHaveValue(draft);
    await expect(page.getByRole("button", { name: "移除 notes.txt", exact: true })).toBeVisible();
    for (const theme of ["light", "dark"]) {
      await page.locator("#user-menu-button").click();
      await page.locator("#appearance-select").selectOption(theme);
      await page.keyboard.press("Escape");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(page.locator("#composer-input")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await page.screenshot({ path: info.outputPath(`${theme}-${width}.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});
