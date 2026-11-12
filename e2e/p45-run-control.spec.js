import { test, expect } from "@playwright/test";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { startConfiguredDashboard, startDashboard } from "../test/dashboard-fixture.mjs";
import { readFixtureRequestBody } from "../test/http-request-body-fixture.mjs";
import { createTask, markTaskRunning } from "./p45-work-helpers.js";
import { seedRequirement } from "./p45-requirement-fixture.js";

function stream(response, delta, finishReason = null) {
  response.write(
    `data: ${JSON.stringify({
      id: "p45-run-control-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    })}\n\n`
  );
}
function complete(response, text) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  stream(response, { role: "assistant", content: text });
  stream(response, {}, "stop");
  response.end("data: [DONE]\n\n");
}
function toolCall(response, { id, command }) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  stream(response, { role: "assistant" });
  stream(response, {
    tool_calls: [
      {
        index: 0,
        id,
        type: "function",
        function: { name: "bash", arguments: JSON.stringify({ command }) }
      }
    ]
  });
  stream(response, {}, "tool_calls");
  response.end("data: [DONE]\n\n");
}
const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

async function setup(handle) {
  const requests = [];
  let dashboard;
  const provider = createServer(async (request, response) => {
    try {
      const raw = await readFixtureRequestBody(request);
      if (request.method !== "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "fixture-model" }, { id: "fixture-alt" }] }));
        return;
      }
      const body = JSON.parse(raw);
      requests.push(body);
      await handle({ body, response, requests });
    } catch (error) {
      response.destroy(error);
    }
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  dashboard = await startDashboard({
    modelEndpoint: `http://127.0.0.1:${provider.address().port}`,
    model: "fixture-model"
  });
  await mkdir(join(dashboard.root, "pi"), { recursive: true });
  await writeFile(join(dashboard.root, "pi", "settings.json"), JSON.stringify({ retry: { baseDelayMs: 1 } }));
  const stop = async () => {
    await dashboard.stop();
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
  };
  return { ...dashboard, requests, stop };
}

async function taskState(page, dashboard, taskId) {
  const response = await page.request.get(`${dashboard.base}/api/tasks/${taskId}`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function waitForTask(page, dashboard, taskId, predicate) {
  await expect.poll(async () => predicate(await taskState(page, dashboard, taskId))).toBe(true);
}

test("the run bar pauses at the step boundary and continues from that point", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const work = {};
  const local = await setup(({ response, requests }) => {
    if (requests.length === 1) {
      toolCall(response, {
        id: "browser-pause-step",
        command: `mkdir -p ${shellQuote(join(work.task, "agents", "main", "work"))}; printf 'started' > ${shellQuote(join(work.task, "agents", "main", "work", "started"))}; sleep 1.2; printf 'step-1\\n' >> ${shellQuote(work.marker)}`
      });
      return;
    }
    complete(response, "已从暂停处继续。");
  });
  try {
    const taskId = "browser-pause";
    await createTask(page, local, { taskId, goal: "先记录第一步，再停下来", projectId: local.projectId });
    work.task = join(local.workspaceRoot, taskId);
    work.marker = join(work.task, "agents", "main", "work", "steps.txt");
    await page.goto(local.base);
    await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
    await page.locator("#composer-input").fill("先记录第一步，再停下来。");
    await page.locator("#send-button").click();

    const bar = page.locator("#run-control");
    await expect(bar).toBeVisible();
    await expect(bar.locator("[data-run-label]")).toContainText("Main 正在工作");
    await expect(bar.locator("[data-run-time]")).toHaveText(/\d\d:\d\d/);
    await expect(bar.locator("[data-run-step]")).toHaveText("第 1 步");
    await expect(bar.getByRole("button", { name: "暂停" })).toBeVisible();
    // Stopping moved to the composer's stop key; the strip only pauses.
    await expect(bar.getByRole("button", { name: "取消运行" })).toHaveCount(0);
    await expect(page.locator("#stop-button")).toBeVisible();
    await expect
      .poll(async () =>
        readFile(join(work.task, "agents", "main", "work", "started"), "utf8").catch(() => "")
      )
      .not.toBe("");
    await page.screenshot({ path: testInfo.outputPath("run-active-1440.png") });

    await bar.getByRole("button", { name: "暂停" }).click();
    // The paused round keeps the strip, amber, with 继续 as its one action.
    const paused = page.locator("#run-control[data-run-paused]");
    await expect(paused).toBeVisible({ timeout: 30_000 });
    await expect(paused.locator("[data-run-label]")).toHaveText("已暂停");
    await expect(paused.locator("[data-run-detail]")).toHaveText("停在第 1 步之后");
    await expect(page.locator(".request-error")).toHaveCount(0);
    await expect(paused.getByRole("button", { name: "继续" })).toBeVisible();
    await expect(paused.getByRole("button", { name: "暂停" })).toBeHidden();
    await expect(page.locator(".run-paused")).toHaveCount(0);
    await waitForTask(page, local, taskId, (detail) => detail.task.status === "paused");
    expect(local.requests).toHaveLength(1);
    expect(await readFile(work.marker, "utf8")).toBe("step-1\n");
    await page.screenshot({ path: testInfo.outputPath("run-paused-1440.png") });
    await page.evaluate(() => localStorage.setItem("atria.appearance", "light"));
    await page.reload();
    await expect(paused).toBeVisible();
    await expect(paused).toContainText("已暂停");
    await expect(page.locator(".chat-message.user")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("run-paused-light-1440.png") });
    await page.evaluate(() => localStorage.setItem("atria.appearance", "dark"));
    await page.reload();
    await expect(paused).toBeVisible();

    await paused.getByRole("button", { name: "继续" }).click();
    await waitForTask(page, local, taskId, (detail) => detail.task.status === "completed");
    await expect(bar).toBeHidden();
    await expect(paused).toHaveCount(0);
    expect(local.requests).toHaveLength(2);
    expect(await readFile(work.marker, "utf8")).toBe("step-1\n");
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await local.stop();
  }
});

test("the run bar names the requirement phase the panel records", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const work = {};
  const local = await setup(({ response, requests }) => {
    if (requests.length === 1) {
      toolCall(response, {
        id: "browser-stage-step",
        command: `mkdir -p ${shellQuote(join(work.task, "agents", "main", "work"))}; sleep 2`
      });
      return;
    }
    complete(response, "审查阶段完成。");
  });
  try {
    const seeded = await seedRequirement(page, local, local.project, {
      title: "评分汇总验收",
      phase: "review"
    });
    const taskId = seeded.session.taskId;
    work.task = join(local.workspaceRoot, taskId);
    await page.goto(local.base);
    await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
    await page.locator("#composer-input").fill("开始审查这一需求。");
    await page.locator("#send-button").click();
    const bar = page.locator("#run-control");
    await expect(bar).toBeVisible();
    await expect(bar.locator("[data-run-detail]")).toContainText("审查", { timeout: 20_000 });
    await expect(bar.locator("[data-run-label]")).toHaveText("Main 正在工作");
    await page.screenshot({ path: testInfo.outputPath("run-stage-1440.png") });
    await waitForTask(page, local, taskId, (detail) => detail.task.status === "completed");
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await local.stop();
  }
});

test("cancel asks before it stops the run and keeps the run on 继续运行", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const work = {};
  const local = await setup(({ response, requests }) => {
    if (requests.length === 1) {
      toolCall(response, {
        id: "browser-cancel-step",
        command: `mkdir -p ${shellQuote(join(work.task, "agents", "main", "work"))}; sleep 10`
      });
      return;
    }
    complete(response, "不应到达的回复。");
  });
  try {
    const taskId = "browser-cancel";
    await createTask(page, local, { taskId, goal: "取消前确认", projectId: local.projectId });
    work.task = join(local.workspaceRoot, taskId);
    await page.goto(local.base);
    await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
    await page.locator("#composer-input").fill("取消前确认。");
    await page.locator("#send-button").click();

    const bar = page.locator("#run-control");
    await expect(bar).toBeVisible();
    await page.setViewportSize({ width: 360, height: 800 });
    await expect(bar).toBeVisible();
    await expect(bar.getByRole("button", { name: "暂停" })).toBeVisible();
    await expect(page.locator("#stop-button")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await page.screenshot({ path: testInfo.outputPath("run-bar-360.png") });
    await page.setViewportSize({ width: 1440, height: 900 });

    // The stop key asks first.
    const stop = page.locator("#stop-button");
    await expect(stop).toHaveAccessibleName("取消运行");
    await stop.click();
    const dialog = page.locator("#run-cancel-confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("取消这次运行？");
    await expect(dialog).toContainText("已完成的步骤和文件改动会保留");
    await expect(dialog.getByRole("button")).toHaveCount(2);
    await expect(dialog.getByRole("button", { name: "继续运行" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "取消运行" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("cancel-confirm-1440.png") });

    await dialog.getByRole("button", { name: "继续运行" }).click();
    await expect(dialog).toBeHidden();
    await expect(stop).toBeFocused();
    await expect(bar).toBeVisible();
    await waitForTask(page, local, taskId, (detail) => detail.task.status === "running");

    await stop.click();
    await dialog.getByRole("button", { name: "取消运行" }).click();
    await expect(bar).toBeHidden({ timeout: 30_000 });
    await waitForTask(page, local, taskId, (detail) => detail.task.status === "cancelled");
    await expect(page.locator("#toast")).toContainText("任务已停止");
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await local.stop();
  }
});

test("an interrupted step continues once and the error card offers another model", async ({
  page
}, testInfo) => {
  test.setTimeout(150_000);
  const work = { recovered: false };
  const local = await setup(({ response, requests }) => {
    if (requests.length === 1) {
      toolCall(response, {
        id: "browser-recover-step",
        command: `mkdir -p ${shellQuote(join(work.task, "agents", "main", "work"))}; printf 'done\\n' >> ${shellQuote(work.marker)}`
      });
      return;
    }
    if (requests.length === 2) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "synthetic unavailable" } }));
      return;
    }
    if (!work.recovered) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "synthetic invalid request", type: "invalid_request" } })
      );
      return;
    }
    complete(response, "已在原步骤处继续。");
  });
  try {
    const taskId = "browser-recovery";
    await createTask(page, local, { taskId, goal: "中断后继续", projectId: local.projectId });
    work.task = join(local.workspaceRoot, taskId);
    work.marker = join(work.task, "agents", "main", "work", "effect.txt");
    await page.goto(local.base);
    await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
    await page.locator("#composer-input").fill("中断后继续。");
    await page.locator("#send-button").click();

    const error = page.locator(".request-error");
    await expect(error).toBeVisible({ timeout: 60_000 });
    await expect(error.locator(".run-error-head strong")).toHaveText("模型请求未完成");
    await expect(error.locator(".run-error-retry")).toContainText("已自动重试");
    await expect(error.getByRole("button", { name: "从中断步骤继续" })).toBeVisible();
    await expect(error.getByRole("button", { name: "切换模型" })).toBeVisible();
    const details = error.getByRole("button", { name: "查看错误详情" });
    await expect(error.locator("[data-error-detail]")).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("run-error-collapsed-1440.png") });
    await details.click();
    await expect(error.locator("[data-error-detail]")).toBeVisible();
    await expect(error.locator("[data-error-type]")).toContainText("HTTP 400");
    await page.screenshot({ path: testInfo.outputPath("run-error-1440.png") });

    await error.getByRole("button", { name: "切换模型" }).click();
    const menu = page.locator("#model-menu");
    await expect(menu).toBeVisible();
    await menu.locator('[data-model="fixture-alt"]').click();
    await expect(page.locator("#model-select .model-name")).toHaveText("fixture-alt");
    await expect(error).toBeVisible();

    work.recovered = true;
    await error.getByRole("button", { name: "从中断步骤继续" }).click();
    await waitForTask(page, local, taskId, (detail) => detail.task.status === "completed");
    await expect(error).toHaveCount(0);
    expect(await readFile(work.marker, "utf8")).toBe("done\n");
    const replay = local.requests.at(-1);
    expect(
      replay.messages.some(
        (message) => message.role === "tool" && message.tool_call_id === "browser-recover-step"
      )
    ).toBe(true);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await local.stop();
  }
});

test("while Main waits the strip names the Subagents it waits for, and the model button holds the effort", async ({
  page
}) => {
  const dashboard = await startConfiguredDashboard();
  try {
    const taskId = "strip-waiting";
    await createTask(page, dashboard, { taskId, goal: "等待子代理", projectId: dashboard.projectId });
    await markTaskRunning(dashboard, {
      taskId,
      runId: "run-strip",
      subagents: [
        { agentId: "subagent_1", role: "executor", state: "running" },
        { agentId: "subagent_2", role: "reviewer", state: "completed" }
      ]
    });
    // The runtime flag is process state; stand in for a live Main.
    await page.route(`**/api/tasks/${taskId}`, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const response = await route.fetch();
      const detail = await response.json();
      await route.fulfill({ response, json: { ...detail, runtime: { ...detail.runtime, active: true } } });
    });
    await page.goto(`${dashboard.base}/?task=${taskId}`);
    const bar = page.locator("#run-control");
    await expect(bar).toBeVisible();
    await expect(bar.locator("[data-run-label]")).toHaveText("等待子代理");
    const name = await page.locator('.subagent-row[data-agent="subagent_1"] .subagent-name').textContent();
    await expect(bar.locator("[data-run-detail]")).toHaveText(name.trim());
    // No command text is shown, and the strip offers no second cancel.
    await expect(bar.getByRole("button", { name: "取消运行" })).toHaveCount(0);

    // One button and one menu hold both the model and the reasoning effort.
    await expect(page.locator("#reasoning-select")).toHaveCount(0);
    await page.locator("#model-select").click();
    const menu = page.locator("#model-menu");
    await expect(menu.locator(".effort-rail")).toBeFocused();
    await expect(menu.locator("[data-thinking-level]")).toHaveCount(6);
    await menu.locator('[data-thinking-level="medium"]').click();
    await expect(page.locator("#model-select .reasoning-name")).toHaveText("中");
    // The pick applies at once and the popover stays open until Esc.
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(page.locator("#model-select")).toBeFocused();
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await dashboard.stop();
  }
});
