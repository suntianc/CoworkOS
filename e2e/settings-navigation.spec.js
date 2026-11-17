import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { openSettings } from "./settings-helper.js";

async function openOverview(page, section = "general") {
  return openSettings(page, section);
}

test("settings navigation returns from a subpage to the page that opened it", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    const overview = await openOverview(page, "tools");
    await overview.locator("[data-search-open]").click();
    const search = page.getByRole("dialog", { name: "联网搜索", exact: true });
    await expect(search.getByRole("button", { name: "返回设置", exact: true })).toBeVisible();
    await search.getByRole("button", { name: "返回设置", exact: true }).click();
    await expect(overview).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(overview.locator("[data-search-open]")).toBeFocused();
  } finally {
    await dashboard.stop();
  }
});

// The model page edits in place; web search is the settings page that opens a sub-page.
const settingsPages = [{ section: "tools", entry: "[data-search-open]", title: "联网搜索" }];

async function assertNavigation(dialog) {
  const heading = dialog.locator(".settings-heading");
  for (const name of ["返回设置", "关闭设置"]) {
    const button = heading.getByRole("button", { name, exact: true });
    await expect(button).toHaveAttribute("aria-label", name);
    await expect(button).toBeInViewport();
  }
  await expect(
    dialog.locator(".modal-actions").getByRole("button", { name: /^(关闭|完成|关闭设置)$/ })
  ).toHaveCount(0);
}

for (const theme of ["dark", "light"]) {
  test(`settings navigation stays reachable by keyboard at the narrow layout in ${theme}`, async ({
    page
  }) => {
    const dashboard = await startDashboard();
    try {
      await page.setViewportSize({ width: 640, height: 700 });
      await page.goto(dashboard.base);
      const overview = await openOverview(page);
      await page.locator(`[data-appearance-value="${theme}"]`).click();
      await expect(page.locator("#settings-back")).toBeInViewport();
      await expect(overview.getByRole("button", { name: "完成", exact: true })).toHaveCount(0);
      for (const { section, entry, title } of settingsPages) {
        await page.locator(`[data-settings-section="${section}"]`).click();
        await overview.locator(entry).click();
        const dialog = page.getByRole("dialog", { name: title, exact: true });
        await assertNavigation(dialog);
        await expect(page.getByRole("dialog")).toHaveCount(1);
        expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        await expect(dialog.getByRole("button", { name: "返回设置", exact: true })).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(dialog.getByRole("button", { name: "关闭设置", exact: true })).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Enter");
        await expect(overview).toBeVisible();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(overview.locator(entry)).toBeFocused();
      }
      await page.locator("#settings-back").click();
      await expect(overview).toBeHidden();
      await expect(page.locator("#user-menu-button")).toBeFocused();
    } finally {
      await dashboard.stop();
    }
  });
}

test("returning from search settings preserves unsaved fields and secret drafts", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    const overview = await openOverview(page, "tools");
    await overview.locator("[data-search-open]").click();
    const search = page.getByRole("dialog", { name: "联网搜索", exact: true });
    await search.locator('[name="provider"]').selectOption("off");
    await search.locator("summary").click();
    await search.locator('[name="exaApiKey"]').fill("synthetic-search-navigation-key");
    await search.getByRole("button", { name: "返回设置", exact: true }).click();
    await overview.locator("[data-search-open]").click();
    await expect(search.locator('[name="provider"]')).toHaveValue("off");
    await expect(search.locator('[name="exaApiKey"]')).toHaveValue("synthetic-search-navigation-key");
    await search.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(overview).toBeVisible();
    await expect(overview.locator("[data-search-open]")).toBeFocused();
    await overview.locator("[data-search-open]").click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(overview).toBeVisible();
    await expect(overview.locator("[data-search-open]")).toBeFocused();
  } finally {
    await dashboard.stop();
  }
});

test("direct model setup opens the model page and exits to its original control", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    const entry = page.locator("#model-setup-button");
    const add = page.locator(".provider-dialog.is-add");
    await entry.click();
    await expect(add).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(add).toBeHidden();
    const overview = page.locator("#settings-entry");
    await expect(page.locator('[data-settings-panel="models"]')).toBeVisible();
    await page.locator("#settings-back").click();
    await expect(overview).toBeHidden();
    await expect(entry).toBeFocused();
  } finally {
    await dashboard.stop();
  }
});

for (const { section, entry, title, endpoint, field } of [
  {
    section: "tools",
    entry: "[data-search-open]",
    title: "联网搜索",
    endpoint: "web-search-settings",
    field: "provider"
  }
]) {
  test(`closing ${title} while its status loads cannot reopen settings after the response`, async ({
    page
  }) => {
    const dashboard = await startDashboard();
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    let requested;
    const started = new Promise((resolve) => {
      requested = resolve;
    });
    try {
      await page.goto(dashboard.base);
      const overview = await openOverview(page, section);
      let settled;
      const finished = new Promise((resolve) => {
        settled = resolve;
      });
      await page.route(`**/api/${endpoint}*`, async (route) => {
        requested();
        await pending;
        // The page may abandon the read once the page closes; the late answer still
        // must not bring the dialog back.
        await route.continue().catch(() => {});
        settled();
      });
      await overview.locator(entry).click();
      await started;
      const dialog = page.getByRole("dialog", { name: title, exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator(`[name="${field}"]`)).toBeDisabled();
      await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
      await expect(dialog).toBeHidden();
      release();
      await finished;
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(overview).toBeVisible();
      await expect(overview.locator(entry)).toBeFocused();
    } finally {
      release();
      await dashboard.stop();
    }
  });

  test(`a completed ${title} save after returning keeps the overview open and its focus`, async ({
    page
  }) => {
    const dashboard = await startDashboard();
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    let requested;
    const started = new Promise((resolve) => {
      requested = resolve;
    });
    try {
      await page.goto(dashboard.base);
      const overview = await openOverview(page, section);
      await overview.locator(entry).click();
      const dialog = page.getByRole("dialog", { name: title, exact: true });
      const input = dialog.locator(`[name="${field}"]`);
      await expect(input).toBeEnabled();
      await input.selectOption("off");
      await page.route(`**/api/${endpoint}*`, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        requested();
        await pending;
        await route.continue();
      });
      await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
      await started;
      await expect(input).toBeDisabled();
      await dialog.getByRole("button", { name: "返回设置", exact: true }).click();
      await expect(overview).toBeVisible();
      const response = page.waitForResponse(
        (response) => response.request().method() === "POST" && response.url().endsWith(`/api/${endpoint}`)
      );
      release();
      await response;
      await expect(page.locator(`[aria-labelledby="web-search-title"] [name="${field}"]`)).toBeEnabled();
      await expect(overview).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(overview.locator(entry)).toBeFocused();
    } finally {
      release();
      await dashboard.stop();
    }
  });
}
