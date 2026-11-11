import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { createTask } from "./p45-work-helpers.js";

/**
 * Motion (#12): a selected background glides between options instead of
 * jumping, a sidebar or panel eases between its columns, and both stay still
 * under reduced motion.
 */

// Records, frame by frame, the moving surface and the layout while `act` runs.
async function record(page, act, { ms = 700 } = {}) {
  await page.evaluate(() => {
    const frames = [];
    window.__motion = { frames, on: true };
    const step = () => {
      if (!window.__motion.on) return;
      const ghost = document.querySelector(".selection-glide");
      const rect = ghost?.getBoundingClientRect();
      frames.push({
        ghost: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        gliding: [...document.querySelectorAll("[data-gliding]")].map((node) => node.dataset.gliding),
        animating: document.body.dataset.layoutAnimating || "",
        sidebar: document.querySelector("#conversation-sidebar").getBoundingClientRect().width
      });
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  await act();
  await page.waitForTimeout(ms);
  return page.evaluate(() => {
    window.__motion.on = false;
    return window.__motion.frames;
  });
}

const box = async (locator) => {
  const { x, y, width, height } = await locator.boundingBox();
  return { x, y, width, height };
};
const between = (value, a, b) => value > Math.min(a, b) + 1 && value < Math.max(a, b) - 1;

test("selected backgrounds glide between options and the sidebar eases open and closed", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await createTask(page, dashboard, {
      taskId: "motion-a",
      goal: "第一个会话",
      projectId: dashboard.projectId
    });
    await createTask(page, dashboard, {
      taskId: "motion-b",
      goal: "第二个会话",
      projectId: dashboard.projectId
    });
    await page.goto(dashboard.base);
    const first = page.locator('.conversation-item[data-task="motion-a"]');
    const second = page.locator('.conversation-item[data-task="motion-b"]');
    await first.click();
    await expect(first).toHaveClass(/active/);

    // Conversations: the surface leaves one row and settles on the other.
    const from = await box(first.locator("xpath=.."));
    const to = await box(second.locator("xpath=.."));
    let frames = await record(page, () => second.click());
    let moving = frames.filter((frame) => frame.ghost);
    expect(moving.length).toBeGreaterThan(4);
    expect(moving.some((frame) => between(frame.ghost.y, from.y, to.y))).toBe(true);
    expect(moving.every((frame) => frame.gliding.includes("conversations"))).toBe(true);
    await expect(page.locator(".selection-glide")).toHaveCount(0);
    await expect(page.locator("[data-gliding]")).toHaveCount(0);
    const row = page.locator(".conversation-row:has(> .conversation-item.active)");
    await expect(row.locator(".conversation-item")).toHaveAttribute("data-task", "motion-b");
    expect(await row.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");

    // The entry switch, Work to Observe and back.
    const work = page.locator("#entry-work");
    const observe = page.locator("#entry-observe");
    const left = await box(work);
    const right = await box(observe);
    frames = await record(page, () => observe.click());
    moving = frames.filter((frame) => frame.ghost);
    expect(moving.some((frame) => between(frame.ghost.x, left.x, right.x))).toBe(true);
    // The leading edge runs ahead, so the surface is wider on its way.
    expect(Math.max(...moving.map((frame) => frame.ghost.width))).toBeGreaterThan(right.width + 4);
    await expect(page.locator(".selection-glide")).toHaveCount(0);
    await expect(observe).toHaveAttribute("aria-selected", "true");
    await work.click();

    // Settings: the section list and a segmented choice.
    await page.getByRole("button", { name: "设置", exact: true }).first().click();
    const general = page.locator('.settings-nav-item[data-settings-section="general"]');
    const models = page.locator('.settings-nav-item[data-settings-section="models"]');
    const top = await box(general);
    const bottom = await box(models);
    frames = await record(page, () => models.click());
    moving = frames.filter((frame) => frame.ghost);
    expect(moving.some((frame) => between(frame.ghost.y, top.y, bottom.y))).toBe(true);
    await general.click();
    await expect(general).toHaveAttribute("aria-current", "page");
    // The glide starts on the frame after the selection changes.
    await page.waitForTimeout(400);
    await expect(page.locator(".selection-glide")).toHaveCount(0);
    const chosen = page.locator('#appearance-choices > [aria-checked="true"]');
    const light = page.locator('[data-appearance-value="light"]');
    await expect(light).toHaveAttribute("aria-checked", "false");
    const start = await box(chosen);
    const end = await box(light);
    frames = await record(page, () => light.click());
    moving = frames.filter((frame) => frame.ghost);
    expect(moving.some((frame) => between(frame.ghost.x, start.x, end.x))).toBe(true);
    await page.locator("#settings-back").click();

    // The sidebar closes over several frames, then opens the same way.
    const open = (await box(page.locator("#conversation-sidebar"))).width;
    frames = await record(page, () => page.locator("#sidebar-toggle").click(), { ms: 500 });
    expect(frames.some((frame) => frame.animating && between(frame.sidebar, 0, open))).toBe(true);
    await expect(page.locator("body")).toHaveClass(/sidebar-collapsed/);
    await expect(page.locator("body")).not.toHaveAttribute("data-layout-animating");
    expect((await box(page.locator("#conversation-sidebar"))).width).toBeLessThan(1);
    frames = await record(page, () => page.locator("#sidebar-toggle").click(), { ms: 500 });
    expect(frames.some((frame) => frame.animating && between(frame.sidebar, 0, open))).toBe(true);
    await expect(page.locator("body")).not.toHaveAttribute("data-layout-animating");
    expect(Math.round((await box(page.locator("#conversation-sidebar"))).width)).toBe(Math.round(open));
  } finally {
    await dashboard.stop();
  }
});

for (const source of ["system", "setting"])
  test(`reduced motion (${source}) moves selections and the sidebar at once`, async ({ page }) => {
    if (source === "system") await page.emulateMedia({ reducedMotion: "reduce" });
    else await page.addInitScript(() => localStorage.setItem("atria.reduced-motion", "on"));
    const dashboard = await startDashboard();
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await createTask(page, dashboard, {
        taskId: "still-a",
        goal: "第一个会话",
        projectId: dashboard.projectId
      });
      await createTask(page, dashboard, {
        taskId: "still-b",
        goal: "第二个会话",
        projectId: dashboard.projectId
      });
      await page.goto(dashboard.base);
      await page.locator('.conversation-item[data-task="still-a"]').click();
      let frames = await record(page, () => page.locator('.conversation-item[data-task="still-b"]').click());
      frames.push(...(await record(page, () => page.locator("#entry-observe").click())));
      expect(frames.filter((frame) => frame.ghost || frame.gliding.length)).toEqual([]);
      await page.locator("#entry-work").click();
      frames = await record(page, () => page.locator("#sidebar-toggle").click(), { ms: 400 });
      expect(frames.filter((frame) => frame.animating)).toEqual([]);
      expect((await box(page.locator("#conversation-sidebar"))).width).toBeLessThan(1);
    } finally {
      await dashboard.stop();
    }
  });

test("the side panel opens in one motion and does not replay its entrance", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await createTask(page, dashboard, { taskId: "pane-a", goal: "面板会话", projectId: dashboard.projectId });
    await page.goto(dashboard.base);
    await page.locator('.conversation-item[data-task="pane-a"]').click();
    const body = page.locator("body");
    const toggle = page.locator("#output-pane-toggle");
    if (!(await body.evaluate((node) => node.classList.contains("output-collapsed")))) await toggle.click();
    await expect(body).toHaveClass(/output-collapsed/);
    await expect(body).not.toHaveAttribute("data-layout-animating");
    await page.evaluate(() => {
      const frames = [];
      window.__pane = frames;
      const pane = document.querySelector(".agent-pane");
      const step = () => {
        const look = getComputedStyle(pane);
        frames.push({
          animating: document.body.dataset.layoutAnimating || "",
          opacity: Number(look.opacity),
          transform: look.transform,
          y: pane.getBoundingClientRect().y
        });
        if (frames.length < 60) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    await toggle.click();
    await page.waitForTimeout(900);
    const frames = await page.evaluate(() => window.__pane);
    const opened = frames.findIndex((frame) => frame.animating === "pane");
    expect(opened).toBeGreaterThanOrEqual(0);
    const settled = frames.slice(opened).findIndex((frame) => !frame.animating) + opened;
    expect(settled).toBeGreaterThan(opened);
    // Once the columns have settled the panel stays put and fully shown.
    for (const frame of frames.slice(settled)) {
      expect(frame.opacity).toBe(1);
      expect(frame.transform).toBe("none");
      expect(frame.y).toBe(frames.at(-1).y);
    }
    // While opening it only fades: it never moves vertically.
    expect(new Set(frames.slice(opened).map((frame) => frame.y)).size).toBe(1);
  } finally {
    await dashboard.stop();
  }
});
