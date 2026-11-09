import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

async function renderFixture(page, base) {
  await page.route("**/app.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "// Isolated conversation fixture." })
  );
  await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
  await page.goto(base);
  await page.evaluate(async () => {
    const { createConversationView } = await import("/assets/controllers/conversation-view.js");
    const user = { role: "user", content: "合成验收：保留思考和工具结果，并输出核对结论。", timestamp: 1 };
    const state = {
      selected: "integrity-fixture",
      localMessages: [],
      executionHistoryOpen: new Map(),
      detail: {
        task: { taskId: "integrity-fixture", status: "running" },
        runtime: { active: true },
        runtimeEvents: []
      }
    };
    const view = createConversationView({
      state,
      $: (selector) => document.querySelector(selector),
      bindStarterPrompts() {},
      textContent: (content) =>
        typeof content === "string" ? content : (content || []).map((part) => part.text || "").join(""),
      retry: () => {
        window.recoveryRetries = (window.recoveryRetries || 0) + 1;
      },
      openSettings: () => {
        window.recoverySettings = (window.recoverySettings || 0) + 1;
      }
    });
    const update = (type, contentIndex, rest = {}) => ({
      type: "message_update",
      assistantMessageEvent: { type, contentIndex, ...rest }
    });
    let messages = [user];
    const render = () => view.renderConversation(messages, state.detail.task);
    window.integrityFixture = {
      poll: render,
      failure({
        partial = false,
        status = "waiting",
        stopReason = "error",
        errorMessage = "Upstream HTTP/2 stream failed"
      } = {}) {
        const content = partial
          ? [{ type: "thinking", thinking: "已经读取输入约束，还未执行工具。" }]
          : [{ type: "text", text: "\n" }];
        const message = { role: "assistant", timestamp: 2, stopReason, errorMessage, content };
        state.detail.runtimeEvents = [
          { type: "turn_start" },
          { type: "message_start", message: user },
          { type: "message_start", message: { role: "assistant", timestamp: 2, content: [] } },
          update("thinking_delta", 0, { delta: "" }),
          { type: "message_end", message },
          { type: "turn_end", message }
        ];
        messages = [user, message];
        state.detail.runtime.active = false;
        state.detail.task.status = status;
        state.detail.task.lastError = errorMessage;
        render();
      },
      progress() {
        state.detail.runtimeEvents = [
          { type: "turn_start" },
          { type: "message_start", message: user },
          { type: "message_start", message: { role: "assistant", timestamp: 2, content: [] } },
          update("thinking_end", 0, { content: "先核对输入，再检查工具结果。" }),
          update("toolcall_end", 1, {
            toolCall: { id: "read", name: "read", arguments: { path: "fixture.txt" } }
          }),
          { type: "tool_execution_start", toolCallId: "read", toolName: "read" },
          { type: "tool_execution_update", toolCallId: "read", partialResult: "部分输出已返回。" }
        ];
        render();
      },
      emptyResult() {
        state.detail.runtimeEvents.push({ type: "tool_execution_end", toolCallId: "read", result: "" });
        render();
      },
      stop() {
        state.detail.runtimeEvents.push({
          type: "tool_execution_start",
          toolCallId: "bash",
          toolName: "bash"
        });
        state.detail.runtime.active = false;
        state.detail.task.status = "waiting";
        render();
      },
      finish(persisted = false) {
        const answer = {
          role: "assistant",
          timestamp: 3,
          stopReason: "stop",
          content: [
            { type: "thinking", thinking: "工具读取后确认了结果。" },
            { type: "text", text: "拆分" },
            { type: "text", text: "回复已完成。" }
          ]
        };
        state.detail.runtimeEvents = [
          { type: "turn_start" },
          { type: "message_start", message: user },
          { type: "message_start", message: { role: "assistant", timestamp: 3, content: [] } },
          { type: "message_end", message: answer },
          { type: "turn_end", message: answer }
        ];
        messages = persisted ? [user, answer] : [user];
        state.detail.runtime.active = false;
        state.detail.task.status = "completed";
        render();
      },
      stoppedPlainText() {
        state.detail.runtimeEvents = [];
        state.detail.runtime.active = false;
        state.detail.task.status = "waiting";
        messages = [
          user,
          { role: "assistant", content: "保留中断前已经写好的正文。", timestamp: 4, stopReason: "aborted" }
        ];
        render();
      }
    };
    window.integrityFixture.progress();
  });
}

test("partial output, empty tool completion and stopped calls retain truthful visible states", async ({
  page
}, testInfo) => {
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await renderFixture(page, dashboard.base);
    const tools = page.locator(".tool-step");
    await expect(page.locator(".live-workflow-head")).toHaveCount(1);
    await expect(tools.first()).toHaveClass(/is-running/);
    await expect(tools.first().locator(".activity-status")).toHaveText("执行中");
    await page.evaluate(() => window.integrityFixture.emptyResult());
    await expect(tools.first()).toHaveClass(/is-done/);
    await expect(tools.first().locator(".activity-status")).toHaveText("调用完成");
    await page.evaluate(() => window.integrityFixture.stop());
    await expect(tools.last().locator(".activity-status")).toHaveText("已停止");
    await expect(page.locator(".tool-step.is-running")).toHaveCount(0);
    await expect(page.locator(".thinking-spinner")).toHaveCount(0);
    await page.locator(".reasoning-details summary").click();
    await page.locator("#conversation").screenshot({ path: testInfo.outputPath("stopped-tools-1440.png") });
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(tools.last().locator(".activity-status")).toBeVisible();
    await page.locator("#conversation").screenshot({ path: testInfo.outputPath("stopped-tools-320.png") });
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("zero-output stream errors expose safe keyboard recovery without automatic reruns", async ({
  page
}, testInfo) => {
  const dashboard = await startDashboard();
  try {
    await renderFixture(page, dashboard.base);
    await page.evaluate(() => window.integrityFixture.failure());
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("模型连接中断");
    await expect(alert).toContainText("手动重试");
    await expect(alert).not.toContainText("Upstream");
    await expect(page.locator(".live-workflow")).toHaveCount(0);
    await expect(page.locator('[data-answer-kind="final"]')).toHaveCount(0);
    await expect(page.locator(".thinking-spinner")).toHaveCount(0);
    expect(await page.evaluate(() => window.recoveryRetries || 0)).toBe(0);
    const retry = page.getByRole("button", { name: "从中断步骤继续" });
    await retry.focus();
    await page.evaluate(() => window.integrityFixture.failure({ partial: true }));
    await expect(retry).toBeFocused();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.recoveryRetries)).toBe(1);
    await page.getByRole("button", { name: "切换模型" }).focus();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.recoverySettings)).toBe(1);
    await page.evaluate(() =>
      window.integrityFixture.failure({
        status: "failed",
        errorMessage: "Provider refused Authorization: Bearer sk-test-synthetic-never-real"
      })
    );
    await expect(alert).toContainText("任务失败");
    await expect(page.locator("#conversation")).not.toContainText("sk-test-synthetic");
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(retry).toBeVisible();
    await page
      .locator("#conversation")
      .screenshot({ path: testInfo.outputPath("stream-error-recovery-320.png") });
  } finally {
    await dashboard.stop();
  }
});

test("partial errored thoughts stay readable and cancellation or completion clears failure recovery", async ({
  page
}, testInfo) => {
  const dashboard = await startDashboard();
  try {
    await renderFixture(page, dashboard.base);
    await page.evaluate(() => window.integrityFixture.failure({ partial: true }));
    await page.locator(".reasoning-details > summary").click();
    await expect(page.locator(".reasoning-copy")).toHaveText("已经读取输入约束，还未执行工具。");
    await expect(page.locator(".reasoning-state")).toHaveText("思考已停止");
    await page.evaluate(() => window.integrityFixture.poll());
    await expect(page.locator(".reasoning-details > summary")).toBeFocused();
    await expect(page.locator(".reasoning-details")).toHaveAttribute("open", "");
    await expect(page.locator(".live-workflow-head")).toContainText("执行已停止");
    await expect(page.getByRole("alert")).toContainText("模型连接中断");
    await expect(page.locator('[data-answer-kind="final"]')).toHaveCount(0);
    await page
      .locator("#conversation")
      .screenshot({ path: testInfo.outputPath("partial-stream-error-1440.png") });
    for (const status of ["waiting", "cancelled"]) {
      await page.evaluate(
        (status) => window.integrityFixture.failure({ partial: true, status, stopReason: "aborted" }),
        status
      );
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.locator('[data-answer-kind="final"]')).toHaveCount(0);
    }
    await page.evaluate(() => window.integrityFixture.finish(true));
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.locator('[data-answer-kind="final"]')).toContainText("拆分回复已完成。");
  } finally {
    await dashboard.stop();
  }
});

test("split final text stays readable during persistence and appears once after recovery", async ({
  page
}, testInfo) => {
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await renderFixture(page, dashboard.base);
    await page.evaluate(() => window.integrityFixture.finish());
    await expect(page.locator(".live-answer")).toHaveCount(1);
    await expect(page.locator(".execution-history")).toHaveCount(0);
    await expect(page.locator("#conversation")).toContainText("拆分回复已完成。");
    await page.locator(".reasoning-details summary").click();
    await page.evaluate(() => window.integrityFixture.finish(true));
    await expect(page.locator('[data-answer-kind="final"]')).toContainText("拆分回复已完成。");
    await expect(page.locator(".live-answer")).toHaveCount(0);
    await page.locator(".execution-history > summary").click();
    await expect(page.locator(".execution-history .live-workflow-head")).toHaveCount(0);
    await expect(page.locator(".execution-history > summary strong")).toHaveText("处理完成");
    await expect(page.locator(".reasoning-copy")).toBeVisible();
    await page.locator("#conversation").screenshot({ path: testInfo.outputPath("split-final-1440.png") });
    await page.evaluate(() => window.integrityFixture.stoppedPlainText());
    await expect(page.locator("#conversation")).toContainText("保留中断前已经写好的正文。");
    await expect(page.locator(".thinking-spinner")).toHaveCount(0);
    await expect(page.locator('[data-answer-kind="final"]')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});
