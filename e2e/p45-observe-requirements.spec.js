import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { test, expect } from "@playwright/test";
import { startConfiguredDashboard, startDashboard } from "../test/dashboard-fixture.mjs";
import { configureMerge, seedRequirement } from "./p45-requirement-fixture.js";
import { createProject, markTaskRunning, writeHumanQuestion } from "./p45-work-helpers.js";

/**
 * The observation requirement list aggregates every connected node.
 *
 * Two real backends hold different requirements in different phases; the list
 * must count them under the same phase tabs, narrow by node, project and text,
 * and read a delivered requirement as delivered instead of in progress.
 */
test.setTimeout(180_000);

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function publishNeed(page, dashboard, projectId, { requestId, title }) {
  const response = await page.request.post(
    `${dashboard.base}/api/projects/${encodeURIComponent(projectId)}/board`,
    {
      data: {
        action: "publish",
        requestId,
        title,
        content: `${title}的内容。`,
        source: { kind: "external" }
      }
    }
  );
  expect(response.status(), await response.text()).toBeLessThan(300);
}

const tabCount = (page, id) => page.locator(`[data-observe-tab="${id}"] .or-tab-count`);

test("two nodes' requirements aggregate with phase counts and scope filters", async ({ page }) => {
  const portA = await freePort();
  let portB = await freePort();
  while (portB === portA) portB = await freePort();
  const origins = `http://127.0.0.1:${portA},http://127.0.0.1:${portB}`;
  const node = await startConfiguredDashboard({
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
    const localProject = await createProject(page, node, "本机项目", `${node.root}/local-project`);
    const remoteProject = await createProject(page, remote, "远程项目", `${remote.root}/remote-project`);
    await configureMerge(page, node, localProject, `${node.root}/local-project`);
    await configureMerge(page, remote, remoteProject, `${remote.root}/remote-project`);

    await seedRequirement(page, node, localProject, { phase: "delivered", title: "本机已交付" });
    await seedRequirement(page, node, localProject, { phase: "review", title: "本机审查中" });
    await seedRequirement(page, remote, remoteProject, { phase: "merged", title: "远程已合入" });
    await publishNeed(page, remote, remoteProject.projectId, {
      requestId: "remote-pending",
      title: "远程待认领"
    });
    // A Main blocked on a person's answer is its own tab, not a phase.
    const waiting = await seedRequirement(page, node, localProject, {
      phase: "review",
      title: "本机等待回复"
    });
    await markTaskRunning(node, { taskId: waiting.session.taskId, runId: "run-waiting" });
    await writeHumanQuestion(node, {
      taskId: waiting.session.taskId,
      runId: "run-waiting",
      question: "导出用哪种格式？"
    });

    await page.goto(node.base);
    // The second node joins from the settings page, as a person would.
    await page.locator("#user-menu-button").click();
    await page.locator('[data-settings-section="nodes"]').click();
    await page.locator("#settings-node-add").click();
    const dialog = page.getByRole("dialog", { name: "添加节点" });
    await dialog.locator("#node-address").fill(remote.base);
    await dialog.locator("#node-name").fill("远程节点");
    await dialog.locator("#node-submit").click();
    await expect(dialog).toBeHidden();
    await page.locator("#settings-back").click();
    await page.getByRole("tab", { name: "观测", exact: true }).click();
    await page.locator('[data-observe-view="requirements"]').click();

    const rows = page.locator("[data-observe-requirement]");
    await expect(rows).toHaveCount(5);
    // Both nodes contribute to one list.
    for (const title of ["本机已交付", "本机审查中", "远程已合入", "远程待认领", "本机等待回复"])
      await expect(rows.filter({ hasText: title })).toHaveCount(1);

    // Phase tabs count the same rows.
    await expect(tabCount(page, "all")).toHaveText("5");
    await expect(tabCount(page, "pending")).toHaveText("1");
    await expect(tabCount(page, "active")).toHaveText("2");
    await expect(tabCount(page, "waiting")).toHaveText("1");
    await expect(tabCount(page, "release")).toHaveText("0");
    await expect(tabCount(page, "delivered")).toHaveText("1");

    // A delivered requirement reads 已交付 everywhere, and is never in progress.
    const delivered = rows.filter({ hasText: "本机已交付" });
    await expect(delivered.locator(".or-pill")).toHaveText("已交付");
    await expect(delivered.locator(".or-pill")).toHaveAttribute("data-stage", "delivered");
    await page.locator('[data-observe-tab="active"]').click();
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "本机已交付" })).toHaveCount(0);
    await expect(rows.filter({ hasText: "远程已合入" })).toContainText("已合入");
    await expect(rows.filter({ hasText: "本机审查中" })).toContainText("审查中");

    await page.locator('[data-observe-tab="waiting"]').click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("本机等待回复");
    await expect(rows.first().locator(".or-pill")).toHaveText("等待回复");

    await page.locator('[data-observe-tab="pending"]').click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("远程待认领");
    await expect(rows.first()).toContainText("看板");

    // Searching narrows the list and the counts that belong to it.
    await page.locator('[data-observe-tab="all"]').click();
    await page.locator("[data-observe-search]").fill("远程");
    await expect(rows).toHaveCount(2);
    await expect(tabCount(page, "all")).toHaveText("2");
    await page.locator("[data-observe-search]").fill("没有这个需求");
    await expect(rows).toHaveCount(0);
    await expect(page.locator(".or-empty")).toHaveText("没有匹配的需求");
    await page.locator("[data-observe-search]").fill("");
    await expect(rows).toHaveCount(5);

    // Scoping by node keeps only that node's requirements and projects.
    await page.locator(`button[data-observe-node="${remote.base}"]`).click();
    await expect(page.locator(`button[data-observe-node="${remote.base}"]`)).toHaveAttribute(
      "aria-current",
      "true"
    );
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "本机已交付" })).toHaveCount(0);
    await expect(tabCount(page, "all")).toHaveText("2");
    await expect(tabCount(page, "delivered")).toHaveText("0");

    // Scoping by project narrows further and titles the panel with the project.
    await page.locator(`button[data-observe-project="${remoteProject.projectId}"]`).click();
    await expect(page.locator("#observe-entry")).toHaveAttribute(
      "data-observe-project",
      remoteProject.projectId
    );
    await expect(rows).toHaveCount(2);
    await expect(page.locator("#observe-title")).toHaveText("需求 · 远程项目");

    // 全部 clears the scope and brings every row back.
    await page.locator("[data-observe-all]").click();
    await expect(rows).toHaveCount(5);
    await expect(page.locator("#observe-title")).toHaveText("需求");

    // The handling session and the merge commit come from the records.
    const merged = rows.filter({ hasText: "远程已合入" });
    await expect(merged.locator(".or-col-session")).toHaveText("远程已合入");
    await expect(merged.locator(".or-col-commit")).toHaveText(/^[0-9a-f]{8}$/);
    await expect(rows.filter({ hasText: "远程待认领" }).locator(".or-col-session")).toHaveText("—");

    // Publishing from the list keeps the board's behaviour: one external need
    // that appears as 待认领 in the project it was published to.
    await page.locator("[data-observe-publish]").click();
    const publish = page.getByRole("dialog", { name: "发布到看板" });
    await publish.locator('[name="projectId"]').selectOption(localProject.projectId);
    await publish.locator('[name="title"]').fill("观测发布的需求");
    await publish.locator('[name="content"]').fill("从观测发布到看板。");
    await publish.locator('button[type="submit"]').click();
    await expect(publish).toBeHidden();
    await expect(rows).toHaveCount(6);
    const published = rows.filter({ hasText: "观测发布的需求" });
    await expect(published).toContainText("看板");
    await expect(published.locator(".or-pill")).toHaveText("待认领");
    await expect(tabCount(page, "pending")).toHaveText("2");
  } finally {
    await remote?.stop();
    await node.stop();
  }
});
