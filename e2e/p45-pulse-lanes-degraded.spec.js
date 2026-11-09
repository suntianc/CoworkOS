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

test.setTimeout(180_000);

test("a node without metrics falls back to stage blocks and reduced motion refreshes a snapshot", async ({
  page
}) => {
  const portA = await freePort();
  let portB = await freePort();
  while (portB === portA) portB = await freePort();
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
      env: { COWORK_TRUSTED_CLIENT_ORIGINS: origins }
    });
    const projectA = await createProject(page, a, "P4 验收示例项目", `${a.root}/p4-project`);
    const projectB = await createProject(page, b, "Formicand", `${b.root}/app-project`);
    const requirementA = await createPulseRequirement(page, a, projectA.projectId, "按分数文件汇总总分");
    const requirementB = await createPulseRequirement(page, b, projectB.projectId, "文档整理");

    const clock = pulseClock();
    const withoutMetrics = await createPulseSession(page, a, {
      projectId: projectA.projectId,
      title: "评分汇总验收",
      requirementId: requirementA.requirementId
    });
    const withMetrics = await createPulseSession(page, b, {
      projectId: projectB.projectId,
      title: "文档整理",
      requirementId: requirementB.requirementId
    });
    await seedPulseLane(a, {
      taskId: withoutMetrics.taskId,
      runId: "run-without-metrics",
      createdAt: clock.ago(-24),
      title: "评分汇总验收",
      main: { from: -24, to: -18 },
      subagents: [
        { agentId: "subagent_1", role: "executor", state: "completed", from: -23, to: -18 },
        { agentId: "subagent_3", role: "reviewer", state: "leased", from: -14, to: 1 }
      ],
      clock
    });
    await seedPulseLane(b, {
      taskId: withMetrics.taskId,
      runId: "run-with-metrics",
      createdAt: clock.ago(-12),
      title: "文档整理",
      main: { from: -12, to: 1 },
      clock
    });

    // This node's protocol has no activity yet: the catalog answers without
    // the field, while the durable Task detail still names the Subagents.
    await page.route(
      (url) => url.origin === new URL(a.base).origin && url.pathname === "/api/tasks",
      async (route) => {
        const response = await route.fetch();
        const catalog = await response.json();
        catalog.tasks = catalog.tasks.map(({ activity: _activity, ...task }) => task);
        await route.fulfill({ response, json: catalog });
      }
    );
    await page.addInitScript(
      ([key, records]) => localStorage.setItem(key, JSON.stringify(records)),
      ["formicand.nodes.v1", [{ origin: new URL(b.base).origin, name: "云端", role: "internal" }]]
    );

    await page.goto(a.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    await page.getByRole("tab", { name: "观测", exact: true }).click();
    await page.locator('[data-observe-view="runs"]').click();

    // The node without activity is marked, and its lanes carry stage blocks.
    const degraded = page.locator("[data-runs-degraded]");
    await expect(degraded).toBeVisible({ timeout: 20_000 });
    await expect(degraded).toContainText("指标未就绪");
    await expect(page.locator("[data-runs-live]")).toBeHidden();

    const localCard = page.locator(`[data-runs-node="${a.base}"]`);
    const degradedLane = localCard.locator(`[data-runs-lane="${withoutMetrics.taskId}"]`);
    await expect(degradedLane).toHaveAttribute("data-degraded", "true", { timeout: 20_000 });
    await expect(degradedLane).toHaveAttribute("data-stage", "review");
    await expect(degradedLane.locator(".runs-block.is-review")).toHaveCount(1);
    await expect(degradedLane.locator(".runs-pulse")).toHaveCount(0);
    await expect(degradedLane).toContainText("24 分");

    // Subagent branches survive without the activity payload.
    const executor = localCard.locator('[data-runs-agent="subagent_1"]');
    await expect(executor).toContainText("Executor");
    await expect(executor).toContainText("Ara");
    await expect(executor).toContainText("已完成");
    await expect(executor.locator(".runs-block.is-dev")).toHaveCount(1);
    await expect(executor.locator(".runs-done")).toHaveCount(1);
    const reviewer = localCard.locator('[data-runs-agent="subagent_3"]');
    await expect(reviewer).toContainText("Reviewer");
    await expect(reviewer).toContainText("Circinus");
    await expect(reviewer.locator(".runs-block.is-review")).toHaveCount(1);
    await expect(reviewer.locator(".runs-head.is-review")).toHaveCount(1);

    // A node that does publish activity keeps its pulse and stage pill.
    const cloudCard = page.locator(`[data-runs-node="${b.base}"]`);
    const liveLane = cloudCard.locator(`[data-runs-lane="${withMetrics.taskId}"]`);
    await expect(liveLane).toHaveCount(1, { timeout: 20_000 });
    await expect(liveLane).toHaveAttribute("data-degraded", "false");
    await expect(liveLane.locator(".runs-pulse.is-dev")).toHaveCount(1);
    await expect(liveLane.locator(".runs-head")).toHaveCount(1);
    await expect(page.locator('[data-observe-panel="runs"]')).toHaveAttribute("data-motion", "live");

    const headAnimation = () =>
      liveLane.locator(".runs-head").evaluate((node) => getComputedStyle(node).animationName);
    await expect.poll(headAnimation).toBe("runs-head-pulse");

    // Reduced motion turns the wave into a static snapshot refreshed on a timer.
    await page.emulateMedia({ reducedMotion: "reduce" });
    const runs = page.locator('[data-observe-panel="runs"]');
    await expect(runs).toHaveAttribute("data-motion", "reduced");
    await expect(runs).toHaveAttribute("data-refresh-ms", "5000");
    await expect.poll(headAnimation).toBe("none");
    const renderedAt = await runs.getAttribute("data-rendered-at");
    await expect.poll(() => runs.getAttribute("data-rendered-at"), { timeout: 12_000 }).not.toBe(renderedAt);

    // User actions still switch the snapshot's window immediately.
    await page.locator('[data-runs-window="5"]').click();
    await expect(runs).toHaveAttribute("data-window", "5");
    await expect(page.locator(".runs-axis")).toContainText("-5 分");
    await expect(degradedLane).toHaveAttribute("data-degraded", "true");

    // Leaving reduced motion returns to the live view.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(runs).toHaveAttribute("data-motion", "live");
    await expect.poll(headAnimation).toBe("runs-head-pulse");
  } finally {
    await b?.stop();
    await a.stop();
  }
});
