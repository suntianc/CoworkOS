import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { openModelConnectionEditor } from "./settings-helper.js";

test("model test locks its input snapshot and keeps the pending state when reopened", async ({ page }) => {
  const dashboard = await startDashboard();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let submitted;
  await page.route("**/api/model-settings/test", async (route) => {
    submitted = route.request().postDataJSON();
    await pending;
    await route.fulfill({ json: { ok: true, supportsImages: false, durationMs: 120 } });
  });
  try {
    await page.goto(dashboard.base);
    await page.locator("#model-setup-button").click();
    const dialog = page.getByRole("dialog", { name: "连接模型" });
    await dialog.getByRole("textbox", { name: "API 地址", exact: true }).fill("https://example.com/v1");
    await dialog.getByRole("textbox", { name: "模型 ID", exact: true }).fill("busy-fixture");
    await dialog.locator('[name="apiKey"]').fill("synthetic-ui-key");
    await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
    await expect(dialog.locator('[name="model"]')).toBeDisabled();
    await expect(dialog.locator('[name="apiKey"]')).toBeDisabled();
    await expect(dialog.locator('[name="reasoningEffort"]')).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "保存连接", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
    await page.locator("#model-setup-button").click();
    await expect(dialog.locator('[name="model"]')).toHaveValue("busy-fixture");
    await expect(dialog.locator('[name="model"]')).toBeDisabled();
    release();
    await expect(dialog.locator("[data-model-result]")).toContainText("连接通过");
    await expect(dialog.locator('[name="model"]')).toBeEnabled();
    expect(submitted.model).toBe("busy-fixture");
    expect(submitted.apiKey).toBe("synthetic-ui-key");
    expect(submitted.mainMaxTokens).toBe(8192);
    expect(submitted.subagentMaxTokens).toBe(8192);
    expect(submitted.supportsReasoningEffort).toBe(false);
    await dialog.locator('[name="model"]').fill("changed-fixture");
    await expect(dialog.locator("[data-model-result]")).toContainText("配置已修改");
  } finally {
    release();
    await dashboard.stop();
  }
});

test("advanced connection parameters round-trip without losing a key and invalid limits keep the form", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await page.locator("#model-setup-button").click();
    const dialog = page.getByRole("dialog", { name: "连接模型" });
    await dialog.locator('[name="baseUrl"]').fill("https://fixture.example/v1");
    await dialog.locator('[name="model"]').fill("advanced-fixture");
    await dialog.locator('[name="apiKey"]').fill("private-ui-fixture");
    await dialog.locator("summary").click();
    await dialog.locator('[name="supportsReasoningEffort"]').check();
    await dialog.locator('[name="reasoningEffort"]').selectOption("low");
    await dialog.locator('[name="mainMaxTokens"]').fill("4096");
    await dialog.locator('[name="subagentMaxTokens"]').fill("2048");
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog).toBeHidden();
    await openModelConnectionEditor(page);
    await expect(dialog.locator('[name="apiKey"]')).toHaveValue("");
    await expect(dialog.locator('[name="reasoningEffort"]')).toHaveValue("low");
    await expect(dialog.locator('[name="mainMaxTokens"]')).toHaveValue("4096");
    await expect(dialog.locator('[name="subagentMaxTokens"]')).toHaveValue("2048");
    await dialog.locator('[name="mainMaxTokens"]').fill("0");
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog).toBeVisible();
    const response = await page.request.get(`${dashboard.base}/api/model-settings`);
    expect((await response.json()).mainMaxTokens).toBe(4096);
  } finally {
    await dashboard.stop();
  }
});

test("configured connections remain manageable from personal settings with correct modal focus", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    const saved = await page.request.post(`${dashboard.base}/api/model-settings`, {
      data: {
        baseUrl: "http://127.0.0.1:1/v1",
        model: "configured-fixture",
        apiKey: "synthetic-configured-key"
      }
    });
    expect(saved.ok()).toBe(true);
    await page.goto(dashboard.base);
    await expect(page.locator("#model-setup-button")).toBeHidden();
    const connection = await openModelConnectionEditor(page);
    await expect(connection).toBeVisible();
    await expect(connection.locator('[name="model"]')).toHaveValue("configured-fixture");
    await expect(connection.locator('[name="apiKey"]')).toHaveValue("");
    await expect(connection.locator('[name="apiKey"]')).toHaveAttribute("placeholder", "留空保留已有密钥");
    await connection.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(connection).toBeHidden();
    // Closing the connection keeps the settings page it was opened from.
    await expect(page.locator("#settings-entry")).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.closest("#settings-entry") !== null)).toBe(true);
  } finally {
    await dashboard.stop();
  }
});

test("closing model setup preserves unsaved fields and a save failure keeps the task draft", async ({
  page
}) => {
  const dashboard = await startDashboard();
  let rejectSave = true;
  await page.route("**/api/model-settings", async (route) => {
    if (rejectSave && route.request().method() === "POST") {
      await route.fulfill({ status: 400, json: { error: "请先保存草稿或处理文档冲突，再修改模型连接" } });
    } else await route.continue();
  });
  try {
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("模型设置失败不能影响任务草稿");
    await page.locator("#model-setup-button").click();
    const dialog = page.getByRole("dialog", { name: "连接模型" });
    await expect(dialog.locator("[data-model-result]")).toContainText("测试连接会消耗模型额度");
    await dialog.locator('[name="baseUrl"]').fill("https://example.com/v1");
    await dialog.locator('[name="model"]').fill("keep-model-fields");
    await dialog.locator('[name="apiKey"]').fill("synthetic-unsaved-ui-key");
    await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
    await page.locator("#model-setup-button").click();
    await expect(dialog.locator('[name="model"]')).toHaveValue("keep-model-fields");
    await expect(dialog.locator('[name="apiKey"]')).toHaveValue("synthetic-unsaved-ui-key");
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog.locator("[data-model-error]")).toContainText("请先保存草稿");
    await expect(dialog.locator("[data-model-result]")).toHaveText(
      "保存未完成，当前输入已保留；请处理上方提示后重试。"
    );
    await expect(dialog.locator('[name="model"]')).toBeEnabled();
    await expect(dialog.getByRole("button", { name: "保存连接", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(page.locator("#composer-input")).toHaveValue("模型设置失败不能影响任务草稿");
    await page.locator("#model-setup-button").click();
    await expect(dialog.locator('[name="apiKey"]')).toHaveValue("synthetic-unsaved-ui-key");
    rejectSave = false;
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog).toBeHidden();
    const saved = await (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
    expect(saved.model).toBe("keep-model-fields");
    await expect(page.locator("#composer-input")).toHaveValue("模型设置失败不能影响任务草稿");
  } finally {
    await dashboard.stop();
  }
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 320, height: 568 }
]) {
  test(`expanded model settings remain scrollable and saveable at ${viewport.width}x${viewport.height}`, async ({
    page
  }) => {
    const dashboard = await startDashboard();
    try {
      await page.setViewportSize(viewport);
      await page.goto(dashboard.base);
      await page.locator("#model-setup-button").click();
      const dialog = page.getByRole("dialog", { name: "连接模型" });
      await dialog.locator('[name="baseUrl"]').fill("https://fixture.example/v1");
      await dialog.locator('[name="api"]').selectOption("openai-responses");
      await dialog.locator('[name="model"]').fill("scroll-fixture");
      await dialog.locator('[name="apiKey"]').fill("local-fixture");
      await dialog.locator("summary").click();
      await dialog.locator('[name="subagentMaxTokens"]').fill("2048");
      const rect = await dialog.boundingBox();
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height);
      await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
      await expect(dialog).toBeHidden();
      const result = await (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
      expect(result.api).toBe("openai-responses");
      expect(result.subagentMaxTokens).toBe(2048);
    } finally {
      await dashboard.stop();
    }
  });
}
