import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { loadCurrentApplication } from "./application-context-helper.js";

const taskId = "surface-hierarchy";
const draft = "保留未发送的界面调整要求";

async function setup(page) {
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.addInitScript(() => localStorage.setItem("atria.appearance", "system"));
    await page.route("**/api/models", (route) =>
      route.fulfill({
        json: { configured: true, current: "surface-fixture", models: ["surface-fixture"] }
      })
    );
    const created = await page.request.post(`${dashboard.base}/api/tasks`, {
      data: { taskId, goal: "界面层次验收" }
    });
    expect(created.ok()).toBe(true);
    await page.goto(`${dashboard.base}/?task=${taskId}`);
    await expect(page.locator("#composer-input")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    return {
      dashboard,
      async stop() {
        await page.unrouteAll({ behavior: "ignoreErrors" });
        await dashboard.stop();
        expect(errors).toEqual([]);
      }
    };
  } catch (error) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await dashboard.stop();
    throw error;
  }
}

async function surfaceGeometry(page) {
  return page.evaluate(() => {
    const rectangle = (selector) => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    const composer = document.querySelector(".composer");
    const style = getComputedStyle(composer);
    const shadowBlur = Math.max(
      0,
      ...style.boxShadow.split(/,(?![^(]*\))/).map((layer) => {
        const lengths = layer.match(/-?\d+(?:\.\d+)?px/g) ?? [];
        return parseFloat(lengths[2] ?? "0");
      })
    );
    const visibleBorders = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return [];
      const border = getComputedStyle(node);
      return ["Top", "Right", "Bottom", "Left"].filter(
        (side) =>
          parseFloat(border[`border${side}Width`]) > 0 &&
          border[`border${side}Style`] !== "none" &&
          !/rgba\([^)]*,\s*0\)$|transparent/.test(border[`border${side}Color`])
      );
    };
    return {
      composer: rectangle(".composer"),
      pane: rectangle("#conversation-pane"),
      scroll: rectangle("#conversation"),
      shadow: style.boxShadow,
      shadowBlur,
      cardBackground: style.backgroundColor,
      paneBackground: getComputedStyle(document.querySelector(".chat-pane")).backgroundColor,
      collaborationBackground: getComputedStyle(document.querySelector(".workbench-header")).backgroundColor,
      visibleBorders: Object.fromEntries(
        [".app-topbar", ".chat-pane", ".conversation-sidebar", ".workbench-tabs", ".workbench-header"].map(
          (selector) => [selector, visibleBorders(selector)]
        )
      ),
      pageWidth: document.documentElement.scrollWidth,
      viewportHeight: window.innerHeight
    };
  });
}

function expectCardSpacing(geometry, width) {
  const { composer, pane, scroll } = geometry;
  expect(geometry.pageWidth).toBeLessThanOrEqual(width);
  expect(composer.x - pane.x).toBeGreaterThanOrEqual(12);
  expect(pane.x + pane.width - composer.x - composer.width).toBeGreaterThanOrEqual(12);
  expect(geometry.viewportHeight - composer.y - composer.height).toBeGreaterThanOrEqual(12);
  expect(scroll.y + scroll.height).toBeLessThanOrEqual(composer.y + 1);
  expect(geometry.cardBackground).not.toBe(geometry.paneBackground);
  expect(geometry.shadowBlur).toBeGreaterThanOrEqual(12);
}

for (const theme of ["light", "dark"]) {
  test(`${theme} shell stays open while the composer keeps its elevation and outer space at desktop and 320px`, async ({
    page
  }, info) => {
    await page.emulateMedia({ colorScheme: theme });
    const fixture = await setup(page);
    try {
      const input = page.locator("#composer-input");
      await input.fill(draft);
      for (const width of [1440, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await input.evaluate((node) => node.blur());
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const resting = await surfaceGeometry(page);
        expectCardSpacing(resting, width);
        // The glass conversation panel owns one continuous edge in both themes.
        expect(resting.visibleBorders[".chat-pane"]).toEqual(["Top", "Right", "Bottom", "Left"]);
        for (const [selector, borders] of Object.entries(resting.visibleBorders).filter(
          ([selector]) => selector !== ".chat-pane"
        ))
          expect(borders, `${width}px ${selector} permanent borders`).toEqual([]);
        await page.screenshot({ path: info.outputPath(`${theme}-${width}-resting.png`) });

        await input.focus();
        await expect(input).toBeFocused();
        await expect(input).toHaveValue(draft);
        await expect(page.locator(".composer")).toHaveCSS("box-shadow", resting.shadow);
        const focused = await surfaceGeometry(page);
        expectCardSpacing(focused, width);
        expect(focused.composer).toEqual(resting.composer);
        await page.screenshot({ path: info.outputPath(`${theme}-${width}-focused.png`) });
      }
    } finally {
      await fixture.stop();
    }
  });
}

async function expectRestingDivider(divider) {
  await expect(divider).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect.poll(() => divider.evaluate((node) => getComputedStyle(node, "::after").opacity)).toBe("1");
  expect(await divider.evaluate((node) => getComputedStyle(node, "::after").width)).toBe("1px");
  expect((await divider.boundingBox()).width).toBeGreaterThanOrEqual(6);
}

async function expectKeyboardDivider(divider) {
  await divider.focus();
  // Enter through Tab so a preceding mouse action cannot suppress :focus-visible.
  await divider.press("Shift+Tab");
  await divider.page().keyboard.press("Tab");
  await expect(divider).toBeFocused();
  await expect.poll(() => divider.evaluate((node) => getComputedStyle(node, "::after").opacity)).toBe("1");
  const cue = await divider.evaluate((node) => {
    const style = getComputedStyle(node, "::after");
    return { width: parseFloat(style.width), background: style.backgroundColor };
  });
  expect(cue.width).toBe(2);
  expect(cue.background).not.toBe("rgba(0, 0, 0, 0)");
}

async function openSplit(page, dashboard) {
  const created = await page.request.post(`${dashboard.base}/api/tasks/${taskId}/resources`, {
    data: {
      kind: "text/markdown",
      title: "界面层次验收.md",
      initialContent: "# 界面层次验收\n\n检查并排布局中的留白与交互。"
    }
  });
  expect(created.ok()).toBe(true);
  const { resource } = await created.json();
  const opened = await page.request.post(`${dashboard.base}/api/workbench/tabs`, {
    data: { kind: "application", resourceId: resource.resourceId, bindTo: taskId }
  });
  expect(opened.ok()).toBe(true);
  await page.goto(dashboard.base);
  await expect(page.locator("[data-editor-input]:visible")).toBeVisible();
  await loadCurrentApplication(page);
  await expect(page.locator(".chat-pane")).toHaveClass(/is-collaborating/);
  await expect(page.locator("#composer-input")).toHaveValue(draft);
}

test("thin sidebar and split dividers strengthen on keyboard focus and resize without losing the draft", async ({
  page
}, info) => {
  const fixture = await setup(page);
  try {
    const input = page.locator("#composer-input");
    await input.fill(draft);
    await page.mouse.move(700, 32);
    const sidebar = page.getByRole("separator", { name: "调整会话侧栏宽度" });
    await input.focus();
    await expectRestingDivider(sidebar);
    const sidebarWidth = Number(await sidebar.getAttribute("aria-valuenow"));
    await expectKeyboardDivider(sidebar);
    await page.keyboard.press("ArrowRight");
    await expect(sidebar).toHaveAttribute("aria-valuenow", String(sidebarWidth + 16));
    await expect(input).toHaveValue(draft);
    await page.keyboard.press("ArrowLeft");
    await expect(sidebar).toHaveAttribute("aria-valuenow", String(sidebarWidth));

    await openSplit(page, fixture.dashboard);

    const split = page.locator("[data-workspace-divider]");
    await input.focus();
    await page.mouse.move(700, 32);
    await expectRestingDivider(split);
    const originalShare = Number(await split.getAttribute("aria-valuenow"));
    const originalWidth = (await page.locator("#conversation-pane").boundingBox()).width;
    await expectKeyboardDivider(split);
    await page.keyboard.press("ArrowRight");
    await expect(split).toHaveAttribute("aria-valuenow", String(originalShare + 2));
    expect((await page.locator("#conversation-pane").boundingBox()).width).toBeGreaterThan(originalWidth);
    await page.keyboard.press("ArrowLeft");
    await expect(split).toHaveAttribute("aria-valuenow", String(originalShare));
    await expect(input).toHaveValue(draft);

    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await input.focus();
      await expectRestingDivider(split);
      await expect.poll(async () => (await surfaceGeometry(page)).shadowBlur).toBeGreaterThanOrEqual(12);
      const geometry = await surfaceGeometry(page);
      expectCardSpacing(geometry, 1440);
      expect(geometry.visibleBorders[".workbench-header"]).toEqual([]);
      expect(geometry.collaborationBackground).toBe(geometry.paneBackground);
      await page.screenshot({ path: info.outputPath(`${theme}-1440-split.png`) });
      await expectKeyboardDivider(split);
      await page.screenshot({ path: info.outputPath(`${theme}-1440-split-divider-focused.png`) });
    }
  } finally {
    await fixture.stop();
  }
});

async function touchResize(page, cdp, divider, ending, otherDivider) {
  await expectRestingDivider(divider);
  const original = Number(await divider.getAttribute("aria-valuenow"));
  const maximum = Number(await divider.getAttribute("aria-valuemax"));
  const box = await divider.boundingBox();
  const start = { x: box.x + box.width / 2, y: box.y + 200 };
  const moved = { ...start, x: start.x + (original > maximum - 4 ? -32 : 32) };
  await divider.evaluate((node) => {
    node.addEventListener(
      "pointerdown",
      (event) => {
        node.dataset.touchPointer = String(event.pointerId);
      },
      { once: true }
    );
  });
  let touching = false;
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
    touching = true;
    await expect(divider).toHaveClass(/is-dragging/);
    await expect(page.locator("body")).toHaveClass(/workspace-resizing/);
    await expect.poll(() => divider.evaluate((node) => getComputedStyle(node, "::after").opacity)).toBe("1");
    expect(await divider.evaluate((node) => getComputedStyle(node, "::after").width)).toBe("2px");
    if (otherDivider) await expectRestingDivider(otherDivider);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [moved] });
    await expect(divider).not.toHaveAttribute("aria-valuenow", String(original));
    if (ending === "lost-capture") {
      await divider.evaluate((node) => node.releasePointerCapture(Number(node.dataset.touchPointer)));
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ ...moved, x: moved.x + 1 }]
      });
    } else {
      await cdp.send("Input.dispatchTouchEvent", {
        type: ending === "cancel" ? "touchCancel" : "touchEnd",
        touchPoints: []
      });
      touching = false;
    }
    await expect(divider).not.toHaveClass(/is-dragging/);
    await expect(page.locator("body")).not.toHaveClass(/workspace-resizing/);
    await expectRestingDivider(divider);
    if (touching) {
      const stopped = await divider.getAttribute("aria-valuenow");
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ ...moved, x: moved.x + 12 }]
      });
      await expect(divider).toHaveAttribute("aria-valuenow", stopped);
    }
    await expect(page.locator("#composer-input")).toHaveValue(draft);
  } finally {
    if (touching) await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await divider.evaluate((node) => delete node.dataset.touchPointer);
  }
}

test.describe("touch divider feedback", () => {
  test.use({ hasTouch: true });
  test("sidebar and split show only the current drag and recover after end, cancel and capture loss", async ({
    page,
    context
  }) => {
    const fixture = await setup(page);
    let cdp;
    try {
      cdp = await context.newCDPSession(page);
      await expect(page.locator("#composer-input")).toBeVisible();
      await page.locator("#composer-input").fill(draft);
      expect(await page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches)).toBe(true);
      const sidebar = page.locator("#sidebar-divider");
      for (const ending of ["cancel", "lost-capture", "end"]) await touchResize(page, cdp, sidebar, ending);
      await openSplit(page, fixture.dashboard);
      const split = page.locator("[data-workspace-divider]");
      for (const ending of ["cancel", "lost-capture", "end"]) {
        await touchResize(page, cdp, split, ending, sidebar);
        await expectRestingDivider(sidebar);
      }
    } finally {
      try {
        await cdp?.detach();
      } finally {
        await fixture.stop();
      }
    }
  });
});
