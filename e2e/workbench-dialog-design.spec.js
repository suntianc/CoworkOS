import { openSaveCopy } from "./application-file-helper.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const appearances = [
  [1440, "light"],
  [320, "light"],
  [1440, "dark"],
  [320, "dark"]
];

async function checkDialog(dialog, width, height) {
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
  await expect(dialog).toHaveCSS("border-top-width", "0px");
  await expect(dialog).toHaveCSS("border-radius", "24px");
  expect(
    await dialog.locator("input,select").evaluateAll((nodes) =>
      nodes.every((node) => {
        const style = getComputedStyle(node);
        return style.fontSize === "14px" && style.borderTopStyle === "solid";
      })
    )
  ).toBe(true);
  expect(
    await dialog.locator("button").evaluateAll((nodes) =>
      nodes.every((node) => {
        const style = getComputedStyle(node);
        return style.fontSize === "14px" && style.borderTopStyle !== "outset";
      })
    )
  ).toBe(true);
}

test("the compatibility workspace picker uses shared fields and actions without clipping", async ({
  page
}, info) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    await page.goto(dashboard.base);
    await page.evaluate(async () => {
      const { createApplicationWorkspacePicker } =
        await import("/assets/workbench/application-workspace-picker.js");
      createApplicationWorkspacePicker({
        displayName: "文本编辑器",
        api: { chooseWorkspace: async () => ({ cancelled: true }) },
        workspaces: ["/fixture/一个很长的项目文件夹名称/用于检查工作区选项是否完整可读"]
      });
    });
    const dialog = page.getByRole("dialog", { name: "新建文本编辑器实例" });
    await expect(dialog.locator(".dialog-description")).toHaveCount(0);
    await expect(dialog.getByRole("combobox").locator("option").nth(1)).toHaveText(
      "/fixture/一个很长的项目文件夹名称/用于检查工作区选项是否完整可读"
    );
    await expect(dialog.getByRole("button", { name: "创建实例", exact: true })).toBeDisabled();
    await dialog.getByRole("combobox").selectOption({ index: 1 });
    await expect(dialog.getByRole("button", { name: "创建实例", exact: true })).toBeEnabled();
    for (const [width, colorScheme] of appearances) {
      await page.setViewportSize({ width, height: 620 });
      await page.emulateMedia({ colorScheme });
      await checkDialog(dialog, width, 620);
      await page.screenshot({ path: info.outputPath(`workspace-picker-${colorScheme}-${width}.png`) });
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  } finally {
    await dashboard.stop();
  }
});
