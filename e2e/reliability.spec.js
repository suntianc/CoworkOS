import { splitUploadedFiles } from "../web/assets/uploaded-files.js";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("composer drafts and complete attachments survive conversations, refresh and rejection", async ({
  page
}) => {
  // A usable connection keeps the send action available; this test observes
  // draft and attachment recovery, not first-use setup.
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const task = await (
      await page.request.post(`${dashboard.base}/api/tasks`, {
        data: { taskId: "draft-task", goal: "原会话" }
      })
    ).json();
    await page.goto(dashboard.base);
    await expect(page.locator('.conversation-item[data-task="draft-task"]')).toBeVisible();
    await page.locator('.conversation-item[data-task="draft-task"]').click();
    await page.locator("#composer-input").fill("请保留这份未发送草稿");
    const text = "BEGIN\n" + "x".repeat(13000) + "\nEND_SENTINEL";
    await page
      .locator("#file-input")
      .setInputFiles({ name: "full.txt", mimeType: "text/plain", buffer: Buffer.from(text) });
    await expect(page.locator("#attachment-strip")).toContainText("已添加");
    await page.locator("#new-conversation").click();
    await expect(page.locator("#composer-input")).toHaveValue("");
    await page.locator("#composer-input").fill("新会话的独立草稿");
    await page.locator('.conversation-item[data-task="draft-task"]').click();
    await expect(page.locator("#composer-input")).toHaveValue("请保留这份未发送草稿");
    await expect(page.locator("#attachment-strip")).toContainText("full.txt");
    await page.reload();
    await expect(page.locator("#composer-input")).toHaveValue("请保留这份未发送草稿");
    await expect(page.locator("#attachment-strip")).toContainText("full.txt");
    await page
      .locator("#file-input")
      .setInputFiles({ name: "image.png", mimeType: "image/png", buffer: Buffer.from([137, 80, 0]) });
    await expect(page.locator("#toast")).toContainText("内容与扩展名不一致");
    await expect(page.locator("#attachment-strip")).toContainText("full.txt");
    await page.locator("#file-input").setInputFiles({
      name: "too-large.txt",
      mimeType: "text/plain",
      buffer: Buffer.alloc(25 * 1024 * 1024 + 1, 120)
    });
    await expect(page.locator("#toast")).toContainText("不能超过25 MB");
    await page.keyboard.press("Meta+k");
    await expect(page.locator("#composer-input")).toHaveValue("新会话的独立草稿");
    await page.reload();
    await expect(page.locator("#composer-input")).toHaveValue("新会话的独立草稿");
    await page.route("**/api/tasks", (route) => route.abort());
    await expect(page.locator("#connection-state")).toContainText("连接中断", { timeout: 10_000 });
    await expect(page.locator("#send-button")).toBeDisabled();
    await expect(page.locator("#composer-input")).toHaveValue("新会话的独立草稿");
    await page.unroute("**/api/tasks");
    await expect(page.locator("#connection-state")).toBeHidden({ timeout: 10_000 });
    await expect(page.locator("#send-button")).toBeEnabled();
    expect(task.taskId).toBe("draft-task");
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

for (const width of [1280, 1440, 474, 320])
  test(`composer controls remain reachable at ${width}px`, async ({ page }) => {
    const dashboard = await startDashboard();
    try {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(dashboard.base);
      await expect(page.locator("#app-bind-select")).toBeHidden();
      await expect(page.locator("#model-select")).toBeHidden();
      for (const configured of [false, true]) {
        if (configured) {
          await page.route("**/api/models", (route) =>
            route.fulfill({
              json: { configured: true, current: "layout-fixture", models: ["layout-fixture"] }
            })
          );
          await page.reload();
          await expect(page.locator("#model-setup-button")).toBeHidden();
        }
        for (const selector of [
          ".attach-button",
          configured ? "#model-select" : "#model-setup-button",
          "#send-button"
        ]) {
          await expect(page.locator(selector)).toBeVisible();
          const box = await page.locator(selector).boundingBox();
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
          expect(
            await page.locator(selector).evaluate((node) => {
              const r = node.getBoundingClientRect();
              return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
            })
          ).toBe(true);
        }
      }
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "添加文件", exact: true }).click();
      await (await chooser).setFiles([]);
    } finally {
      await dashboard.stop();
    }
  });

test("real Pi receives a complete attachment and steering; stop aborts inference and a new run works", async ({
  page
}) => {
  test.setTimeout(90_000);
  const requests = [];
  let hold = false,
    closedHeld = false;
  const provider = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.end('{"data":[]}');
      return;
    }
    let body = "";
    for await (const chunk of req.setEncoding("utf8")) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({ id: `r-${requests.length}`, object: "chat.completion.chunk", model: "browser-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      );
    send({ role: "assistant", reasoning_content: "检查文件内容及首尾。" });
    if (hold) {
      send({ reasoning_content: "正在等待隔离测试服务。" });
      res.on("close", () => {
        closedHeld = true;
      });
      return;
    }
    if (requests.length === 1) {
      const content = requests[0].messages.findLast((message) => message.role === "user").content;
      const text = typeof content === "string" ? content : content.map((part) => part.text || "").join("");
      const file = splitUploadedFiles(text).files[0];
      send({
        tool_calls: [
          {
            index: 0,
            id: "read-full-upload",
            type: "function",
            function: {
              name: "read_attachment",
              arguments: JSON.stringify({ id: file.uploadId, limit: 20000 })
            }
          }
        ]
      });
      send({}, "tool_calls");
      res.end("data: [DONE]\n\n");
      return;
    }
    send({ content: "完成，完整附件已接收。" });
    send({}, "stop");
    res.end("data: [DONE]\n\n");
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  let dashboard;
  try {
    dashboard = await startDashboard({ modelEndpoint: `http://127.0.0.1:${provider.address().port}/v1` });
    await page.goto(dashboard.base);
    await page.locator("#new-conversation").click();
    await page.locator("#composer-input").fill("检查完整附件");
    await page.locator("#file-input").setInputFiles({
      name: "full.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("BEGIN\n" + "x".repeat(13000) + "\nEND_SENTINEL")
    });
    await expect(page.locator("#attachment-strip")).toContainText("full.txt");
    await page.locator("#send-button").click();
    await expect(page.locator('[data-answer-kind="final"]')).toContainText("完成", { timeout: 30_000 });
    await expect(page.locator("#composer-input")).toBeFocused();
    expect(JSON.stringify(requests[1].messages)).toContain("END_SENTINEL");
    await expect(page.locator(".chat-message.user").first()).toContainText("full.txt");
    await expect(page.locator(".chat-message.user").first()).not.toContainText("atria_uploaded_files");
    await expect(page.locator(".execution-history")).not.toHaveAttribute("open");
    const taskId = await page.locator(".conversation-item.active").getAttribute("data-task");
    hold = true;
    await page.locator("#composer-input").fill("保持运行，测试补充和停止");
    await page.locator("#send-button").click();
    await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(3);
    await expect(page.locator("#composer-input")).toHaveValue("");
    await expect(page.locator("#composer-input")).toBeFocused();
    let releaseInterjection;
    let interjectionStarted = false;
    let followUp;
    const interjectionGate = new Promise((resolve) => {
      releaseInterjection = resolve;
    });
    await page.route("**/interject", async (route) => {
      interjectionStarted = true;
      followUp = route.request().postDataJSON();
      await interjectionGate;
      await route.continue();
    });
    await page.locator("#composer-input").fill("补充指令必须保留在记录里");
    await expect(page.locator("#stop-button")).toBeHidden();
    await expect(page.locator("#send-button")).toBeVisible();
    await page.locator("#send-button").click();
    await expect.poll(() => interjectionStarted).toBe(true);
    expect(followUp.delivery).toBe("followUp");
    await page.locator("#composer-input").fill("等待发送期间写的下一条草稿");
    releaseInterjection();
    await page.getByRole("button", { name: "立即发送：补充指令必须保留在记录里", exact: true }).click();
    await expect(page.locator(".chat-message.user").last()).toContainText("补充指令必须保留");
    await expect(page.locator("#composer-input")).toHaveValue("等待发送期间写的下一条草稿");
    await page.reload();
    await expect(page.locator(".chat-message.user").last()).toContainText("补充指令必须保留");
    await expect(page.locator("#composer-input")).toHaveValue("等待发送期间写的下一条草稿");
    await expect(page.locator("#stop-button")).toBeHidden();
    await expect(page.locator("#send-button")).toBeVisible();
    await page.locator(`.conversation-item[data-task="${taskId}"]`).hover();
    await page.locator(`[data-session-menu="${taskId}"]`).click();
    await page.locator('[data-session-action="stop"]').click();
    await expect(page.locator("#toast")).toContainText("任务已停止", { timeout: 10_000 });
    await expect(page.locator("#stop-button")).toBeHidden({ timeout: 10_000 });
    await expect(page.locator("#send-button")).toBeVisible();
    await expect(page.locator("#composer-input")).toHaveValue("等待发送期间写的下一条草稿");
    const detail = await (await page.request.get(`${dashboard.base}/api/tasks/${taskId}`)).json();
    expect(detail.task.status).toBe("cancelled");
    expect(detail.runtime.active).toBe(false);
    await expect.poll(() => closedHeld).toBe(true);
    hold = false;
    await page.locator("#new-conversation").click();
    await page.locator("#composer-input").fill("取消后可以开始新的任务");
    await page.locator("#send-button").click();
    await expect(page.locator('[data-answer-kind="final"]')).toContainText("完成", { timeout: 30_000 });
  } finally {
    await dashboard?.stop();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
});
