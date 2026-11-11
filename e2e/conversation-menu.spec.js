import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const titles = { "menu-a": "设计方案 A", "menu-b": "建模方案 B" };

async function seed(page, dashboard) {
  for (const [taskId, goal] of Object.entries(titles)) {
    const response = await page.request.post(`${dashboard.base}/api/tasks`, { data: { taskId, goal } });
    expect(response.ok()).toBe(true);
  }
  await page.route("**/api/tasks/menu-b", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const detail = await (await route.fetch()).json();
    return route.fulfill({
      json: {
        ...detail,
        runtime: { active: false },
        messages: [
          { role: "user", content: "请保留 **原始格式** 并总结方案 B。", timestamp: 1 },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "PRIVATE_THINKING" },
              { type: "text", text: "## 方案 B\n\n- 已完成验证。\n\n```js\nconst ready = true;\n```" }
            ],
            timestamp: 2
          }
        ],
        runtimeEvents: [{ type: "runtime_event", payload: { secret: "PRIVATE_TOOL_LOG" } }]
      }
    });
  });
  await page.goto(dashboard.base);
  await expect(page.locator(".conversation-item")).toHaveCount(2);
  await page.locator('[data-task="menu-a"]').click();
  await expect(page.locator("#topbar-task")).toHaveText(titles["menu-a"]);
  await page.locator("#composer-input").fill("保留 A 的未发送草稿");
}

async function openSidebarMenu(page, taskId = "menu-b") {
  const trigger = page.locator(`[data-session-menu="${taskId}"]`);
  await revealSidebarTree(page, trigger);
  await trigger.locator("..").hover();
  await trigger.click();
  await expect(page.locator("#session-menu")).toBeVisible();
  return page.locator("#session-menu");
}

/**
 * A 640-1023 window folds the tree into the icon rail, so its project opens the
 * tree that holds the row. A phone-sized window opens the sidebar drawer first.
 */
async function revealSidebarTree(page, row) {
  const drawer = page.locator(".sidebar-drawer-toggle:visible");
  if (await drawer.isVisible()) {
    if ((await drawer.getAttribute("aria-expanded")) !== "true") await drawer.click();
    await expect(page.locator(".project-group").first()).toBeVisible();
    return;
  }
  if (await row.isVisible()) return;
  await page.locator(".project-heading .project-row").first().focus();
  await expect(row).toBeVisible();
}

async function expectOriginalDraft(page) {
  await expect(page.locator("#topbar-task")).toHaveText(titles["menu-a"]);
  await expect(page.locator("#composer-input")).toHaveValue("保留 A 的未发送草稿");
}

test("marking another conversation unread survives refresh and clears when it is opened", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await seed(page, dashboard);
    const marker = page.locator('[data-task="menu-b"] .conversation-unread');
    const menu = await openSidebarMenu(page);
    await menu.locator('[data-session-action="unread"]').click();
    await expect(marker).toBeVisible();
    await expect(marker).toHaveAttribute("aria-label", "未读");
    await expectOriginalDraft(page);
    await page.reload();
    await expect(marker).toBeVisible();
    await expectOriginalDraft(page);
    await openSidebarMenu(page);
    await expect(menu.locator('[data-session-action="unread"]')).toHaveText("标记为已读");
    await page.keyboard.press("Escape");
    await page.locator('[data-task="menu-b"]').click();
    await expect(page.locator("#topbar-task")).toHaveText(titles["menu-b"]);
    await expect(marker).toHaveCount(0);
    await page.locator('[data-task="menu-a"]').click();
    await expectOriginalDraft(page);
  } finally {
    await dashboard.stop();
  }
});

test("copy and Markdown export capture the menu conversation without changing the selected draft", async ({
  page,
  context
}) => {
  const dashboard = await startDashboard();
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: dashboard.base });
    await seed(page, dashboard);
    const copy = async (action) => {
      const menu = await openSidebarMenu(page);
      await menu.locator('[data-session-submenu="copy"]').click();
      await menu.locator(`[data-session-action="${action}"]`).click();
      await expect(menu).toBeHidden();
      await expectOriginalDraft(page);
    };
    for (const [action, expected] of [
      ["copy-title", titles["menu-b"]],
      ["copy", "menu-b"],
      ["copy-link", `${dashboard.base}/?task=menu-b`]
    ]) {
      await copy(action);
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
    }
    await copy("copy-content");
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain("请保留 **原始格式** 并总结方案 B。");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("## 方案 B");
    expect(copied).toContain("const ready = true;");
    expect(copied).not.toMatch(/PRIVATE_THINKING|PRIVATE_TOOL_LOG/);
    const menu = await openSidebarMenu(page);
    const downloading = page.waitForEvent("download");
    await menu.locator('[data-session-action="export"]').click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(`${titles["menu-b"]}.md`);
    expect(await readFile(await download.path(), "utf8")).toBe(copied);
    await expectOriginalDraft(page);
    await page.route("**/api/tasks/menu-b", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return route.fulfill({ status: 503, json: { error: "合成读取失败" } });
    });
    await page.evaluate(() => navigator.clipboard.writeText("保留原有剪贴板"));
    await copy("copy-content");
    await expect(page.locator("#toast")).toContainText("合成读取失败");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("保留原有剪贴板");
  } finally {
    await dashboard.stop();
  }
});

test("copy submenus preserve keyboard focus through refresh and stay inside desktop and narrow viewports", async ({
  page
}, info) => {
  const dashboard = await startDashboard();
  try {
    await seed(page, dashboard);
    for (const width of [1440, 640]) {
      await page.setViewportSize({ width, height: 700 });
      const menu = await openSidebarMenu(page);
      const trigger = page.locator('[data-session-menu="menu-b"]');
      const copy = menu.locator('[data-session-submenu="copy"]');
      const submenu = menu.locator('[data-session-submenu-panel="copy"]');
      await copy.focus();
      await copy.press("ArrowRight");
      await expect(submenu).toBeVisible();
      await expect(submenu.locator('[data-session-action="copy-title"]')).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(submenu.locator('[data-session-action="copy"]')).toBeFocused();
      if (width === 1440) {
        await page.request.patch(`${dashboard.base}/api/tasks/menu-b`, { data: { pinned: true } });
        // The catalog poll is the refresh the panel used to offer.
        await page.waitForResponse((response) => new URL(response.url()).pathname === "/api/tasks");
        await expect(page.locator('[data-task="menu-b"]')).toContainText("★");
        await expect(submenu).toBeVisible();
        await expect(submenu.locator('[data-session-action="copy"]')).toBeFocused();
      }
      for (const panel of [menu, submenu]) {
        const box = await panel.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(700);
      }
      await page.screenshot({ path: info.outputPath(`conversation-menu-${width}.png`) });
      await page.keyboard.press("ArrowLeft");
      await expect(submenu).toBeHidden();
      await expect(copy).toBeFocused();
      await copy.press("ArrowRight");
      await page.keyboard.press("Escape");
      await expect(menu).toBeVisible();
      await expect(submenu).toBeHidden();
      await expect(copy).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(trigger).toBeFocused();
      await trigger.locator("..").hover();
      await trigger.click();
      await page.locator("#topbar-task").click();
      await expect(menu).toBeHidden();
      await expectOriginalDraft(page);
    }
  } finally {
    await dashboard.stop();
  }
});

test("opening a conversation in a new tab and following its link selects that conversation", async ({
  page,
  context
}) => {
  const dashboard = await startDashboard();
  let opened, releaseTaskList;
  try {
    await seed(page, dashboard);
    const menu = await openSidebarMenu(page);
    const opening = context.waitForEvent("page");
    await menu.locator('[data-session-action="open"]').click();
    opened = await opening;
    await expect(opened).toHaveURL(`${dashboard.base}/?task=menu-b`);
    await expect(opened.locator("#topbar-task")).toHaveText(titles["menu-b"]);
    await expectOriginalDraft(page);
    await opened.close();
    opened = undefined;
    const active = await page.request.post(`${dashboard.base}/api/workbench/tabs`, {
      data: { kind: "conversation", taskId: "menu-a" }
    });
    expect(active.ok()).toBe(true);
    expect((await active.json()).activeTabId).toBe("conversation:menu-a");
    const taskListGate = new Promise((resolve) => {
      releaseTaskList = resolve;
    });
    const delayedTaskList = async (route) => {
      const response = await route.fetch();
      await taskListGate;
      await route.fulfill({ response });
    };
    await page.route("**/api/tasks", delayedTaskList);
    const tabsFirst = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/workbench/tabs" && response.request().method() === "GET"
    );
    await page.goto(`${dashboard.base}/?task=menu-b`);
    expect((await (await tabsFirst).json()).activeTabId).toBe("conversation:menu-a");
    await expect(page.locator('[data-tab="conversation:menu-a"]')).toBeAttached();
    releaseTaskList();
    await expect(page.locator("#topbar-task")).toHaveText(titles["menu-b"]);
    await page.unroute("**/api/tasks", delayedTaskList);
    await page.goto(`${dashboard.base}/?task=menu-a`);
    await expectOriginalDraft(page);
  } finally {
    releaseTaskList?.();
    await page.unrouteAll({ behavior: "wait" });
    await opened?.close();
    await dashboard.stop();
  }
});
