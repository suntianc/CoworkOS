import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const taskId = "polish_task";

async function seedConversation(page, dashboard) {
  await page.request.post(`${dashboard.base}/api/tasks`, { data: { taskId, goal: "打磨回归会话" } });
  const detail = await (await page.request.get(`${dashboard.base}/api/tasks/${taskId}`)).json();
  await page.route(`**/api/tasks/${taskId}`, (route) =>
    route.fulfill({
      json: {
        ...detail,
        task: {
          ...detail.task,
          status: "completed",
          completion: { policy: "natural", signal: "natural_stop" }
        },
        runtime: { active: false },
        messages: [
          { role: "user", content: "说明结果", timestamp: 1 },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "先看看目录" },
              { type: "toolCall", id: "t1", name: "bash", arguments: { command: "cd src && ls" } }
            ],
            timestamp: 2,
            stopReason: "toolUse"
          },
          {
            role: "toolResult",
            toolCallId: "t1",
            toolName: "bash",
            content: [{ type: "text", text: "app.js" }],
            timestamp: 3
          },
          {
            role: "assistant",
            content: "可以选中并复制的正文 `code`。\n\n第二段正文。\n\n## 小结\n\n```js\nconst a = 1;\n```",
            timestamp: 4,
            stopReason: "stop"
          }
        ]
      }
    })
  );
}

test("desktop chrome keeps a top drag band while pane content stays selectable", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await seedConversation(page, dashboard);
    await page.goto(dashboard.base);
    // The preload script sets this flag in the native host; the browser stands in for it.
    await page.evaluate(() => {
      document.documentElement.dataset.desktopPlatform = "darwin";
    });
    await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
    const final = page.locator('[data-answer-kind="final"]');
    await expect(final).toContainText("可以选中并复制的正文");

    // Chromium outside Electron does not compute -webkit-app-region; the
    // desktop titlebar spec checks the regions in the native host.
    expect(await page.locator("#work-entry").evaluate((node) => getComputedStyle(node).userSelect)).toBe(
      "text"
    );
    const band = await page.locator("#app-titlebar").boundingBox();
    const main = await page.locator("#work-entry").boundingBox();
    expect(band).toMatchObject({ x: 0, y: 0, height: 44 });
    expect(band.y + band.height).toBeLessThanOrEqual(main.y);
    expect(await page.locator(".titlebar-lead").evaluate((node) => getComputedStyle(node).paddingLeft)).toBe(
      "84px"
    );

    // Dragging across the answer selects its text.
    const paragraph = final.locator(".markdown-body p").first();
    const box = await paragraph.boundingBox();
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    expect(await page.evaluate(() => getSelection().toString())).toContain("可以选中");
  } finally {
    await dashboard.stop();
  }
});

test("the composer accepts typing only after the first draft restore", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    // Hold the draft lease: restoring the leased draft writes the input, so
    // the composer must refuse typing until that restore has happened.
    await page.addInitScript(() => {
      const request = navigator.locks.request.bind(navigator.locks);
      const gate = new Promise((resolve) => (window.releaseDraftLease = resolve));
      navigator.locks.request = (...args) => gate.then(() => request(...args));
    });
    await page.goto(dashboard.base);
    const input = page.locator("#composer-input");
    await expect(input).toHaveAttribute("aria-busy", "true");
    await expect(input).not.toBeEditable();
    await page.evaluate(() => window.releaseDraftLease());
    await expect(input).toBeEditable();
    await expect(input).not.toHaveAttribute("aria-busy");
    // Typing while the backend still loads survives the rest of startup.
    await input.fill("就绪后输入的文字");
    await expect(page.locator("#entry-work")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(input).toHaveValue("就绪后输入的文字");
  } finally {
    await dashboard.stop();
  }
});

/** Text below the WCAG AA ratio for its size, skipping disabled and inert previews. */
const lowContrastText = () => {
  const parse = (value) => {
    const match = value.match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map(Number);
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  };
  const luminance = (rgb) =>
    rgb
      .slice(0, 3)
      .map((value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const over = (top, base) =>
    top.slice(0, 3).map((value, index) => value * top[3] + base[index] * (1 - top[3]));
  const pageBase = document.documentElement.dataset.theme === "light" ? [244, 244, 248] : [14, 14, 15];
  const background = (element) => {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color && color[3] > 0) {
        layers.push(color);
        if (color[3] >= 1) break;
      }
    }
    return layers.reduceRight((base, layer) => over(layer, base), pageBase);
  };
  const failures = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const element = walker.currentNode.parentElement;
    if (!walker.currentNode.textContent.trim() || seen.has(element)) continue;
    seen.add(element);
    if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    if (element.closest("[disabled], [aria-disabled='true'], [inert], .settings-group.is-placeholder, svg"))
      continue;
    const style = getComputedStyle(element);
    let opacity = 1;
    for (let node = element; node; node = node.parentElement)
      opacity *= Number(getComputedStyle(node).opacity);
    if (opacity < 0.75) continue;
    const back = background(element);
    const text = parse(style.color);
    const fore = over([text[0], text[1], text[2], text[3] * opacity], back);
    const [high, low] = [luminance(fore), luminance(back)].sort((a, b) => b - a);
    const ratio = (high + 0.05) / (low + 0.05);
    const size = parseFloat(style.fontSize);
    const required = size >= 24 || (Number(style.fontWeight) >= 700 && size >= 18.66) ? 3 : 4.5;
    if (ratio < required)
      failures.push(`${ratio.toFixed(2)} ${walker.currentNode.textContent.trim().slice(0, 24)}`);
  }
  return failures;
};

for (const theme of ["dark", "light"]) {
  test(`text keeps AA contrast in the ${theme} theme`, async ({ page }) => {
    const dashboard = await startDashboard();
    try {
      await seedConversation(page, dashboard);
      await page.goto(dashboard.base);
      await page.getByRole("button", { name: "设置", exact: true }).first().click();
      await page.getByRole("radio", { name: theme === "dark" ? "深色" : "浅色", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      expect(await page.evaluate(lowContrastText), "settings").toEqual([]);
      await page.locator("#settings-back").click();
      await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
      await expect(page.locator('[data-answer-kind="final"]')).toContainText("可以选中");
      expect(await page.evaluate(lowContrastText), "conversation").toEqual([]);
      await page.locator("#entry-observe").click();
      await expect(page.locator("#observe-entry, [data-entry-panel='observe']").first()).toBeVisible();
      expect(await page.evaluate(lowContrastText), "observe").toEqual([]);
    } finally {
      await dashboard.stop();
    }
  });
}

test("the main panel edge resizes the sidebar without a dividing line, and margins match settings", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(dashboard.base);
    const main = await page.locator("#work-entry").boundingBox();
    expect(Math.round(1440 - (main.x + main.width))).toBe(10);
    const divider = page.locator("#sidebar-divider");
    expect(await divider.evaluate((node) => getComputedStyle(node, "::after").opacity)).toBe("0");
    const handle = await divider.boundingBox();
    expect(handle.x + handle.width).toBeGreaterThan(main.x);
    expect(handle.x).toBeLessThan(main.x);

    const before = (await page.locator("#conversation-sidebar").boundingBox()).width;
    await page.mouse.move(main.x + 1, main.y + 300);
    await page.mouse.down();
    await page.mouse.move(main.x + 61, main.y + 300, { steps: 6 });
    await page.mouse.up();
    const after = (await page.locator("#conversation-sidebar").boundingBox()).width;
    expect(Math.round(after - before)).toBe(60);

    await page.getByRole("button", { name: "设置", exact: true }).first().click();
    const settings = await page.locator(".settings-content").boundingBox();
    expect(Math.round(1440 - (settings.x + settings.width))).toBe(10);
  } finally {
    await dashboard.stop();
  }
});

test("conversation rows and steps keep their geometry on hover", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await seedConversation(page, dashboard);
    await page.goto(dashboard.base);
    const row = page.locator(`.conversation-item[data-task="${taskId}"]`);
    await row.click();
    const final = page.locator('[data-answer-kind="final"]');
    await expect(final).toContainText("第二段正文");

    // The answer follows the collapsed history at its own paragraph rhythm.
    const gaps = await page.locator("#conversation").evaluate((root) => {
      const header = root.querySelector(".execution-history > summary").getBoundingClientRect();
      const [first, second] = root.querySelectorAll('[data-answer-kind="final"] .markdown-body p');
      return {
        header: Math.round(first.getBoundingClientRect().top - header.bottom),
        paragraph: Math.round(second.getBoundingClientRect().top - first.getBoundingClientRect().bottom)
      };
    });
    expect(gaps.header).toBe(gaps.paragraph);

    // A hovered step only changes colour.
    await page.locator(".execution-history > summary").click();
    const step = page.locator(".tool-step").first();
    await expect(step).toBeVisible();
    await page.mouse.move(0, 0);
    const resting = await step.locator("summary").boundingBox();
    await step.locator("summary").hover();
    await page.waitForTimeout(300);
    expect(await step.locator("summary").boundingBox()).toEqual(resting);

    // Hover quick actions sit on the row without their own fill or a light fade mask.
    await row.hover();
    const quick = page.locator(`.conversation-row:has([data-task="${taskId}"]) .conversation-quick`);
    await expect(quick).toHaveCSS("opacity", "1");
    expect(
      await quick
        .locator("button")
        .first()
        .evaluate((node) => getComputedStyle(node).backgroundColor)
    ).toBe("rgba(0, 0, 0, 0)");
  } finally {
    await dashboard.stop();
  }
});
