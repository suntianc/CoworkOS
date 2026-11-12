import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

for (const slowModels of [true, false]) {
  test(
    slowModels
      ? "connection default survives delayed model discovery and old conversations"
      : "a manually picked model becomes the default for the next new conversation",
    async ({ page }) => {
      const dashboard = await startDashboard();
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let modelsStarted = false;
      try {
        const saved = await page.request.post(`${dashboard.base}/api/model-settings`, {
          data: { baseUrl: "http://127.0.0.1:1/v1", model: "new-default", apiKey: "local-fixture" }
        });
        expect(saved.ok()).toBe(true);
        const profile = await saved.json();
        for (const taskId of ["old-a", "old-b"]) {
          await page.request.post(`${dashboard.base}/api/tasks`, { data: { taskId, goal: taskId } });
          await page.route(`**/api/tasks/${taskId}`, async (route) => {
            const response = await route.fetch();
            const detail = await response.json();
            await route.fulfill({
              response,
              json: {
                ...detail,
                task: { ...detail.task, model: "old-model" },
                messages: [{ role: "user", content: `历史消息 ${taskId}` }]
              }
            });
          });
        }
        await page.route("**/api/models", async (route) => {
          modelsStarted = true;
          if (slowModels) await gate;
          await route.fulfill({
            json: {
              configured: true,
              current: "new-default",
              connectionProfileId: profile.activeProfileId,
              models: ["new-default", "old-model"]
            }
          });
        });
        let submitted;
        await page.route("**/run", (route) => {
          submitted = route.request().postDataJSON();
          return route.fulfill({ status: 202, json: { runId: "fixture-run", model: submitted.model } });
        });
        await page.goto(dashboard.base);
        await expect.poll(() => modelsStarted).toBe(true);
        for (const taskId of ["old-a", "old-b"]) {
          await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
          await expect(page.locator("#topbar-task")).toHaveText(taskId);
          await expect(page.locator("#conversation")).toContainText(`历史消息 ${taskId}`);
          await expect(page.locator(".model-name")).toHaveText("new-default", { timeout: 2000 });
        }
        if (!slowModels) {
          await page.locator("#model-select").click();
          // The popover opens on the reasoning rail; the model list is its second page.
          await page.locator("#model-menu .effort-model").click();
          await page.locator('[data-model="old-model"]').click();
          await expect(page.locator(".model-name")).toHaveText("old-model");
        }
        await page.locator("#new-conversation").click();
        await expect(page.locator(".model-name")).toHaveText(slowModels ? "new-default" : "old-model", {
          timeout: 2000
        });
        await page.locator("#composer-input").fill("使用新建对话的默认模型");
        await page.locator("#send-button").click();
        await expect.poll(() => submitted?.model).toBe(slowModels ? "new-default" : "old-model");
        if (!slowModels) {
          await page.locator('.conversation-item[data-task="old-b"]').click();
          await expect(page.locator(".model-name")).toHaveText("old-model");
        }
      } finally {
        release();
        await page.unrouteAll({ behavior: "wait" });
        await dashboard.stop();
      }
    }
  );
}
