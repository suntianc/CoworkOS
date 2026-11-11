import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { protocolStream } from "../test/model-protocol-fixture.mjs";

test("real retries announce HTTP failure and a stopped request never becomes completed after follow-up/reload", async ({
  page
}) => {
  test.setTimeout(90000);
  let requests = 0,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const provider = createServer(async (req, res) => {
    for await (const _ of req) {
      /* drain */
    }
    if (req.method !== "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "browser-fixture" }] }));
      return;
    }
    const n = ++requests;
    if (n === 1) {
      res.writeHead(524, { "content-type": "application/json" });
      res.end('{"error":{"message":"524 gateway timeout"}}');
      return;
    }
    if (n === 2) {
      await gate;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(protocolStream("openai-completions", { text: "重试后恢复成功。" }));
      return;
    }
    if (n === 3) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        "data: " +
          JSON.stringify({
            id: "held",
            object: "chat.completion.chunk",
            model: "browser-fixture",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "只输出了部分内容，尚未完成。" },
                finish_reason: null
              }
            ]
          }) +
          "\n\n"
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(protocolStream("openai-completions", { text: "后续请求完成。" }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  let dashboard;
  try {
    dashboard = await startDashboard({ modelEndpoint: `http://127.0.0.1:${provider.address().port}/v1` });
    await page.goto(dashboard.base);
    await page.locator("#new-conversation").click();
    const send = async (text) => {
      await page.locator("#composer-input").fill(text);
      await page.locator("#send-button").click();
    };
    await send("测试自动重试");
    await expect(page.locator(".request-retry")).toContainText("HTTP 524", { timeout: 30000 });
    await expect(page.locator(".request-retry")).toContainText("1 / 5");
    release();
    await expect(page.locator('[data-answer-kind="final"]')).toContainText("重试后恢复成功", {
      timeout: 30000
    });
    await expect(page.locator(".request-retry")).toHaveCount(0);
    await send("需要停止的请求");
    await expect(page.locator("#conversation")).toContainText("只输出了部分内容", { timeout: 30000 });
    await page.locator("#stop-button").click();
    await page.locator("#run-cancel-confirm").getByRole("button", { name: "取消运行" }).click();
    await expect(page.locator("#send-button")).toBeVisible();
    await send("继续新的请求");
    await expect(page.locator('[data-answer-kind="final"]').last()).toContainText("后续请求完成", {
      timeout: 30000
    });
    await page.reload();
    const stopped = page.locator(".live-workflow").filter({ hasText: "只输出了部分内容" });
    await expect(stopped).toContainText("执行已停止");
    await expect(stopped).toContainText("整轮任务未完成");
    await expect(stopped).not.toContainText("整轮任务已完成");
  } finally {
    release();
    await dashboard?.stop();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
});
