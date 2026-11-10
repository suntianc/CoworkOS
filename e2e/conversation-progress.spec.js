import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("follow-up opens an assistant message before inference and animates each thinking step", async ({
  page
}) => {
  test.setTimeout(90_000);
  let requestCount = 0;
  const gates = [0, 1].map(() => {
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    return { promise, release };
  });
  const errors = [];
  const provider = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.end('{"data":[]}');
      return;
    }
    for await (const _chunk of req) {
      /* drain request */
    }
    const current = ++requestCount;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({ id: `progress-${current}`, object: "chat.completion.chunk", model: "browser-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      );
    send({ role: "assistant" });
    if (current === 1) {
      send({ content: "第一轮回答已完成。" });
      send({}, "stop");
    } else if (current === 2) {
      send({ reasoning_content: "先查看可用应用。" });
      await gates[0].promise;
      send({
        tool_calls: [
          {
            index: 0,
            id: "inspect-apps",
            type: "function",
            function: { name: "list_applications", arguments: "{}" }
          }
        ]
      });
      send({}, "tool_calls");
    } else {
      send({ reasoning_content: "根据应用信息继续思考。" });
      await gates[1].promise;
      send({ content: "追问回答已完成。" });
      send({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  let dashboard, releaseSubmission;
  try {
    dashboard = await startDashboard({ modelEndpoint: `http://127.0.0.1:${provider.address().port}/v1` });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
    await page.goto(dashboard.base);
    await page.locator("#new-conversation").click();
    await page.locator("#composer-input").fill("先回答一次");
    await page.locator("#send-button").click();
    await expect(page.locator('[data-answer-kind="final"]')).toContainText("第一轮回答已完成。", {
      timeout: 30_000
    });
    const holdSubmission = new Promise((resolve) => {
      releaseSubmission = resolve;
    });
    await page.route("**/api/tasks/*/run", async (route) => {
      await holdSubmission;
      await route.continue();
    });
    await page.locator("#composer-input").fill("继续追问，看看应用");
    await page.locator("#send-button").click();
    const pending = page.locator('[data-answer-kind="pending"]');
    await expect(pending).toContainText("正在思考…");
    await expect(pending.locator(".thinking-spinner")).toBeVisible();
    await expect(page.locator('[data-answer-kind="final"]')).toContainText("第一轮回答已完成。");
    await expect(page.locator(".chat-message.user").last()).toContainText("继续追问");
    expect(requestCount).toBe(1);
    expect(
      await pending.locator(".thinking-spinner").evaluate((el) => getComputedStyle(el).animationName)
    ).toBe("ui-spin");
    releaseSubmission();
    await expect(pending.locator(".reasoning-step")).toContainText("先查看可用应用。", { timeout: 30_000 });
    await expect(pending.locator(".reasoning-step .thinking-spinner")).toHaveCount(1);
    gates[0].release();
    await expect(pending.locator(".reasoning-step")).toHaveCount(2, { timeout: 30_000 });
    await expect(pending.locator(".reasoning-step").first()).toContainText("思考完成");
    await expect(pending.locator(".reasoning-step").first().locator(".thinking-spinner")).toHaveCount(0);
    await expect(pending.locator(".reasoning-step").last().locator(".thinking-spinner")).toBeVisible();
    gates[1].release();
    await expect(page.locator('[data-answer-kind="final"]').last()).toContainText("追问回答已完成。", {
      timeout: 30_000
    });
    await expect(pending).toHaveCount(0);
    await expect(page.locator("#conversation .thinking-spinner")).toHaveCount(0);
    await page.route("**/api/tasks/*/run", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"测试发送失败"}' })
    );
    await page.locator("#composer-input").fill("失败后保留草稿");
    await page.locator("#send-button").click();
    await expect(page.locator("#toast")).toContainText("发送失败");
    await expect(pending).toHaveCount(0);
    await expect(page.locator("#composer-input")).toHaveValue("失败后保留草稿");
    await expect(page.locator(".chat-message.user")).toHaveCount(2);
    expect(errors).toEqual([]);
  } finally {
    releaseSubmission?.();
    gates.forEach((gate) => gate.release());
    await dashboard?.stop();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
});
