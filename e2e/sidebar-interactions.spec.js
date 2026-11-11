import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const projectName = "研究项目 · 多智能体协作与交互界面设计";
const conversationTitle = "梳理项目中的界面布局、字体层级和侧边栏交互细节";

async function seed(page, dashboard, { extraTasks = 0 } = {}) {
  const projects = [];
  for (const [name, directory] of [
    [projectName, "research"],
    ["工作文档", "documents"]
  ]) {
    const projectDirectory = join(dashboard.root, directory);
    await mkdir(projectDirectory);
    const response = await page.request.post(`${dashboard.base}/api/projects`, {
      data: { projectName: name, projectDirectory }
    });
    expect(response.status()).toBe(201);
    projects.push((await response.json()).project);
  }
  for (const [taskId, goal, project] of [
    ["sidebar-current", "当前会话", projects[0]],
    ["sidebar-long", conversationTitle, projects[0]],
    ["sidebar-document", "整理工作文档", projects[1]]
  ]) {
    const response = await page.request.post(`${dashboard.base}/api/tasks`, {
      data: { taskId, goal, projectId: project.projectId }
    });
    expect(response.ok()).toBe(true);
  }
  for (let index = 0; index < extraTasks; index++) {
    const response = await page.request.post(`${dashboard.base}/api/tasks`, {
      data: {
        taskId: `sidebar-history-${index}`,
        goal: `项目中的历史会话 ${index + 1}`,
        projectId: projects[0].projectId
      }
    });
    expect(response.ok()).toBe(true);
  }
  await page.goto(dashboard.base);
  await expect(page.locator(".project-group")).toHaveCount(2);
  await expect(page.locator(".conversation-item")).toHaveCount(3 + extraTasks);
  // A 640-1023 window folds the tree into the icon rail; its project opens it.
  const group = page.locator(`[data-project="${projects[0].projectId}"]`);
  const current = page.locator('[data-task="sidebar-current"]');
  if (!(await current.isVisible())) await group.locator(".project-row").focus();
  await current.click();
  await page.locator("#composer-input").fill("保留当前会话的未发送草稿");
  return {
    group,
    heading: group.locator(".project-heading"),
    project: group.locator(".project-row"),
    settings: group.locator(".project-settings"),
    create: group.locator(".project-create"),
    row: group.locator(".conversation-row").filter({ has: page.locator('[data-task="sidebar-long"]') }),
    task: page.locator('[data-task="sidebar-long"]'),
    menu: page.locator('[data-session-menu="sidebar-long"]')
  };
}

async function moveOutside(page) {
  await page.mouse.move(900, 70);
}

async function pointerHits(button) {
  return button.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  });
}

async function expectStableBox(locator, original) {
  const box = await locator.boundingBox();
  for (const key of ["x", "y", "width", "height"]) expect(box[key], key).toBeCloseTo(original[key], 2);
}

test("long sidebar titles keep their geometry while project and conversation actions appear", async ({
  page
}) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    const sidebar = await seed(page, dashboard);
    await moveOutside(page);
    const name = sidebar.group.locator(".project-name"),
      title = sidebar.task.locator(".conversation-title-text");
    const nameBox = await name.boundingBox(),
      titleBox = await title.boundingBox();
    await sidebar.heading.hover();
    await expectStableBox(name, nameBox);
    await moveOutside(page);
    await sidebar.row.hover();
    await expectStableBox(title, titleBox);
    for (const action of [sidebar.settings, sidebar.create, sidebar.menu]) {
      const box = await action.boundingBox();
      expect(box.width).toBe(24);
      expect(box.height).toBe(24);
    }
    await sidebar.menu.click();
    await page.locator('[data-session-action="unread"]').click();
    const unread = sidebar.task.locator(".conversation-unread");
    await expect(unread).toBeVisible();
    await sidebar.row.hover();
    expect(await pointerHits(unread)).toBe(true);
    const unreadBox = await unread.boundingBox(),
      menuBox = await sidebar.menu.boundingBox();
    expect(unreadBox.x + unreadBox.width).toBeLessThan(menuBox.x);
    await expect(page.locator("#composer-input")).toHaveValue("保留当前会话的未发送草稿");
  } finally {
    await dashboard.stop();
  }
});

test("hidden sidebar actions ignore pointer hits and keyboard Tab reveals each action", async ({ page }) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    const sidebar = await seed(page, dashboard);
    await moveOutside(page);
    for (const action of [sidebar.settings, sidebar.create, sidebar.menu]) {
      await expect(action).toHaveCSS("opacity", "0");
      expect(await pointerHits(action)).toBe(false);
    }
    await sidebar.heading.hover();
    await expect(sidebar.settings).toHaveCSS("opacity", "1");
    expect(await pointerHits(sidebar.settings)).toBe(true);
    await sidebar.row.hover();
    await expect(sidebar.menu).toHaveCSS("opacity", "1");
    expect(await pointerHits(sidebar.menu)).toBe(true);
    await moveOutside(page);
    await sidebar.project.focus();
    await page.keyboard.press("Tab");
    await expect(sidebar.settings).toBeFocused();
    await expect(sidebar.settings).toHaveCSS("opacity", "1");
    await page.keyboard.press("Tab");
    await expect(sidebar.create).toBeFocused();
    await expect(sidebar.create).toHaveCSS("opacity", "1");
    await sidebar.task.focus();
    await page.keyboard.press("Tab");
    await expect(sidebar.menu).toBeFocused();
    await expect(sidebar.menu).toHaveCSS("opacity", "1");
    await expect(page.locator("#session-menu")).toBeHidden();
    await expect(page.locator(".conversation-item.active")).toHaveAttribute("data-task", "sidebar-current");
  } finally {
    await dashboard.stop();
  }
});

test("project disclosure keeps its leading slot and turns right when the project collapses", async ({
  page
}) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    const sidebar = await seed(page, dashboard);
    const disclosure = sidebar.group.locator(".project-disclosure"),
      chevron = disclosure.locator(".project-chevron"),
      name = sidebar.group.locator(".project-name");
    await expect(disclosure).toHaveCount(1);
    const disclosureBox = await disclosure.boundingBox(),
      nameBox = await name.boundingBox();
    expect(disclosureBox.x + disclosureBox.width).toBeLessThanOrEqual(nameBox.x);
    await sidebar.project.click();
    await expect(sidebar.project).toHaveAttribute("aria-expanded", "false");
    await expect(sidebar.group.locator(".conversation-list")).toBeHidden();
    await expect(chevron).toHaveCSS("transform", "none");
    await expect
      .poll(() =>
        chevron.locator("svg").evaluate((node) => {
          const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
          return Math.round((Math.atan2(matrix.b, matrix.a) * 180) / Math.PI);
        })
      )
      .toBe(-90);
    await expectStableBox(name, nameBox);
    await sidebar.project.click();
    await expect(sidebar.project).toHaveAttribute("aria-expanded", "true");
    await expect(sidebar.task).toBeVisible();
    await expect(sidebar.task).not.toHaveClass(/active/);
  } finally {
    await dashboard.stop();
  }
});

test("an open conversation menu keeps its row highlighted and mouse dismissal clears incidental focus", async ({
  page
}, info) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    await page.addInitScript(() => localStorage.setItem("atria.appearance", "system"));
    const sidebar = await seed(page, dashboard);
    const panel = page.locator("#session-menu");
    await sidebar.row.hover();
    const hoverBackground = await sidebar.row.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(hoverBackground).not.toBe("rgba(0, 0, 0, 0)");
    await sidebar.menu.click();
    await expect(panel).toBeVisible();
    await moveOutside(page);
    await expect(sidebar.row).toHaveCSS("background-color", hoverBackground);
    await expect(sidebar.menu).toHaveAttribute("aria-expanded", "true");
    for (const theme of ["dark", "light"]) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.screenshot({
        path: info.outputPath(`sidebar-menu-${theme}-1440.png`),
        fullPage: true,
        animations: "disabled"
      });
    }
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(sidebar.menu).toBeFocused();
    await expect(sidebar.menu).toHaveCSS("opacity", "1");
    await sidebar.menu.click();
    await expect(panel).toBeVisible();
    await sidebar.menu.click();
    await expect(panel).toBeHidden();
    await moveOutside(page);
    await expect(sidebar.menu).toBeFocused();
    await expect(sidebar.menu).toHaveCSS("opacity", "0");
    await expect(page.locator(".conversation-item.active")).toHaveAttribute("data-task", "sidebar-current");
    await expect(page.locator("#composer-input")).toHaveValue("保留当前会话的未发送草稿");
  } finally {
    await dashboard.stop();
  }
});

test("touch devices keep project and conversation actions visible without hover", async ({ browser }) => {
  const dashboard = await startDashboard({ defaultProject: false });
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 700, height: 900 }
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem("atria.appearance", "system"));
    const sidebar = await seed(page, dashboard);
    // The rail has no hover to reveal actions with: focusing the project icon
    // opens its floating tree, which carries the project and session commands.
    await sidebar.project.focus();
    const railSettings = sidebar.group.locator("[data-rail-settings]");
    const railCreate = sidebar.group.locator("[data-rail-create]");
    for (const action of [railSettings, railCreate, sidebar.menu]) {
      await expect(action).toHaveCSS("opacity", "1");
      expect(await pointerHits(action)).toBe(true);
    }
    await sidebar.menu.tap();
    await expect(page.locator("#session-menu")).toBeVisible();
    await expect(page.locator(".conversation-item.active")).toHaveAttribute("data-task", "sidebar-current");
  } finally {
    await context.close();
    await dashboard.stop();
  }
});

test("menus beside bottom sidebar rows keep their trigger clear and flip above in narrow viewports", async ({
  page
}, info) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    const sidebar = await seed(page, dashboard, { extraTasks: 18 });
    const row = sidebar.group.locator(".conversation-row").last(),
      trigger = row.locator(".conversation-menu"),
      panel = page.locator("#session-menu");
    for (const width of [1440, 640]) {
      await page.setViewportSize({ width, height: 900 });
      await row.scrollIntoViewIfNeeded();
      await row.hover();
      await trigger.click();
      await expect(panel).toBeVisible();
      const rowBox = await row.boundingBox(),
        anchorBox = await trigger.boundingBox(),
        menuBox = await panel.boundingBox();
      expect(anchorBox.y).toBeGreaterThan(500);
      expect(menuBox.x).toBeGreaterThanOrEqual(8);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width - 8);
      expect(menuBox.y).toBeGreaterThanOrEqual(8);
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(892);
      if (width >= 608) expect(menuBox.x).toBeGreaterThanOrEqual(rowBox.x + rowBox.width);
      else expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(anchorBox.y);
      expect(await pointerHits(trigger)).toBe(true);
      await page.screenshot({
        path: info.outputPath(`sidebar-menu-bottom-${width}.png`),
        fullPage: true,
        animations: "disabled"
      });
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
    }
  } finally {
    await dashboard.stop();
  }
});
