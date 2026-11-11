import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { openSettings } from "./settings-helper.js";
import { UserMemoryStore } from "../dist/src/runtime/user-memory-store.js";

test("memory use, independent learning and budgets survive restart without losing data", async ({
  page
}, testInfo) => {
  const dashboard = await startDashboard();
  const store = new UserMemoryStore(join(dashboard.root, "home", "memory", "user-memory.json"));
  try {
    await page.goto(dashboard.base);
    let dialog = await openSettings(page, "tools");
    const use = () => dialog.getByRole("checkbox", { name: "使用个人记忆", exact: true });
    const learning = () => dialog.getByRole("checkbox", { name: "自动学习", exact: true });
    const learningOptions = () => dialog.locator(".user-memory-learning-options");
    await expect(learning()).toBeHidden();
    await expect(learningOptions().locator("summary")).toContainText("已关闭");
    await learningOptions().locator("summary").click();
    await expect(use()).not.toBeChecked();
    await expect(learning()).not.toBeChecked();
    await expect(learning()).toBeDisabled();
    await expect(page.getByRole("button", { name: "管理记忆" })).toHaveCount(0);
    await use().check();
    await expect(use()).toBeChecked();
    expect((await store.read()).learningEnabled).toBe(false);
    await learning().check();
    await expect(learningOptions().locator("summary")).toContainText("已开启");
    expect((await store.read()).learningEnabled).toBe(true);
    await dialog.getByRole("textbox", { name: "后台模型", exact: true }).fill("background-small");
    await dialog.getByRole("spinbutton", { name: "单次输出上限", exact: true }).fill("1024");
    await dialog.getByRole("spinbutton", { name: "每小时请求上限", exact: true }).fill("4");
    await dialog.getByRole("button", { name: "保存学习设置", exact: true }).click();
    await expect(dialog.getByText("学习设置已保存", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("user-memory-inline.png"), fullPage: true });
    await dashboard.restart();
    await page.goto(dashboard.base);
    dialog = await openSettings(page, "tools");
    await expect(learningOptions().locator("summary")).toContainText("已开启");
    await learningOptions().locator("summary").click();
    await expect(learning()).toBeChecked();
    await expect(use()).toBeChecked();
    expect((await store.read()).learningOptions).toEqual({
      model: "background-small",
      maxTokens: 1024,
      maxRequestsPerHour: 4
    });
    await store.enqueueLearning({ taskId: "pending", runId: "r", text: "我平常写邮件喜欢简洁一些" });
    expect((await store.read()).pending.length).toBe(1);
    await learning().uncheck();
    await expect(learningOptions().locator("summary")).toContainText("已关闭");
    expect((await store.read()).pending.length).toBe(1);
    expect((await store.read()).learningEnabled).toBe(false);
    await expect(use()).toBeChecked();
    await use().uncheck();
    await expect(learning()).toBeDisabled();
    await use().check();
    await expect(learning()).not.toBeChecked();
    await learning().check();
    await dialog.getByRole("button", { name: "查看记忆", exact: true }).click();
    const memories = page.getByRole("dialog", { name: "个人记忆", exact: true });
    await expect(memories.getByRole("textbox", { name: "个人记忆内容", exact: true })).toBeVisible();
    await store.remember({
      content: "邮件偏好简洁",
      category: "preference",
      scope: "user",
      source: {
        taskId: "fixture",
        runId: "fixture-run",
        quote: "我平常写邮件喜欢简洁一些",
        origin: "explicit"
      }
    });
    await memories.getByRole("button", { name: "返回设置" }).click();
    await dialog.getByRole("button", { name: "查看记忆", exact: true }).click();
    const editor = memories.getByRole("textbox", { name: "个人记忆内容", exact: true });
    await expect(editor).toHaveValue("邮件偏好简洁");
    await editor.fill("我叫小林，技术问题先举例再解释");
    await memories.getByRole("button", { name: "保存记忆", exact: true }).click();
    await expect(memories.getByText("已保存", { exact: true })).toBeVisible();
    await memories.getByRole("button", { name: "返回设置" }).click();
    await dialog.getByRole("button", { name: "查看记忆", exact: true }).click();
    await expect(editor).toHaveValue("我叫小林，技术问题先举例再解释");
    await page.screenshot({ path: testInfo.outputPath("user-memory-details.png"), fullPage: true });
    await memories.getByRole("button", { name: "返回设置" }).click();
    await expect(learning()).toBeChecked();
    await page.setViewportSize({ width: 390, height: 844 });
    await learning().scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("user-memory-inline-mobile.png"), fullPage: true });
  } finally {
    await dashboard.stop();
  }
});
