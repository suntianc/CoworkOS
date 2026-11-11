import { test, expect } from "@playwright/test";
import { once } from "node:events";
import { createServer } from "node:http";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { readFixtureRequestBody } from "../test/http-request-body-fixture.mjs";
import { createTask } from "./p45-work-helpers.js";

const terminal = [
  "\u001b[32m✔ stage of a merged record is merged (2ms)\u001b[0m",
  "\u001b[31m✘ a reopened review returns to developing\u001b[0m",
  ...Array.from({ length: 14 }, (_, index) => `  detail ${index + 1}`)
].join("\n");
const reply = [
  "主要改动在 `useChangeStages.ts:222` 和 `stages.json`。",
  "",
  "| 阶段 | 旧来源 | 新来源 |",
  "|---|---|---|",
  "| 开发 | 最新会话标题 | 需求记录 · development |",
  "| 审查 | 子 Agent 状态 | 需求记录 · reviews[] |",
  "",
  "```typescript",
  "export function stageOf(record: Requirement) {",
  '  return record.reviews.length ? "reviewing" : "developing";',
  "}",
  "```",
  "",
  "```diff web/hooks/useChangeStages.ts",
  "@@ -218,3 +218,2 @@ export function useChangeStages",
  "   const record = useRequirement(id);",
  '-  const stage = session.title.includes("审查")',
  '-    ? "reviewing" : "developing";',
  "+  const stage = stageOf(record);",
  "```",
  "",
  "- [x] 阶段改为从需求记录推导",
  "- [ ] 补一条审查中途重开的测试",
  "",
  "> [!NOTE]",
  "> 旧会话没有需求记录时仍按「开发」显示。",
  "",
  "> [!WARNING]",
  "> stages.json 的格式变了。",
  "",
  "```mermaid",
  "graph LR",
  "  A[需求记录] --> B[开发] --> C[审查] --> D[合入]",
  "```",
  "",
  "```terminal npm test exit=1",
  terminal,
  "```"
].join("\n");

function complete(response, text) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish] of [[{ role: "assistant", content: text }], [{}, "stop"]])
    response.write(
      `data: ${JSON.stringify({ id: "p45-rich", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`
    );
  response.end("data: [DONE]\n\n");
}

async function setup() {
  const provider = createServer(async (request, response) => {
    await readFixtureRequestBody(request);
    if (request.method !== "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    complete(response, reply);
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const dashboard = await startDashboard({
    modelEndpoint: `http://127.0.0.1:${provider.address().port}`,
    model: "fixture-model"
  });
  return {
    ...dashboard,
    async stop() {
      await dashboard.stop();
      provider.closeAllConnections();
      await new Promise((done) => provider.close(done));
    }
  };
}

for (const scheme of ["dark", "light"])
  test(`a reply's tables, code, diffs, lists, callouts, diagrams and output render as blocks (${scheme})`, async ({
    page,
    context
  }, testInfo) => {
    test.setTimeout(120_000);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.addInitScript((value) => localStorage.setItem("atria.appearance", value), scheme);
    const local = await setup();
    try {
      const taskId = `rich-blocks-${scheme}`;
      await createTask(page, local, { taskId, goal: "渲染组件", projectId: local.projectId });
      await page.goto(local.base);
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
      await page.locator("#composer-input").fill("说明改了哪些文件");
      await page.locator("#send-button").click();
      const answer = page.locator('.chat-message.main[data-answer-kind="final"] .markdown-body');
      await expect(answer).toBeVisible({ timeout: 30_000 });

      // A file chip that names nothing openable is not a button.
      await expect(answer.locator(".file-chip")).toHaveCount(2);
      await expect(answer.locator("button.file-chip")).toHaveCount(0);
      await expect(answer.locator(".file-chip").first()).toContainText("useChangeStages.ts:222");

      const table = answer.locator(".table-block");
      await expect(table.locator(".code-block-language")).toHaveText("2 行 × 3 列");
      await table.hover();
      await table.getByRole("button", { name: "复制" }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        [
          "| 阶段 | 旧来源 | 新来源 |",
          "| --- | --- | --- |",
          "| 开发 | 最新会话标题 | 需求记录 · development |",
          "| 审查 | 子 Agent 状态 | 需求记录 · reviews[] |"
        ].join("\n")
      );
      await table.getByRole("button", { name: "放大" }).click();
      const zoom = page.locator("dialog.block-zoom");
      await expect(zoom.locator("table tbody tr")).toHaveCount(2);
      await page.keyboard.press("Escape");
      await expect(zoom).toHaveCount(0);

      const diff = answer.locator(".diff-block");
      await expect(diff.locator(".diff-path")).toHaveText("web/hooks/useChangeStages.ts");
      await expect(diff.locator(".diff-count.is-add")).toHaveText("+1");
      await expect(diff.locator(".diff-count.is-remove")).toHaveText("-2");
      await expect(diff.locator(".diff-inline")).toBeVisible();
      await diff.getByRole("button", { name: "并排" }).click();
      await expect(diff.locator(".diff-split")).toBeVisible();
      await expect(diff.locator(".diff-inline")).toBeHidden();
      await expect(diff.getByRole("button", { name: "并排" })).toHaveAttribute("aria-pressed", "true");
      await diff.locator("[data-diff-collapse]").click();
      await expect(diff.locator(".diff-body")).toBeHidden();
      await diff.locator("[data-diff-collapse]").click();
      await expect(diff.locator(".diff-split")).toBeVisible();

      await expect(answer.locator(".task-list input:checked")).toHaveCount(1);
      await expect(answer.locator(".callout.is-info .callout-title")).toHaveText("注意");
      await expect(answer.locator(".callout.is-warning .callout-title")).toHaveText("警告");

      const diagram = answer.locator(".diagram-block");
      await expect(diagram.locator("[data-diagram-canvas] svg")).toBeVisible({ timeout: 20_000 });
      await expect(diagram.locator("[data-diagram-canvas] svg")).toContainText("审查");
      await diagram.getByRole("button", { name: "源码" }).click();
      await expect(diagram.locator(".diagram-source")).toBeVisible();
      await diagram.getByRole("button", { name: "源码" }).click();

      const output = answer.locator(".terminal-block");
      await expect(output.locator(".terminal-command")).toHaveText("npm test");
      await expect(output.locator(".terminal-exit")).toHaveText("退出码 1");
      await expect(output.locator(".ansi-green").first()).toContainText("merged");
      await expect(output.locator("[data-terminal-rest]")).toBeHidden();
      await output.getByRole("button", { name: "展开其余 4 行" }).click();
      await expect(output.locator("[data-terminal-rest]")).toBeVisible();

      // A later poll re-renders the conversation; the reader's choices stay.
      await page.waitForTimeout(4000);
      await expect(diff.locator(".diff-split")).toBeVisible();
      await expect(output.locator("[data-terminal-rest]")).toBeVisible();
      await expect(diagram.locator("[data-diagram-canvas] svg")).toBeVisible();

      await page.mouse.move(0, 0);
      await page.setViewportSize({ width: 1440, height: 2000 });
      await page.locator("#conversation").evaluate((node) => (node.scrollTop = 0));
      await page.screenshot({ path: testInfo.outputPath(`rich-blocks-${scheme}.png`) });
    } finally {
      await local.stop();
    }
  });
