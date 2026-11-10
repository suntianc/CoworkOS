import { expect } from "@playwright/test";

/**
 * Settings is one page with six sections; these helpers open it at a known place so
 * a test reads the control it is about instead of the navigation.
 */
export async function openSettings(page, section = "general") {
  const entry = page.locator("#settings-entry");
  // The trigger lives in the sidebar the page replaces, so only click it when closed.
  if (!(await entry.isVisible())) await page.locator("#user-menu-button").click();
  await expect(entry).toBeVisible();
  await page.locator(`[data-settings-section="${section}"]`).click();
  await expect(page.locator(`[data-settings-panel="${section}"]`)).toBeVisible();
  return entry;
}

export async function chooseAppearance(page, value) {
  await openSettings(page);
  await page.locator(`[data-appearance-value="${value}"]`).click();
  await expect(page.locator(`[data-appearance-value="${value}"]`)).toHaveAttribute("aria-checked", "true");
}

export async function closeSettings(page) {
  await page.locator("#settings-back").click();
  await expect(page.locator("#settings-entry")).toBeHidden();
}

export async function openModelConnectionEditor(page, { add = false } = {}) {
  const settings = await openSettings(page, "models");
  await (
    add ? settings.locator("#settings-model-add") : settings.locator("[data-model-edit]").first()
  ).click();
  return page.getByRole("dialog", { name: "连接模型", exact: true });
}

export async function openWebSearchSettings(page) {
  const settings = await openSettings(page, "tools");
  await settings.locator("[data-search-open]").click();
  return page.getByRole("dialog", { name: "联网搜索", exact: true });
}
