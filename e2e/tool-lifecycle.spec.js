import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("returned async tools retain real work status through progress, callbacks and completion", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.route("**/app.js", (route) =>
      route.fulfill({ contentType: "application/javascript", body: "// Isolated UI state fixture" })
    );
    await page.goto(dashboard.base);
    await page.evaluate(async () => {
      const { createConversationView } = await import("/assets/controllers/conversation-view.js");
      const user = { role: "user", content: "四缸发动机协作状态验收", timestamp: 1 };
      const runtimeEvents = [{ type: "turn_start" }, { type: "message_start", message: user }];
      for (const [id, name, args, data] of [
        ["question", "askhuman", { question: "使用机械联动还是动力学仿真？" }, { status: "timeout" }],
        [
          "dispatch",
          "call_subagent",
          { mode: "async", task: "独立核验曲轴、活塞和凸轮联动" },
          { accepted: true, callId: "one", name: "Ara" }
        ],
        [
          "message",
          "send_subagent_message",
          { callId: "one", message: "补充核对凸轮间隙" },
          { status: "queued", messageId: "message-one" }
        ]
      ])
        runtimeEvents.push(
          { type: "tool_execution_start", toolCallId: id, toolName: name, args },
          { type: "tool_execution_end", toolCallId: id, toolName: name, result: { details: data } }
        );
      const state = {
        selected: "fixture",
        localMessages: [],
        executionHistoryOpen: new Map(),
        detail: {
          task: { taskId: "fixture", status: "running" },
          runtime: { active: true },
          runtimeEvents,
          coordination: {
            calls: [{ callId: "one", status: "running" }],
            pending: ["one"],
            callbackPending: []
          }
        }
      };
      const view = createConversationView({
        state,
        $: (selector) => document.querySelector(selector),
        bindStarterPrompts() {},
        textContent: (value) => (typeof value === "string" ? value : "")
      });
      window.lifecycleFixture = { state, render: () => view.renderConversation([user], state.detail.task) };
      window.lifecycleFixture.render();
    });
    await expect(page.locator(".tool-step .activity-status")).toHaveText(["未答复，已继续", "已入队"]);
    const agent = page.locator(".subagent-step");
    await expect(page.locator(".subagent-group")).toContainText("派出 1 个子助手");
    await expect(agent.locator(".subagent-status")).toHaveText("运行中");
    await agent.locator("summary").first().click();
    await mkdir(".tmp/status-verification", { recursive: true });
    await page.screenshot({ path: test.info().outputPath("running.png"), fullPage: true });
    await page.evaluate(() => {
      const fixture = window.lifecycleFixture;
      fixture.state.detail.runtime.active = false;
      fixture.state.detail.coordination = {
        calls: [{ callId: "one", status: "completed" }],
        callbackPending: ["one"]
      };
      fixture.render();
    });
    // Done but not yet read by Main is still done for the person.
    await expect(agent.locator(".subagent-status")).toHaveText("完成");
    await expect(page.locator(".live-workflow-head")).toHaveCount(0);
    await expect(agent).toHaveAttribute("open", "");
    await page.evaluate(() => {
      window.lifecycleFixture.state.detail.coordination.callbackPending = [];
      window.lifecycleFixture.render();
    });
    await expect(agent.locator(".subagent-status")).toHaveText("完成");
    await expect(page.locator(".execution-history")).toHaveCount(0);
  } finally {
    await dashboard.stop();
  }
});
