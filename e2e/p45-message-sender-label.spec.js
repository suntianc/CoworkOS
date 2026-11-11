import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

async function bootRenderer(page, base) {
  await page.route("**/app.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "// Isolated conversation fixture." })
  );
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 500, json: { error: "This renderer fixture does not use APIs." } })
  );
  await page.goto(base);
}

test("assistant replies render as body text without a sender label, keeping thinking and tool activity", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await bootRenderer(page, dashboard.base);
    await page.evaluate(async () => {
      const { createConversationView } = await import("/assets/controllers/conversation-view.js");
      const update = (type, contentIndex, value = {}) => ({
        type: "message_update",
        assistantMessageEvent: { type, contentIndex, ...value }
      });
      const user = { role: "user", content: "核对评分文件并汇总总分。", timestamp: 1 };
      const toolCall = { type: "toolCall", id: "read-1", name: "read", arguments: { path: "scores.csv" } };
      const state = {
        selected: "sender-fixture",
        localMessages: [],
        executionHistoryOpen: new Map(),
        detail: {
          task: { taskId: "sender-fixture", status: "completed" },
          runtime: { active: false },
          runtimeEvents: [
            { type: "turn_start" },
            { type: "message_start", message: user },
            { type: "message_start", message: { role: "assistant", timestamp: 2, content: [] } },
            update("thinking_start", 0),
            update("thinking_delta", 0, { delta: "先读取分数文件，再汇总总分。" }),
            update("thinking_end", 0, { content: "先读取分数文件，再汇总总分。" }),
            {
              type: "tool_execution_start",
              toolCallId: "read-1",
              toolName: "read",
              args: { path: "scores.csv" }
            },
            {
              type: "tool_execution_end",
              toolCallId: "read-1",
              toolName: "read",
              result: { content: [{ type: "text", text: "90,85,95" }] }
            },
            { type: "message_end", message: { role: "assistant", content: [toolCall] } }
          ]
        }
      };
      const view = createConversationView({
        state,
        $: (selector) => document.querySelector(selector),
        textContent: (content) =>
          typeof content === "string" ? content : (content || []).map((part) => part.text || "").join("")
      });
      view.renderConversation(
        [user, { role: "assistant", timestamp: 3, content: [{ type: "text", text: "总分是 270 分。" }] }],
        state.detail.task
      );
    });

    const reply = page.locator('.chat-message.main[data-answer-kind="final"]');
    await expect(reply).toHaveCount(1);
    await expect(reply.locator(".markdown-body")).toHaveText("总分是 270 分。");
    await expect(reply.locator(".message-meta")).toHaveCount(0);
    await expect(reply.locator(".message-avatar")).toHaveCount(0);
    await expect(page.locator("#conversation")).not.toContainText("FORMICAND");
    await expect(page.locator(".live-workflow")).toHaveCount(1);
    await expect(page.locator(".reasoning-step")).toHaveCount(1);
    await expect(page.locator(".tool-step")).toHaveCount(1);
  } finally {
    await dashboard.stop();
  }
});

test("a streaming reply shows its state without a sender label", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await bootRenderer(page, dashboard.base);
    await page.evaluate(async () => {
      const { createConversationView } = await import("/assets/controllers/conversation-view.js");
      const update = (type, contentIndex, value = {}) => ({
        type: "message_update",
        assistantMessageEvent: { type, contentIndex, ...value }
      });
      const user = { role: "user", content: "核对评分文件并汇总总分。", timestamp: 1 };
      const state = {
        selected: "sender-stream",
        localMessages: [],
        executionHistoryOpen: new Map(),
        detail: {
          task: { taskId: "sender-stream", status: "running" },
          runtime: { active: true },
          runtimeEvents: [
            { type: "turn_start" },
            { type: "message_start", message: user },
            { type: "message_start", message: { role: "assistant", timestamp: 2, content: [] } },
            update("thinking_start", 0),
            update("thinking_delta", 0, { delta: "正在核对总分。" })
          ]
        }
      };
      const view = createConversationView({
        state,
        $: (selector) => document.querySelector(selector),
        textContent: (content) =>
          typeof content === "string" ? content : (content || []).map((part) => part.text || "").join("")
      });
      view.renderConversation([user], state.detail.task);
    });

    const pending = page.locator('.chat-message.main[data-answer-kind="pending"]');
    await expect(pending).toHaveCount(1);
    await expect(pending.locator(".message-meta")).toHaveCount(0);
    await expect(pending.locator(".message-avatar")).toHaveCount(0);
    await expect(pending.locator(".reasoning-step")).toHaveCount(1);
    await expect(pending).toContainText("正在思考");
    await expect(page.locator("#conversation")).not.toContainText("FORMICAND");
  } finally {
    await dashboard.stop();
  }
});
