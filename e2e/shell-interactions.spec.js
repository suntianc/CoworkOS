import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

async function seed(page, dashboard) {
  for (const [taskId, goal] of [
    ["shell-a", "设计方案 A"],
    ["shell-b", "建模方案 B"]
  ]) {
    const response = await page.request.post(`${dashboard.base}/api/tasks`, { data: { taskId, goal } });
    expect(response.ok()).toBe(true);
  }
  await page.goto(dashboard.base);
  await expect(page.locator(".conversation-item")).toHaveCount(2);
}

test("project collapse responds once and preserves state and keyboard focus through refresh", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await seed(page, dashboard);
    const group = page.locator(".project-group");
    const row = group.locator(".project-row");
    await row.click();
    await expect(group).toHaveClass(/collapsed/);
    await expect(row).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".conversation-item").first()).toBeHidden();
    await row.press("Enter");
    await expect(group).not.toHaveClass(/collapsed/);
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await page.locator('.conversation-item[data-task="shell-a"]').click();
    await expect(page.locator("#topbar-task")).toHaveText("设计方案 A");
    await row.focus();
    const refresh = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/tasks");
    await page.locator(".panel-add").dispatchEvent("click");
    await refresh;
    await expect(row).toBeFocused();
    await expect(page.locator('.conversation-item[data-task="shell-a"]')).toHaveAttribute(
      "aria-current",
      "page"
    );
  } finally {
    await dashboard.stop();
  }
});

test("search confines keyboard focus, navigates results and restores the invoking control", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await seed(page, dashboard);
    const trigger = page.getByRole("button", { name: "搜索", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "搜索对话" });
    const input = page.getByRole("textbox", { name: "搜索对话" });
    await expect(dialog).toBeVisible();
    await expect(input).toBeFocused();
    await input.dispatchEvent("keydown", { key: "Escape", isComposing: true });
    await expect(dialog).toBeVisible();
    await expect(input).toBeFocused();
    if (process.env.COWORK_KEEP_QUALITY_PROBE === "1")
      await page.screenshot({ path: test.info().outputPath("search-desktop.png") });
    await input.press("Shift+Tab");
    await expect(dialog.locator(".search-result").last()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(input).toBeFocused();
    await input.press("ArrowDown");
    await expect(dialog.locator(".search-result").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(dialog.locator(".search-result").last()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await input.fill("建模");
    await expect(dialog.locator(".search-result")).toHaveCount(1);
    await input.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(page.locator("#topbar-task")).toHaveText("建模方案 B");
    await page.locator("#composer-input").fill("B 的独立草稿");
    await page.keyboard.press("Control+p");
    await expect(dialog).toBeVisible();
    await input.fill("设计");
    await input.press("Enter");
    await expect(page.locator("#topbar-task")).toHaveText("设计方案 A");
    await page.locator('.conversation-item[data-task="shell-b"]').click();
    await expect(page.locator("#composer-input")).toHaveValue("B 的独立草稿");
  } finally {
    await dashboard.stop();
  }
});

test("search remains usable in narrow and short windows without changing the draft", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await seed(page, dashboard);
    await page.locator("#composer-input").fill("搜索前保留的草稿");
    for (const width of [1440, 1280, 474, 320]) {
      await page.setViewportSize({ width, height: 550 });
      await page.keyboard.press("Control+p");
      const dialog = page.getByRole("dialog", { name: "搜索对话" });
      await expect(dialog).toBeVisible();
      const bounds = await dialog.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(550);
      await expect(dialog.getByRole("button", { name: "关闭搜索" })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      if (process.env.COWORK_KEEP_QUALITY_PROBE === "1")
        await page.screenshot({ path: test.info().outputPath(`search-${width}.png`) });
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(page.locator("#composer-input")).toHaveValue("搜索前保留的草稿");
    }
  } finally {
    await dashboard.stop();
  }
});

test("a rename dialog keeps its original target when the background selection changes", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await seed(page, dashboard);
    await page.locator('.conversation-item[data-task="shell-a"]').click();
    await expect(page.locator("#topbar-task")).toHaveText("设计方案 A");
    await page.getByRole("button", { name: "会话菜单", exact: true }).click();
    await page.locator('[data-session-action="rename"]').click();
    const dialog = page.getByRole("dialog", { name: "重命名会话" });
    await page.getByRole("textbox", { name: "会话名称" }).fill("A 的新名称");
    await page.locator('.conversation-item[data-task="shell-b"]').dispatchEvent("click");
    await expect(page.locator("#topbar-task")).toHaveText("建模方案 B");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.conversation-item[data-task="shell-a"]')).toContainText("A 的新名称");
    await expect(page.locator('.conversation-item[data-task="shell-b"]')).toContainText("建模方案 B");
    await expect(page.locator("#topbar-task")).toHaveText("建模方案 B");
  } finally {
    await dashboard.stop();
  }
});

test("a delayed archive response preserves the new conversation and its draft", async ({ page }) => {
  const dashboard = await startDashboard();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let received = false;
  try {
    await seed(page, dashboard);
    await page.locator('.conversation-item[data-task="shell-a"]').click();
    await expect(page.locator("#topbar-task")).toHaveText("设计方案 A");
    await page.route("**/api/tasks/shell-a", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      received = true;
      await gate;
      return route.fulfill({ response: await route.fetch() });
    });
    await page.getByRole("button", { name: "会话菜单", exact: true }).click();
    await page.locator('[data-session-action="archive"]').click();
    await expect.poll(() => received).toBe(true);
    await page.locator('.conversation-item[data-task="shell-b"]').click();
    await expect(page.locator("#topbar-task")).toHaveText("建模方案 B");
    await page.locator("#composer-input").fill("归档期间 B 的草稿");
    release();
    await expect(page.locator('.conversation-item[data-task="shell-a"]')).toHaveCount(0);
    await expect(page.locator("#topbar-task")).toHaveText("建模方案 B");
    await expect(page.locator("#composer-input")).toHaveValue("归档期间 B 的草稿");
  } finally {
    release();
    await dashboard.stop();
  }
});

test("a pending rename keeps keyboard focus inside the dialog when its save button is disabled", async ({
  page
}) => {
  const dashboard = await startDashboard();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let received = false;
  try {
    await seed(page, dashboard);
    await page.locator('.conversation-item[data-task="shell-a"]').click();
    await expect(page.locator("#topbar-task")).toHaveText("设计方案 A");
    await page.route("**/api/tasks/shell-a", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      received = true;
      await gate;
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "合成保存失败" })
      });
    });
    await page.getByRole("button", { name: "会话菜单", exact: true }).click();
    await page.locator('[data-session-action="rename"]').click();
    const dialog = page.getByRole("dialog", { name: "重命名会话" });
    const input = dialog.getByRole("textbox", { name: "会话名称" });
    await input.fill("保留失败后的名称");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(() => received).toBe(true);
    await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    await page.keyboard.press("Tab");
    await expect(input).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeFocused();
    release();
    await expect(dialog.getByRole("alert")).toContainText("合成保存失败");
    await expect(input).toHaveValue("保留失败后的名称");
    await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "会话菜单", exact: true })).toBeFocused();
  } finally {
    release();
    await dashboard.stop();
  }
});

test("sidebar conversation menus stay anchored and edit their own session without navigating", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await seed(page, dashboard);
    await page.locator('.conversation-item[data-task="shell-a"]').click();
    await page.locator("#composer-input").fill("保留 A 的草稿");
    const topMenuTrigger = page.locator(".session-header #session-menu-button");
    await expect(topMenuTrigger).toBeVisible();
    const trigger = page.locator('[data-session-menu="shell-b"]');
    const menu = page.locator("#session-menu");
    for (const width of [1440, 1280, 700]) {
      await page.setViewportSize({ width, height: 700 });
      const titleBox = await page.locator("#topbar-task").boundingBox();
      const topTriggerBox = await topMenuTrigger.boundingBox();
      const headerBox = await page.locator(".session-header").boundingBox();
      expect(topTriggerBox.x).toBeGreaterThanOrEqual(titleBox.x + titleBox.width - 1);
      expect(topTriggerBox.x).toBeGreaterThanOrEqual(0);
      expect(topTriggerBox.x + topTriggerBox.width).toBeLessThanOrEqual(width);
      expect(headerBox.width).toBeGreaterThan(0);
      await topMenuTrigger.click();
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem")).toHaveCount(8);
      if (width === 1440 && process.env.COWORK_KEEP_QUALITY_PROBE === "1")
        await page.screenshot({ path: ".tmp/ui-preview/session-menu-corrected.png" });
      expect(
        await menu
          .locator("[data-session-action]:visible")
          .evaluateAll((nodes) => nodes.map((node) => node.dataset.sessionAction).sort())
      ).toEqual(["archive", "delete", "export", "open", "pin", "rename", "unread"]);
      await expect(menu.locator('[data-session-submenu="copy"]')).toBeVisible();
      const topMenuBox = await menu.boundingBox();
      expect(topMenuBox.x).toBeGreaterThanOrEqual(0);
      expect(topMenuBox.x + topMenuBox.width).toBeLessThanOrEqual(width);
      expect(topMenuBox.y + topMenuBox.height).toBeLessThanOrEqual(700);
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(topMenuTrigger).toBeFocused();
      await trigger.focus();
      await trigger.press("ArrowDown");
      await expect(menu.locator('[data-session-action="rename"]')).toBeFocused();
      const bounds = await menu.boundingBox();
      const anchor = await trigger.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(700);
      expect(
        bounds.x >= anchor.x + anchor.width ||
          bounds.y >= anchor.y + anchor.height ||
          bounds.y + bounds.height <= anchor.y
      ).toBe(true);
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await trigger.locator("..").hover();
    await trigger.click();
    await page.screenshot({ path: ".tmp/sidebar-menu-preview.png" });
    await menu.getByRole("menuitem", { name: "重命名会话" }).click();
    await page.getByRole("textbox", { name: "会话名称" }).fill("B 的手动名称");
    await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator('.conversation-item[data-task="shell-b"]')).toContainText("B 的手动名称");
    await expect(page.locator("#topbar-task")).toHaveText("设计方案 A");
    await expect(page.locator("#composer-input")).toHaveValue("保留 A 的草稿");
    await trigger.locator("..").hover();
    await trigger.click();
    await menu.getByRole("menuitem", { name: "置顶会话", exact: true }).click();
    await expect(page.locator('.conversation-item[data-task="shell-b"]')).toContainText("★");
    await trigger.locator("..").hover();
    await trigger.click();
    await menu.getByRole("menuitem", { name: "归档会话", exact: true }).click();
    await expect(trigger).toHaveCount(0);
    await expect(page.locator("#topbar-task")).toHaveText("设计方案 A");
    await expect(page.locator("#composer-input")).toHaveValue("保留 A 的草稿");
  } finally {
    await dashboard.stop();
  }
});

test("deleting a sidebar conversation requires confirmation and removes its stored history", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await seed(page, dashboard);
    await page.locator('.conversation-item[data-task="shell-a"]').click();
    const trigger = page.locator('[data-session-menu="shell-b"]');
    await trigger.locator("..").hover();
    await trigger.click();
    await page.once("dialog", async (dialog) => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toContain("删除后无法恢复");
      await dialog.accept();
    });
    await page.getByRole("menuitem", { name: "删除会话", exact: true }).click();
    await expect(page.locator('.conversation-item[data-task="shell-b"]')).toHaveCount(0);
    await expect(page.locator("#topbar-task")).toHaveText("设计方案 A");
    expect((await page.request.get(`${dashboard.base}/api/tasks/shell-b`)).status()).toBe(400);
  } finally {
    await dashboard.stop();
  }
});

test("a compact sidebar keeps navigation reachable at desktop and narrow widths without changing the draft", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await seed(page, dashboard);
    await page.locator('.conversation-item[data-task="shell-a"]').click();
    await page.locator("#composer-input").fill("侧栏调整保留草稿");
    const sidebar = page.locator(".conversation-sidebar");
    const selected = sidebar.locator('.conversation-item[data-task="shell-a"]');
    const newConversation = sidebar.locator("#new-conversation");
    await expect(sidebar.locator(".brand-chevron")).toHaveCount(0);
    await expect(sidebar.locator(".brand-lockup")).toHaveText("Formicand");
    await expect(sidebar.locator(".conversation-item-meta")).toHaveCount(0);
    await expect(selected).toHaveText("设计方案 A");
    await expect(selected).toHaveAttribute("aria-description", /已创建/);
    for (const width of [1440, 1280, 1024, 700]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(sidebar).toBeVisible();
      const box = await sidebar.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeLessThanOrEqual(248);
      expect((await selected.boundingBox()).height).toBe(36);
      for (const label of ["搜索", "设置"]) {
        const control = sidebar.getByRole("button", { name: label, exact: true });
        await expect(control).toBeVisible();
        const rect = await control.boundingBox();
        expect(rect.x + rect.width).toBeLessThanOrEqual(box.x + box.width);
      }
      await page.mouse.move(box.x + box.width + 12, box.y + 20);
      const beforeHover = await newConversation.boundingBox();
      await newConversation.hover();
      await expect(newConversation).toHaveCSS("transform", "none");
      await expect(newConversation).toHaveCSS("box-shadow", "none");
      expect(await newConversation.boundingBox()).toEqual(beforeHover);
      await page.screenshot({ path: test.info().outputPath(`sidebar-${width}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await expect(page.locator("#composer-input")).toHaveValue("侧栏调整保留草稿");
      await expect(page.locator("#topbar-task")).toHaveText("设计方案 A");
    }
    // Narrow windows keep the entry, navigation and settings reachable as icons.
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(sidebar).toBeVisible();
    expect((await sidebar.boundingBox()).width).toBeLessThanOrEqual(48);
    for (const [role, label] of [
      ["tab", "工作"],
      ["tab", "观测"],
      ["button", "设置"]
    ]) {
      const control = page.getByRole(role, { name: label, exact: true });
      await expect(control).toBeVisible();
      const rect = await control.boundingBox();
      const box = await sidebar.boundingBox();
      expect(rect.x + rect.width).toBeLessThanOrEqual(box.x + box.width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await expect(page.locator("#composer-input")).toHaveValue("侧栏调整保留草稿");
  } finally {
    await dashboard.stop();
  }
});

test("sidebar divider resizes without navigating, persists, supports keyboard and resets", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seed(page, dashboard);
    await page.locator('.conversation-item[data-task="shell-a"]').click();
    await page.locator("#composer-input").fill("保留草稿");
    const divider = page.getByRole("separator", { name: "调整会话侧栏宽度" });
    const sidebar = page.locator(".conversation-sidebar");
    const before = await sidebar.boundingBox();
    const handle = await divider.boundingBox();
    await page.mouse.move(handle.x + 3, handle.y + 150);
    await page.mouse.down();
    await page.mouse.move(before.width + 60, handle.y + 150, { steps: 8 });
    await page.mouse.up();
    expect((await sidebar.boundingBox()).width).toBeGreaterThan(before.width + 40);
    await expect(page.locator("#composer-input")).toHaveValue("保留草稿");
    await expect(page.locator("#topbar-task")).toHaveText("设计方案 A");
    const resized = (await sidebar.boundingBox()).width;
    await page.reload();
    expect(Math.abs((await sidebar.boundingBox()).width - resized)).toBeLessThan(2);
    await divider.focus();
    await divider.press("Home");
    await expect(divider).toHaveAttribute("aria-valuenow", "180");
    await divider.press("ArrowRight");
    await expect(divider).toHaveAttribute("aria-valuenow", "196");
    await divider.press("End");
    await expect(divider).toHaveAttribute("aria-valuenow", "420");
    await divider.dblclick({ position: { x: 3, y: 150 } });
    expect(Math.abs((await sidebar.boundingBox()).width - before.width)).toBeLessThan(2);
    await page.setViewportSize({ width: 474, height: 800 });
    await expect(divider).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(474);
  } finally {
    await dashboard.stop();
  }
});
