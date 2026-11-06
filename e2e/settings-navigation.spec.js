import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

async function openOverview(page) {
  const button = page.getByRole("button", { name: "设置", exact: true });
  if (!(await button.isVisible())) await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
  await button.click();
  return page.getByRole("dialog", { name: "设置", exact: true });
}

test("settings navigation returns from a subpage to its overview", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    const overview = await openOverview(page);
    await overview.getByRole("button", { name: "管理模型连接", exact: true }).click();
    const model = page.getByRole("dialog", { name: "连接模型", exact: true });
    await expect(model.getByRole("button", { name: "返回设置", exact: true })).toBeVisible();
    await model.getByRole("button", { name: "返回设置", exact: true }).click();
    await expect(overview).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(overview.getByRole("button", { name: "管理模型连接", exact: true })).toBeFocused();
  } finally {
    await dashboard.stop();
  }
});

const settingsPages = [
  { entry: "管理模型连接", title: "连接模型" },
  { entry: "管理联网搜索", title: "联网搜索" }
];

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
  test(`settings navigation stays reachable by keyboard at 320px in ${theme}`, async ({ page }) => {
    const dashboard = await startDashboard();
    try {
      await page.setViewportSize({ width: 320, height: 600 });
      await page.goto(dashboard.base);
      const overview = await openOverview(page);
      await overview.locator("#appearance-select").selectOption(theme);
      await expect(
        overview.locator(".settings-heading").getByRole("button", { name: "关闭设置", exact: true })
      ).toBeInViewport();
      await expect(overview.getByRole("button", { name: "完成", exact: true })).toHaveCount(0);
      for (const { entry, title } of settingsPages) {
        await overview.getByRole("button", { name: entry, exact: true }).click();
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
        await expect(page.getByRole("dialog")).toHaveCount(1);
        await expect(overview.getByRole("button", { name: entry, exact: true })).toBeFocused();
      }
      await overview.getByRole("button", { name: "关闭设置", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "设置", exact: true })).toBeFocused();
    } finally {
      await dashboard.stop();
    }
  });
}

test("returning from model and search settings preserves unsaved fields and secret drafts", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    const overview = await openOverview(page);
    await overview.getByRole("button", { name: "管理模型连接", exact: true }).click();
    const model = page.getByRole("dialog", { name: "连接模型", exact: true });
    await model.locator('[name="baseUrl"]').fill("https://draft.example/v1");
    await model.locator('[name="model"]').fill("unsaved-navigation-model");
    await model.locator('[name="apiKey"]').fill("synthetic-model-navigation-key");
    await model.getByRole("button", { name: "返回设置", exact: true }).click();
    await overview.getByRole("button", { name: "管理模型连接", exact: true }).click();
    await expect(model.locator('[name="baseUrl"]')).toHaveValue("https://draft.example/v1");
    await expect(model.locator('[name="model"]')).toHaveValue("unsaved-navigation-model");
    await expect(model.locator('[name="apiKey"]')).toHaveValue("synthetic-model-navigation-key");
    await model.getByRole("button", { name: "返回设置", exact: true }).click();
    await overview.getByRole("button", { name: "管理联网搜索", exact: true }).click();
    const search = page.getByRole("dialog", { name: "联网搜索", exact: true });
    await search.locator('[name="provider"]').selectOption("serper");
    await search.locator("summary").click();
    await search.locator('[name="exaApiKey"]').fill("synthetic-search-navigation-key");
    await search.getByRole("button", { name: "返回设置", exact: true }).click();
    await overview.getByRole("button", { name: "管理联网搜索", exact: true }).click();
    await expect(search.locator('[name="provider"]')).toHaveValue("serper");
    await expect(search.locator('[name="exaApiKey"]')).toHaveValue("synthetic-search-navigation-key");
    await search.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "设置", exact: true })).toBeFocused();
    await openOverview(page);
    await overview.getByRole("button", { name: "管理联网搜索", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "设置", exact: true })).toBeFocused();
  } finally {
    await dashboard.stop();
  }
});

test("direct model setup can return to the overview and exits to its original control", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    const entry = page.locator("#model-setup-button");
    const model = page.getByRole("dialog", { name: "连接模型", exact: true });
    await entry.click();
    await model.getByRole("button", { name: "返回设置", exact: true }).click();
    const overview = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(overview).toBeVisible();
    await expect(overview.getByRole("button", { name: "管理模型连接", exact: true })).toBeFocused();
    await overview.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(entry).toBeFocused();
    await entry.click();
    await model.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(entry).toBeFocused();
    await entry.click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(entry).toBeFocused();
  } finally {
    await dashboard.stop();
  }
});

for (const { entry, title, endpoint, field } of [
  { entry: "管理模型连接", title: "连接模型", endpoint: "model-settings", field: "model" },
  { entry: "管理联网搜索", title: "联网搜索", endpoint: "web-search-settings", field: "provider" }
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
      const overview = await openOverview(page);
      await page.route(`**/api/${endpoint}`, async (route) => {
        requested();
        await pending;
        await route.continue();
      });
      await overview.getByRole("button", { name: entry, exact: true }).click();
      await started;
      const dialog = page.getByRole("dialog", { name: title, exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator(`[name="${field}"]`)).toBeDisabled();
      await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
      const response = page.waitForResponse((response) => response.url().endsWith(`/api/${endpoint}`));
      release();
      await response;
      await expect(
        page.locator(
          `[aria-labelledby="${title === "连接模型" ? "model-settings-title" : "web-search-title"}"] [name="${field}"]`
        )
      ).toBeEnabled();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "设置", exact: true })).toBeFocused();
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
      const overview = await openOverview(page);
      await overview.getByRole("button", { name: entry, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: title, exact: true });
      const input = dialog.locator(`[name="${field}"]`);
      await expect(input).toBeEnabled();
      if (title === "连接模型") {
        await dialog.locator('[name="baseUrl"]').fill("https://save.example/v1");
        await input.fill("saved-navigation-model");
        await dialog.locator('[name="apiKey"]').fill("synthetic-save-navigation-key");
      } else await input.selectOption("off");
      await page.route(`**/api/${endpoint}`, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        requested();
        await pending;
        await route.continue();
      });
      await dialog
        .getByRole("button", { name: title === "连接模型" ? "保存连接" : "保存设置", exact: true })
        .click();
      await started;
      await expect(input).toBeDisabled();
      await dialog.getByRole("button", { name: "返回设置", exact: true }).click();
      await expect(overview).toBeVisible();
      const response = page.waitForResponse(
        (response) => response.request().method() === "POST" && response.url().endsWith(`/api/${endpoint}`)
      );
      release();
      await response;
      await expect(
        page.locator(
          `[aria-labelledby="${title === "连接模型" ? "model-settings-title" : "web-search-title"}"] [name="${field}"]`
        )
      ).toBeEnabled();
      await expect(overview).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await expect(overview.getByRole("button", { name: entry, exact: true })).toBeFocused();
    } finally {
      release();
      await dashboard.stop();
    }
  });
}
