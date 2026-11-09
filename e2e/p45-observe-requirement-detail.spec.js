import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { configureMerge, seedRequirement } from "./p45-requirement-fixture.js";

/**
 * The observation detail reads one requirement's recorded facts.
 *
 * Each section is asserted against the records a real backend published —
 * phase, handling session, owner, merge, ledger revision, completion criteria,
 * review conclusion and change size — and the view must not offer to open the
 * session or the diff, because observation is read-only.
 */
test.setTimeout(120_000);

test("the detail shows the recorded requirement and offers no session or diff", async ({ page }) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    const directory = join(dashboard.root, "project");
    await mkdir(directory, { recursive: true });
    const response = await page.request.post(`${dashboard.base}/api/projects`, {
      data: { projectName: "P4 验收示例项目", projectDirectory: directory }
    });
    expect(response.status(), await response.text()).toBeLessThan(300);
    const project = (await response.json()).project;
    await configureMerge(page, dashboard, project, directory);
    await seedRequirement(page, dashboard, project, {
      phase: "delivered",
      title: "按分数文件汇总总分",
      criteria: ["bash summarize.sh 输出 30", "只有 header 的 CSV 输出 0", "文件不存在时退出码 1"],
      findings: [
        { title: "给 summarize.sh 增加参数校验" },
        { title: "README 补充用法示例" },
        { title: "失败时输出可读原因" }
      ]
    });

    await page.goto(dashboard.base);
    await page.getByRole("tab", { name: "观测", exact: true }).click();
    await page.locator('[data-observe-view="requirements"]').click();
    const row = page.locator("[data-observe-requirement]").filter({ hasText: "按分数文件汇总总分" });
    await expect(row).toContainText("已交付");
    await row.click();

    const detail = page.locator("#observe-detail");
    await expect(detail).toBeVisible();
    await expect(detail.locator(".or-crumb")).toHaveText("需求详情");
    await expect(detail.locator(".or-detail-title")).toHaveText("按分数文件汇总总分");
    const tags = detail.locator(".or-tag");
    await expect(tags).toHaveCount(3);
    await expect(tags.nth(0)).toHaveText("已交付");
    await expect(tags.nth(1)).toHaveText("内部");
    await expect(tags.nth(2)).toHaveText("Full");

    // The phase strip highlights the current phase and marks the settled ones.
    const stepper = detail.locator(".or-stepper");
    await expect(stepper).toHaveAttribute("data-stage", "delivered");
    await expect(stepper.locator(".or-step")).toHaveCount(5);
    expect(
      await stepper.locator(".or-step").evaluateAll((nodes) => nodes.map((node) => node.dataset.state))
    ).toEqual(["done", "done", "done", "done", "done"]);

    // The facts come from the records: the Main session that handled it, the
    // current owner, the merged commit and the ledger revision.
    const facts = detail.locator(".or-fact");
    await expect(facts.nth(0)).toContainText("处理会话");
    await expect(facts.nth(0)).toContainText("按分数文件汇总总分");
    await expect(facts.nth(1)).toContainText("归属人");
    await expect(facts.nth(2)).toContainText("合入");
    await expect(facts.nth(2).locator(".or-fact-value")).toHaveText(/^main · [0-9a-f]{8}$/);
    await expect(facts.nth(3).locator(".or-fact-value")).toHaveText(/^v\d+ · 已记录交付$/);

    // Completion criteria are checked by the recorded passing checks.
    const criteria = detail.locator('[data-or-section="criteria"]');
    await expect(criteria.locator(".or-label")).toHaveText("完成标准 3/3");
    expect(
      await criteria
        .locator(".or-checks li")
        .evaluateAll((nodes) => nodes.map((node) => node.dataset.checked))
    ).toEqual(["true", "true", "true"]);

    // The review conclusion names the verdict and how many findings were ruled
    // out of scope; expanding it lists the settled findings.
    const review = detail.locator('[data-or-section="review"]');
    await expect(review.locator(".or-review-text")).toHaveText("独立审查通过");
    await expect(review.locator(".or-review-findings")).toHaveText("3 项范围外");
    await expect(review.locator(".or-findings")).toBeHidden();
    await review.locator("[data-observe-review]").click();
    await expect(review.locator(".or-findings")).toBeVisible();
    await expect(review.locator(".or-findings li")).toHaveCount(3);
    await expect(review.locator(".or-findings li").first()).toContainText("已驳回");

    // The change is only the file and its line counts.
    const change = detail.locator('[data-or-section="change"]');
    await expect(change.locator(".or-file")).toHaveCount(2);
    await expect(change.locator(".or-file").nth(0)).toContainText("notes.md");
    await expect(change.locator(".or-file").nth(0).locator(".or-add")).toHaveText("+1");
    await expect(change.locator(".or-file").nth(1).locator(".or-file-name")).toHaveText("summarize.sh");

    // Observation never opens a session or a diff.
    await expect(page.getByRole("button", { name: "打开会话" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "查看 diff" })).toHaveCount(0);
    await expect(page.locator("#observe-detail")).not.toContainText("查看 diff");
    await expect(page.locator("#observe-detail a")).toHaveCount(0);

    // The three legacy dialogs and their sidebar entries are gone.
    for (const selector of ["#ledger-nav", "#board-nav", "#development-nav", ".ledger-card", ".board-card"])
      await expect(page.locator(selector)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "需求台账", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "需求看板", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "需求现场", exact: true })).toHaveCount(0);

    // Closing the detail returns to the list alone.
    await detail.locator("[data-observe-detail-close]").click();
    await expect(detail).toBeHidden();
    await expect(page.locator("[data-observe-requirement]")).toHaveCount(1);
  } finally {
    await dashboard.stop();
  }
});
