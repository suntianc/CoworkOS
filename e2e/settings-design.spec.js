import { test, expect } from "@playwright/test";
import { startConfiguredDashboard as startDashboard } from "../test/dashboard-fixture.mjs";
import { openModelConnectionEditor, openSettings, openWebSearchSettings } from "./settings-helper.js";

async function assertContained(panel, page) {
  await expect(panel).toBeVisible();
  const geometry = await panel.boundingBox();
  const viewport = page.viewportSize();
  expect(geometry.x).toBeGreaterThanOrEqual(0);
  expect(geometry.y).toBeGreaterThanOrEqual(0);
  expect(geometry.x + geometry.width).toBeLessThanOrEqual(viewport.width);
  expect(geometry.y + geometry.height).toBeLessThanOrEqual(viewport.height);
  expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
}

for (const theme of ["dark", "light"]) {
  test(`settings and their sub-pages stay contained and reachable in ${theme}`, async ({
    page
  }, testInfo) => {
    test.setTimeout(90_000);
    const dashboard = await startDashboard();
    try {
      await page.goto(dashboard.base);
      for (const width of [1440, 640]) {
        await page.setViewportSize({ width, height: 900 });
        const entry = await openSettings(page);
        await page.locator(`[data-appearance-value="${theme}"]`).click();
        await expect(page.locator("#settings-back")).toBeInViewport();
        expect(await entry.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-settings.png`) });

        const model = await openModelConnectionEditor(page, { add: true });
        await assertContained(model, page);
        await model.locator('[name="model"]').fill("保留模型设置草稿");
        await model.getByRole("button", { name: "关闭设置", exact: true }).click();

        const search = await openWebSearchSettings(page);
        await assertContained(search, page);
        await page.keyboard.press("Escape");
        await expect(search).toBeHidden();
        await expect(entry).toBeVisible();
        await page.locator("#settings-back").click();
        await expect(entry).toBeHidden();
      }
    } finally {
      await dashboard.stop();
    }
  });
}

test("settings drop glass under reduced transparency", async ({ page }) => {
  const dashboard = await startDashboard();
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-reduced-transparency", value: "reduce" },
        { name: "prefers-color-scheme", value: "dark" }
      ]
    });
    await page.goto(dashboard.base);
    await page.locator("#user-menu-button").click();
    const entry = page.locator("#settings-entry");
    await expect(entry).toBeVisible();
    await expect(entry.locator(".settings-content")).toHaveCSS("background-image", "none");
    await expect(entry.locator(".settings-content")).toHaveCSS("backdrop-filter", "none");
    const model = await openModelConnectionEditor(page, { add: true });
    await expect(model).toHaveCSS("backdrop-filter", "none");
    await page.keyboard.press("Escape");
    await expect(model).toBeHidden();
    await expect(entry).toBeVisible();
  } finally {
    await client.detach();
    await dashboard.stop();
  }
});
