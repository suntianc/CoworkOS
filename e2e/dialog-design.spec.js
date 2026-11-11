import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

async function seed(page, dashboard) {
  for (const [taskId, goal] of [
    ["dialog-a", "需要保留草稿的会话 A"],
    ["dialog-b", "可以继续处理的会话 B"]
  ]) {
    const created = await page.request.post(`${dashboard.base}/api/tasks`, { data: { taskId, goal } });
    expect(created.ok()).toBe(true);
  }
  // Emulated color schemes drive the theme only while the page follows the system.
  await page.addInitScript(() => localStorage.setItem("atria.appearance", "system"));
  await page.goto(`${dashboard.base}/?task=dialog-a`);
  await expect(page.locator("#topbar-task")).toHaveText("需要保留草稿的会话 A");
  await page.locator("#composer-input").fill("打开弹窗前保留的草稿");
}

async function openRename(page) {
  await page.locator("#session-menu-button").click();
  await page.locator('[data-session-action="rename"]').click();
  const dialog = page.getByRole("dialog", { name: "重命名会话", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function contained(dialog, width, height) {
  const box = await dialog.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(box.y + box.height).toBeLessThanOrEqual(height);
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
}

test("rename uses the shared dialog controls in light and dark at desktop and narrow sizes", async ({
  page
}, info) => {
  const dashboard = await startDashboard();
  try {
    await seed(page, dashboard);
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const width of [1440, 320]) {
        const height = width === 320 ? 420 : 900;
        await page.setViewportSize({ width, height });
        const dialog = await openRename(page);
        await contained(dialog, width, height);
        const input = dialog.getByRole("textbox", { name: "会话名称", exact: true });
        const save = dialog.getByRole("button", { name: "保存", exact: true });
        const cancel = dialog.getByRole("button", { name: "取消", exact: true });
        await expect(input).toBeFocused();
        await expect(input).toHaveCSS("font-size", "14px");
        await expect(input).toHaveCSS("border-top-style", "solid");
        await expect(input).toHaveCSS("border-top-width", "1px");
        await expect(input).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
        await expect(input).toHaveCSS("border-radius", "12px");
        await expect(input).toHaveCSS("outline-width", "2px");
        await expect(dialog).toHaveCSS("border-top-width", "1px");
        await expect(dialog).toHaveCSS("border-radius", "16px");
        await expect(cancel).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
        await expect(cancel).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(save).toHaveCSS("font-size", "14px");
        await expect(save).toHaveCSS("border-top-style", "solid");
        await expect(dialog.locator("h2")).toHaveCSS("font-size", "18px");
        await expect(dialog.locator("h2")).toHaveCSS("font-weight", "500");
        const controls = await dialog.evaluate((node) => {
          const input = node.querySelector("input");
          const label = input.closest("label");
          const primary = node.querySelector('[type="submit"]');
          const panel = getComputedStyle(node);
          return {
            inputWidth: input.getBoundingClientRect().width,
            fieldWidth: label.getBoundingClientRect().width,
            primaryColor: getComputedStyle(primary).color,
            primaryBackground: getComputedStyle(primary).backgroundColor,
            text: panel.getPropertyValue("--ui-on-accent").trim(),
            accent: panel.getPropertyValue("--ui-accent").trim(),
            backdrop: getComputedStyle(node.parentElement).backdropFilter,
            panelBackground: panel.backgroundColor
          };
        });
        expect(Math.abs(controls.inputWidth - controls.fieldWidth)).toBeLessThan(1);
        expect(controls.primaryBackground).toBe(theme === "light" ? "rgb(28, 28, 34)" : "rgb(236, 236, 238)");
        expect(controls.primaryColor).toBe(theme === "light" ? "rgb(244, 244, 248)" : "rgb(14, 14, 15)");
        expect(controls.panelBackground).toBe(
          theme === "light" ? "rgba(251, 251, 253, 0.95)" : "rgba(16, 16, 20, 0.88)"
        );
        expect(controls.backdrop).toBe("none");
        await expect(save).toBeInViewport();
        await expect(cancel).toBeInViewport();
        await page.screenshot({ path: info.outputPath(`rename-${theme}-${width}.png`) });
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(page.locator("#session-menu-button")).toBeFocused();
        await expect(page.locator("#composer-input")).toHaveValue("打开弹窗前保留的草稿");
      }
    }
  } finally {
    await dashboard.stop();
  }
});

test("rename retains its field and focus while saving fails, and recent conversations share the same dialog", async ({
  page
}, info) => {
  const dashboard = await startDashboard();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let received = false;
  try {
    await seed(page, dashboard);
    await page.route("**/api/tasks/dialog-a", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      received = true;
      await gate;
      return route.fulfill({ status: 500, json: { error: "暂时无法保存，请重试" } });
    });
    const dialog = await openRename(page);
    const input = dialog.getByRole("textbox", { name: "会话名称", exact: true });
    const save = dialog.getByRole("button", { name: "保存", exact: true });
    await input.fill("   ");
    await save.click();
    await expect(dialog.getByRole("alert")).toHaveText("请输入会话名称");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toBeFocused();
    expect(await input.evaluate((node) => getComputedStyle(node).borderTopColor)).toBe(
      await input.evaluate((node) => getComputedStyle(node).outlineColor)
    );
    expect(received).toBe(false);
    await input.fill("保存失败后保留的新名称");
    await save.click();
    await expect.poll(() => received).toBe(true);
    await expect(save).toBeDisabled();
    await expect(save).toHaveAttribute("aria-busy", "true");
    await page.keyboard.press("Tab");
    await expect(input).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeFocused();
    release();
    await expect(dialog.getByRole("alert")).toHaveText("暂时无法保存，请重试");
    await expect(dialog.getByRole("alert")).toHaveCSS("color", "rgb(192, 58, 58)");
    await expect(input).toHaveValue("保存失败后保留的新名称");
    await expect(save).toBeEnabled();
    await page.screenshot({ path: info.outputPath("rename-save-failed.png") });
    await page.keyboard.press("Escape");
    // Emulated color schemes drive the theme only while the page follows the system.
    await page.addInitScript(() => localStorage.setItem("atria.appearance", "system"));
    await page.goto(`${dashboard.base}/?task=dialog-a`);
    await expect(page.locator("#composer-input")).toHaveValue("打开弹窗前保留的草稿");
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
    await dashboard.stop();
  }
});
