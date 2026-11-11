import { expect, test } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { seedRequirement } from "./p45-requirement-fixture.js";
import { createProject, markTaskRunning, writeHumanQuestion } from "./p45-work-helpers.js";
import { addNode, freePort, openObservation, publishNeed } from "./p45-observe-fixture.js";

/**
 * What the overview says needs attention, and what it must not offer.
 *
 * The four reasons come from recorded facts: a Main waiting on a person, a
 * review that failed, a claim nobody picked up for days, and a node that went
 * away. Observation is read-only, so none of them carries a claim action, and
 * the legacy Main-session and external-capacity dialogs are gone.
 */
test.setTimeout(240_000);

test("attention names replies, failed reviews, stale claims and offline nodes without claiming", async ({
  page
}) => {
  const portA = await freePort();
  let portB = await freePort();
  while (portB === portA) portB = await freePort();
  const origins = `http://127.0.0.1:${portA},http://127.0.0.1:${portB}`;
  const local = await startDashboard({
    port: portA,
    defaultProject: false,
    env: { COWORK_TRUSTED_CLIENT_ORIGINS: origins }
  });
  let remote;
  try {
    remote = await startDashboard({
      port: portB,
      defaultProject: false,
      env: { COWORK_TRUSTED_CLIENT_ORIGINS: origins }
    });
    const project = await createProject(page, local, "本机项目", `${local.root}/local-project`);

    // A Main blocked on a person's answer.
    const waiting = await seedRequirement(page, local, project, {
      phase: "review",
      title: "导出格式确认"
    });
    await markTaskRunning(local, { taskId: waiting.session.taskId, runId: "run-waiting" });
    await writeHumanQuestion(local, {
      taskId: waiting.session.taskId,
      runId: "run-waiting",
      question: "导出用哪种格式？"
    });
    // A review that came back for a fix.
    await seedRequirement(page, local, project, { phase: "rework", title: "修复登录超时" });
    // A need nobody claimed.
    await publishNeed(page, local, project.projectId, {
      requestId: "stale-need",
      title: "报表导出 CSV"
    });

    await page.goto(local.base);
    await addNode(page, { base: remote.base, name: "远程节点", role: "external" });
    await openObservation(page);

    const card = (origin) => page.locator(`[data-observe-node-card="${origin}"]`);
    await expect(card(remote.base)).toHaveAttribute("data-status", "online");
    await expect(card(local.base).locator('[data-stat="waiting"] .oo-stat-value')).toHaveText("1");

    // The node goes away; the stored last-seen mark is what remains.
    await remote.stop();
    await expect(card(remote.base)).toHaveAttribute("data-status", "offline", { timeout: 30_000 });

    // Three days later the unclaimed need is stale and the offline node is old.
    await page.clock.setFixedTime(Date.now() + 3 * 24 * 60 * 60_000 + 60 * 60_000);
    await page.locator('[data-observe-view="requirements"]').click();
    await page.locator('[data-observe-view="overview"]').click();

    const attention = page.locator("[data-observe-attention]");
    await expect(attention).toBeVisible();
    await expect(attention.locator("[data-observe-attention-item]")).toHaveCount(4);
    await expect(attention.locator(".oo-badge")).toHaveText("4");

    await expect(page.locator('[data-attention="waiting"]')).toContainText("导出格式确认");
    await expect(page.locator('[data-attention="waiting"]')).toContainText("等待回复");
    await expect(page.locator('[data-attention="review"]')).toContainText("修复登录超时");
    await expect(page.locator('[data-attention="review"]')).toContainText("审查未通过");
    await expect(page.locator('[data-attention="pending"]')).toContainText("报表导出 CSV");
    await expect(page.locator('[data-attention="pending"]')).toContainText(/待认领 3 天/);
    await expect(page.locator('[data-attention="offline"]')).toContainText("远程节点");
    await expect(page.locator('[data-attention="offline"]')).toContainText(/离线/);

    // Reading never turns into claiming: no claim action anywhere on the view.
    await expect(attention.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /领取/ })).toHaveCount(0);
    await expect(page.locator("[data-observe-panel] [data-claim]")).toHaveCount(0);

    // The Main session and external capacity dialogs and their entries are gone.
    await expect(page.locator("#main-sessions-nav")).toHaveCount(0);
    await expect(page.locator("#main-capacity-nav")).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Main 会话", exact: true })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "外部容量", exact: true })).toHaveCount(0);
    await expect(page.getByText("外部容量", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Main 会话", exact: true })).toHaveCount(0);
  } finally {
    await remote?.stop();
    await local.stop();
  }
});
