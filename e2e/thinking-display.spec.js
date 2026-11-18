import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

async function renderSyntheticThought(page, base, firstThoughtInput) {
  // Use the shipped DOM, CSS and conversation controller, without booting the
  // app, creating a task, starting a run or contacting a model.
  const apiRequests = [];
  await page.route("**/app.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "// Isolated conversation fixture." })
  );
  await page.route("**/api/**", (route) => {
    apiRequests.push(route.request().url());
    return route.fulfill({ status: 500, json: { error: "This renderer fixture does not use APIs." } });
  });
  await page.goto(base);
  await page.addStyleTag({ content: ".reasoning-copy { max-height:80px; overflow:auto; }" });
  await page.evaluate(async (initialThought) => {
    const { createConversationView } = await import("/assets/controllers/conversation-view.js");
    const update = (type, contentIndex, value = {}) => ({
      type: "message_update",
      assistantMessageEvent: { type, contentIndex, ...value }
    });
    const user = { role: "user", content: "合成验收：核对输入文件，并说明工具读取后的结果。", timestamp: 1 };
    let firstThought =
      initialThought ??
      Array.from({ length: 20 }, (_, index) => `检查项 ${index + 1}：确认本地合成数据的输入约束。`).join(
        "\n"
      );
    let secondThought = "文件读取已结束，继续核对内容与要求是否一致。";
    const call = { type: "toolCall", id: "inspect", name: "read", arguments: { path: "fixture.txt" } };
    const state = {
      selected: "thinking-fixture",
      localMessages: [],
      executionHistoryOpen: new Map(),
      detail: {
        task: { taskId: "thinking-fixture", status: "running" },
        runtime: { active: true },
        runtimeEvents: [
          { type: "turn_start" },
          { type: "message_start", message: user },
          { type: "message_start", message: { role: "assistant", timestamp: 2, content: [] } },
          update("thinking_start", 0),
          update("thinking_delta", 0, { delta: firstThought })
        ]
      }
    };
    const view = createConversationView({
      state,
      $: (selector) => document.querySelector(selector),
      bindStarterPrompts() {},
      textContent: (content) =>
        typeof content === "string" ? content : (content || []).map((part) => part.text || "").join("")
    });
    let messages = [user];
    const render = () => view.renderConversation(messages, state.detail.task);
    window.thoughtFixture = {
      poll: render,
      beforeFirstToken() {
        state.detail.runtimeEvents = [];
        render();
      },
      retryBeforeToken() {
        state.detail.runtimeEvents.push({ type: "auto_retry_start", attempt: 1, maxAttempts: 5 });
        render();
      },
      endThought() {
        state.detail.runtimeEvents.push(
          { type: "auto_retry_end", attempt: 1, success: true },
          update("thinking_end", 0, { content: firstThought })
        );
        render();
      },
      attachmentTool() {
        state.detail.runtimeEvents.push({
          type: "tool_execution_start",
          toolCallId: "attachment",
          toolName: "read_attachment",
          args: { path: "fixture.txt" }
        });
        render();
      },
      attachmentReturned() {
        state.detail.runtimeEvents.push({
          type: "tool_execution_end",
          toolCallId: "attachment",
          toolName: "read_attachment",
          result: { content: [] }
        });
        render();
      },
      streamReply() {
        state.detail.runtimeEvents.push(update("text_delta", 3, { delta: "正在整理附件内容。" }));
        render();
      },
      stop() {
        state.detail.runtime.active = false;
        state.detail.task.status = "cancelled";
        render();
      },
      toolBatch() {
        state.detail.runtimeEvents.push(update("thinking_end", 0, { content: firstThought }));
        for (const [index, name] of ["read", "read", "edit", "bash", "bash", "bash"].entries()) {
          const id = `batch-${index}`;
          state.detail.runtimeEvents.push(
            update("toolcall_end", index + 1, {
              toolCall: {
                id,
                name,
                arguments: name === "bash" ? { command: "node check.mjs" } : { path: `fixture-${index}.txt` }
              }
            }),
            { type: "tool_execution_start", toolCallId: id, toolName: name }
          );
          if (index !== 5)
            state.detail.runtimeEvents.push({
              type: "tool_execution_end",
              toolCallId: id,
              toolName: name,
              isError: index === 4,
              result: {
                content: [
                  {
                    type: "text",
                    text:
                      index === 4
                        ? "Error: Cannot find module fixture.mjs\nCommand exited with code 1"
                        : "完成"
                  }
                ]
              }
            });
        }
        render();
      },
      append(delta) {
        firstThought += delta;
        state.detail.runtimeEvents.push(update("thinking_delta", 0, { delta }));
        render();
      },
      delta() {
        firstThought += "\n新的片段：保留正在阅读的位置。";
        state.detail.runtimeEvents.push(
          update("thinking_delta", 0, { delta: "\n新的片段：保留正在阅读的位置。" })
        );
        render();
      },
      toolThenThought() {
        state.detail.runtimeEvents.push(
          update("thinking_end", 0, { content: firstThought }),
          update("toolcall_end", 1, { toolCall: call }),
          { type: "tool_execution_start", toolCallId: "inspect", toolName: "read", args: call.arguments },
          {
            type: "tool_execution_end",
            toolCallId: "inspect",
            toolName: "read",
            result: "本地合成文件读取完成。"
          },
          update("thinking_start", 2),
          update("thinking_delta", 2, { delta: secondThought })
        );
        render();
      },
      finish(stopReason = "stop") {
        const answer = {
          role: "assistant",
          timestamp: 2,
          stopReason,
          content: [
            { type: "thinking", thinking: firstThought },
            call,
            { type: "thinking", thinking: secondThought },
            ...(stopReason === "stop" ? [{ type: "text", text: "合成输入核对完成。" }] : [])
          ]
        };
        state.detail.runtimeEvents.push(
          { type: "message_end", message: answer },
          { type: "turn_end", message: answer }
        );
        state.detail.runtime.active = false;
        state.detail.task.status = stopReason === "stop" ? "completed" : "waiting";
        messages = [user, answer];
        render();
      }
    };
    render();
  }, firstThoughtInput);
  return apiRequests;
}

test("completed tool batches are compact, keyboard accessible, and keep failures and active commands visible at all widths", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    for (const width of [1440, 1280, 474, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const requests = await renderSyntheticThought(page, dashboard.base, "检查文件和命令。");
      await page.evaluate(() => window.thoughtFixture.toolBatch());
      const group = page.locator(".tool-group-details");
      await expect(group.locator(":scope > summary")).toHaveText(
        "读取了 2 个文件 · 编辑了 1 个文件 · 运行了 1 条命令"
      );
      await expect(group).not.toHaveAttribute("open", "");
      await expect(group.locator(".tool-step").first()).not.toBeVisible();
      await expect(page.locator(".workflow-rail > .tool-step.is-failed")).toBeVisible();
      await expect(page.locator(".workflow-rail > .tool-step.is-running")).toBeVisible();
      await expect(page.locator(".tool-context.is-failure")).toContainText("脚本或模块不存在");
      await page.screenshot({ path: test.info().outputPath(`tool-group-${width}.png`) });
      await group.locator(":scope > summary").focus();
      await page.keyboard.press("Enter");
      await expect(group).toHaveAttribute("open", "");
      await expect(group.locator(".tool-step").first()).toBeVisible();
      await page.evaluate(() => window.thoughtFixture.poll());
      await expect(group.locator(":scope > summary")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(group).not.toHaveAttribute("open", "");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(requests).toEqual([]);
    }
  } finally {
    await dashboard.stop();
  }
});

test("progress animates before tokens, during retries and between tools until completion or stop", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    for (const width of [1440, 1280, 474, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const requests = await renderSyntheticThought(page, dashboard.base, "检查输入约束。");
      await page.evaluate(() => window.thoughtFixture.beforeFirstToken());
      const placeholder = page.locator(".assistant-thinking");
      await expect(placeholder).toBeVisible();
      await expect(placeholder).toContainText("思考中");
      await page.evaluate(() => window.thoughtFixture.retryBeforeToken());
      await expect(placeholder).toContainText("恢复模型连接");
      await expect(placeholder.locator(".thinking-spinner")).toBeVisible();
      await page.evaluate(() => window.thoughtFixture.endThought());
      const progress = page.locator(".workflow-progress-spinner");
      await expect(progress).toBeVisible();
      await expect(page.locator(".workflow-heading")).toContainText("等待模型响应");
      const animationTime = await progress.evaluate((node) => node.getAnimations()[0]?.currentTime ?? 0);
      await expect
        .poll(() => progress.evaluate((node) => node.getAnimations()[0]?.currentTime ?? 0))
        .toBeGreaterThan(animationTime + 40);
      await progress.evaluate((node) => {
        window.savedProgressNode = node;
      });
      await page.evaluate(() => window.thoughtFixture.attachmentTool());
      await expect(page.locator(".tool-action")).toContainText("读取附件");
      await expect(page.locator(".workflow-heading")).toContainText("读取附件");
      await page.evaluate(() => window.thoughtFixture.attachmentReturned());
      await expect(page.locator(".workflow-heading")).toContainText("等待模型响应");
      expect(await progress.evaluate((node) => node === window.savedProgressNode)).toBe(true);
      await page.evaluate(() => window.thoughtFixture.poll());
      expect(await progress.evaluate((node) => node === window.savedProgressNode)).toBe(true);
      await page.evaluate(() => window.thoughtFixture.streamReply());
      await expect(page.locator(".workflow-heading")).toContainText("正在生成回复");
      await page.screenshot({ path: test.info().outputPath(`continuous-progress-${width}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.evaluate(() => window.thoughtFixture.finish());
      await expect(page.locator("[data-thinking-key]")).toHaveCount(0);
      await expect(page.locator('[data-answer-kind="final"]')).toBeVisible();
      expect(requests).toEqual([]);
    }
    await renderSyntheticThought(page, dashboard.base, "检查停止反馈。");
    await page.evaluate(() => window.thoughtFixture.stop());
    await expect(page.locator("[data-thinking-key]")).toHaveCount(0);
  } finally {
    await dashboard.stop();
  }
});

test("streaming thought expansion, keyboard focus and reading position survive deltas, polling and completion", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    const apiRequests = await renderSyntheticThought(page, dashboard.base);
    const thoughts = page.locator(".reasoning-details");
    await thoughts.first().locator("summary").click();
    await thoughts
      .first()
      .locator(".reasoning-copy")
      .evaluate((node) => {
        node.scrollTop = 52;
      });
    await page.evaluate(() => window.thoughtFixture.delta());
    await expect(thoughts.first()).toHaveAttribute("open", "");
    await expect(thoughts.first().locator("summary")).toBeFocused();
    expect(
      await thoughts
        .first()
        .locator(".reasoning-copy")
        .evaluate((node) => node.scrollTop)
    ).toBe(52);
    await page.evaluate(() => window.thoughtFixture.poll());
    await expect(thoughts.first().locator("summary")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(thoughts.first()).not.toHaveAttribute("open", "");
    await page.evaluate(() => window.thoughtFixture.poll());
    await expect(thoughts.first()).not.toHaveAttribute("open", "");
    await expect(thoughts.first().locator("summary")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect
      .poll(() =>
        thoughts
          .first()
          .locator(".reasoning-copy")
          .evaluate((node) => node.scrollTop)
      )
      .toBe(52);
    await page.evaluate(() => window.thoughtFixture.toolThenThought());
    await expect(thoughts).toHaveCount(2);
    await expect(thoughts.first()).toHaveAttribute("open", "");
    await expect(thoughts.last()).not.toHaveAttribute("open", "");
    await thoughts.last().locator("summary").click();
    await expect(page.locator(".reasoning-step").first()).toContainText("思考完成");
    await expect(page.locator(".reasoning-step").last()).toContainText("思考中");
    await expect(page.locator(".tool-step")).toContainText("读取文件");
    await expect(page.locator(".thinking-spinner")).toHaveCount(1);
    const compactThought = await page.locator(".reasoning-step").last().boundingBox();
    expect(compactThought.height).toBeLessThan(150);
    await page
      .locator('[data-answer-kind="pending"]')
      .screenshot({ path: test.info().outputPath("thinking-expanded.png") });
    await page.evaluate(() => window.thoughtFixture.finish());
    const history = page.locator(".execution-history");
    await expect(history).not.toHaveAttribute("open", "");
    await expect(history.locator(":scope > summary")).toBeFocused();
    await history.locator(":scope > summary").click();
    await expect(thoughts.first()).toHaveAttribute("open", "");
    await expect(thoughts.last()).toHaveAttribute("open", "");
    await expect
      .poll(() =>
        thoughts
          .first()
          .locator(".reasoning-copy")
          .evaluate((node) => node.scrollTop)
      )
      .toBe(52);
    await expect(page.locator(".thinking-spinner")).toHaveCount(0);
    await expect(page.locator('[data-answer-kind="final"]')).toContainText("合成输入核对完成。");
    expect(apiRequests).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("collapsed thinking uses one real sentence and dense streaming keeps its row and animation continuous", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const apiRequests = await renderSyntheticThought(page, dashboard.base, "核对输入");
      const summary = page.locator(".reasoning-details > summary");
      await expect(page.locator(".reasoning-preview")).toHaveText("核对输入");
      await expect(page.locator(".reasoning-copy")).not.toBeVisible();
      await expect(summary).not.toContainText("查看思考过程");
      await expect(page.locator(".reasoning-step .activity-step-head")).toHaveCount(0);
      const result = await page.evaluate(async () => {
        const row = () => document.querySelector(".reasoning-details > summary");
        const step = () => document.querySelector(".reasoning-step");
        const phase = () => row().querySelector(".thinking-spinner").getAnimations()[0].currentTime;
        const before = {
          height: row().getBoundingClientRect().height,
          step: step().getBoundingClientRect().height,
          phase: phase()
        };
        const samples = [];
        const originalRow = row();
        const originalSpinner = row().querySelector(".thinking-spinner");
        const durations = [];
        for (const character of "与本地文件权限".repeat(18)) {
          const started = performance.now();
          window.thoughtFixture.append(character);
          durations.push(performance.now() - started);
          samples.push({
            height: row().getBoundingClientRect().height,
            step: step().getBoundingClientRect().height,
            phase: phase()
          });
          await new Promise((resolve) => setTimeout(resolve, 3));
        }
        return {
          before,
          samples,
          sameRow: row() === originalRow,
          sameSpinner: row().querySelector(".thinking-spinner") === originalSpinner,
          durations,
          preview: row().querySelector(".reasoning-preview").textContent,
          full: document.querySelector(".reasoning-copy").textContent
        };
      });
      for (const sample of result.samples) {
        expect(sample.height).toBe(result.before.height);
        expect(sample.step).toBe(result.before.step);
      }
      expect(result.sameRow).toBe(true);
      expect(result.sameSpinner).toBe(true);
      expect(result.samples.at(-1).phase - result.before.phase).toBeGreaterThan(250);
      expect(Array.from(result.preview).length).toBe(88);
      expect(result.preview.endsWith("…")).toBe(true);
      expect(result.full.length).toBeGreaterThan(result.preview.length);
      const previewLayout = await page.locator(".reasoning-preview").evaluate((node) => ({
        whiteSpace: getComputedStyle(node).whiteSpace,
        textOverflow: getComputedStyle(node).textOverflow,
        width: node.getBoundingClientRect().width,
        summaryWidth: node.parentElement.getBoundingClientRect().width
      }));
      expect(previewLayout.whiteSpace).toBe("nowrap");
      expect(previewLayout.textOverflow).toBe("ellipsis");
      expect(previewLayout.width).toBeLessThan(previewLayout.summaryWidth);
      await test.info().attach(`dense-stream-${width}.json`, {
        body: JSON.stringify({ ...result, previewLayout }, null, 2),
        contentType: "application/json"
      });
      await page.screenshot({ path: test.info().outputPath(`preview-active-${width}.png`) });
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(".reasoning-copy")).toBeVisible();
      await page.evaluate(() => window.thoughtFixture.append("。更多后续思考。"));
      await expect(summary).toBeFocused();
      await expect(page.locator(".reasoning-details")).toHaveAttribute("open", "");
      await page.keyboard.press("Enter");
      await expect(page.locator(".reasoning-details")).not.toHaveAttribute("open", "");
      await page.evaluate(() => window.thoughtFixture.finish("aborted"));
      await expect(page.locator(".thinking-spinner")).toHaveCount(0);
      expect(
        await page
          .locator(".reasoning-step")
          .evaluateAll((nodes) => nodes.map((node) => node.getAnimations({ subtree: true }).length))
      ).toEqual([0, 0]);
      expect(apiRequests).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`preview-${width}.png`) });
      await page.unrouteAll({ behavior: "wait" });
    }
  } finally {
    await dashboard.stop();
  }
});

test("reduced motion keeps the same real thought preview and running status without a rotating animation", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const apiRequests = await renderSyntheticThought(
      page,
      dashboard.base,
      "先检查输入约束。再读取工具结果。"
    );
    await expect(page.locator(".reasoning-preview")).toHaveText("先检查输入约束。");
    await expect(page.locator(".reasoning-state")).toHaveText("思考中");
    const spinner = page.locator(".thinking-spinner");
    await expect(spinner).toBeVisible();
    expect(await spinner.evaluate((node) => node.getAnimations().length)).toBe(0);
    const progress = page.locator(".workflow-progress-spinner");
    await expect(progress).toBeVisible();
    expect(await progress.evaluate((node) => node.getAnimations().length)).toBe(0);
    await page.evaluate(() => window.thoughtFixture.delta());
    await expect(page.locator(".reasoning-preview")).toHaveText("先检查输入约束。");
    await page.locator(".reasoning-details > summary").click();
    await expect(page.locator(".reasoning-copy")).toBeVisible();
    expect(await spinner.evaluate((node) => node.getAnimations().length)).toBe(0);
    expect(apiRequests).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("the actual model's Markdown planning heading is plain when folded and formatted when opened", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    const thought =
      "**Planning project inspection and testing**\nI should read the project instructions first.";
    const apiRequests = await renderSyntheticThought(page, dashboard.base, thought);
    await expect(page.locator(".reasoning-preview")).toHaveText("Planning project inspection and testing");
    await expect(page.locator(".reasoning-copy")).not.toBeVisible();
    await page.evaluate(() => window.thoughtFixture.delta());
    await expect(page.locator(".reasoning-preview")).toHaveText("Planning project inspection and testing");
    await page.locator(".reasoning-details > summary").click();
    await expect(page.locator(".reasoning-copy strong")).toHaveText(
      "Planning project inspection and testing"
    );
    await expect(page.locator(".reasoning-copy")).toContainText(
      "I should read the project instructions first."
    );
    await expect(page.locator(".reasoning-copy")).toContainText("新的片段：保留正在阅读的位置。");
    await expect(page.locator(".reasoning-copy")).not.toContainText("**");
    await page.locator(".activity-raw > summary").click();
    await expect(page.locator(".activity-raw-copy")).toHaveText(thought + "\n新的片段：保留正在阅读的位置。");
    await page.screenshot({ path: test.info().outputPath("thinking-markdown-after.png") });
    expect(apiRequests).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("the first completed sentence stays stable while later thought and tools arrive", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    const apiRequests = await renderSyntheticThought(
      page,
      dashboard.base,
      "Inspect the local file. Keep the answer separate."
    );
    await expect(page.locator(".reasoning-preview")).toHaveText("Inspect the local file.");
    await page.evaluate(() => window.thoughtFixture.delta());
    await expect(page.locator(".reasoning-preview")).toHaveText("Inspect the local file.");
    await page.evaluate(() => window.thoughtFixture.toolThenThought());
    await expect(page.locator(".reasoning-preview").first()).toHaveText("Inspect the local file.");
    await expect(page.locator(".reasoning-preview").last()).toHaveText(
      "文件读取已结束，继续核对内容与要求是否一致。"
    );
    await expect(page.locator(".reasoning-copy").last()).not.toBeVisible();
    await page.evaluate(() => window.thoughtFixture.finish());
    await expect(page.locator(".execution-history")).not.toHaveAttribute("open", "");
    await page.locator(".execution-history > summary").click();
    await expect(page.locator(".reasoning-preview").first()).toHaveText("Inspect the local file.");
    await expect(page.locator(".reasoning-copy").first()).not.toBeVisible();
    await expect(page.locator('[data-answer-kind="final"]')).toHaveText(/合成输入核对完成。/);
    await expect(page.locator('[data-answer-kind="final"]')).not.toContainText("Inspect the local file");
    expect(apiRequests).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("interrupted reasoning retains partial text and distinguishes an ended pre-tool thought from a stopped one", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    for (const stopReason of ["aborted", "error", "length"]) {
      const apiRequests = await renderSyntheticThought(page, dashboard.base);
      await page.evaluate(() => window.thoughtFixture.toolThenThought());
      await page.locator(".reasoning-details").last().locator("summary").click();
      await page.evaluate((reason) => window.thoughtFixture.finish(reason), stopReason);
      await expect(page.locator(".reasoning-step").first()).toContainText("思考完成");
      await expect(page.locator(".reasoning-step").last()).toContainText("思考已停止");
      await expect(page.locator(".reasoning-copy").last()).toBeVisible();
      await expect(page.locator(".reasoning-copy").last()).toContainText("文件读取已结束");
      await expect(page.locator(".thinking-spinner")).toHaveCount(0);
      await expect(page.locator('[data-answer-kind="final"]')).toHaveCount(0);
      expect(apiRequests).toEqual([]);
      await page.unrouteAll({ behavior: "wait" });
    }
  } finally {
    await dashboard.stop();
  }
});
