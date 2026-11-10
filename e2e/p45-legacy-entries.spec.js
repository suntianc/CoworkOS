import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("removed entries are gone, nodes never read as services and attachments still open", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#entry-work")).toBeVisible();
    for (const selector of [
      "#goals-nav",
      "#apps-nav",
      "#apps-panel",
      "#team-view",
      "#team-trace-details",
      "#agent-galaxy",
      "#monitor-section",
      ".goal-workspace",
      ".watch-workspace",
      ".starter-prompts"
    ])
      await expect(page.locator(selector)).toHaveCount(0);
    for (const label of ["工作台", "应用", "长期任务", "智能体团队", "成员记录", "查看执行轨迹"])
      await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);

    const visibleText = await page.locator("body").innerText();
    expect(visibleText).not.toMatch(/长期任务|智能体|成员记录|执行轨迹|工作台/);
    expect(visibleText).not.toMatch(/daemon/i);
    expect(visibleText).not.toMatch(/服务/);

    await page.locator("#file-input").setInputFiles({
      name: "验收附件.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("附件内容仍可打开")
    });
    await page.locator("#attachment-strip [data-upload-preview]").click();
    await expect(page.locator(".attachment-preview [data-preview-content]")).toContainText(
      "附件内容仍可打开"
    );
    await page.locator(".attachment-preview [data-preview-close]").click();
    await expect(page.locator(".attachment-preview")).toBeHidden();
  } finally {
    await dashboard.stop();
  }
});

test("the legacy dialogs and their entries are gone from the work entry", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#entry-work")).toBeVisible();
    // Observation carries the overview and the requirement list, so the
    // dialogs that preceded them and their sidebar entries are removed.
    for (const selector of [
      "#ledger-nav",
      "#development-nav",
      "#board-nav",
      "#main-sessions-nav",
      "#main-capacity-nav",
      ".ledger-card",
      ".board-card"
    ])
      await expect(page.locator(selector)).toHaveCount(0);
    await expect(page.locator('[data-entry-mode="observe"]')).toBeVisible();
    await page.locator('[data-entry-mode="observe"]').click();
    await expect(page.locator("#observe-entry")).toBeVisible();
    await expect(page.locator("[data-observe-node-card]")).toHaveCount(1);
    await page.locator('[data-observe-view="requirements"]').click();
    await expect(page.locator("[data-observe-requirements-list]")).toBeVisible();
  } finally {
    await dashboard.stop();
  }
});
