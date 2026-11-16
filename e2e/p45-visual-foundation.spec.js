import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { openSettings } from "./settings-helper.js";

test("Formicand replaces the old name in the title, mark and about row", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();

    await expect(page).toHaveTitle("Formicand");
    // The sidebar carries no brand row; the window title, icon and about row name the product.
    await expect(page.locator("#conversation-sidebar .brand-lockup")).toHaveCount(0);

    const icon = await page.locator('link[rel="icon"]').getAttribute("href");
    expect(icon).toBe("/assets/brand/app-icon.svg");
    const iconResponse = await page.request.get(new URL(icon, page.url()).href);
    expect(iconResponse.ok()).toBe(true);
    expect(iconResponse.headers()["content-type"]).toContain("svg");

    const settings = await openSettings(page);
    const about = settings.locator(".about-product");
    await expect(about).toContainText("Formicand");
    await expect(about.locator(".about-mark use")).toHaveAttribute("href", "#i-formicand-mark");
    await expect(about.locator("[data-update-action]")).toBeHidden();

    // Visible product copy no longer carries the vendor name.
    expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/CoworkOS/);
  } finally {
    await dashboard.stop();
  }
});
