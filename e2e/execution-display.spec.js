import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const headings = ["核对脚本路径", "检查 Python 语法", "确认执行结果"];

async function executionFixture(page, base, command) {
  const requests = { api: [], external: [] };
  const origin = new URL(base).origin;
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      requests.external.push(route.request().url());
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  await page.route("**/app.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "// Isolated execution display fixture." })
  );
  await page.route("**/api/**", (route) => {
    requests.api.push(route.request().url());
    return route.fulfill({ status: 500, json: { error: "This display fixture does not use APIs." } });
  });
  await page.goto(base);
  await page.evaluate(
    async ({ titles, command }) => {
      // Exercise the shipped DOM, CSS and conversation controller. These are
      // synthetic Pi records; no command, model or user task is executed.
      const { createConversationView } = await import("/assets/controllers/conversation-view.js");
      const epoch = 1_791_436_167_224;
      const runId = `main-${epoch}`;
      const taskId = "execution-display-fixture";
      const thought = `\n<thinking>${titles.map((title) => `**${title}**`).join("")}`;
      let currentThought = thought;
      let sequence = 0;
      const record = (payload, ms = 0) => ({
        type: "runtime_event",
        eventId: `runtime-${runId}-${sequence++}`,
        runId,
        taskId,
        agentId: "main",
        occurredAt: new Date(epoch + ms).toISOString(),
        payload
      });
      const ledger = (type, ms, ledgerRunId = runId) => ({
        eventId: `event-${ledgerRunId}-${type}-${ms}`,
        type: `main.run_${type}`,
        runId: ledgerRunId,
        occurredAt: new Date(epoch + ms).toISOString(),
        payload: {}
      });
      const user = {
        role: "user",
        content: "合成验收：检查 Python 脚本的路径和语法，按实际执行记录说明结果。",
        timestamp: epoch
      };
      const pathCall = {
        type: "toolCall",
        id: "python-path",
        name: "bash",
        arguments: { command: command || "python3 agents/main/work/create_harness_ppt.py", timeout: 120 }
      };
      const syntaxCall = {
        type: "toolCall",
        id: "python-syntax",
        name: "bash",
        arguments: {
          command:
            "python3 /fixture/workspace/execution-display-fixture/agents/main/work/create_harness_ppt.py",
          timeout: 120
        }
      };
      const assistant = (timestamp, content, stopReason = "toolUse") => ({
        role: "assistant",
        timestamp: epoch + timestamp,
        content,
        stopReason
      });
      const state = {
        selected: taskId,
        localMessages: [],
        executionHistoryOpen: new Map(),
        detail: {
          workspaceRoot: "/fixture/workspace",
          task: {
            taskId,
            status: "running",
            activeRunId: runId,
            createdAt: new Date(epoch - 86_400_000).toISOString()
          },
          runtime: { active: true, runId },
          runtimeRunId: runId,
          coordination: { pending: [], callbackPending: [] },
          events: [
            ledger("spawned", -100_000, "previous-run"),
            ledger("completed", -90_000, "previous-run"),
            ledger("spawned", 0)
          ],
          runtimeEvents: []
        }
      };
      const view = createConversationView({
        state,
        $: (selector) => document.querySelector(selector),
        bindStarterPrompts() {},
        textContent: (content) =>
          typeof content === "string"
            ? content
            : (content || [])
                .filter((part) => part.type === "text")
                .map((part) => part.text || "")
                .join("")
      });
      const push = (payload, ms) => state.detail.runtimeEvents.push(record(payload, ms));
      const update = (type, contentIndex, value = {}) => ({
        type: "message_update",
        assistantMessageEvent: { type, contentIndex, ...value }
      });
      let messages = [user];
      const render = () => view.renderConversation(messages, state.detail.task);
      push({ type: "turn_start" });
      push({ type: "message_start", message: user });
      push({ type: "message_start", message: assistant(1, [], undefined) });
      push(update("text_start", 0));
      // Keep a split provider wrapper in the fixture to test projection of
      // streamed fragments as well as the eventual message snapshot.
      push(update("text_delta", 0, { delta: "\n<thi" }));
      push(update("text_delta", 0, { delta: currentThought.slice(5) }));
      push(update("toolcall_end", 1, { toolCall: pathCall }));
      push(
        { type: "tool_execution_start", toolCallId: pathCall.id, toolName: "bash", args: pathCall.arguments },
        1000
      );
      window.executionFixture = {
        poll: render,
        toolOutput(text) {
          push(
            {
              type: "tool_execution_end",
              toolCallId: pathCall.id,
              toolName: "bash",
              isError: false,
              result: { content: text ? [{ type: "text", text }] : [] }
            },
            3000
          );
          render();
        },
        append(text = "\n\n继续核对工具实际输出。") {
          currentThought += text;
          push(update("text_delta", 0, { delta: text }));
          render();
        },
        missingFile(output) {
          const message = assistant(1, [{ type: "text", text: currentThought }, pathCall]);
          push(update("text_end", 0, { content: currentThought }));
          push({ type: "message_end", message });
          push(
            {
              type: "tool_execution_end",
              toolCallId: pathCall.id,
              toolName: "bash",
              isError: true,
              result: {
                content: [
                  {
                    type: "text",
                    text:
                      output ??
                      "python3: can't open file '/fixture/workspace/agents/main/work/create_harness_ppt.py': [Errno 2] No such file or directory\n\nCommand exited with code 2"
                  }
                ],
                details: {}
              }
            },
            3000
          );
          push({ type: "turn_end", message });
          render();
        },
        startSyntax() {
          push({ type: "turn_start" }, 4000);
          push({ type: "message_start", message: assistant(4000, [], undefined) }, 4000);
          push(update("toolcall_end", 0, { toolCall: syntaxCall }), 4000);
          push(
            {
              type: "tool_execution_start",
              toolCallId: syntaxCall.id,
              toolName: "bash",
              args: syntaxCall.arguments
            },
            4000
          );
          render();
        },
        syntaxError() {
          const message = assistant(4000, [syntaxCall]);
          push({ type: "message_end", message }, 7000);
          push(
            {
              type: "tool_execution_end",
              toolCallId: syntaxCall.id,
              toolName: "bash",
              isError: true,
              result: {
                content: [
                  {
                    type: "text",
                    text: '  File "/fixture/workspace/execution-display-fixture/agents/main/work/create_harness_ppt.py", line 226\n    title = "unfinished\n                         ^\nSyntaxError: EOL while scanning string literal\n\nCommand exited with code 1'
                  }
                ],
                details: {}
              }
            },
            7000
          );
          push({ type: "turn_end", message }, 7000);
          render();
        },
        finish() {
          const final = assistant(
            181_000,
            [
              {
                type: "text",
                text: "已按实际工具返回定位路径和语法问题。本合成验收保留完整执行记录。"
              }
            ],
            "stop"
          );
          push({ type: "turn_start" }, 180_000);
          push({ type: "message_start", message: final }, 180_000);
          push({ type: "message_end", message: final }, 181_000);
          push({ type: "turn_end", message: final }, 181_000);
          const completed = ledger("completed", 181_000);
          state.detail.events.push(completed, { ...completed });
          state.detail.runtime.active = false;
          state.detail.task.status = "completed";
          state.detail.task.completion = { signal: "natural_stop" };
          messages = [user, final];
          render();
        }
      };
      document.querySelector("#topbar-task").textContent = "执行记录显示验收";
      render();
    },
    { titles: headings, command }
  );
  return requests;
}

async function completeFixture(page) {
  await page.evaluate(() => {
    window.executionFixture.missingFile();
    window.executionFixture.startSyntax();
    window.executionFixture.syntaxError();
    window.executionFixture.finish();
  });
}

async function saveEvidence(page, name) {
  const image = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path: image });
  const layout = await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    document: {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    },
    conversation: {
      clientWidth: document.querySelector("#conversation").clientWidth,
      scrollWidth: document.querySelector("#conversation").scrollWidth
    },
    paragraphs: Array.from(document.querySelectorAll(".reasoning-copy > p"), (node) => ({
      text: node.textContent,
      fontSize: getComputedStyle(node).fontSize,
      lineHeight: getComputedStyle(node).lineHeight,
      bounds: { width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }
    })),
    details: Array.from(document.querySelectorAll("#conversation details"), (node) => ({
      className: node.className,
      open: node.open,
      focused: node.querySelector(":scope > summary") === document.activeElement
    })),
    spinnerAnimations: Array.from(
      document.querySelectorAll(".thinking-spinner, .tool-progress-spinner"),
      (node) =>
        node
          .getAnimations()
          .map((animation) => ({ playState: animation.playState, currentTime: animation.currentTime }))
    )
  }));
  await writeFile(test.info().outputPath(`${name}.json`), JSON.stringify(layout, null, 2));
  await test.info().attach(name, { path: image, contentType: "image/png" });
  await test
    .info()
    .attach(`${name}-layout`, { body: JSON.stringify(layout, null, 2), contentType: "application/json" });
  return layout;
}

async function expectCompactClean(page) {
  const visible = await page.locator("#conversation").innerText();
  expect(visible).not.toMatch(/<\/?think(?:ing)?>|\*{4,}|\bcommand=|\btimeout=/i);
  await expect(page.locator(".tool-subject").first()).toHaveText("create_harness_ppt.py");
  await expect(page.locator(".tool-action > strong").first()).toHaveText("运行 Python 脚本");
}

test("a compound command failure names the command group and retains successful probe output", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    const requests = await executionFixture(
      page,
      dashboard.base,
      "printf 'PATH=%s\\n' \"$PATH\"; ls /fixture/task/agents/main/work"
    );
    await page.evaluate(() =>
      window.executionFixture.missingFile(
        "PATH=/usr/bin:/bin\nls: /fixture/task/agents/main/work: No such file or directory\n\nCommand exited with code 1"
      )
    );
    const tool = page.locator(".tool-step").first();
    await expect(tool).toHaveClass(/is-failed/);
    await expect(tool.locator(".tool-action > strong")).toHaveText("执行组合命令");
    await expect(tool.locator(".tool-subject")).toHaveText("printf 等命令");
    await expect(tool.locator(".tool-context")).toHaveText("文件或目录不存在");
    await tool.locator(".tool-details > summary").click();
    await expect(tool.locator(".tool-details-body")).toContainText("PATH=/usr/bin:/bin");
    await expect(tool.locator(".tool-details-body")).toContainText("Command exited with code 1");
    expect(requests).toEqual({ api: [], external: [] });
  } finally {
    await dashboard.stop();
  }
});

test("provider thinking envelopes, failure evidence, raw details and keyboard state survive updates and completion", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    const requests = await executionFixture(page, dashboard.base);
    await expectCompactClean(page);
    const thought = page.locator(".reasoning-details").first();
    const thoughtSummary = thought.locator(":scope > summary");
    await expect(thoughtSummary.locator(".reasoning-preview")).toHaveText(headings[0]);
    await expect(thought.locator(".reasoning-copy")).not.toBeVisible();
    await thoughtSummary.focus();
    await page.keyboard.press("Enter");
    await expect(thought).toHaveAttribute("open", "");
    await expect(thought.locator(".reasoning-copy > p")).toHaveText(headings);
    const sizes = await thought
      .locator(".reasoning-copy > p")
      .evaluateAll((nodes) => nodes.map((node) => parseFloat(getComputedStyle(node).fontSize)));
    expect(sizes).toEqual([14, 14, 14]);
    await page.evaluate(() => window.executionFixture.append());
    await expect(thoughtSummary).toBeFocused();
    await expect(thought).toHaveAttribute("open", "");
    await page.evaluate(() => window.executionFixture.poll());
    await expect(thoughtSummary).toBeFocused();

    const rawThought = thought.locator(".activity-raw");
    await rawThought.locator(":scope > summary").focus();
    await page.keyboard.press("Enter");
    await expect(rawThought.locator(".activity-raw-copy")).toContainText(
      "<thinking>**核对脚本路径****检查 Python 语法****确认执行结果**"
    );
    await page.evaluate(() => window.executionFixture.append("\n继续保留原始片段。"));
    await expect(rawThought).toHaveAttribute("open", "");
    await expect(rawThought.locator(":scope > summary")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(rawThought).not.toHaveAttribute("open", "");
    await page.evaluate(() => window.executionFixture.missingFile());
    await expect(page.locator(".tool-step").first()).toHaveClass(/is-failed/);
    await expect(page.locator(".tool-context").first()).toHaveText("文件或目录不存在");
    await expect(page.locator(".tool-duration").first()).toHaveText("2.0 秒");

    const tool = page.locator(".tool-details").first();
    const toolSummary = tool.locator(":scope > summary");
    await toolSummary.focus();
    await page.keyboard.press("Enter");
    await expect(tool).toHaveAttribute("open", "");
    await expect(tool.locator(".tool-details-body")).toContainText(
      '"command": "python3 agents/main/work/create_harness_ppt.py"'
    );
    await expect(tool.locator(".tool-details-body")).toContainText('"timeout": 120');
    await expect(tool.locator(".tool-details-body")).toContainText("Command exited with code 2");
    await page.evaluate(() => window.executionFixture.startSyntax());
    await expect(tool).toHaveAttribute("open", "");
    await expect(toolSummary).toBeFocused();
    await page.evaluate(() => window.executionFixture.syntaxError());
    await expect(page.locator(".tool-context").last()).toHaveText("Python 第 226 行语法错误");
    await expect(toolSummary).toBeFocused();
    await page.evaluate(() => window.executionFixture.poll());
    await expect(toolSummary).toBeFocused();
    await saveEvidence(page, "failed-tools-expanded-active");

    await page.evaluate(() => window.executionFixture.finish());
    const history = page.locator(".execution-history");
    await expect(history).not.toHaveAttribute("open", "");
    await expect(history.locator(":scope > summary")).toContainText("用时 3分钟1秒");
    await expect(history.locator(":scope > summary")).toContainText("2 次调用未成功");
    await expect(history.locator(":scope > summary")).toBeFocused();
    await expect(page.locator(".thinking-spinner, .tool-progress-spinner")).toHaveCount(0);
    await expect(page.locator('[data-answer-kind="final"]')).toContainText(
      "已按实际工具返回定位路径和语法问题"
    );
    await page.keyboard.press("Enter");
    await expect(history).toHaveAttribute("open", "");
    await expect(thought).toHaveAttribute("open", "");
    await expect(tool).toHaveAttribute("open", "");
    await page.evaluate(() => window.executionFixture.poll());
    await expect(history.locator(":scope > summary")).toBeFocused();
    await expect
      .poll(() =>
        page
          .locator(".live-workflow")
          .evaluate(
            (node) =>
              node.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running")
                .length
          )
      )
      .toBe(0);
    await saveEvidence(page, "completed-history-expanded");
    expect(requests).toEqual({ api: [], external: [] });
  } finally {
    await dashboard.stop();
  }
});

for (const width of [1440, 768, 320]) {
  test(`execution history and readable details fit a ${width}px viewport`, async ({ page }) => {
    const dashboard = await startDashboard();
    try {
      await page.setViewportSize({ width, height: 900 });
      const requests = await executionFixture(page, dashboard.base);
      await completeFixture(page);
      const history = page.locator(".execution-history");
      await expect(history).not.toHaveAttribute("open", "");
      await expect(history.locator(":scope > summary > strong")).toHaveText("用时 3分钟1秒");
      await expectCompactClean(page);
      await saveEvidence(page, `completed-folded-${width}`);
      await history.locator(":scope > summary").click();
      await saveEvidence(page, `completed-rows-${width}`);
      await page.locator(".reasoning-details > summary").first().click();
      await page.locator(".tool-details > summary").first().click();
      await expect(page.locator(".reasoning-copy > p")).toHaveText(headings);
      await expect(page.locator(".tool-context").first()).toHaveText("文件或目录不存在");
      await expect(page.locator(".tool-context").last()).toContainText("Python 第 226 行语法错误");
      const summary = await page.locator(".tool-details > summary").first().boundingBox();
      const action = await page.locator(".tool-action").first().boundingBox();
      // The verb starts after the row's 16px status mark and its 8px gap.
      expect(action.x).toBeCloseTo(summary.x + 24, 0);
      await expect(page.locator(".tool-step").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(page.locator(".tool-step .activity-status").first()).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)"
      );
      await expect(page.locator(".tool-action").first()).toHaveCSS(
        "flex-direction",
        width === 320 ? "column" : "row"
      );
      if (width === 320)
        await expect(page.locator(".tool-subject").first()).toHaveText("create_harness_ppt.py");
      await expectCompactClean(page);
      const layout = await saveEvidence(page, `completed-expanded-${width}`);
      expect(layout.document.scrollWidth).toBeLessThanOrEqual(layout.document.clientWidth + 1);
      expect(layout.conversation.scrollWidth).toBeLessThanOrEqual(layout.conversation.clientWidth + 1);
      expect(layout.paragraphs.map((paragraph) => paragraph.fontSize)).toEqual(["14px", "14px", "14px"]);
      for (const selector of [
        ".execution-history > summary",
        ".reasoning-details > summary",
        ".tool-details > summary",
        ".tool-details-body",
        ".tool-context"
      ]) {
        const boxes = await page.locator(selector).evaluateAll((nodes) =>
          nodes
            .filter((node) => node.checkVisibility())
            .map((node) => ({
              left: node.getBoundingClientRect().left,
              right: node.getBoundingClientRect().right
            }))
        );
        for (const box of boxes) {
          expect(box.left).toBeGreaterThanOrEqual(-1);
          expect(box.right).toBeLessThanOrEqual(width + 1);
        }
      }
      expect(requests).toEqual({ api: [], external: [] });
    } finally {
      await dashboard.stop();
    }
  });
}

test("independent detail reading positions survive streamed updates and reopening", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    // Long arguments and long output make both detail sections scrollable.
    const longCommand = `python3 ${"agents/main/work/synthetic-folder/".repeat(60)}check.py`;
    const requests = await executionFixture(page, dashboard.base, longCommand);
    await page.evaluate(() => window.executionFixture.toolOutput("synthetic output line\n".repeat(100)));
    const tool = page.locator(".tool-details").first();
    await tool.locator(":scope > summary").click();
    const parameters = tool.locator('[data-reading-key="参数"]');
    const returned = tool.locator('[data-reading-key="返回结果"]');
    await parameters.evaluate((node) => {
      node.scrollTop = 91;
    });
    await returned.evaluate((node) => {
      node.scrollTop = 123;
    });
    await expect.poll(() => parameters.evaluate((node) => node.scrollTop)).toBe(91);
    await expect.poll(() => returned.evaluate((node) => node.scrollTop)).toBe(123);
    await page.evaluate(() => window.executionFixture.append());
    await expect.poll(() => parameters.evaluate((node) => node.scrollTop)).toBe(91);
    await expect.poll(() => returned.evaluate((node) => node.scrollTop)).toBe(123);
    await tool.locator(":scope > summary").click();
    await page.evaluate(() => window.executionFixture.append("\n继续保留技术详情的阅读位置。"));
    await tool.locator(":scope > summary").click();
    await expect.poll(() => returned.evaluate((node) => node.scrollTop)).toBe(123);
    expect(requests).toEqual({ api: [], external: [] });
  } finally {
    await dashboard.stop();
  }
});

test("reduced motion retains actual busy state and tool progress without rotating animations", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const requests = await executionFixture(page, dashboard.base);
    await expect(page.locator('[data-answer-kind="pending"]')).toHaveAttribute("aria-busy", "true");
    await expect(page.locator(".reasoning-state").first()).toHaveText("思考中");
    await expect(page.locator(".tool-step .activity-status").first()).toHaveText("执行中");
    const spinners = page.locator(".thinking-spinner, .tool-progress-spinner");
    await expect(spinners).toHaveCount(2);
    expect(await spinners.evaluateAll((nodes) => nodes.map((node) => node.getAnimations().length))).toEqual([
      0, 0
    ]);
    await page.evaluate(() => window.executionFixture.append());
    await expect(page.locator(".reasoning-preview").first()).toHaveText(headings[0]);
    await expect(page.locator('[data-answer-kind="pending"]')).toHaveAttribute("aria-busy", "true");
    const layout = await saveEvidence(page, "reduced-motion-active");
    expect(layout.spinnerAnimations).toEqual([[], []]);
    await completeFixture(page);
    await expect(page.locator(".thinking-spinner, .tool-progress-spinner")).toHaveCount(0);
    await expect(page.locator('[data-answer-kind="pending"]')).toHaveCount(0);
    await expect(page.locator(".execution-history > summary")).toContainText("用时 3分钟1秒");
    expect(requests).toEqual({ api: [], external: [] });
  } finally {
    await dashboard.stop();
  }
});
