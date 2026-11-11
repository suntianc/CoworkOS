import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { sidebarDrawerToggle } from "./p45-work-helpers.js";

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
  const trigger = page.locator(`.conversation-item[data-task="${taskId}"]`);
  await revealSidebarTree(page, trigger);
  await trigger.click({ button: "right" });
  await expect(page.locator("#session-menu")).toBeVisible();
  return page.locator("#session-menu");
}

/**
 * A 640-1023 window folds the tree into the icon rail, so its project opens the
 * tree that holds the row. A phone-sized window opens the sidebar drawer first.
 */
async function revealSidebarTree(page, row) {
  const drawer = await sidebarDrawerToggle(page);
  if (drawer) {
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

test("the menu offers rename, pin, unread, archive and delete, and quick actions keep the draft", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await seed(page, dashboard);
    const menu = await openSidebarMenu(page);
    await expect(menu.locator("[data-session-action]:visible")).toHaveText([
      "重命名",
      "置顶",
      "标记为未读",
      "归档",
      "删除"
    ]);
    await expect(menu.locator('[data-session-action="stop"]')).toBeHidden();
    await expect(menu.getByText(/导出|复制|新标签页/)).toHaveCount(0);
    await page.keyboard.press("Escape");
    // Pin from the row's quick actions: the row shows a pin and moves up.
    const row = page.locator(".conversation-row").filter({ has: page.locator('[data-task="menu-b"]') });
    await row.hover();
    await row.locator('[data-quick-action="pin"]').click();
    await expect(row.locator(".conversation-pin")).toHaveCount(1);
    await expect(page.locator(".conversation-item").first()).toHaveAttribute("data-task", "menu-b");
    await expectOriginalDraft(page);
    await openSidebarMenu(page);
    await expect(menu.locator('[data-session-action="pin"]')).toHaveText("取消置顶");
    await page.keyboard.press("Escape");
    await row.hover();
    await row.locator('[data-quick-action="archive"]').click();
    await expect(page.locator('.conversation-item[data-task="menu-b"]')).toHaveCount(0);
    await expectOriginalDraft(page);
  } finally {
    await dashboard.stop();
  }
});

test("the menu keeps keyboard focus through refresh and stays inside desktop and narrow viewports", async ({
  page
}, info) => {
  const dashboard = await startDashboard();
  try {
    await seed(page, dashboard);
    for (const width of [1440, 640]) {
      await page.setViewportSize({ width, height: 700 });
      const menu = await openSidebarMenu(page);
      const trigger = page.locator('.conversation-item[data-task="menu-b"]');
      await expect(menu.locator('[data-session-action="rename"]')).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(menu.locator('[data-session-action="pin"]')).toBeFocused();
      if (width === 1440) {
        await page.request.patch(`${dashboard.base}/api/tasks/menu-b`, { data: { pinned: true } });
        // The catalog poll re-renders the rows under the open menu.
        await page.waitForResponse((response) => new URL(response.url()).pathname === "/api/tasks");
        await expect(
          page.locator('.conversation-row:has([data-task="menu-b"]) .conversation-pin')
        ).toHaveCount(1);
        await expect(menu).toBeVisible();
        await expect(menu.locator('[data-session-action="pin"]')).toHaveText("取消置顶");
        await expect(menu.locator('[data-session-action="pin"]')).toBeFocused();
      }
      const box = await menu.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(700);
      await page.screenshot({ path: info.outputPath(`conversation-menu-${width}.png`) });
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(trigger).toBeFocused();
      await trigger.press("Shift+F10");
      await expect(menu).toBeVisible();
      await page.locator("#topbar-task").click();
      await expect(menu).toBeHidden();
      await expectOriginalDraft(page);
    }
  } finally {
    await dashboard.stop();
  }
});

test("following a conversation link selects that conversation", async ({ page }) => {
  const dashboard = await startDashboard();
  let releaseTaskList;
  try {
    await seed(page, dashboard);
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
    await dashboard.stop();
  }
});
