import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { configureMerge, seedArtifact, seedRequirement } from "./p45-requirement-fixture.js";

/**
 * The work panel reads one requirement's recorded phase.
 *
 * Each case is a real requirement whose development, review, merge and
 * delivery facts were published by a backend identity, so the panel's phase,
 * criteria, change and attachments are checked against those records rather
 * than against a seeded screen.
 */
const CASES = [
  {
    phase: "development",
    title: "汇总分数文件",
    stage: "development",
    steps: ["done", "current", "pending", "pending", "pending"],
    checks: ["false", "false"],
    meta: { development: "Main" }
  },
  {
    phase: "review",
    title: "审查中的需求",
    stage: "review",
    steps: ["done", "done", "current", "pending", "pending"],
    checks: ["true", "true"],
    meta: { review: "Reviewer Norma" }
  },
  {
    phase: "rework",
    title: "待返修的需求",
    stage: "rework",
    steps: ["done", "done", "blocked", "pending", "pending"],
    checks: ["true", "false"],
    meta: { review: "Reviewer Norma" }
  },
  {
    phase: "merged",
    title: "已合入的需求",
    stage: "merged",
    steps: ["done", "done", "done", "done", "pending"],
    checks: ["true", "true"],
    meta: { merge: "main" }
  },
  {
    phase: "delivered",
    title: "已交付的需求",
    stage: "delivered",
    steps: ["done", "done", "done", "done", "done"],
    checks: ["true", "true"],
    meta: {}
  }
];

test("the requirement panel shows the recorded phase, criteria, change and attachments", async ({ page }) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    const directory = join(dashboard.root, "project");
    await mkdir(directory, { recursive: true });
    const response = await page.request.post(`${dashboard.base}/api/projects`, {
      data: { projectName: "需求进度验收", projectDirectory: directory }
    });
    expect(response.status(), await response.text()).toBeLessThan(300);
    const project = (await response.json()).project;
    await configureMerge(page, dashboard, project, directory);
    const seeded = [];
    for (const entry of CASES) {
      const records = await seedRequirement(page, dashboard, project, {
        phase: entry.phase,
        title: entry.title
      });
      await seedArtifact(page, dashboard, records.session.taskId, "验收记录.md", `# ${entry.title}\n`);
      seeded.push({ ...entry, ...records });
    }

    // The panel must never empty its stepper once shown while the same Task's records reload.
    await page.addInitScript(() => {
      window.__rpEmptied = false;
      let shown = false;
      new MutationObserver(() => {
        const count = document.querySelectorAll("[data-requirement-panel] .rp-step").length;
        if (count) shown = true;
        else if (shown) window.__rpEmptied = true;
      }).observe(document, { childList: true, subtree: true });
    });
    for (const entry of seeded) {
      const detailPath = `/api/tasks/${encodeURIComponent(entry.session.taskId)}`;
      // Hold the first detail read so the records land first, as they do under load.
      let held = false;
      await page.route(
        (url) => url.pathname === detailPath,
        async (route) => {
          if (!held) {
            held = true;
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
          await route.continue();
        }
      );
      const detailRead = page.waitForResponse((response) => new URL(response.url()).pathname === detailPath);
      await page.goto(`${dashboard.base}/?task=${encodeURIComponent(entry.session.taskId)}`);
      await expect(page.locator("#output-pane-toggle")).toHaveAttribute("aria-expanded", "false");
      await page.locator("#output-pane-toggle").click();
      const panel = page.locator("[data-requirement-panel]");
      await expect(panel.locator(".rp-title")).toHaveText(entry.title);
      const stepper = panel.locator(".rp-stepper");
      await expect(stepper).toHaveAttribute("data-stage", entry.stage);
      await expect(stepper.locator(".rp-step")).toHaveCount(5);
      expect(
        await stepper.locator(".rp-step").evaluateAll((nodes) => nodes.map((node) => node.dataset.state))
      ).toEqual(entry.steps);
      // The first detail read of the Task must not blank the records already shown.
      await detailRead;
      await expect(stepper.locator(".rp-step")).toHaveCount(5);
      expect(await page.evaluate(() => window.__rpEmptied)).toBe(false);
      expect(
        await panel.locator(".rp-check").evaluateAll((nodes) => nodes.map((node) => node.dataset.checked))
      ).toEqual(entry.checks);
      for (const [step, meta] of Object.entries(entry.meta))
        await expect(stepper.locator(`[data-step="${step}"] .rp-step-meta`)).toHaveText(meta);

      // The change is the same committed diff in every phase that has one.
      const files = panel.locator(".rp-diff-file");
      await expect(files).toHaveCount(2);
      await expect(files.nth(0)).toContainText("notes.md");
      await expect(files.nth(0).locator(".rp-add")).toHaveText("+1");
      await expect(files.nth(1)).toContainText("summarize.sh");
      await expect(files.nth(1).locator(".rp-add")).toHaveText("+2");

      const attachment = panel.locator("#output-list .rp-attachment");
      await expect(attachment).toHaveCount(1);
      await expect(attachment).toContainText("验收记录.md");
      const download = attachment.locator("a.rp-download");
      await expect(download).toHaveAttribute("download", "验收记录.md");
      expect(await download.getAttribute("href")).toContain(
        `/api/tasks/${encodeURIComponent(entry.session.taskId)}/artifact`
      );
      expect(await download.getAttribute("href")).toContain("download=1");
    }

    // A delivered requirement never reads as in progress anywhere in the panel.
    const delivered = seeded.at(-1);
    await page.goto(`${dashboard.base}/?task=${encodeURIComponent(delivered.session.taskId)}`);
    await page.locator("#output-pane-toggle").click();
    const panel = page.locator("[data-requirement-panel]");
    await expect(panel.locator(".rp-stepper")).toHaveAttribute("data-stage", "delivered");
    await expect(panel.locator('.rp-step[data-state="current"]')).toHaveCount(0);
    expect(await panel.innerText()).not.toContain("待返修");
  } finally {
    await dashboard.stop();
  }
});
