import { test, expect } from "@playwright/test";
import { loadCurrentApplication } from "./application-context-helper.js";
import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { startDashboard } from "../test/dashboard-fixture.mjs";

async function seed(page, dashboard, { failed = false } = {}) {
  const taskId = "reading-width";
  await page.request.post(`${dashboard.base}/api/tasks`, { data: { taskId, goal: "阅读列验收" } });
  const user = { role: "user", timestamp: 1, content: "请核对这份合成报告。" };
  let humanQuestion;
  const answer = {
    role: "assistant",
    timestamp: 2,
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: "核对工具结果。" },
      {
        type: "text",
        text: `${"一段可读的报告正文。\n\n".repeat(40)}\n\`\`\`js\n${"long_code_".repeat(100)}\n\`\`\`\n\n| 列 | 值 |\n| --- | --- |\n| ${"long_cell_".repeat(60)} | 内容 |`
      }
    ]
  };
  await page.route(`**/api/tasks/${taskId}`, async (route) => {
    const detail = await (await route.fetch()).json();
    return route.fulfill({
      json: {
        ...detail,
        task: {
          ...detail.task,
          status: failed ? "failed" : "completed",
          lastError: failed ? "Synthetic connection failure" : undefined
        },
        runtime: { active: false },
        humanRequests: humanQuestion ? [humanQuestion] : [],
        messages: [user, answer],
        runtimeEvents: [
          { type: "turn_start" },
          { type: "message_start", message: user },
          { type: "message_start", message: answer },
          { type: "tool_execution_start", toolCallId: "read", toolName: "read" },
          { type: "tool_execution_end", toolCallId: "read", toolName: "read", result: "合成工具结果" },
          { type: "message_end", message: answer },
          { type: "turn_end", message: answer }
        ].map((payload, index) => ({
          type: "runtime_event",
          runId: "reading-run",
          eventId: `reading-event-${index}`,
          payload
        }))
      }
    });
  });
  await page.goto(dashboard.base);
  await expect(page.locator(failed ? ".request-error" : ".chat-message.main")).toBeVisible();
  return {
    setHumanQuestion(request) {
      humanQuestion = request;
    },
    append(text) {
      answer.content[1].text += `\n\n${text}`;
    }
  };
}

async function geometry(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const { x, width } = document.querySelector(selector).getBoundingClientRect();
      return { x, width, center: x + width / 2 };
    };
    return {
      pane: rect("#conversation-pane"),
      answer: rect(".chat-message.main"),
      user: rect(".chat-message.user"),
      history: rect(".execution-history"),
      composer: rect(".composer"),
      pageWidth: document.documentElement.scrollWidth
    };
  });
}

async function checkColumn(page) {
  const boxes = await geometry(page);
  for (const key of ["answer", "history", "composer"]) {
    expect(boxes[key].width, key).toBeLessThanOrEqual(960.5);
    expect(Math.abs(boxes[key].center - boxes.pane.center), key).toBeLessThanOrEqual(1);
    expect(Math.abs(boxes[key].x - boxes.composer.x), key).toBeLessThanOrEqual(1);
    expect(Math.abs(boxes[key].width - boxes.composer.width), key).toBeLessThanOrEqual(1);
  }
  expect(
    Math.abs(boxes.user.x + boxes.user.width - boxes.composer.x - boxes.composer.width)
  ).toBeLessThanOrEqual(1);
  expect(boxes.pageWidth).toBeLessThanOrEqual(page.viewportSize().width);
  return boxes;
}

test("failure recovery stays within the shared column", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await seed(page, dashboard, { failed: true });
    for (const width of [1440, 2560, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator(".request-error")).toBeVisible();
      const error = await page.locator(".request-error").boundingBox();
      const composer = await page.locator(".composer").boundingBox();
      expect(error.x).toBeCloseTo(composer.x, 0);
      expect(error.width).toBeCloseTo(composer.width, 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await dashboard.stop();
  }
});

test("reading columns stay within the viewport across desktop and mobile breakpoints", async ({
  page
}, info) => {
  const dashboard = await startDashboard();
  try {
    await page.emulateMedia({ colorScheme: "light" });
    await seed(page, dashboard);
    await page.locator("#composer-input").fill("边界窗口保留草稿");
    for (const width of [900, 901, 959, 960, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      for (const right of [false, true]) {
        const body = page.locator("body");
        if ((await body.evaluate((node) => node.classList.contains("output-collapsed"))) !== right) {
          await page.locator("#output-pane-toggle").click();
        }
        await checkColumn(page);
        const content = await page.locator(".chat-message.main").boundingBox();
        for (const selector of [".chat-message.main pre", ".chat-message.main table"]) {
          const box = await page.locator(selector).boundingBox();
          expect(box.x).toBeGreaterThanOrEqual(content.x - 1);
          expect(box.x + box.width).toBeLessThanOrEqual(content.x + content.width + 1);
        }
        expect(
          await page.locator(".chat-message.main pre").evaluate((node) => node.scrollWidth > node.clientWidth)
        ).toBe(true);
        await expect(page.locator("#composer-input")).toHaveValue("边界窗口保留草稿");
        await page.screenshot({ path: info.outputPath(`boundary-${width}-${Number(right)}.png`) });
        if (width > 900) {
          const divider = page.locator("#sidebar-divider");
          await divider.focus();
          await divider.press("End");
          await checkColumn(page);
          await divider.press("Home");
          await checkColumn(page);
        }
      }
    }
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await dashboard.stop();
  }
});
