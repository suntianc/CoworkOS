import { test as base, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const taskId = "composer-focus-task";
const otherTaskId = "composer-focus-other";
const test = base.extend({
  dashboard: async ({}, use) => {
    const dashboard = await startDashboard();
    try {
      await use(dashboard);
    } finally {
      await dashboard.stop();
    }
  },
  page: async ({ page, dashboard }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const id of [taskId, otherTaskId])
      await page.request.post(`${dashboard.base}/api/tasks`, {
        data: { taskId: id, goal: id }
      });
    await page.route("**/api/models", (route) =>
      route.fulfill({
        json: { configured: true, current: "focus-fixture", models: ["focus-fixture"] }
      })
    );
    await page.goto(dashboard.base);
    await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
    await use(page);
    expect(errors).toEqual([]);
  }
});

async function runningTask(page, dashboard, { held = false } = {}) {
  const detail = await (await page.request.get(`${dashboard.base}/api/tasks/${taskId}`)).json();
  let active = false;
  let started = false;
  let settled = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/tasks/${taskId}`, (route) =>
    route.fulfill({
      json: {
        ...detail,
        task: { ...detail.task, status: active ? "running" : "created" },
        runtime: { active }
      }
    })
  );
  await page.route(`**/api/tasks/${taskId}/run`, async (route) => {
    started = true;
    if (held) await gate;
    active = true;
    await route.fulfill({ json: { runId: "focus-run", model: "focus-fixture" } });
    settled = true;
  });
  await page.route(`**/api/tasks/${taskId}/interject`, (route) =>
    route.fulfill({ json: { messageId: "focus-interjection" } })
  );
  return { release, started: () => started, settled: () => settled };
}

test("a clicked send returns focus to the composer after an accepted run and queued follow-up", async ({
  page,
  dashboard
}) => {
  await runningTask(page, dashboard);
  const input = page.locator("#composer-input");
  await input.fill("启动合成任务");
  await page.locator("#send-button").click();
  await expect(page.locator("#send-button")).toBeHidden();
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await page.keyboard.type("补充一条合成指令");
  await page.locator("#send-button").click();
  await expect(page.locator("#queued-messages")).toContainText("补充一条合成指令");
  await expect(page.locator(".chat-message.user").last()).toContainText("启动合成任务");
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
});

test("a delayed send does not move focus out of the settings entry", async ({ page, dashboard }) => {
  const run = await runningTask(page, dashboard, { held: true });
  try {
    await page.locator("#composer-input").fill("响应前打开设置");
    await page.locator("#send-button").click();
    await expect.poll(run.started).toBe(true);
    await page.locator("#user-menu-button").click();
    const section = page.locator('[data-settings-section="general"]');
    await expect(section).toBeFocused();
    run.release();
    await expect.poll(run.settled).toBe(true);
    await expect(section).toBeFocused();
    await expect(page.locator("#settings-entry")).toBeVisible();
    await expect(page.locator("#app-layout")).toBeHidden();
  } finally {
    run.release();
  }
});

for (const returnToOriginal of [false, true])
  test(`a delayed send preserves navigation focus and the ${returnToOriginal ? "revisited" : "other"} task draft`, async ({
    page,
    dashboard
  }) => {
    const run = await runningTask(page, dashboard, { held: true });
    try {
      const input = page.locator("#composer-input");
      await input.fill("原请求文本");
      await page.locator("#send-button").click();
      await expect.poll(run.started).toBe(true);
      await page.locator(`.conversation-item[data-task="${otherTaskId}"]`).click();
      if (returnToOriginal) await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
      await input.fill("导航后独立草稿");
      await page.locator("#model-select").focus();
      run.release();
      await expect(page.locator("#send-button")).toBeEnabled();
      await expect(input).toHaveValue("导航后独立草稿");
      await expect(page.locator("#model-select")).toBeFocused();
      await expect(page.locator(".conversation-item.active")).toHaveAttribute(
        "data-task",
        returnToOriginal ? taskId : otherTaskId
      );
    } finally {
      run.release();
    }
  });
