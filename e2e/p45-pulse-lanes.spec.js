import { expect, test } from "@playwright/test";
import { createServer } from "node:net";
import { once } from "node:events";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { createProject } from "./p45-work-helpers.js";
import {
  createPulseRequirement,
  createPulseSession,
  pulseClock,
  seedPulseLane
} from "./p45-pulse-fixture.js";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function unusedPort() {
  const port = await freePort();
  return port;
}

test.setTimeout(180_000);

test("two nodes draw pulse lanes, Subagent branches, capacity groups and a stall", async ({ page }) => {
  const portA = await freePort();
  let portB = await freePort();
  while (portB === portA) portB = await freePort();
  const closedPort = await unusedPort();
  const origins = `http://127.0.0.1:${portA},http://127.0.0.1:${portB}`;
  const a = await startDashboard({
    port: portA,
    defaultProject: false,
    env: { COWORK_TRUSTED_CLIENT_ORIGINS: origins }
  });
  let b;
  try {
    b = await startDashboard({
      port: portB,
      defaultProject: false,
      config: { mainCapacity: { resident: 3, continuation: 2 } },
      env: { COWORK_TRUSTED_CLIENT_ORIGINS: origins }
    });
    const projectA = await createProject(page, a, "P4 验收示例项目", `${a.root}/p4-project`);
    const projectB = await createProject(page, b, "官网", `${b.root}/site-project`);
    const requirementA1 = await createPulseRequirement(page, a, projectA.projectId, "按分数文件汇总总分");
    const requirementA2 = await createPulseRequirement(page, a, projectA.projectId, "文档整理");
    const requirementB1 = await createPulseRequirement(page, b, projectB.projectId, "客户 A 登录问题");
    const requirementB2 = await createPulseRequirement(page, b, projectB.projectId, "结算页文案");
    const requirementB3 = await createPulseRequirement(page, b, projectB.projectId, "发票抬头修改");

    const clock = pulseClock();
    const pulse = await createPulseSession(page, a, {
      projectId: projectA.projectId,
      title: "评分汇总验收",
      requirementId: requirementA1.requirementId
    });
    const document = await createPulseSession(page, a, {
      projectId: projectA.projectId,
      title: "文档整理",
      requirementId: requirementA2.requirementId
    });
    const resident1 = await createPulseSession(page, b, {
      projectId: projectB.projectId,
      title: "常驻 1",
      requirementId: requirementB1.requirementId,
      entryKind: "external",
      kind: "regular"
    });
    const resident2 = await createPulseSession(page, b, {
      projectId: projectB.projectId,
      title: "常驻 2",
      entryKind: "external",
      kind: "regular"
    });
    const continuation1 = await createPulseSession(page, b, {
      projectId: projectB.projectId,
      title: "结算页文案",
      requirementId: requirementB2.requirementId,
      entryKind: "external",
      kind: "continuation"
    });
    const continuation2 = await createPulseSession(page, b, {
      projectId: projectB.projectId,
      title: "发票抬头",
      requirementId: requirementB3.requirementId,
      entryKind: "external",
      kind: "continuation"
    });

    await seedPulseLane(a, {
      taskId: pulse.taskId,
      runId: "run-pulse",
      clock,
      createdAt: clock.ago(-24),
      title: "评分汇总验收",
      main: { from: -24, to: -18 },
      subagents: [
        { agentId: "subagent_1", role: "executor", state: "completed", from: -23, to: -18 },
        { agentId: "subagent_3", role: "reviewer", state: "leased", from: -14, to: 1 }
      ]
    });
    await seedPulseLane(a, {
      taskId: document.taskId,
      runId: "run-document",
      clock,
      createdAt: clock.ago(-12),
      title: "文档整理",
      main: { from: -12, to: 1 }
    });
    await seedPulseLane(b, {
      taskId: resident1.taskId,
      runId: "run-resident-1",
      clock,
      createdAt: clock.ago(-60),
      title: "常驻 1",
      main: { from: -60, to: 1 }
    });
    await seedPulseLane(b, {
      taskId: resident2.taskId,
      runId: "run-resident-2",
      clock,
      createdAt: clock.ago(-180),
      title: "常驻 2",
      main: { from: -180, to: -179 }
    });
    await seedPulseLane(b, {
      taskId: continuation1.taskId,
      runId: "run-continuation-1",
      clock,
      createdAt: clock.ago(-26),
      title: "结算页文案",
      main: { from: -26, to: -11 }
    });
    await seedPulseLane(b, {
      taskId: continuation2.taskId,
      runId: "run-continuation-2",
      clock,
      createdAt: clock.ago(-18),
      title: "发票抬头",
      main: { from: -18, to: 1 }
    });

    const offlineOrigin = `http://127.0.0.1:${closedPort}`;
    await page.addInitScript(
      ([key, records]) => localStorage.setItem(key, JSON.stringify(records)),
      [
        "formicand.nodes.v1",
        [
          { origin: new URL(b.base).origin, name: "云端", role: "external" },
          {
            origin: offlineOrigin,
            name: "测试机",
            role: "internal",
            lastSeen: new Date(clock.ago(-120)).toISOString()
          }
        ]
      ]
    );

    await page.goto(a.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    await page.getByRole("tab", { name: "观测", exact: true }).click();
    await page.locator('[data-observe-view="runs"]').click();
    await expect(page.locator("[data-observe-runs-controls]")).toBeVisible();

    // Both online nodes and the collapsed offline node.
    await expect(page.locator(".runs-node[data-runs-node]")).toHaveCount(3, { timeout: 20_000 });
    const localCard = page.locator(`[data-runs-node="${a.base}"]`);
    const cloudCard = page.locator(`[data-runs-node="${b.base}"]`);
    await expect(localCard).toContainText("本机");
    await expect(localCard).toContainText("对内");
    await expect(cloudCard).toContainText("云端");
    await expect(cloudCard).toContainText("对外");
    await expect(page.locator("[data-runs-live]")).toBeVisible();

    // Main lanes with their session, stage, project · requirement and duration.
    const pulseLane = localCard.locator(`[data-runs-lane="${pulse.taskId}"]`);
    await expect(pulseLane).toHaveCount(1, { timeout: 20_000 });
    await expect(pulseLane).toHaveAttribute("data-stage", "review");
    await expect(pulseLane).toContainText("评分汇总验收");
    await expect(pulseLane).toContainText("审查");
    await expect(pulseLane).toContainText("P4 验收示例项目 · 按分数文件汇总总分");
    await expect(pulseLane).toContainText("24 分");
    await expect(pulseLane.locator(".runs-pulse.is-dev")).toHaveCount(1);
    await expect(pulseLane.locator(".runs-pulse.is-idle")).toHaveCount(1);
    await expect(pulseLane.locator(".runs-pulse.is-review")).toHaveCount(1);

    // Subagent branches: role, name, completion and the running head.
    const executor = localCard.locator('[data-runs-agent="subagent_1"]');
    await expect(executor).toContainText("Executor");
    await expect(executor).toContainText("Ara");
    await expect(executor).toContainText("已完成");
    await expect(executor.locator(".runs-done")).toHaveCount(1);
    const reviewer = localCard.locator('[data-runs-agent="subagent_3"]');
    await expect(reviewer).toContainText("Reviewer");
    await expect(reviewer).toContainText("Circinus");
    await expect(reviewer.locator(".runs-head")).toHaveCount(1);
    await expect(localCard.locator(`[data-runs-lane="${document.taskId}"]`)).toContainText("12 分");

    // External node: usage bars, empty slots as flat lines, and the four lanes.
    const regular = cloudCard.locator('[data-runs-slot="regular"]');
    await expect(regular).toContainText("常驻");
    await expect(regular).toContainText("2/3");
    await expect(regular.locator(".runs-slot-seg.is-regular")).toHaveCount(2);
    const continuation = cloudCard.locator('[data-runs-slot="continuation"]');
    await expect(continuation).toContainText("2/2");
    await expect(cloudCard.locator("[data-runs-empty]")).toHaveCount(1);
    await expect(cloudCard.locator("[data-runs-empty]")).toContainText("常驻 3");
    await expect(cloudCard.locator("[data-runs-empty] .runs-flat")).toHaveCount(1);
    await expect(cloudCard.locator(`[data-runs-lane="${resident1.taskId}"]`)).toContainText("1 小时");
    await expect(cloudCard.locator(`[data-runs-lane="${resident2.taskId}"]`)).toContainText("空闲");
    await expect(cloudCard.locator(`[data-runs-lane="${resident2.taskId}"]`)).toContainText("3 小时");
    await expect(cloudCard.locator(`[data-runs-lane="${continuation2.taskId}"]`)).toContainText("18 分");

    // A Main whose writes stopped is highlighted with how long it has been quiet.
    const stalled = cloudCard.locator(`[data-runs-lane="${continuation1.taskId}"]`);
    await expect(stalled).toHaveAttribute("data-stalled", "true");
    await expect(stalled).toHaveAttribute("data-stage", "wait");
    await expect(stalled.locator("[data-runs-stall]")).toHaveText(/12 分无进展/);

    // The offline node folds to one row with its last-seen time.
    const offline = page.locator(`[data-runs-node="${offlineOrigin}"]`);
    await expect(offline).toContainText("测试机", { timeout: 20_000 });
    await expect(offline).toContainText("离线 · 2 小时前");
    await expect(offline.locator("[data-runs-lane]")).toHaveCount(0);

    // Changing the window changes the axis and the drawn range.
    const wideLane = cloudCard.locator(`[data-runs-lane="${resident1.taskId}"]`);
    await expect(wideLane.locator(".runs-wave")).toHaveAttribute("data-slices", "30");
    await page.locator('[data-runs-window="5"]').click();
    await expect(page.locator('[data-observe-panel="runs"]')).toHaveAttribute("data-window", "5");
    await expect(page.locator(".runs-axis")).toContainText("-5 分");
    await expect(wideLane.locator(".runs-wave")).toHaveAttribute("data-slices", "5");
    await page.locator('[data-runs-window="120"]').click();
    await expect(page.locator(".runs-axis")).toContainText("-120 分");
    await expect(wideLane.locator(".runs-wave")).toHaveAttribute("data-slices", "60");
    await page.locator('[data-runs-window="30"]').click();
    await expect(page.locator(".runs-axis")).toContainText("-30 分");

    // The header controls belong to this view only.
    await page.locator('[data-observe-view="requirements"]').click();
    await expect(page.locator("[data-observe-runs-controls]")).toBeHidden();
    await page.locator('[data-observe-view="runs"]').click();
    await expect(page.locator("[data-observe-runs-controls]")).toBeVisible();

    // Observation stays read-only: no control opens a session.
    await expect(page.locator("[data-observe-panel='runs'] a")).toHaveCount(0);
    await expect(page.locator("[data-observe-panel='runs'] button").filter({ hasText: "打开" })).toHaveCount(
      0
    );
  } finally {
    await b?.stop();
    await a.stop();
  }
});
