import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

test("steering reaches the next model call while queued input waits until the current work finishes", async ({
  page
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let releaseSteered;
  const steeredGate = new Promise((resolve) => {
    releaseSteered = resolve;
  });
  const provider = await modelProtocolFixture("openai-completions", async (_body, requests) => {
    if (requests.length === 1) {
      await gate;
      return { name: "bash", arguments: { command: "printf STEP_DONE" } };
    }
    if (requests.length === 2) await steeredGate;
    return { text: requests.length === 2 ? "当前任务已完成" : "排队请求已完成" };
  });
  const dashboard = await startDashboard({ modelEndpoint: provider.baseUrl });
  try {
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("开始当前任务");
    await page.locator("#send-button").click();
    await expect.poll(() => provider.requests.length).toBe(1);
    await expect(page.locator("#send-button")).toBeHidden();
    await expect(page.locator("#message-delivery")).toHaveCount(0);
    const id = await page.locator(".conversation-item.active").getAttribute("data-task");
    const invalid = await page.request.post(`${dashboard.base}/api/tasks/${id}/interject`, {
      data: { message: "不应接受", delivery: "invalid" }
    });
    expect(invalid.ok()).toBe(false);
    await page.locator("#composer-input").fill("QUEUED_REQUEST");
    await page.locator("#send-button").click();
    await expect(page.locator("#queued-messages")).toContainText("QUEUED_REQUEST");
    await page.reload();
    await expect(page.locator("#queued-messages")).toContainText("QUEUED_REQUEST");
    for (const width of [1440, 1280, 474, 320]) {
      await page.setViewportSize({ width, height: 700 });
      const box = await page.locator("#queued-messages").boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(700);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator("#composer-input").fill("STEER_REQUEST");
    await page.locator("#send-button").click();
    await expect(page.locator("#composer-input")).toHaveValue("");
    await page.reload();
    const promote = page.getByRole("button", { name: "立即发送：STEER_REQUEST", exact: true });
    await expect(promote).toBeVisible();
    await page.locator("#composer-input").fill("下一条未发送的草稿");
    await page.locator(".composer").screenshot({ path: ".tmp/message-queue-preview.png" });
    const messageId = await promote.getAttribute("data-promote-message");
    await promote.click();
    await expect(page.locator("#queued-messages")).not.toContainText("STEER_REQUEST");
    await expect(page.locator("#queued-messages")).toContainText("QUEUED_REQUEST");
    await expect(page.locator("#composer-input")).toHaveValue("下一条未发送的草稿");
    const duplicate = await page.request.post(
      `${dashboard.base}/api/tasks/${id}/interject/${messageId}/steer`
    );
    expect(duplicate.ok()).toBe(true);
    release();
    await expect.poll(() => provider.requests.length, { timeout: 20000 }).toBe(2);
    const steerRequest = provider.requests.find(({ body }) =>
      JSON.stringify(body.messages).includes("STEER_REQUEST")
    );
    expect(steerRequest).toBeTruthy();
    const next = JSON.stringify(steerRequest.body.messages);
    expect(next).toContain("STEER_REQUEST");
    expect(next).not.toContain("QUEUED_REQUEST");
    // The persisted Main context can quote the same text in the system prompt, so the
    // "delivered once" claim counts user turns rather than raw occurrences.
    expect(
      steerRequest.body.messages.filter(
        (message) => message.role === "user" && JSON.stringify(message).includes("STEER_REQUEST")
      )
    ).toHaveLength(1);
    // Steering drains only after the in-flight tool call returns, so the steer user turn
    // follows that call's result (docs/product-api.md, steering). Compare message
    // positions: the system prompt may quote both texts and must not decide the order.
    const messages = steerRequest.body.messages;
    const stepResult = messages.findIndex(
      (message) => message.role === "tool" && JSON.stringify(message).includes("STEP_DONE")
    );
    const steerTurn = messages.findIndex(
      (message) => message.role === "user" && JSON.stringify(message).includes("STEER_REQUEST")
    );
    expect(stepResult).toBeGreaterThan(-1);
    expect(steerTurn).toBeGreaterThan(stepResult);
    const instruction = page.locator(".chat-message.user").filter({ hasText: "STEER_REQUEST" });
    await expect(instruction).toHaveCount(1);
    await expect(page.locator('[data-answer-kind="continuation"] .tool-step')).toHaveCount(1);
    const assertOrder = async () => {
      expect(
        await page.locator("#conversation").evaluate((root) => {
          const activity = root.querySelector('[data-answer-kind="continuation"]');
          const input = [...root.querySelectorAll(".chat-message.user")].find((node) =>
            node.textContent.includes("STEER_REQUEST")
          );
          const continuing = root.querySelector('[data-answer-kind="pending"]');
          return Boolean(
            activity &&
            input &&
            continuing &&
            activity.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING &&
            input.compareDocumentPosition(continuing) & Node.DOCUMENT_POSITION_FOLLOWING
          );
        })
      ).toBe(true);
    };
    await assertOrder();
    await page.reload();
    await expect(instruction).toHaveCount(1);
    await expect(page.locator('[data-answer-kind="continuation"] .tool-step')).toHaveCount(1);
    await assertOrder();
    releaseSteered();
    await expect.poll(() => provider.requests.length, { timeout: 20000 }).toBe(3);
    const queued = JSON.stringify(provider.requests[2].body.messages);
    expect(queued).toContain("当前任务已完成");
    expect(queued).toContain("QUEUED_REQUEST");
    await expect(page.locator("#stop-button")).toBeHidden();
    await expect(page.locator("#queued-messages")).toBeHidden();
    await page.reload();
    await expect(page.locator("#conversation")).not.toContainText("等待当前任务结束");
    await expect(page.locator("#conversation")).toContainText("排队请求已完成");
    await expect(page.locator('[data-answer-kind="final"]')).toHaveCount(2);
    await expect(page.getByText("当前任务已完成", { exact: true })).toBeVisible();
    await expect(page.locator(".chat-message.user").filter({ hasText: "QUEUED_REQUEST" })).toHaveCount(1);
  } finally {
    release();
    releaseSteered();
    await dashboard.stop();
    await provider.close();
  }
});

test("stopped queued messages can be cancelled or sent once without losing the composer draft", async ({
  page
}) => {
  let releaseFirst, releaseSecond;
  const first = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const second = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  const provider = await modelProtocolFixture("openai-completions", async (_body, requests) => {
    if (requests.length === 1) await first;
    if (requests.length === 2) await second;
    return { text: "停止后的队列续发成功" };
  });
  const dashboard = await startDashboard({ modelEndpoint: provider.baseUrl });
  try {
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("START_BEFORE_STOP");
    await page.locator("#send-button").click();
    await expect.poll(() => provider.requests.length).toBe(1);
    const taskId = await page.locator(".conversation-item.active").getAttribute("data-task");
    for (const message of ["SEND_AFTER_STOP", "CANCEL_AFTER_STOP", "CANCEL_WHILE_RUNNING"]) {
      await page.locator("#composer-input").fill(message);
      await page.locator("#send-button").click();
      await expect(page.locator("#queued-messages")).toContainText(message);
    }
    await page.getByRole("button", { name: "取消排队：CANCEL_WHILE_RUNNING", exact: true }).click();
    await expect(page.locator("#queued-messages")).not.toContainText("CANCEL_WHILE_RUNNING");
    await page.locator("#stop-button").click();
    await expect(page.locator("#stop-button")).toBeHidden();
    releaseFirst();
    await page.reload();
    await expect(page.locator("#queued-messages")).toContainText("等待发送");
    const cancelled = page.getByRole("button", { name: "取消排队：CANCEL_AFTER_STOP", exact: true });
    const cancelId = await cancelled.getAttribute("data-cancel-message");
    await cancelled.click();
    await expect(page.locator("#queued-messages")).not.toContainText("CANCEL_AFTER_STOP");
    const again = await page.request.post(
      `${dashboard.base}/api/tasks/${taskId}/interject/${cancelId}/cancel`
    );
    expect(again.ok()).toBe(true);
    const cancelledSend = await page.request.post(
      `${dashboard.base}/api/tasks/${taskId}/interject/${cancelId}/steer`
    );
    expect(cancelledSend.status()).toBe(409);
    await page.locator("#composer-input").fill("未发送的另一条草稿");
    const send = page.getByRole("button", { name: "立即发送：SEND_AFTER_STOP", exact: true });
    await expect(send).toBeEnabled();
    const messageId = await send.getAttribute("data-promote-message");
    await send.click();
    await expect.poll(() => provider.requests.length, { timeout: 20000 }).toBe(2);
    const duplicate = await page.request.post(
      `${dashboard.base}/api/tasks/${taskId}/interject/${messageId}/steer`
    );
    expect(duplicate.ok()).toBe(true);
    const sendRequest = provider.requests.find(({ body }) =>
      JSON.stringify(body.messages).includes("SEND_AFTER_STOP")
    );
    expect(sendRequest).toBeTruthy();
    const sent = JSON.stringify(sendRequest.body.messages);
    expect(
      sendRequest.body.messages.filter(
        (message) => message.role === "user" && JSON.stringify(message).includes("SEND_AFTER_STOP")
      )
    ).toHaveLength(1);
    expect(sent).toContain("START_BEFORE_STOP");
    expect(sent).not.toContain("CANCEL_AFTER_STOP");
    expect(sent).not.toContain("CANCEL_WHILE_RUNNING");
    expect(sent).not.toContain("atria-queued-user");
    await expect(page.locator("#composer-input")).toHaveValue("未发送的另一条草稿");
    await expect(page.locator("#conversation")).not.toContainText("atria-queued-user");
    await expect(page.locator(".chat-message.user").filter({ hasText: "SEND_AFTER_STOP" })).toHaveCount(1);
    releaseSecond();
    await expect(page.locator("#conversation")).toContainText("停止后的队列续发成功");
    await expect(page.locator("#stop-button")).toBeHidden();
    await expect(page.locator("#queued-messages")).toBeHidden();
    await page.reload();
    await expect(page.locator("#queued-messages")).toBeHidden();
    await expect(page.locator(".chat-message.user").filter({ hasText: "SEND_AFTER_STOP" })).toHaveCount(1);
    await expect(page.locator("#conversation")).not.toContainText("CANCEL_AFTER_STOP");
    const retry = await page.request.post(
      `${dashboard.base}/api/tasks/${taskId}/interject/${messageId}/steer`
    );
    expect(retry.ok()).toBe(true);
    expect(provider.requests.length).toBe(2);
  } finally {
    releaseFirst();
    releaseSecond();
    await dashboard.stop();
    await provider.close();
  }
});
