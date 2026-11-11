import { test, expect } from "@playwright/test";
import { once } from "node:events";
import { createServer } from "node:http";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { readFixtureRequestBody } from "../test/http-request-body-fixture.mjs";
import { createTask } from "./p45-work-helpers.js";

const replies = [
  "第一个回答，带一段代码：\n\n```js\nconst answer = 1;\n```",
  "第二个回答。",
  "从第一个回答继续。"
];

function complete(response, text) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish] of [[{ role: "assistant", content: text }], [{}, "stop"]])
    response.write(
      `data: ${JSON.stringify({ id: "p45-reply", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`
    );
  response.end("data: [DONE]\n\n");
}

async function setup() {
  const requests = [];
  const provider = createServer(async (request, response) => {
    const raw = await readFixtureRequestBody(request);
    if (request.method !== "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    requests.push(JSON.parse(raw));
    complete(response, replies[requests.length - 1] ?? "多余的请求。");
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const dashboard = await startDashboard({
    modelEndpoint: `http://127.0.0.1:${provider.address().port}`,
    model: "fixture-model"
  });
  return {
    ...dashboard,
    requests,
    async stop() {
      await dashboard.stop();
      provider.closeAllConnections();
      await new Promise((done) => provider.close(done));
    }
  };
}

const finals = (page) => page.locator('.chat-message.main[data-answer-kind="final"]');

async function send(page, text, count) {
  await page.locator("#composer-input").fill(text);
  await page.locator("#send-button").click();
  await expect(finals(page)).toHaveCount(count, { timeout: 30_000 });
  await expect(page.locator("#run-control")).toBeHidden();
}

test("a settled reply copies, forks from that point and shows when it was written", async ({
  page,
  context
}, testInfo) => {
  test.setTimeout(120_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const local = await setup();
  try {
    const taskId = "reply-actions";
    await createTask(page, local, { taskId, goal: "回复操作", projectId: local.projectId });
    await page.goto(local.base);
    await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
    await send(page, "第一个问题", 1);
    await send(page, "第二个问题", 2);

    const [first, second] = [finals(page).nth(0), finals(page).nth(1)];
    const bar = first.locator(".reply-actions");
    await expect(bar.getByRole("button", { name: "复制回复" })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Fork" })).toBeVisible();
    await expect(bar.locator("time")).toHaveText(/^\d\d:\d\d$/);
    // The latest reply keeps its bar in full view; earlier ones until hovered.
    await expect(second.locator(".reply-actions")).toHaveClass(/is-latest/);
    await page.mouse.move(0, 0);
    await expect.poll(() => bar.evaluate((node) => Number(getComputedStyle(node).opacity))).toBeLessThan(1);
    await expect
      .poll(() => second.locator(".reply-actions").evaluate((node) => Number(getComputedStyle(node).opacity)))
      .toBe(1);
    await bar.locator(".reply-time").hover();
    await expect.poll(() => bar.evaluate((node) => Number(getComputedStyle(node).opacity))).toBe(1);
    const tooltip = bar.locator(".reply-time-full");
    await expect(tooltip).toHaveText(new RegExp(`${new Date().getFullYear()}年.*\\d\\d:\\d\\d:\\d\\d`));
    await expect.poll(() => tooltip.evaluate((node) => Number(getComputedStyle(node).opacity))).toBe(1);
    await page.screenshot({ path: testInfo.outputPath("reply-actions-1440.png") });

    // Copy takes the reply's Markdown, not its rendered text.
    await bar.getByRole("button", { name: "复制回复" }).click();
    await expect(bar.getByRole("button", { name: "复制回复" })).toHaveClass(/is-copied/);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(replies[0]);

    // A code block has its language, a wrap switch and its own copy.
    const code = first.locator(".code-block");
    await expect(code.locator(".code-block-language")).toHaveText("js");
    await code.getByRole("button", { name: "换行" }).click();
    await expect(code).toHaveClass(/is-wrapped/);
    await expect(code.getByRole("button", { name: "换行" })).toHaveAttribute("aria-pressed", "true");
    await code.getByRole("button", { name: "复制" }).click();
    await expect(code.locator("[data-code-copy-label]")).toHaveText("已复制");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("const answer = 1;");

    // Fork opens a new conversation holding the history up to that reply.
    await bar.getByRole("button", { name: "Fork" }).click();
    await expect(page.locator("#topbar-task")).toHaveText("回复操作 · Fork");
    await expect(finals(page)).toHaveCount(1);
    await expect(finals(page).first()).toContainText("第一个回答");
    await expect(page.locator(".chat-message.user")).toHaveCount(1);
    await expect(page.locator(".conversation-item", { hasText: "回复操作 · Fork" })).toHaveCount(1);
    await expect(page.locator(`.conversation-item[data-task="${taskId}"]`)).toHaveCount(1);

    await send(page, "接着第一个回答", 2);
    const context = JSON.stringify(local.requests.at(-1).messages);
    expect(context).toContain("第一个问题");
    expect(context).toContain("接着第一个回答");
    expect(context).not.toContain("第二个问题");
  } finally {
    await local.stop();
  }
});
