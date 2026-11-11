import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import {
  createProject,
  createTask,
  markTaskRunning,
  sidebarDrawerToggle,
  writeHumanQuestion
} from "./p45-work-helpers.js";
import { seedRequirement } from "./p45-requirement-fixture.js";

/**
 * A whole-shell geometry read for one selector list. Rectangles are rounded so
 * the assertions talk about the layout, not sub-pixel rounding.
 */
const boxes = (page, selectors) =>
  page.evaluate(
    (list) =>
      Object.fromEntries(
        list.map(([key, selector]) => {
          const node = document.querySelector(selector);
          if (!node) return [key, null];
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return [
            key,
            {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              display: style.display,
              position: style.position,
              visibility: style.visibility
            }
          ];
        })
      ),
    selectors
  );

const visible = (box) =>
  Boolean(box) && box.display !== "none" && box.visibility !== "hidden" && box.width > 0 && box.height > 0;

// A sidebar or panel that was just toggled is measured once its columns settle.
const layout = async (page) => {
  await expect(page.locator("body")).not.toHaveAttribute("data-layout-animating");
  return boxes(page, [
    ["layout", "#app-layout"],
    ["sidebar", "#conversation-sidebar"],
    ["main", "#work-entry"],
    ["panel", "#agent-pane"],
    ["toggle", "#output-pane-toggle"],
    ["drawerToggle", "#sidebar-toggle"],
    ["composer", ".composer"],
    ["observe", "#observe-entry"],
    ["settings", "#settings-entry"]
  ]);
};

const documentWidth = (page) => page.evaluate(() => document.documentElement.scrollWidth);

/** The seeded conversation and its requirement records, ready for assertions. */
async function openWork(page, dashboard, { title = "评分汇总验收", phase = "review" } = {}) {
  const seeded = await seedRequirement(page, dashboard, dashboard.project, { title, phase });
  await page.goto(`${dashboard.base}/?task=${encodeURIComponent(seeded.session.taskId)}`);
  await expect(page.locator("#composer-input")).toBeVisible();
  await expect(page.locator(`.conversation-item[data-task="${seeded.session.taskId}"]`)).toBeVisible();
  return seeded;
}

/**
 * The entry switch lives in the rail on a narrow window and in the sidebar on a
 * wide one; on a web phone window it is inside the drawer, so open that first.
 */
async function chooseEntry(page, name) {
  await openSidebar(page);
  await page.getByRole("tab", { name, exact: true }).click();
  await expect(page.locator("#app-layout")).toHaveAttribute(
    "data-entry",
    name === "观测" ? "observe" : "work"
  );
}

const drawerTransform = (page) =>
  page.evaluate(() => getComputedStyle(document.querySelector("#conversation-sidebar")).transform);

/** Close the fullscreen sidebar drawer from its own control, when it is one. */
async function closeSidebar(page) {
  const toggle = await sidebarDrawerToggle(page);
  if (!toggle) return;
  if ((await toggle.getAttribute("aria-expanded")) !== "true") return;
  await page.locator("#sidebar-drawer-close").click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => drawerTransform(page)).toBe("matrix(1, 0, 0, 1, -16, 0)");
}

/**
 * On a web phone window the sidebar is a drawer; open it and let the slide
 * finish. Wider windows have the sidebar on screen already, so nothing happens.
 */
async function openSidebar(page) {
  const toggle = await sidebarDrawerToggle(page);
  if (!toggle) return;
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => drawerTransform(page)).toBe("none");
}

/** Wait for the sidebar drawer's slide to finish before measuring it. */
const settleDrawer = async (page, open) => {
  const expected = open ? "none" : "matrix(1, 0, 0, 1, -16, 0)";
  await expect.poll(() => drawerTransform(page)).toBe(expected);
};

test("the work surface keeps three columns at 1440 and turns the requirement panel into a right drawer below 1280", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await openWork(page, dashboard);

    await page.setViewportSize({ width: 1440, height: 900 });
    const wide = await layout(page);
    expect(wide.sidebar.width).toBe(248);
    expect(wide.main.width).toBeGreaterThan(900);
    expect(await documentWidth(page)).toBe(1440);
    expect(visible(wide.panel)).toBe(false);

    // At 1440 the panel is a column: opening it narrows the conversation instead of covering it.
    await page.locator("#output-pane-toggle").click();
    await expect(page.locator("[data-requirement-panel] .rp-title")).toHaveText("评分汇总验收");
    const wideOpen = await layout(page);
    expect(wideOpen.panel.width).toBe(360);
    expect(wideOpen.panel.position).toBe("relative");
    expect(wideOpen.panel.x).toBe(wideOpen.main.x + wideOpen.main.width + 10);
    expect(wideOpen.main.width).toBeLessThan(wide.main.width);
    expect(await documentWidth(page)).toBe(1440);
    await page.locator("[data-panel-collapse]").click();
    await expect.poll(async () => visible((await layout(page)).panel)).toBe(false);

    // 1100 keeps two columns and the panel floats over the conversation.
    await page.setViewportSize({ width: 1100, height: 900 });
    await expect.poll(async () => (await layout(page)).main.width).toBeGreaterThan(700);
    const narrow = await layout(page);
    expect(visible(narrow.toggle)).toBe(true);
    expect(visible(narrow.panel)).toBe(false);
    expect(await page.locator("#output-pane-toggle").innerText()).toContain("需求进度");
    await expect(page.locator("#output-pane-toggle")).toContainText("审查中");
    expect(await documentWidth(page)).toBe(1100);

    await page.locator("#output-pane-toggle").click();
    await expect(page.locator("[data-requirement-panel] .rp-title")).toHaveText("评分汇总验收");
    await expect.poll(async () => visible((await layout(page)).panel)).toBe(true);
    const drawer = await layout(page);
    expect(drawer.panel.position).toBe("fixed");
    expect(drawer.panel.width).toBe(360);
    expect(drawer.panel.x + drawer.panel.width).toBe(1090);
    expect(drawer.main.width).toBe(narrow.main.width);
    expect(drawer.panel.x).toBeLessThan(drawer.main.x + drawer.main.width);
    expect(await documentWidth(page)).toBe(1100);
    await page.screenshot({
      path: test.info().outputPath("work-1100-drawer.png"),
      clip: { x: 0, y: 0, width: 1100, height: 900 }
    });

    // The drawer's own close affordance puts it away again.
    await page.locator("[data-panel-collapse]").click();
    await expect.poll(async () => visible((await layout(page)).panel)).toBe(false);
    await expect(page.locator("#composer-input")).toBeVisible();
  } finally {
    await dashboard.stop();
  }
});

test("at 960 the sidebar collapses to an icon rail whose project expands the tree on hover", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    const second = await createProject(page, dashboard, "第二个项目", `${dashboard.root}/second-project`);
    const seeded = await openWork(page, dashboard);
    await createTask(page, dashboard, {
      taskId: "rail-second",
      goal: "修复登录超时",
      projectId: second.projectId
    });
    await markTaskRunning(dashboard, { taskId: "rail-second", runId: "run-rail-question" });
    await writeHumanQuestion(dashboard, {
      taskId: "rail-second",
      runId: "run-rail-question",
      question: "合入前需要保留旧接口吗？"
    });
    await page.goto(`${dashboard.base}/?task=${encodeURIComponent(seeded.session.taskId)}`);
    await expect(page.locator("#composer-input")).toBeVisible();

    await page.setViewportSize({ width: 960, height: 900 });
    await expect.poll(async () => (await layout(page)).sidebar.width).toBe(56);
    const rail = await layout(page);
    expect(rail.main.x).toBe(66);
    expect(rail.main.width).toBe(884);
    expect(await documentWidth(page)).toBe(960);

    // The rail shows one icon per project, not the tree.
    await expect(page.locator(".project-row .project-name").first()).toBeHidden();
    await expect(page.locator(".conversation-item").first()).toBeHidden();
    const row = await boxes(page, [["row", ".project-group .project-row"]]);
    expect(row.row.width).toBeLessThanOrEqual(40);

    // Hovering the project expands its tree as a floating panel the rail does not clip.
    const group = page.locator(`.project-group[data-project="${dashboard.projectId}"]`);
    const flyoutDefinition = [
      ["flyout", `.project-group[data-project="${dashboard.projectId}"] .conversation-list`]
    ];
    await expect(group.locator(".conversation-list")).toBeHidden();
    await group.locator(".project-row").hover();
    await expect.poll(async () => visible((await boxes(page, flyoutDefinition)).flyout)).toBe(true);
    const flyout = await boxes(page, flyoutDefinition);
    expect(flyout.flyout.position).toBe("fixed");
    expect(flyout.flyout.x).toBeGreaterThanOrEqual(56);
    await expect(group.locator(".conversation-list")).toContainText("评分汇总验收");
    await expect(group.locator(".conversation-list")).toContainText("测试项目");
    expect(await documentWidth(page)).toBe(960);
    await page.screenshot({
      path: test.info().outputPath("work-960-rail.png"),
      clip: { x: 0, y: 0, width: 960, height: 900 }
    });

    // A Main waiting on a person marks the project icon itself in the rail.
    const badge = await boxes(page, [
      ["dot", `.project-group[data-project="${second.projectId}"] .project-question`],
      ["row", `.project-group[data-project="${second.projectId}"] .project-row`]
    ]);
    expect(visible(badge.dot)).toBe(true);
    expect(badge.dot.x).toBeGreaterThanOrEqual(badge.row.x);
    expect(badge.dot.x + badge.dot.width).toBeLessThanOrEqual(badge.row.x + badge.row.width);

    // The hovered tree is the real navigation, not a copy.
    await group.locator(`.conversation-item[data-task="${seeded.session.taskId}"]`).click();
    await expect(page.locator(`.conversation-item[data-task="${seeded.session.taskId}"]`)).toHaveAttribute(
      "aria-current",
      "page"
    );

    // The requirement panel stays reachable from the title bar at this width too.
    await expect(page.locator("#output-pane-toggle")).toBeVisible();
    await page.locator("#output-pane-toggle").click();
    await expect.poll(async () => visible((await layout(page)).panel)).toBe(true);
    await expect
      .poll(async () => {
        const { panel } = await layout(page);
        return panel.x + panel.width;
      })
      .toBe(950);
    const drawer = await layout(page);
    expect(drawer.panel.position).toBe("fixed");
    expect(drawer.panel.width).toBe(360);
    await page.locator("[data-panel-collapse]").click();
    await expect.poll(async () => visible((await layout(page)).panel)).toBe(false);
  } finally {
    await dashboard.stop();
  }
});

test("a web window at 390 is one column with the sidebar and the requirement panel as fullscreen drawers", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    const seeded = await openWork(page, dashboard);

    await page.setViewportSize({ width: 390, height: 900 });
    await expect.poll(async () => (await layout(page)).main.width).toBe(374);
    await expect.poll(async () => visible((await layout(page)).sidebar)).toBe(false);
    const single = await layout(page);
    expect(single.main.x).toBe(8);
    expect(visible(single.drawerToggle)).toBe(true);
    expect(await documentWidth(page)).toBe(390);
    expect(single.composer.x + single.composer.width).toBeLessThanOrEqual(390);

    // The sidebar opens over the conversation and closes again from its own control.
    await page.locator("#sidebar-toggle").click();
    await expect(page.locator("#conversation-sidebar")).toBeVisible();
    await settleDrawer(page, true);
    const open = await layout(page);
    expect(open.sidebar.x).toBe(0);
    expect(open.sidebar.width).toBe(390);
    await expect(page.locator("#sidebar-toggle")).toHaveAttribute("aria-expanded", "true");
    await page.screenshot({
      path: test.info().outputPath("work-390-sidebar.png"),
      clip: { x: 0, y: 0, width: 390, height: 900 }
    });
    await page.keyboard.press("Escape");
    await expect.poll(async () => visible((await layout(page)).sidebar)).toBe(false);
    await expect(page.locator("#sidebar-toggle")).toHaveAttribute("aria-expanded", "false");

    // Picking a conversation also returns to it.
    await page.locator("#sidebar-toggle").click();
    await page.locator(`.conversation-item[data-task="${seeded.session.taskId}"]`).click();
    await expect.poll(async () => visible((await layout(page)).sidebar)).toBe(false);
    await expect(page.locator("#composer-input")).toBeVisible();

    // The requirement panel is the same fullscreen treatment.
    await expect(page.locator("#output-pane-toggle")).toBeVisible();
    await page.locator("#output-pane-toggle").click();
    await expect.poll(async () => visible((await layout(page)).panel)).toBe(true);
    await expect
      .poll(async () => {
        const { panel } = await layout(page);
        return `${panel.x}:${panel.width}`;
      })
      .toBe("8:374");
    const drawer = await layout(page);
    expect(drawer.panel.position).toBe("fixed");
    expect(await documentWidth(page)).toBe(390);
    await page.screenshot({
      path: test.info().outputPath("work-390-panel.png"),
      clip: { x: 0, y: 0, width: 390, height: 900 }
    });
    await page.locator("[data-panel-collapse]").click();
    await expect.poll(async () => visible((await layout(page)).panel)).toBe(false);
  } finally {
    await dashboard.stop();
  }
});

test("observation reflows every view and floats the requirement detail below 1280", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await openWork(page, dashboard);
    await chooseEntry(page, "观测");
    await closeSidebar(page);

    const observeBodyOverflow = () =>
      page.evaluate(() => {
        const body = document.querySelector(".observe-body");
        return { scroll: body.scrollWidth, client: body.clientWidth };
      });

    for (const width of [1440, 1100, 960, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(async () => (await layout(page)).observe.width).toBeLessThan(width);
      for (const view of ["overview", "requirements", "runs"]) {
        await openSidebar(page);
        await page.locator(`[data-observe-view="${view}"]`).click();
        await closeSidebar(page);
        await expect(page.locator(`[data-observe-panel="${view}"]`)).toBeVisible();
        const measured = await boxes(page, [
          ["sidebar", "#conversation-sidebar"],
          ["observe", "#observe-entry"]
        ]);
        if (width >= 1024) expect(measured.sidebar.width, `sidebar at ${width}`).toBe(248);
        else if (width >= 640) expect(measured.sidebar.width, `sidebar at ${width}`).toBe(56);
        else
          await expect
            .poll(async () => visible((await layout(page)).sidebar), `sidebar drawer at ${width}`)
            .toBe(false);
        expect(measured.observe.x, `observe x at ${width}`).toBe(width >= 1024 ? 258 : width >= 640 ? 66 : 8);
        const overflow = await observeBodyOverflow();
        expect(overflow.scroll, `${view} scrolls sideways at ${width}`).toBeLessThanOrEqual(
          overflow.client + 1
        );
        if (view === "overview") {
          const matrix = await boxes(page, [
            ["matrix", ".oo-matrix"],
            ["panel", ".oo-progress"]
          ]);
          expect(matrix.matrix.x + matrix.matrix.width, `matrix right at ${width}`).toBeLessThanOrEqual(
            matrix.panel.x + matrix.panel.width
          );
        }
        expect(await documentWidth(page), `document width at ${width}`).toBe(width);
        await page.screenshot({ path: test.info().outputPath(`observe-${view}-${width}.png`) });
      }

      // The requirement detail is a third column at 1280 and up, a drawer below.
      await openSidebar(page);
      await page.locator('[data-observe-view="requirements"]').click();
      await closeSidebar(page);
      await page.locator("[data-observe-requirement]").first().click();
      const detail = page.locator("#observe-detail");
      await expect(detail).toBeVisible();
      await expect(page.locator("#app-layout")).toHaveAttribute("data-observe-detail", "open");
      const placed = await boxes(page, [
        ["detail", "#observe-detail"],
        ["observe", "#observe-entry"]
      ]);
      if (width >= 1280) {
        expect(placed.detail.position, `detail at ${width}`).not.toBe("fixed");
        expect(placed.detail.x, `detail x at ${width}`).toBeGreaterThan(
          placed.observe.x + placed.observe.width
        );
      } else {
        expect(placed.detail.position, `detail at ${width}`).toBe("fixed");
        expect(placed.detail.width, `detail width at ${width}`).toBeLessThanOrEqual(420);
      }
      expect(await documentWidth(page), `detail document width at ${width}`).toBe(width);
      await page.screenshot({ path: test.info().outputPath(`observe-detail-${width}.png`) });
      await detail.locator("[data-observe-detail-close]").click();
      await expect(detail).toBeHidden();
    }
  } finally {
    await dashboard.stop();
  }
});

test("settings keeps a usable single column on a 390 wide window", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();

    for (const width of [1440, 1100, 960]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator("#user-menu-button").click();
      await expect(page.locator("#settings-entry")).toBeVisible();
      const twoColumn = await boxes(page, [
        ["nav", ".settings-nav"],
        ["content", ".settings-content"]
      ]);
      expect(twoColumn.nav.width, `nav at ${width}`).toBe(248);
      expect(twoColumn.content.x, `content x at ${width}`).toBe(258);
      expect(twoColumn.content.width, `content width at ${width}`).toBeGreaterThan(600);
      expect(await documentWidth(page), `document width at ${width}`).toBe(width);
      await page.locator("#settings-back").click();
      await expect(page.locator("#settings-entry")).toBeHidden();
    }

    // Below 640 the navigation stacks above a single full-width content column.
    await page.setViewportSize({ width: 390, height: 900 });
    await page.locator("#sidebar-toggle").click();
    await expect(page.locator("#conversation-sidebar")).toBeVisible();
    await page.locator("#user-menu-button").click();
    await expect(page.locator("#settings-entry")).toBeVisible();
    const stacked = await boxes(page, [
      ["nav", ".settings-nav"],
      ["content", ".settings-content"]
    ]);
    expect(stacked.nav.width).toBeLessThanOrEqual(370);
    expect(stacked.nav.y + stacked.nav.height).toBeLessThanOrEqual(stacked.content.y);
    expect(stacked.content.x).toBe(stacked.nav.x);
    expect(stacked.content.width).toBeGreaterThanOrEqual(340);
    expect(await documentWidth(page)).toBe(390);
    await expect(page.locator('[data-settings-panel="general"] .settings-page-title')).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("settings-390.png"),
      clip: { x: 0, y: 0, width: 390, height: 900 }
    });

    // Every section stays reachable at this width.
    for (const [name, title] of [
      ["nodes", "节点连接"],
      ["models", "模型与角色"],
      ["capacity", "运行名额"],
      ["members", "成员与通道"],
      ["tools", "工具"],
      ["general", "通用"]
    ]) {
      await page.locator(`[data-settings-section="${name}"]`).click();
      await expect(page.locator(`[data-settings-panel="${name}"] .settings-page-title`)).toHaveText(title);
      expect(await documentWidth(page)).toBe(390);
    }
  } finally {
    await dashboard.stop();
  }
});

test("the light theme keeps every page's text and status colours readable at each breakpoint", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.addInitScript(() => localStorage.setItem("atria.appearance", "light"));
    await openWork(page, dashboard);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    /**
     * The paint order a reader sees: every ancestor background composited over
     * the page, then the text colour over that. Gradients are ignored, so the
     * ratio is the conservative reading of a glass panel over the solid page.
     */
    const contrast = (pairs) =>
      page.evaluate(
        (list) =>
          Object.fromEntries(
            list.map(([key, selector]) => {
              const node = document.querySelector(selector);
              if (!node) return [key, null];
              const parse = (value) => {
                const match = value.match(/rgba?\(([^)]+)\)/);
                if (!match) return null;
                const parts = match[1]
                  .split(/[ ,/]+/)
                  .filter(Boolean)
                  .map(Number);
                return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
              };
              const over = (top, under) => ({
                r: top.r * top.a + under.r * (1 - top.a),
                g: top.g * top.a + under.g * (1 - top.a),
                b: top.b * top.a + under.b * (1 - top.a),
                a: 1
              });
              const channel = (value) => {
                const unit = value / 255;
                return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
              };
              const luminance = ({ r, g, b }) =>
                0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
              const chain = [];
              for (let current = node; current; current = current.parentElement) chain.unshift(current);
              let background = { r: 255, g: 255, b: 255, a: 1 };
              for (const current of chain) {
                const color = parse(getComputedStyle(current).backgroundColor);
                if (color && color.a > 0) background = over(color, background);
              }
              const text = over(parse(getComputedStyle(node).color), background);
              const [lighter, darker] = [luminance(text), luminance(background)].sort((a, b) => b - a);
              return [key, { ratio: (lighter + 0.05) / (darker + 0.05) }];
            })
          ),
        pairs
      );

    const expectReadable = async (pairs, width, pageName) => {
      const measured = await contrast(pairs);
      for (const [key, selector, minimum] of pairs) {
        expect(measured[key], `${pageName} ${key} at ${width} is missing`).not.toBeNull();
        expect(measured[key].ratio, `${pageName} ${key} (${selector}) at ${width}`).toBeGreaterThanOrEqual(
          minimum
        );
      }
    };
    const workPage = [
      ["title", "#topbar-task", 4.5],
      ["composer", "#composer-input", 4.5],
      ["project", ".project-name", 4.5],
      ["conversation", ".conversation-item-title", 4.5],
      ["headerButton", ".session-header-button", 3]
    ];
    const observePage = [
      ["header", ".observe-header h1", 4.5],
      ["panelTitle", ".oo-panel-head h2", 4.5],
      ["statValue", ".oo-stat-value", 4.5],
      ["statKey", ".oo-stat-key", 3],
      ["matrixProject", ".oo-matrix-name", 4.5],
      ["matrixStage", ".oo-matrix-stage", 3]
    ];
    const settingsPage = [
      ["pageTitle", ".settings-page-title", 4.5],
      ["navCurrent", '[data-settings-section][aria-current="page"]', 4.5],
      ["navItem", '[data-settings-section]:not([aria-current="page"])', 3]
    ];

    for (const width of [1440, 1100, 960, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => documentWidth(page)).toBe(width);
      // The page itself stays the theme's own solid colour.
      const backdrop = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(backdrop, `backdrop at ${width}`).toBe("rgb(244, 244, 248)");
      await expectReadable(workPage, width, "work");

      await chooseEntry(page, "观测");
      await expect(page.locator("#observe-entry")).toBeVisible();
      await expect(page.locator(".oo-matrix-name").first()).toBeVisible();
      await expectReadable(observePage, width, "observe");

      await chooseEntry(page, "工作");
      await openSidebar(page);
      await page.locator("#user-menu-button").click();
      await expect(page.locator("#settings-entry")).toBeVisible();
      await expectReadable(settingsPage, width, "settings");
      await page.locator("#settings-back").click();
      await expect(page.locator("#settings-entry")).toBeHidden();
    }
  } finally {
    await dashboard.stop();
  }
});
