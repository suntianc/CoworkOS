import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { startDashboard } from "../test/dashboard-fixture.mjs";

async function seed(page, base, id, goal) {
  await page.request.post(`${base}/api/tasks`, { data: { taskId: id, goal } });
}

test("rename, pin, archive and restore keep the conversation identity and draft", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await seed(page, dashboard.base, "organized", "很长的初始请求".repeat(100));
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("会话组织不影响草稿");
    await page.getByRole("button", { name: "会话菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "重命名会话", exact: true }).click();
    await page.getByRole("textbox", { name: "会话名称" }).fill("本轮产品验收");
    await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator('.conversation-item[data-task="organized"]')).toContainText("本轮产品验收");
    await expect(page.locator("#composer-input")).toHaveValue("会话组织不影响草稿");
    await page.getByRole("button", { name: "会话菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "置顶会话", exact: true }).click();
    await expect(page.locator('.conversation-item[data-task="organized"]')).toContainText("★");
    await page.getByRole("button", { name: "会话菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "归档会话", exact: true }).click();
    await expect(page.locator('.conversation-item[data-task="organized"]')).toHaveCount(0);
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.locator("#task-search-input").fill("本轮产品验收");
    await page.locator(".search-result").click();
    await expect(page.locator("#composer-input")).toHaveValue("会话组织不影响草稿");
    await page.getByRole("button", { name: "会话菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "恢复会话", exact: true }).click();
    await expect(page.locator('.conversation-item[data-task="organized"]')).toBeVisible();
    const saved = await (await page.request.get(`${dashboard.base}/api/tasks/organized`)).json();
    expect(saved.task.title).toBe("本轮产品验收");
    expect(saved.task.archived).toBe(false);
    expect(saved.task.pinned).toBe(true);
  } finally {
    await dashboard.stop();
  }
});

test("unconfigured Web offers model setup and an authentication failure can be retried", async ({ page }) => {
  test.setTimeout(60_000);
  let fail = true,
    requests = 0;
  const provider = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.end('{"data":[{"id":"recovery-fixture"}]}');
      return;
    }
    for await (const _ of req) {
      /* drain */
    }
    requests++;
    if (fail) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":{"message":"private provider detail","type":"authentication_error"}}');
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: "retry", object: "chat.completion.chunk", model: "recovery-fixture", choices: [{ index: 0, delta: { role: "assistant", content: "重试成功" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
    );
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  let dashboard;
  try {
    dashboard = await startDashboard();
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("配置后再完成这条请求");
    await page.locator("#model-setup-button").click();
    await page
      .getByRole("textbox", { name: "API 地址", exact: true })
      .fill(`http://127.0.0.1:${provider.address().port}/v1`);
    await page.getByRole("textbox", { name: "模型 ID", exact: true }).fill("recovery-fixture");
    await page.locator('[name="apiKey"]').fill("synthetic-local-fixture-key");
    await page.locator('[name="api"]').selectOption("openai-completions");
    await page.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(page.locator("#model-setup-button")).toBeHidden();
    await expect(page.locator("#composer-input")).toHaveValue("配置后再完成这条请求");
    await page.locator("#send-button").click();
    await expect(page.locator(".request-error")).toContainText("模型连接认证失败", { timeout: 30_000 });
    await expect(page.locator(".request-error")).not.toContainText("private provider detail");
    fail = false;
    await page.getByRole("button", { name: "从中断步骤继续" }).click();
    await expect(page.locator('[data-answer-kind="final"]')).toContainText("重试成功", { timeout: 30_000 });
    expect(requests).toBe(2);
  } finally {
    await dashboard?.stop();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
});
