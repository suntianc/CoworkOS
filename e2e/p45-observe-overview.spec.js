import { expect, test } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { configureMerge, seedRequirement } from "./p45-requirement-fixture.js";
import { seedCapacitySlots } from "./p45-pulse-fixture.js";
import { createProject, markTaskRunning } from "./p45-work-helpers.js";
import { addNode, freePort, openObservation, publishNeed } from "./p45-observe-fixture.js";

/**
 * The observation overview aggregates every connected node.
 *
 * Two real backends hold different projects and phases; the node cards, the
 * phase matrix and the running table must read those snapshots, follow the
 * sidebar's node and project scope, and show a node's last seen time once it
 * is gone.
 */
test.setTimeout(240_000);

test("two nodes' cards, phase matrix and running table follow their snapshots and the sidebar scope", async ({
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
      config: { mainCapacity: { resident: 3, continuation: 2 } },
      env: { COWORK_TRUSTED_CLIENT_ORIGINS: origins }
    });
    const localProject = await createProject(page, local, "本机项目", `${local.root}/local-project`);
    const remoteProject = await createProject(page, remote, "远程项目", `${remote.root}/remote-project`);
    await configureMerge(page, local, localProject, `${local.root}/local-project`);
    await configureMerge(page, remote, remoteProject, `${remote.root}/remote-project`);

    // Internal node: one phase under review, one merged this week, one running.
    await seedRequirement(page, local, localProject, { phase: "review", title: "导出格式确认" });
    await seedRequirement(page, local, localProject, { phase: "merged", title: "本机已合入" });
    const localRun = await seedRequirement(page, local, localProject, {
      phase: "development",
      title: "按分数文件汇总总分"
    });
    await markTaskRunning(local, { taskId: localRun.session.taskId, runId: "run-local" });

    // External node: two running Mains occupying one resident and one
    // continuation slot, plus one need nobody has claimed.
    const remoteRun = await seedRequirement(page, remote, remoteProject, {
      phase: "development",
      title: "客户 A 登录问题"
    });
    const remoteContinuation = await seedRequirement(page, remote, remoteProject, {
      phase: "development",
      title: "结算页文案"
    });
    await markTaskRunning(remote, { taskId: remoteRun.session.taskId, runId: "run-remote" });
    await markTaskRunning(remote, { taskId: remoteContinuation.session.taskId, runId: "run-continuation" });
    const started = Date.now();
    await seedCapacitySlots(remote, [
      {
        projectId: remoteProject.projectId,
        sessionId: remoteRun.session.sessionId,
        taskId: remoteRun.session.taskId,
        runId: "run-remote",
        kind: "regular",
        startedAt: started - 24 * 60_000
      },
      {
        projectId: remoteProject.projectId,
        sessionId: remoteContinuation.session.sessionId,
        taskId: remoteContinuation.session.taskId,
        runId: "run-continuation",
        kind: "continuation",
        startedAt: started - 6 * 60_000
      }
    ]);
    await publishNeed(page, remote, remoteProject.projectId, {
      requestId: "remote-pending",
      title: "报表导出 CSV"
    });

    await page.goto(local.base);
    await addNode(page, { base: remote.base, name: "远程节点", role: "external" });
    await openObservation(page);

    const card = (origin) => page.locator(`[data-observe-node-card="${origin}"]`);
    const stat = (origin, key) => card(origin).locator(`[data-stat="${key}"]`);
    const matrixRow = (projectId) => page.locator(`[data-observe-matrix-project="${projectId}"]`);
    const cell = (projectId, stage) => matrixRow(projectId).locator(`[data-matrix-stage="${stage}"]`);
    const running = page.locator("[data-observe-running-row]");
    const runRow = (taskId) => page.locator(`[data-observe-running-row][data-task-id="${taskId}"]`);
    const runCell = (taskId, column) => runRow(taskId).locator(`[data-column="${column}"]`);

    // Node cards read each node's own records and the role they were added with.
    await expect(card(local.base)).toHaveAttribute("data-role", "internal");
    await expect(card(local.base)).toHaveAttribute("data-status", "online");
    await expect(stat(local.base, "running").locator(".oo-stat-value")).toHaveText("1");
    await expect(stat(local.base, "waiting").locator(".oo-stat-value")).toHaveText("0");
    await expect(stat(local.base, "merged").locator(".oo-stat-value")).toHaveText("1");

    await expect(card(remote.base)).toHaveAttribute("data-role", "external");
    await expect(stat(remote.base, "resident").locator(".oo-stat-value")).toHaveText("1/3");
    await expect(stat(remote.base, "continuation").locator(".oo-stat-value")).toHaveText("1/2");
    await expect(stat(remote.base, "pending").locator(".oo-stat-value")).toHaveText("1");

    // The phase matrix counts each project's requirements in its column.
    await expect(matrixRow(localProject.projectId).locator(".oo-matrix-name")).toHaveText("本机项目");
    await expect(cell(localProject.projectId, "pending")).toHaveText("·");
    await expect(cell(localProject.projectId, "development")).toHaveText("1");
    await expect(cell(localProject.projectId, "review")).toHaveText("1");
    await expect(cell(localProject.projectId, "merge")).toHaveText("1");
    await expect(cell(localProject.projectId, "release")).toHaveText("·");

    await expect(matrixRow(remoteProject.projectId).locator(".oo-matrix-name")).toHaveText("远程项目");
    await expect(cell(remoteProject.projectId, "pending")).toHaveText("1");
    await expect(cell(remoteProject.projectId, "development")).toHaveText("2");
    await expect(cell(remoteProject.projectId, "review")).toHaveText("·");
    await expect(cell(remoteProject.projectId, "merge")).toHaveText("·");
    await expect(cell(remoteProject.projectId, "release")).toHaveText("·");

    // The running table names the requirement, project, node, Main, phase and how long it has run.
    await expect(running).toHaveCount(3);
    await expect(runCell(localRun.session.taskId, "requirement")).toHaveText("按分数文件汇总总分");
    await expect(runCell(localRun.session.taskId, "project")).toHaveText("本机项目");
    await expect(runCell(localRun.session.taskId, "node")).toHaveText("本机");
    await expect(runCell(localRun.session.taskId, "session")).toHaveText("按分数文件汇总总分");
    await expect(runCell(localRun.session.taskId, "stage")).toHaveText("开发中");
    await expect(runCell(localRun.session.taskId, "duration")).toHaveText(/分|小时/);
    await expect(runCell(remoteRun.session.taskId, "node")).toHaveText("远程节点");
    await expect(runCell(remoteRun.session.taskId, "stage")).toHaveText("开发中");

    // Scoping by node keeps that node's cards, projects and rows.
    await page.locator(`button[data-observe-node="${remote.base}"]`).click();
    await expect(page.locator("[data-observe-node-card]")).toHaveCount(1);
    await expect(card(remote.base)).toBeVisible();
    await expect(matrixRow(localProject.projectId)).toHaveCount(0);
    await expect(matrixRow(remoteProject.projectId)).toBeVisible();
    await expect(running).toHaveCount(2);
    await expect(runRow(localRun.session.taskId)).toHaveCount(0);

    // Scoping by project narrows the matrix and the table further.
    await page.locator(`button[data-observe-project="${remoteProject.projectId}"]`).click();
    await expect(page.locator("[data-observe-matrix-project]")).toHaveCount(1);
    await expect(running).toHaveCount(2);

    // Clearing the node scope brings the other node back; the project scope is
    // independent and still narrows both panels to that project.
    await page.locator(`button[data-observe-node="${remote.base}"]`).click();
    await expect(page.locator("[data-observe-node-card]")).toHaveCount(2);
    await expect(page.locator("[data-observe-matrix-project]")).toHaveCount(1);
    await expect(running).toHaveCount(2);
    // Clearing the project scope restores every project and row.
    await page.locator(`button[data-observe-project="${remoteProject.projectId}"]`).click();
    await expect(page.locator("[data-observe-matrix-project]")).toHaveCount(2);
    await expect(running).toHaveCount(3);

    // A node that stops answering keeps its card and says when it was last seen.
    await remote.stop();
    await expect(card(remote.base)).toHaveAttribute("data-status", "offline", { timeout: 30_000 });
    await expect(stat(remote.base, "lastSeen").locator(".oo-stat-key")).toHaveText("最后在线");
    await expect(stat(remote.base, "lastSeen").locator(".oo-stat-value")).toHaveText(
      /刚刚|分钟前|小时前|天前/
    );
    await expect(stat(remote.base, "resident")).toHaveCount(0);
    await expect(card(local.base)).toHaveAttribute("data-status", "online");

    // The two links carry their section to the matching observation view.
    await page.locator('[data-observe-open="requirements"]').click();
    await expect(page.locator('[data-observe-panel="requirements"]')).toBeVisible();
    await page.locator('[data-observe-view="overview"]').click();
    await expect(page.locator('[data-observe-panel="overview"]')).toBeVisible();
    await page.locator('[data-observe-open="runs"]').click();
    await expect(page.locator('[data-observe-panel="runs"]')).toBeVisible();
  } finally {
    await remote?.stop();
    await local.stop();
  }
});
