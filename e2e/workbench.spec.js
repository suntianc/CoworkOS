import { openApplicationFileMenu } from "./application-file-helper.js";
import { loadCurrentApplication } from "./application-context-helper.js";
import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test as base, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

const test = base.extend({
  dashboard: async ({}, use) => {
    const server = await startDashboard();
    try {
      await use(server);
    } finally {
      await server.stop();
    }
  },
  page: async ({ page, dashboard }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.prompt = () => {
        throw new Error("prompt() is not supported");
      };
    });
    // Fonts are optional presentation assets; these tests run without external services.
    await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
    await page.goto(dashboard.base);
    await use(page);
    expect(errors, "no uncaught page errors").toEqual([]);
  }
});

test("shell dialogs dismiss with Escape and restore focus", async ({ page }) => {
  // Browser previews retain navigation without pretending to be a native window.
  await expect(page.locator(".traffic")).toHaveCount(0);
  await expect(page.locator(".chat-header")).toHaveCount(0);
  await expect(page.locator(".session-header-actions button")).toHaveCount(2);
  await expect(page.locator("#share-button")).toHaveCount(0);
  const panelToggle = page.getByRole("button", { name: "切换任务面板", exact: true });
  await expect(page.locator("#agent-pane")).toBeHidden();
  await expect(panelToggle).toHaveAttribute("aria-expanded", "false");
  const profile = page.locator("#user-menu-button");
  const menuTrigger = page.locator("#session-menu-button");
  const menu = page.locator("#session-menu");
  await expect(menuTrigger).toBeVisible();
  await menuTrigger.click();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveCount(8);
  for (const action of ["rename", "pin", "unread", "export", "open", "archive"])
    await expect(menu.locator(`[data-session-action="${action}"]`)).toBeDisabled();
  await expect(menu.locator('[data-session-submenu="copy"]')).toBeDisabled();
  await expect(menu.locator('[data-session-action="stop"]')).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(menuTrigger).toBeFocused();
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(menuTrigger).toBeVisible();
    await expect(panelToggle).toBeVisible();
    await expect(page.locator("#agent-pane")).toBeHidden();
    const collapsed = await page
      .locator("body")
      .evaluate((node) => node.classList.contains("output-collapsed"));
    await panelToggle.click();
    await expect
      .poll(() => page.locator("body").evaluate((node) => node.classList.contains("output-collapsed")))
      .toBe(!collapsed);
    await expect(page.locator("#agent-pane")).toBeVisible();
    await expect(panelToggle).toHaveAttribute("aria-expanded", "true");
    await panelToggle.click();
    await expect(page.locator("#agent-pane")).toBeHidden();
    await expect(panelToggle).toHaveAttribute("aria-expanded", "false");
    await profile.click();
    const settings = page.locator("#settings-entry");
    await expect(settings).toBeVisible();
    const box = await settings.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await expect(profile).toBeFocused();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await page.locator("html").getAttribute("data-desktop-platform")).toBeNull();
  expect(
    await page
      .locator(".session-header")
      .evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region"))
  ).not.toBe("drag");
  await profile.click();
  const settings = page.locator("#settings-entry");
  // The page opens on the section navigation, and Escape is the one exit.
  await expect(page.locator('[data-settings-section="general"]')).toBeFocused();
  await expect(page.locator("#settings-entry .computer-setting")).toHaveCount(1);
  await expect(page.locator("#computer-access-enabled")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(profile).toBeFocused();
  await expect(page.locator("#details-modal, #details-close")).toHaveCount(0);
});
