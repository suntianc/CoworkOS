import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

/** Selects open the application's own option menu, not the system popup. */

async function openGeneral(page) {
  await page.locator("#user-menu-button").click();
  await expect(page.locator("#settings-entry")).toBeVisible();
  return page.locator("#language-select");
}

test("a select opens the app's menu with the current option checked, and a click chooses", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    const select = await openGeneral(page);

    await select.click();
    const menu = page.getByRole("listbox", { name: "界面语言" });
    await expect(menu).toBeVisible();
    await expect(select).toHaveAttribute("aria-expanded", "true");
    await expect(menu.getByRole("option")).toHaveText(["简体中文", "English"]);
    await expect(menu.getByRole("option", { name: "简体中文" })).toHaveAttribute("aria-selected", "true");
    await expect(menu.getByRole("option", { name: "简体中文" }).locator(".ui-icon")).toHaveCount(1);
    await expect(menu.getByRole("option", { name: "English" }).locator(".ui-icon")).toHaveCount(0);
    await expect(menu.getByRole("option", { name: "简体中文" })).toBeFocused();

    // The list hangs under the control, at least as wide, on the popover surface.
    const [field, list] = await Promise.all([select.boundingBox(), menu.boundingBox()]);
    expect(list.y).toBeGreaterThanOrEqual(field.y + field.height);
    expect(list.y - (field.y + field.height)).toBeLessThan(8);
    expect(list.width).toBeGreaterThanOrEqual(field.width - 1);
    const surface = await menu.evaluate((node) => {
      const probe = document.createElement("div");
      probe.style.background = "var(--popover-fill)";
      document.body.append(probe);
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { actual: getComputedStyle(node).backgroundColor, expected };
    });
    expect(surface.actual).toBe(surface.expected);

    // A second click on the control closes the list and leaves the value.
    await select.click();
    await expect(menu).toHaveCount(0);
    await expect(select).not.toHaveAttribute("aria-expanded");
    await expect(select).toBeFocused();

    // A click elsewhere dismisses it too.
    await select.click();
    await expect(menu).toBeVisible();
    await page.locator("#settings-entry h1").first().click();
    await expect(menu).toHaveCount(0);
    await expect(select).toHaveValue("zh-CN");

    // Choosing fires change as the system menu would: the language switches.
    await select.click();
    await menu.getByRole("option", { name: "English" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  } finally {
    await dashboard.stop();
  }
});

test("the keyboard opens, moves, finds by letter, chooses and dismisses without leaving settings", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    const select = await openGeneral(page);
    const menu = page.getByRole("listbox", { name: "界面语言" });

    await select.focus();
    await page.keyboard.press("ArrowDown");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("option", { name: "简体中文" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("option", { name: "English" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("option", { name: "English" })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(menu.getByRole("option", { name: "简体中文" })).toBeFocused();

    // Escape closes only the list; settings, which also closes on Escape, stays.
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(page.locator("#settings-entry")).toBeVisible();
    await expect(select).toBeFocused();

    // Tab closes the list and keeps focus on the control.
    await page.keyboard.press("Space");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(menu).toHaveCount(0);
    await expect(select).toBeFocused();

    // A typed letter jumps to the matching option; Enter chooses it.
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await page.keyboard.press("e");
    await expect(menu.getByRole("option", { name: "English" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  } finally {
    await dashboard.stop();
  }
});
