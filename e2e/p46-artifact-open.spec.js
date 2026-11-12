import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { configureMerge, seedArtifact, seedRequirement } from "./p45-requirement-fixture.js";

test("点击产物只读预览并可下载，不可预览的直接下载，且没有编辑器入口", async ({ page }) => {
  test.setTimeout(120_000);
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    const directory = join(dashboard.root, "project");
    await mkdir(directory, { recursive: true });
    const created = await page.request.post(`${dashboard.base}/api/projects`, {
      data: { projectName: "产物验收", projectDirectory: directory }
    });
    expect(created.status()).toBeLessThan(300);
    const project = (await created.json()).project;
    await configureMerge(page, dashboard, project, directory);
    const records = await seedRequirement(page, dashboard, project, { phase: "review", title: "产物打开" });
    const taskId = records.session.taskId;
    await seedArtifact(page, dashboard, taskId, "方案.md", "# 方案\n\n只读预览。\n");
    await seedArtifact(page, dashboard, taskId, "数据.bin", Buffer.from([0, 1, 2, 255]));

    await page.goto(`${dashboard.base}/?task=${encodeURIComponent(taskId)}`);
    await page.locator("#output-pane-toggle").click();
    const panel = page.locator("[data-requirement-panel]");
    const drawer = page.locator("#artifact-drawer");

    // No application surface or "open in editor" control exists on the work page.
    await expect(page.locator("#workbench")).toHaveCount(0);
    await expect(page.locator("[data-tab-strip]")).toHaveCount(0);
    await expect(page.locator("#app-bind-select")).toHaveCount(0);
    await expect(page.getByText("在编辑器中打开")).toHaveCount(0);
    await expect(page.getByText("在应用中打开")).toHaveCount(0);

    // A previewable artifact opens read-only and downloads from the drawer.
    await panel.locator('[data-artifact="方案.md"]').click();
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".artifact-markdown")).toContainText("只读预览。");
    await expect(drawer.locator("[data-open-system]")).toHaveCount(0);
    const preview = page.waitForEvent("download");
    await drawer.getByRole("link", { name: "下载", exact: true }).click();
    expect((await preview).suggestedFilename()).toBe("方案.md");
    await drawer.getByRole("button", { name: "关闭预览" }).click();
    await expect(drawer).toBeHidden();

    // An artifact the preview cannot show downloads directly instead of opening an empty pane.
    const binary = page.waitForEvent("download");
    await panel.locator('[data-artifact="数据.bin"]').click();
    expect((await binary).suggestedFilename()).toBe("数据.bin");
    await expect(drawer).toBeHidden();

    // The diff view and attachment preview still live in the same drawer.
    await panel.getByRole("button", { name: "查看 diff" }).click();
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('[data-drawer-tab="diff"]')).toHaveAttribute("aria-selected", "true");
    await expect(drawer.locator(".drawer-diff-file")).toHaveCount(2);
    await drawer.locator('[data-drawer-file="方案.md"]').click();
    await expect(drawer.locator('[data-drawer-file="方案.md"]')).toHaveAttribute("aria-selected", "true");
    await expect(drawer.locator(".drawer-content")).toContainText("只读预览。");
  } finally {
    await dashboard.stop();
  }
});
