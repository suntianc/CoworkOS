import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { configureMerge, seedArtifact, seedRequirement, seedRun } from "./p45-requirement-fixture.js";

test("usage stays folded until asked, and diff and attachments preview inside the work entry", async ({
  page
}) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    const directory = join(dashboard.root, "project");
    await mkdir(directory, { recursive: true });
    const created = await page.request.post(`${dashboard.base}/api/projects`, {
      data: { projectName: "预览验收", projectDirectory: directory }
    });
    expect(created.status()).toBeLessThan(300);
    const project = (await created.json()).project;
    await configureMerge(page, dashboard, project, directory);
    const records = await seedRequirement(page, dashboard, project, {
      phase: "review",
      title: "预览与用量"
    });
    await seedArtifact(
      page,
      dashboard,
      records.session.taskId,
      "验收记录.md",
      "# 验收记录\n\n三条完成标准通过。\n"
    );
    await seedRun(page, dashboard, records.session.taskId);
    await page.goto(`${dashboard.base}/?task=${encodeURIComponent(records.session.taskId)}`);
    await page.locator("#output-pane-toggle").click();
    const panel = page.locator("[data-requirement-panel]");

    // ---- usage is folded by default -----------------------------------------
    const toggle = panel.locator("[data-usage-toggle]");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(panel.locator(".rp-usage[data-expanded='false']")).toHaveCount(1);
    await expect(panel.locator(".rp-role")).toHaveCount(0);
    await expect(panel.locator(".rp-exec")).toHaveCount(0);
    await expect(toggle.locator(".rp-usage-value")).toHaveText(/\d\d:\d\d · 2\.98M tokens/);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(panel.locator(".rp-role")).toHaveCount(3);
    const roles = panel.locator(".rp-role");
    await expect(roles.nth(0)).toContainText("Main");
    await expect(roles.nth(0).locator(".rp-role-value")).toHaveText("1.21M");
    await expect(roles.nth(1)).toContainText("Executor");
    await expect(roles.nth(1)).toContainText("Ara");
    await expect(roles.nth(1).locator(".rp-role-value")).toHaveText("1.34M");
    await expect(roles.nth(2)).toContainText("Reviewer");
    await expect(roles.nth(2)).toContainText("Norma");
    await expect(roles.nth(2).locator(".rp-role-value")).toHaveText("0.43M");
    const details = panel.locator(".rp-kv");
    await expect(details).toHaveCount(4);
    await expect(details.nth(0)).toContainText("工具调用");
    await expect(details.nth(0)).toContainText("148 次");
    await expect(details.nth(1)).toContainText("子 Agent");
    await expect(details.nth(1)).toContainText("2 个");
    await expect(details.nth(2)).toContainText("工作目录");
    await expect(details.nth(2)).toContainText("checkouts");
    await expect(details.nth(3)).toContainText("会话标识");
    await expect(details.nth(3)).toContainText(records.session.sessionId.slice(0, 8));
    await expect(toggle.locator("use").last()).toHaveAttribute("href", "#i-chevron-down");

    // ---- the diff opens in the work entry's own drawer ----------------------
    const url = page.url();
    await panel.getByRole("button", { name: "查看 diff" }).click();
    const drawer = page.locator("#artifact-drawer");
    await expect(drawer).toBeVisible();
    const diffTab = drawer.locator('[data-drawer-tab="diff"]');
    await expect(diffTab).toHaveAttribute("aria-selected", "true");
    const lines = drawer.locator(".drawer-lines");
    await expect(lines.locator(".drawer-diff-file")).toHaveCount(2);
    await expect(lines).toContainText("notes.md");
    await expect(lines).toContainText("summarize.sh");
    await expect(lines).toContainText("#!/usr/bin/env bash");
    await expect(drawer.locator(".drawer-line-number").first()).toHaveText("1");
    await expect(drawer.locator(".artifact-drawer-title")).toContainText("改动");

    // The same change can be read one file at a time.
    await drawer.locator('[data-drawer-tab="file"]').click();
    await expect(drawer.locator('[data-drawer-tab="file"]')).toHaveAttribute("aria-selected", "true");
    await drawer.getByRole("button", { name: "summarize.sh" }).click();
    // The 文件 tab shows the file as committed, not its patch.
    await expect(drawer.locator(".drawer-file-line")).toHaveCount(2);
    await expect(drawer.locator(".drawer-file-line").first()).toContainText("#!/usr/bin/env bash");
    await expect(drawer.locator(".drawer-line")).toHaveCount(0);

    // The attachment tab previews the file and downloads the original bytes.
    await drawer.locator('[data-drawer-file="验收记录.md"]').click();
    await expect(drawer.locator('[data-drawer-file="验收记录.md"]')).toHaveAttribute("aria-selected", "true");
    await expect(drawer.locator(".drawer-content")).toContainText("三条完成标准通过。");
    await expect(drawer.getByRole("link", { name: "下载", exact: true })).toBeVisible();
    const download = page.waitForEvent("download");
    await drawer.getByRole("link", { name: "下载", exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("验收记录.md");

    // Closing returns to the same conversation position and the trigger.
    await drawer.getByRole("button", { name: "关闭预览" }).click();
    await expect(drawer).toBeHidden();
    expect(page.url()).toBe(url);
    await expect(page.getByRole("button", { name: "查看 diff" })).toBeFocused();
    await expect(page.locator("#conversation-pane")).toBeVisible();

    // Escape is the same close: no navigation, focus returns to the trigger.
    await panel.getByRole("button", { name: "查看 diff" }).click();
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("button", { name: "查看 diff" })).toBeFocused();

    // An attachment in the panel opens the drawer on its own tab.
    await panel.locator('[data-artifact="验收记录.md"]').click();
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('[data-drawer-file="验收记录.md"]')).toHaveAttribute("aria-selected", "true");
    await expect(drawer.locator(".drawer-content")).toContainText("验收记录");
  } finally {
    await dashboard.stop();
  }
});
