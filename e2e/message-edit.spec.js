import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

/** A box read is only meaningful once the bubble is attached and laid out. */
const stableBox = async (locator) => {
  await expect.poll(async () => (await locator.boundingBox()) !== null).toBe(true);
  return locator.boundingBox();
};

const layout = (page) =>
  page.evaluate(() => {
    const rect = (selector, last = false) => {
      const nodes = [...document.querySelectorAll(selector)];
      const { x, y, width, height } = (last ? nodes.at(-1) : nodes[0]).getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      bubble: rect(".chat-message.user .user-message-bubble", true),
      composer: rect(".composer"),
      answer: rect('.chat-message.main[data-answer-kind="final"]'),
      scrollTop: document.querySelector("#conversation").scrollTop
    };
  });
function expectUnmoved(before, after) {
  for (const element of ["bubble", "composer", "answer"])
    for (const key of ["x", "y", "width", "height"])
      expect(Math.abs(after[element][key] - before[element][key]), `${element} ${key}`).toBeLessThan(0.5);
  expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThan(0.5);
}
function expectExpanded(before, after) {
  expect(Math.abs(after.bubble.y - before.bubble.y), "bubble top stays anchored").toBeLessThan(0.5);
  expect(
    Math.abs(after.bubble.x + after.bubble.width - before.bubble.x - before.bubble.width),
    "bubble right stays anchored"
  ).toBeLessThan(0.5);
  expect(after.bubble.width).toBeGreaterThanOrEqual(before.bubble.width);
  expect(after.bubble.height).toBeGreaterThanOrEqual(110);
  for (const key of ["x", "y", "width", "height"])
    expect(Math.abs(after.composer[key] - before.composer[key]), `composer ${key}`).toBeLessThan(0.5);
  expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThan(0.5);
}

for (const pause of ["restart", "stop"]) {
  test(`edited resend after ${pause} at a human question keeps the bottom draft`, async ({
    page
  }, testInfo) => {
    let releaseQuestion;
    const questionGate = new Promise((done) => {
      releaseQuestion = done;
    });
    const provider = await modelProtocolFixture("openai-completions", async (_body, requests) => {
      if (requests.length === 1) {
        await questionGate;
        return { name: "askhuman", arguments: { question: "你想查询哪个城市今天的天气？" } };
      }
      return { text: "北京天气的新回复。" };
    });
    const dashboard = await startDashboard({
      modelEndpoint: provider.baseUrl,
      defaultProject: pause !== "stop"
    });
    try {
      await page.goto(dashboard.base);
      await page.locator("#composer-input").fill("你好，今天天气怎么样？");
      await page.locator("#send-button").click();
      await expect(page.locator("#composer-input")).toHaveValue("");
      await page.locator("#composer-input").fill("保留底部草稿");
      releaseQuestion();
      await expect(page.locator("#human-questions")).toContainText("你想查询哪个城市今天的天气？", {
        timeout: 30000
      });
      const taskId = await page.locator(".conversation-item.active").getAttribute("data-task");
      if (pause === "restart") {
        await dashboard.restart();
        await page.reload();
        await expect(page.locator("#human-questions")).toBeVisible();
        // Recovery reattaches the saved turn; editing is only accepted once it settles.
        await expect
          .poll(
            async () =>
              (await (await page.request.get(`${dashboard.base}/api/tasks/${taskId}`)).json()).runtime.active
          )
          .toBe(false);
      } else {
        await page.locator(".conversation-item.active").click({ button: "right" });
        await page.locator('[data-session-action="stop"]').click();
        await expect(page.locator("#human-questions")).toBeHidden();
        await expect
          .poll(
            async () =>
              (await (await page.request.get(`${dashboard.base}/api/tasks/${taskId}`)).json()).runtime.active
          )
          .toBe(false);
      }
      await page.getByRole("button", { name: "编辑消息" }).click();
      await page.locator("[data-inline-message-edit]").fill("北京今天的天气怎么样？");
      await page.screenshot({ path: testInfo.outputPath("resend-pending-question.png") });
      const accepted = page.waitForResponse((response) =>
        response.url().endsWith(`/api/tasks/${taskId}/messages/edit`)
      );
      await page.getByRole("button", { name: "发送编辑后的消息", exact: true }).click();
      expect((await accepted).status()).toBe(202);
      await expect(page.locator("#conversation")).toContainText("北京天气的新回复。", { timeout: 30000 });
      await expect(page.locator("#human-questions")).toBeHidden();
      await expect(page.locator("#composer-input")).toHaveValue("保留底部草稿");
      await expect(page.locator("[data-inline-message-edit]")).toHaveCount(0);
      const detail = await (await page.request.get(`${dashboard.base}/api/tasks/${taskId}`)).json();
      expect(detail.humanRequests[0].status).toBe("cancelled");
      const context = JSON.stringify(provider.requests.at(-1).body.messages);
      expect(context).toContain("北京今天的天气怎么样？");
      expect(context).not.toContain("你好，今天天气怎么样？");
      expect(context).not.toContain("你想查询哪个城市今天的天气？");
      expect(context).not.toContain("保留底部草稿");
      await page.reload();
      await expect(page.locator("#human-questions")).toBeHidden();
      await expect(page.locator("#composer-input")).toHaveValue("保留底部草稿");
      await page.screenshot({ path: testInfo.outputPath("resend-completed.png") });
    } finally {
      releaseQuestion();
      await dashboard.stop();
      await provider.close();
    }
  });
}

test("latest message edit preserves drafts, attachments and line breaks through cancel and resend", async ({
  page
}) => {
  const provider = await modelProtocolFixture("openai-completions", async (_body, requests) => ({
    text: requests.length === 1 ? "ORIGINAL_ANSWER" : "EDITED_ANSWER"
  }));
  const dashboard = await startDashboard({ modelEndpoint: provider.baseUrl });
  try {
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("ORIGINAL_MESSAGE\nLINE_TWO");
    await page.locator("#file-input").setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("FULL_ATTACHMENT_BODY")
    });
    await expect(page.locator("#attachment-strip")).toContainText("notes.txt");
    await page.locator("#send-button").click();
    await expect(page.getByRole("button", { name: "编辑消息" })).toBeVisible({ timeout: 30000 });
    const taskId = await page.locator(".conversation-item.active").getAttribute("data-task");
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`${dashboard.base}/api/tasks/${taskId}`)).json()).runtime.active
      )
      .toBe(false);
    await page.locator("#composer-input").fill("UNSENT_DRAFT");
    await page.getByRole("button", { name: "编辑消息" }).click();
    await expect(page.locator("[data-inline-message-edit]")).toHaveValue("ORIGINAL_MESSAGE\nLINE_TWO");
    await expect(page.locator(".chat-message.user .inline-message-editor")).toBeVisible();
    await expect(page.locator(".composer")).toBeVisible();
    await expect(page.locator("#composer-input")).toHaveValue("UNSENT_DRAFT");
    await page.locator("#composer-input").fill("UNSENT_DRAFT_UPDATED");
    await expect(page.locator("[data-inline-message-edit]")).toHaveValue("ORIGINAL_MESSAGE\nLINE_TWO");
    await expect(page.locator(".inline-edit-attachments")).toContainText("notes.txt");
    await page.setViewportSize({ width: 320, height: 900 });
    await page.getByRole("button", { name: "编辑附件", exact: true }).click();
    const attachments = await page.locator(".inline-edit-attachments").boundingBox();
    expect(attachments.x).toBeGreaterThanOrEqual(0);
    expect(attachments.x + attachments.width).toBeLessThanOrEqual(320);
    await page.getByRole("button", { name: "移除附件 notes.txt" }).click();
    await expect(page.locator(".inline-edit-attachments")).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "取消编辑", exact: true }).click();
    await expect(page.locator("#composer-input")).toHaveValue("UNSENT_DRAFT_UPDATED");
    expect(provider.requests).toHaveLength(1);
    const edit = page.getByRole("button", { name: "编辑消息" });
    await edit.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".inline-edit-attachments")).toContainText("notes.txt");
    await page.locator("[data-inline-message-edit]").fill("EDITED_MESSAGE\nEDITED_LINE");
    await page.reload();
    await expect(page.locator("[data-inline-message-edit]")).toBeVisible();
    await expect(page.locator("[data-inline-message-edit]")).toHaveValue("EDITED_MESSAGE\nEDITED_LINE");
    await expect(page.locator("#composer-input")).toHaveValue("UNSENT_DRAFT_UPDATED");
    await page.getByRole("button", { name: "发送编辑后的消息", exact: true }).click();
    await expect(page.locator("#composer-input")).toHaveValue("UNSENT_DRAFT_UPDATED");
    await expect(page.locator("#conversation")).toContainText("EDITED_ANSWER", { timeout: 30000 });
    await expect(page.locator(".conversation-versions")).toHaveCount(0);
    await expect(page.locator("#conversation")).not.toContainText("ORIGINAL_MESSAGE");
    await expect(page.locator("#conversation")).not.toContainText("ORIGINAL_ANSWER");
    const newContext = JSON.stringify(provider.requests[1].body.messages);
    expect(newContext).toContain("EDITED_MESSAGE");
    expect(newContext).toContain("EDITED_LINE");
    expect(newContext).toContain("notes.txt");
    expect(newContext).not.toContain("ORIGINAL_MESSAGE");
    expect(newContext).not.toContain("ORIGINAL_ANSWER");
    expect(newContext).not.toContain("UNSENT_DRAFT");
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});

test("compact bubbles expand for editing with keyboard controls at desktop and narrow widths", async ({
  page
}, testInfo) => {
  const provider = await modelProtocolFixture("openai-completions", () => ({ text: "已收到。" }));
  const dashboard = await startDashboard({ modelEndpoint: provider.baseUrl });
  try {
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("你好");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("已收到。", { timeout: 30000 });
    const taskId = await page.locator(".conversation-item.active").getAttribute("data-task");
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`${dashboard.base}/api/tasks/${taskId}`)).json()).runtime.active
      )
      .toBe(false);
    const message = page.locator(".chat-message.user");
    const edit = message.getByRole("button", { name: "编辑消息" });
    await expect(message.locator(".message-meta")).toHaveCount(0);
    await page.locator("#composer-input").fill("留着的草稿");
    for (const width of [1440, 1280, 474, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await message.hover();
      const bubble = await stableBox(message.locator(".user-message-bubble"));
      if (width >= 1280) expect(bubble.height).toBeLessThan(50);
      await edit.focus();
      await expect(edit).toHaveCSS("opacity", "1");
      if (width === 1440) {
        await message.screenshot({ path: testInfo.outputPath("compact-bubble.png") });
        await page.emulateMedia({ colorScheme: "dark" });
        await message.screenshot({ path: testInfo.outputPath("compact-bubble-dark.png") });
      }
      if (width === 1440) await page.screenshot({ path: testInfo.outputPath("before-edit.png") });
      const before = await layout(page);
      await page.keyboard.press("Enter");
      const input = message.getByRole("textbox", { name: "编辑消息内容" });
      await expect(input).toBeFocused();
      await expect(page.locator(".composer")).toBeVisible();
      await expect(page.locator("#composer-input")).toHaveValue("留着的草稿");
      expectExpanded(before, await layout(page));
      await expect(message.locator("[data-cancel-message-edit]")).toHaveText("取消");
      await expect(message.locator("[data-submit-message-edit]")).toHaveText("发送");
      const editingBubble = await stableBox(message.locator(".user-message-bubble"));
      const send = await stableBox(message.locator("[data-submit-message-edit]"));
      expect(send.y + send.height).toBeLessThan(editingBubble.y + editingBubble.height);
      expect(send.x + send.width).toBeLessThan(editingBubble.x + editingBubble.width);
      await testInfo.attach(`layout-${width}`, {
        body: JSON.stringify({ before, editing: await layout(page) }, null, 2),
        contentType: "application/json"
      });
      if (width === 1440) await page.screenshot({ path: testInfo.outputPath("editing-original.png") });
      await input.fill("第一行");
      await input.press("End");
      await input.press("Enter");
      await input.pressSequentially("第二行");
      await expect(input).toHaveValue("第一行\n第二行");
      expectExpanded(before, await layout(page));
      const overflow = await message.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
      expect(overflow).toBe(false);
      if (width === 1440) await message.screenshot({ path: testInfo.outputPath("inline-editor.png") });
      if (width === 320) await message.screenshot({ path: testInfo.outputPath("inline-editor-narrow.png") });
      await input.press("Escape");
      await expect(edit).toBeFocused();
      await expect(page.locator("#composer-input")).toHaveValue("留着的草稿");
      expectUnmoved(before, await layout(page));
      expect(provider.requests).toHaveLength(1);
    }
    await edit.click();
    const input = message.getByRole("textbox", { name: "编辑消息内容" });
    await input.fill("修改后重发");
    await input.press("Control+Enter");
    await expect(input).toHaveCount(0);
    await expect(page.locator("#composer-input")).toHaveValue("留着的草稿");
    await expect.poll(() => provider.requests.length).toBe(2);
    expect(JSON.stringify(provider.requests[1].body.messages)).toContain("修改后重发");
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});

test("multiline editing grows within a bound and preserves the composer and scroll position", async ({
  page
}, testInfo) => {
  const provider = await modelProtocolFixture("openai-completions", () => ({
    text: "这一行答复用于形成长对话。\n\n".repeat(60)
  }));
  const dashboard = await startDashboard({ modelEndpoint: provider.baseUrl });
  try {
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("第一行消息\n第二行消息\n第三行消息");
    await page.locator("#send-button").click();
    await expect(page.locator('.chat-message.main[data-answer-kind="final"]')).toBeVisible({
      timeout: 30000
    });
    const taskId = await page.locator(".conversation-item.active").getAttribute("data-task");
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`${dashboard.base}/api/tasks/${taskId}`)).json()).runtime.active
      )
      .toBe(false);
    const edit = page.getByRole("button", { name: "编辑消息", exact: true });
    await edit.scrollIntoViewIfNeeded();
    const before = await layout(page);
    await edit.click();
    expectExpanded(before, await layout(page));
    await page.getByRole("textbox", { name: "编辑消息内容" }).fill("修改第一行\n修改第二行\n修改第三行");
    expectExpanded(before, await layout(page));
    const input = page.getByRole("textbox", { name: "编辑消息内容" });
    await input.fill("一行较长的编辑内容。\n".repeat(80));
    const bounds = await input.boundingBox();
    expect(bounds.height).toBeLessThanOrEqual(280);
    expect(await input.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    expectExpanded(before, await layout(page));
    await page.screenshot({ path: testInfo.outputPath("stable-inline-layout.png") });
    await page.getByRole("button", { name: "取消编辑", exact: true }).click();
    expectUnmoved(before, await layout(page));
    expect(provider.requests).toHaveLength(1);
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});

test("opening the latest editor near the bottom does not jump the conversation", async ({ page }) => {
  const provider = await modelProtocolFixture("openai-completions", (_body, requests) => ({
    text: requests.length === 1 ? "之前的回复。\n\n".repeat(25) : "已收到。"
  }));
  const dashboard = await startDashboard({ modelEndpoint: provider.baseUrl });
  try {
    await page.goto(dashboard.base);
    for (const [index, text] of ["先说明情况", "继续"].entries()) {
      await page.locator("#composer-input").fill(text);
      await page.locator("#send-button").click();
      const taskId = await page.locator(".conversation-item.active").getAttribute("data-task");
      await expect
        .poll(
          async () =>
            (await (await page.request.get(`${dashboard.base}/api/tasks/${taskId}`)).json()).runtime.active
        )
        .toBe(false);
      // The page, not only the backend, has to see the round end; otherwise
      // the next message is sent as an instruction to a run it thinks is live.
      await expect(page.locator('.chat-message.main[data-answer-kind="final"]')).toHaveCount(index + 1);
      await expect(page.locator("#run-control")).toBeHidden();
    }
    await expect(page.locator('.chat-message.main[data-answer-kind="final"]')).toHaveCount(2);
    await page.locator("#conversation").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    const before = await layout(page);
    expect(before.scrollTop).toBeGreaterThan(0);
    await page.getByRole("button", { name: "编辑消息", exact: true }).click();
    expectExpanded(before, await layout(page));
    await page.getByRole("button", { name: "取消编辑", exact: true }).click();
    expectUnmoved(before, await layout(page));
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});
