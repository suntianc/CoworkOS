import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("model setup tests credentials before saving and retains image support settings and the task draft", async ({
  page
}) => {
  let failure = true;
  const requests = [];
  const provider = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method !== "POST") return res.end('{"data":[{"id":"connection-fixture"}]}');
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    if (failure) {
      res.writeHead(401);
      return res.end('{"error":{"message":"private-test-key provider detail"}}');
    }
    res.setHeader("content-type", "text/event-stream");
    const send = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "connection", object: "chat.completion.chunk", created: 1, model: "connection-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      );
    send({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "connection-call",
          type: "function",
          function: {
            name: "atria_connection_check",
            arguments: JSON.stringify({ status: "connected", color: "none", code: "none" })
          }
        }
      ]
    });
    send({}, "tool_calls");
    res.end("data: [DONE]\n\n");
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const dashboard = await startDashboard();
  try {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("测试连接不会丢失任务草稿");
    await page.locator("#model-setup-button").click();
    const dialog = page.getByRole("dialog", { name: "连接模型" });
    await dialog
      .getByRole("textbox", { name: "API 地址", exact: true })
      .fill(`http://127.0.0.1:${provider.address().port}`);
    await dialog.getByRole("textbox", { name: "模型 ID", exact: true }).fill("connection-fixture");
    await dialog.locator('[name="apiKey"]').fill("private-test-key");
    await dialog.locator('[name="api"]').selectOption("openai-completions");
    await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
    await expect(dialog.locator("[data-model-error]")).toContainText("认证失败");
    await expect(dialog).not.toContainText("private-test-key provider detail");
    expect((await (await page.request.get(`${dashboard.base}/api/model-settings`)).json()).configured).toBe(
      false
    );
    failure = false;
    await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
    await expect(dialog.locator("[data-model-result]")).toContainText("连接通过");
    expect(requests[1].stream).toBe(true);
    expect(requests[1].max_completion_tokens).toBe(8192);
    expect(requests[1].reasoning_effort).toBeUndefined();
    expect(
      requests[1].messages
        .find((message) => message.role === "user")
        .content.some((block) => block.type === "image_url")
    ).toBe(false);
    await dialog.getByRole("checkbox", { name: "此模型支持图像输入" }).check();
    await page.setViewportSize({ width: 320, height: 720 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("#composer-input")).toHaveValue("测试连接不会丢失任务草稿");
    const status = await (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
    expect(status.supportsImages).toBe(true);
    expect(status).not.toHaveProperty("apiKey");
    expect(JSON.parse(await readFile(join(dashboard.root, "config.json"), "utf8")).model).toBe(
      "connection-fixture"
    );
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
});
