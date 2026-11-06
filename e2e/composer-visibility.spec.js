import { loadCurrentApplication } from "./application-context-helper.js";
import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const taskId = "composer-visibility";
const marker = "上一轮输出的最后一句必须保持可见。";
const draft = Array.from({ length: 12 }, (_, i) => `第二轮要求 ${i + 1}：继续修改并保留前面的结果。`).join(
  "\n"
);

async function setup(page, dashboard) {
  await page.request.post(`${dashboard.base}/api/tasks`, { data: { taskId, goal: "多轮输入可见性" } });
  await page.route(`**/api/tasks/${taskId}`, async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    await route.fulfill({
      response,
      json: {
        ...detail,
        task: { ...detail.task, status: "completed" },
        runtime: { active: false },
        runtimeEvents: [],
        messages: [
          { role: "user", content: "先给出完整的分析结果。", timestamp: 1 },
          {
            role: "assistant",
            stopReason: "stop",
            timestamp: 2,
            content: [
              {
                type: "text",
                text:
                  Array.from(
                    { length: 22 },
                    (_, i) =>
                      `分析段落 ${i + 1}：这是上一轮已完成的内容，用来检查滚动位置和输入区之间的关系。`
                  ).join("\n\n") +
                  "\n\n" +
                  marker
              }
            ]
          }
        ]
      }
    });
  });
  await page.goto(dashboard.base);
  await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
  await expect(page.getByText(marker, { exact: true })).toHaveCount(1);
}

async function bottom(page) {
  await page.locator("#conversation").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

async function expectUncovered(page) {
  const output = page.getByText(marker, { exact: true });
  await expect
    .poll(async () => {
      const text = await output.boundingBox();
      const composer = await page.locator(".composer-wrap").boundingBox();
      return text.y + text.height <= composer.y - 8;
    })
    .toBe(true);
}

test("typing the next round, adding an attachment and shrinking the draft keep the last answer above the composer at every width", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await setup(page, dashboard);
    for (const width of [1440, 1280, 474, 320]) {
      await page.setViewportSize({ width, height: 650 });
      const input = page.locator("#composer-input");
      await input.fill("");
      await bottom(page);
      await expectUncovered(page);
      await input.fill(draft);
      await expectUncovered(page);
      await page.locator("#file-input").setInputFiles({
        name: "下一轮参考资料.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("本地合成资料")
      });
      await expect(page.locator("#attachment-strip")).toContainText("下一轮参考资料.txt");
      await expectUncovered(page);
      await page.locator("[data-remove-attachment]").click();
      await expect(page.locator("#attachment-strip")).toBeHidden();
      await expectUncovered(page);
      await input.fill("简短的第二轮要求");
      await expectUncovered(page);
      // Read both boxes in the same layout; asynchronous workbench updates may
      // otherwise change the composer between two separate boundingBox calls.
      await expect
        .poll(() =>
          page.evaluate(() => {
            const scroll = document.querySelector("#conversation").getBoundingClientRect();
            const composer = document.querySelector(".composer-wrap").getBoundingClientRect();
            return scroll.bottom - composer.top;
          })
        )
        .toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await expect(input).toBeFocused();
      if (process.env.COWORK_KEEP_COMPOSER_PROBE === "1")
        await page.screenshot({ path: test.info().outputPath(`${width}.png`) });
    }
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await dashboard.stop();
  }
});

test("growing the next-round draft preserves the position while reading older output", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await setup(page, dashboard);
    const scroll = page.locator("#conversation");
    await scroll.evaluate((el) => {
      el.scrollTop = 180;
    });
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    );
    const before = await scroll.evaluate((el) => el.scrollTop);
    await page.locator("#composer-input").fill(draft);
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    );
    expect(await scroll.evaluate((el) => el.scrollTop)).toBeCloseTo(before, 0);
    await expect(page.locator("#composer-input")).toHaveValue(draft);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await dashboard.stop();
  }
});
