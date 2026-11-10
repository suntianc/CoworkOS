import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { chooseAppearance, closeSettings } from "./settings-helper.js";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

async function uiColors(page) {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    probe.hidden = true;
    document.body.append(probe);
    const colors = Object.fromEntries(
      ["bg", "panel", "text", "secondary"].map((name) => {
        probe.style.color = `var(--ui-${name})`;
        return [name, getComputedStyle(probe).color];
      })
    );
    for (const [key, name] of [
      ["panelFill", "--panel-fill"],
      ["composerFill", "--composer-fill"],
      ["popoverFill", "--popover-fill"]
    ]) {
      probe.style.color = "";
      probe.style.backgroundColor = `var(${name})`;
      colors[key] = getComputedStyle(probe).backgroundColor;
    }
    probe.remove();
    return colors;
  });
}

test("system appearance responds to OS changes while the page remains open", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.addInitScript(() => {
      if (!localStorage.getItem("atria.appearance")) localStorage.setItem("atria.appearance", "system");
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(dashboard.base);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  } finally {
    await dashboard.stop();
  }
});

for (const initial of ["light", "dark"]) {
  test(`appearance follows a ${initial} OS and system changes preserve session state`, async ({ page }) => {
    const dashboard = await startDashboard();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.addInitScript(() => {
        if (!localStorage.getItem("atria.appearance")) localStorage.setItem("atria.appearance", "system");
      });
      await page.request.post(`${dashboard.base}/api/tasks`, {
        data: { taskId: "theme", goal: "Theme fixture" }
      });
      await page.emulateMedia({ colorScheme: initial });
      await page.goto(dashboard.base);
      await page.locator('.conversation-item[data-task="theme"]').click();
      const input = page.locator("#composer-input");
      await input.fill("未发送的草稿 preserved");
      await input.evaluate((element) => {
        element.focus();
        element.setSelectionRange(2, 8);
        window.themeInput = element;
      });
      await expect(page.locator("html")).toHaveAttribute("data-theme", initial);
      await expect(page.locator("html")).toHaveAttribute("data-appearance", "system");
      const geometry = await input.boundingBox();
      for (const colorScheme of [initial, "light", "dark", "light"]) {
        await page.emulateMedia({ colorScheme });
        await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
        await expect(page.locator("html")).toHaveAttribute("data-appearance", "system");
        const colors = await uiColors(page);
        await expect(page.locator(".chat-pane")).toHaveCSS("background-color", colors.panelFill);
        await expect(page.locator(".composer")).toHaveCSS("background-color", colors.composerFill);
        await expect(input).toHaveValue("未发送的草稿 preserved");
        await expect(input).toBeFocused();
        expect(
          await input.evaluate((element) => [
            element === window.themeInput,
            element.selectionStart,
            element.selectionEnd
          ])
        ).toEqual([true, 2, 8]);
        expect(await input.boundingBox()).toEqual(geometry);
        await expect(input).toHaveCSS("color", colors.text);
      }
      await page.locator("#user-menu-button").click();
      await expect(page.locator('[data-appearance-value="system"]')).toHaveAttribute("aria-checked", "true");
      await expect(page.locator("#settings-entry .settings-content")).toHaveCSS(
        "background-color",
        (await uiColors(page)).panelFill
      );
      await chooseAppearance(page, "dark");
      await expect(page.locator("#settings-entry .settings-content")).toHaveCSS(
        "background-color",
        (await uiColors(page)).panelFill
      );
      expect(errors).toEqual([]);
    } finally {
      await dashboard.stop();
    }
  });
}

// Read rendered element colors and composite actual ancestor surfaces, including
// translucent sidebar chrome. Token values alone do not detect legacy overrides.
async function textContrast(locator, pseudo = null) {
  return locator.evaluate((element, pseudoElement) => {
    const rgba = (color) => {
      const values = color.match(/[\d.]+/g).map(Number);
      return [...values.slice(0, 3), values[3] ?? 1];
    };
    const composite = (foreground, background) =>
      foreground
        .slice(0, 3)
        .map((value, index) => value * foreground[3] + background[index] * (1 - foreground[3]));
    let background = [255, 255, 255];
    const ancestors = [];
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) ancestors.unshift(ancestor);
    for (const ancestor of ancestors)
      background = composite(rgba(getComputedStyle(ancestor).backgroundColor), background);
    const foreground = composite(rgba(getComputedStyle(element, pseudoElement).color), background);
    const luminance = (rgb) =>
      rgb
        .map((channel) => {
          const linear = channel / 255;
          return linear <= 0.04045 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const light = Math.max(luminance(foreground), luminance(background));
    const dark = Math.min(luminance(foreground), luminance(background));
    return { foreground, background, ratio: (light + 0.05) / (dark + 0.05) };
  }, pseudo);
}

test("a real conversation keeps light markdown readable and user messages inside their rounded bubble", async ({
  page
}) => {
  const provider = await modelProtocolFixture("openai-completions", () => ({
    text: [
      "## 项目进展",
      "",
      "正文保持清晰，**重点信息**也能阅读。",
      "",
      "### 下一步安排",
      "",
      "> 引用内容同样可读。",
      "",
      "使用 `inline-value` 检查代码。",
      "",
      "```text",
      "Readable code block",
      "```"
    ].join("\n")
  }));
  const dashboard = await startDashboard({ modelEndpoint: provider.baseUrl });
  try {
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("请展示一段包含标题和代码的项目进展。");
    await page.locator("#composer-input").press("Enter");
    const answer = page.locator('.chat-message.main[data-answer-kind="final"] .markdown-body');
    await expect(answer.getByRole("heading", { name: "项目进展", exact: true })).toBeVisible({
      timeout: 30_000
    });
    await page.screenshot({ path: test.info().outputPath("light-conversation.png"), fullPage: true });
    for (const selector of ["h2", "h3", "p", "strong", "blockquote", "p code", "pre code"]) {
      const text = answer.locator(selector).first();
      await expect(text).toBeVisible();
      const colors = await textContrast(text);
      expect.soft(colors.ratio, `${selector}: ${JSON.stringify(colors)}`).toBeGreaterThanOrEqual(4.5);
    }
    const user = page.locator(".chat-message.user");
    await expect(user).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const bubble = user.locator(".user-message-bubble");
    const shape = await bubble.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, radius: Number.parseFloat(style.borderTopLeftRadius) };
    });
    expect(shape.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(shape.radius).toBeGreaterThanOrEqual(16);
    const userColors = await textContrast(bubble.locator(".markdown-body"));
    expect(userColors.ratio, JSON.stringify(userColors)).toBeGreaterThanOrEqual(4.5);
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});

test("light search and sidebar text remain readable in ordinary and hovered states", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    const otherRoot = `${dashboard.root}/other-project`;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(otherRoot);
    for (const task of [
      { taskId: "theme-selected", goal: "Selected project" },
      { taskId: "theme-unselected", goal: "Other project", workspaceRoot: otherRoot }
    ]) {
      const response = await page.request.post(`${dashboard.base}/api/tasks`, { data: task });
      expect(response.ok()).toBe(true);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(dashboard.base);
    await page.locator('.conversation-item[data-task="theme-selected"]').click();
    await chooseAppearance(page, "light");
    await closeSettings(page);
    const brand = page.locator(".brand-lockup strong");
    const project = page.locator(".project-group:not(.is-selected) .project-row").first();
    const searchButton = page.getByRole("button", { name: "搜索", exact: true });
    for (const locator of [brand, project, searchButton]) {
      await expect(locator).toBeVisible();
      const colors = await textContrast(locator);
      expect(colors.ratio, JSON.stringify(colors)).toBeGreaterThanOrEqual(4.5);
    }
    for (const locator of [project, searchButton]) {
      await locator.hover();
      const colors = await textContrast(locator);
      expect(colors.ratio, JSON.stringify(colors)).toBeGreaterThanOrEqual(4.5);
    }
    await searchButton.click();
    const input = page.locator(".search-dialog-head input");
    await expect(input).toBeFocused();
    await input.fill("Other project");
    await expect(page.locator(".search-result")).toBeVisible();
    for (const locator of [
      input,
      page.locator(".search-result"),
      page.locator(".search-dialog-head button")
    ]) {
      const colors = await textContrast(locator);
      expect(colors.ratio, JSON.stringify(colors)).toBeGreaterThanOrEqual(4.5);
    }
    const placeholder = await textContrast(input, "::placeholder");
    expect(placeholder.ratio, JSON.stringify(placeholder)).toBeGreaterThanOrEqual(4.5);
    await page.locator(".search-result").hover();
    const hoveredResult = await textContrast(page.locator(".search-result"));
    expect(hoveredResult.ratio, JSON.stringify(hoveredResult)).toBeGreaterThanOrEqual(4.5);
    await input.fill("No matching project");
    await expect(page.locator(".search-no-results")).toBeVisible();
    const empty = await textContrast(page.locator(".search-no-results"));
    expect(empty.ratio, JSON.stringify(empty)).toBeGreaterThanOrEqual(4.5);
    // The search dialog covers the sidebar, so the preference is set through the page API.
    await page.evaluate(() => window.atriaAppearance.set("dark"));
    const darkColors = await uiColors(page);
    await expect(input).toHaveCSS("color", darkColors.text);
    await expect(brand).toHaveCSS("color", darkColors.text);
    await expect(project).toHaveCSS("color", darkColors.text);
    await page.locator(".search-dialog-head button").click();
    await searchButton.hover();
    await expect(searchButton).toHaveCSS("color", darkColors.text);
    await page.evaluate(() => window.atriaAppearance.set("light"));
    expect((await textContrast(searchButton)).ratio).toBeGreaterThanOrEqual(4.5);
  } finally {
    await dashboard.stop();
  }
});

test("tool outcomes and recovery summaries stay readable in both neutral themes", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.addInitScript(() => {
      if (!localStorage.getItem("atria.appearance")) localStorage.setItem("atria.appearance", "system");
    });
    await page.route("**/app.js", (route) =>
      route.fulfill({ contentType: "application/javascript", body: "// Isolated outcome theme fixture." })
    );
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.goto(dashboard.base);
    await page.evaluate(async () => {
      const { createConversationView } = await import("/assets/controllers/conversation-view.js");
      const task = { taskId: "theme-outcomes", status: "failed", lastError: "HTTP 503" };
      const calls = [
        { type: "toolCall", id: "read", name: "read", arguments: { path: "fixture.txt" } },
        { type: "toolCall", id: "bash", name: "bash", arguments: { command: "python3 missing.py" } }
      ];
      const user = { role: "user", content: "合成测试：读取输入并检查脚本。", timestamp: 1 };
      const answer = {
        role: "assistant",
        content: calls,
        timestamp: 2,
        stopReason: "error",
        errorMessage: "HTTP 503"
      };
      const state = {
        selected: task.taskId,
        localMessages: [],
        executionHistoryOpen: new Map(),
        detail: {
          task,
          runtime: { active: false },
          runtimeEvents: [
            { type: "turn_start" },
            { type: "message_start", message: user },
            { type: "message_start", message: answer },
            ...calls.flatMap((call, index) => [
              { type: "tool_execution_start", toolCallId: call.id, toolName: call.name },
              {
                type: "tool_execution_end",
                toolCallId: call.id,
                toolName: call.name,
                isError: index === 1,
                result: {
                  content: [
                    {
                      type: "text",
                      text: index === 0 ? "Synthetic input read." : "No such file or directory."
                    }
                  ]
                }
              }
            ]),
            { type: "message_end", message: answer },
            { type: "turn_end", message: answer }
          ]
        }
      };
      createConversationView({
        state,
        $: (selector) => document.querySelector(selector),
        bindStarterPrompts() {},
        textContent: (content) => (typeof content === "string" ? content : "")
      }).renderConversation([user, answer], task);
    });
    await expect(page.locator(".tool-step.is-done")).toHaveCount(1);
    await expect(page.locator(".tool-step.is-failed")).toHaveCount(1);
    for (const colorScheme of ["dark", "light"]) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      for (const selector of [
        ".tool-action > strong",
        ".tool-subject",
        ".activity-status",
        ".tool-context",
        ".request-error .run-error-head strong",
        ".request-error-actions button"
      ]) {
        const text = page.locator(selector);
        await expect(text.first()).toBeVisible();
        for (const element of await text.all()) {
          const colors = await textContrast(element);
          expect
            .soft(colors.ratio, `${colorScheme} ${selector}: ${JSON.stringify(colors)}`)
            .toBeGreaterThanOrEqual(4.5);
        }
      }
      await page.screenshot({ path: test.info().outputPath(`${colorScheme}-outcome-summaries.png`) });
    }
  } finally {
    await dashboard.stop();
  }
});

test("manual appearance persists, ignores OS overrides and can return to system without losing drafts", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.addInitScript(() => {
      if (!localStorage.getItem("atria.appearance")) localStorage.setItem("atria.appearance", "system");
    });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(dashboard.base);
    const input = page.locator("#composer-input");
    await input.fill("外观切换草稿");
    await page.locator("#user-menu-button").click();
    await expect(page.locator('[data-appearance-value="system"]')).toHaveAttribute("aria-checked", "true");
    const sample = () =>
      page.locator("#starfield-background").evaluate((canvas) => {
        const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        let visible = 0,
          dark = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (pixels[i + 3] > 100) {
            visible++;
            if (pixels[i] < 160) dark++;
          }
        return { visible, dark };
      });
    for (const [value, label] of [
      ["system", "跟随系统"],
      ["light", "浅色"],
      ["dark", "深色"]
    ])
      await expect(page.locator(`[data-appearance-value="${value}"]`)).toContainText(label);
    await chooseAppearance(page, "light");
    const light = await sample();
    expect(light.visible).toBeGreaterThan(100);
    expect(light.dark).toBeGreaterThan(100);
    await chooseAppearance(page, "dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const dark = await sample();
    expect(dark.dark).toBeLessThan(light.dark / 4);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(input).toHaveValue("外观切换草稿");
    await page.locator("#user-menu-button").click();
    await chooseAppearance(page, "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await chooseAppearance(page, "system");
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "system");
    expect(await page.evaluate(() => localStorage.getItem("atria.appearance"))).toBe("system");
    await page.locator("#settings-back").click();
    await input.focus();
    await input.evaluate((el) => {
      el.setSelectionRange(2, 4);
      window.appearanceInput = el;
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "system");
    await expect(input).toBeFocused();
    expect(
      await input.evaluate((el) => [el === window.appearanceInput, el.selectionStart, el.selectionEnd])
    ).toEqual([true, 2, 4]);
    await expect(input).toHaveValue("外观切换草稿");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator('[data-appearance-value="system"]')).toHaveAttribute("aria-checked", "true");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  } finally {
    await dashboard.stop();
  }
});

test("rapid native selections keep the last saved appearance when a later save fails", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.route("**/app.js", (route) =>
      route.fulfill({ contentType: "application/javascript", body: "// isolated appearance host fixture" })
    );
    await page.addInitScript(() => {
      window.appearanceWrites = [];
      window.savedAppearance = "dark";
      window.bookmanDesktop = {
        appearance: {
          initial: { preference: "dark", effective: "dark" },
          onChange: (handler) => (window.appearanceChange = handler),
          set: (preference) =>
            new Promise((resolve, reject) => window.appearanceWrites.push({ preference, resolve, reject }))
        }
      };
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(dashboard.base);
    await page.locator("#settings-entry").evaluate((element) => (element.hidden = false));
    await chooseAppearance(page, "light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await chooseAppearance(page, "dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.evaluate(() => {
      window.savedAppearance = "light";
      window.appearanceChange({ preference: "light", effective: "light" });
      window.appearanceWrites[0].resolve({ preference: "light", effective: "light" });
    });
    await expect(page.locator('[data-appearance-value="dark"]')).toHaveAttribute("aria-checked", "true");
    await page.evaluate(() => window.appearanceWrites[1].reject(new Error("disk unavailable")));
    await expect(page.locator('[data-appearance-value="light"]')).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator("#appearance-status")).toContainText("无法保存");
    await chooseAppearance(page, "dark");
    await page.evaluate(() => {
      window.savedAppearance = "dark";
      window.appearanceWrites[2].resolve({ preference: "dark", effective: "dark" });
    });
    await expect(page.locator("#appearance-status")).toHaveText("");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  } finally {
    await dashboard.stop();
  }
});

test("a late native system save cannot overwrite a newer host theme change", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.route("**/app.js", (route) =>
      route.fulfill({ contentType: "application/javascript", body: "// isolated appearance host fixture" })
    );
    await page.addInitScript(() => {
      window.bookmanDesktop = {
        appearance: {
          initial: { preference: "light", effective: "light" },
          onChange: (handler) => (window.appearanceChange = handler),
          set: () => new Promise((resolve) => (window.resolveAppearanceSave = resolve))
        }
      };
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(dashboard.base);
    await page.locator("#settings-entry").evaluate((element) => (element.hidden = false));
    await chooseAppearance(page, "system");
    await page.evaluate(() => window.appearanceChange({ preference: "system", effective: "dark" }));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.evaluate(async () => {
      window.resolveAppearanceSave({ preference: "system", effective: "light" });
      await Promise.resolve();
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator('[data-appearance-value="system"]')).toHaveAttribute("aria-checked", "true");
  } finally {
    await dashboard.stop();
  }
});

test("native system appearance uses host changes even when browser media differs", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.route("**/app.js", (route) =>
      route.fulfill({ contentType: "application/javascript", body: "// isolated appearance host fixture" })
    );
    await page.addInitScript(() => {
      localStorage.setItem("atria.appearance", "light");
      window.bookmanDesktop = {
        appearance: {
          initial: { preference: "system", effective: "dark" },
          onChange: (handler) => (window.appearanceChange = handler),
          set: async (preference) => ({ preference, effective: preference })
        }
      };
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(dashboard.base);
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-appearance", "system");
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(page.locator('[data-appearance-value="system"]')).toHaveAttribute("aria-checked", "true");
    await page.evaluate(() => window.appearanceChange({ preference: "system", effective: "light" }));
    await expect(html).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html).toHaveAttribute("data-theme", "light");
    await page.evaluate(() => window.appearanceChange({ preference: "system", effective: "dark" }));
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(html).toHaveCSS("color-scheme", "dark");
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute("content", "#0e0e0f");
    await expect(page.locator('[data-appearance-value="system"]')).toHaveAttribute("aria-checked", "true");
  } finally {
    await dashboard.stop();
  }
});

test("web tabs sync appearance preferences and storage removal restores each tab's system theme", async ({
  page,
  context
}) => {
  const dashboard = await startDashboard();
  const peer = await context.newPage();
  try {
    await page.addInitScript(() => {
      if (!localStorage.getItem("atria.appearance")) localStorage.setItem("atria.appearance", "system");
    });
    await peer.addInitScript(() => {
      if (!localStorage.getItem("atria.appearance")) localStorage.setItem("atria.appearance", "system");
    });
    await page.emulateMedia({ colorScheme: "light" });
    await peer.emulateMedia({ colorScheme: "dark" });
    await page.goto(dashboard.base);
    await peer.goto(dashboard.base);
    const html = page.locator("html");
    const peerHtml = peer.locator("html");
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect(peerHtml).toHaveAttribute("data-theme", "dark");
    await page.locator("#user-menu-button").click();
    await chooseAppearance(page, "dark");
    await expect(peerHtml).toHaveAttribute("data-appearance", "dark");
    await expect(peerHtml).toHaveAttribute("data-theme", "dark");
    await chooseAppearance(page, "system");
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect(peerHtml).toHaveAttribute("data-appearance", "system");
    await expect(peerHtml).toHaveAttribute("data-theme", "dark");
    await peer.reload();
    await expect(peerHtml).toHaveAttribute("data-theme", "dark");
    await expect(peer.locator('[data-appearance-value="system"]')).toHaveAttribute("aria-checked", "true");
    for (const operation of ["remove", "clear", "invalid"]) {
      await chooseAppearance(page, "dark");
      await expect(peerHtml).toHaveAttribute("data-appearance", "dark");
      await peer.evaluate((operation) => {
        if (operation === "clear") localStorage.clear();
        else if (operation === "remove") localStorage.removeItem("atria.appearance");
        else localStorage.setItem("atria.appearance", "invalid");
      }, operation);
      await expect(html).toHaveAttribute("data-appearance", "system");
      await expect(html).toHaveAttribute("data-theme", "light");
      await expect(page.locator('[data-appearance-value="system"]')).toHaveAttribute("aria-checked", "true");
    }
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html).toHaveAttribute("data-theme", "dark");
  } finally {
    await peer.close();
    await dashboard.stop();
  }
});

test("system appearance still follows OS changes when browser preference storage is unavailable", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.addInitScript(() => {
      const read = Storage.prototype.getItem;
      const write = Storage.prototype.setItem;
      Storage.prototype.getItem = function (key) {
        if (key === "atria.appearance") throw new DOMException("Storage blocked", "SecurityError");
        return read.call(this, key);
      };
      Storage.prototype.setItem = function (key, value) {
        if (key === "atria.appearance") throw new DOMException("Storage blocked", "SecurityError");
        return write.call(this, key, value);
      };
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(dashboard.base);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.locator("#user-menu-button").click();
    await chooseAppearance(page, "dark");
    await expect(page.locator("#appearance-status")).toContainText("无法保存");
    await chooseAppearance(page, "system");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "system");
  } finally {
    await dashboard.stop();
  }
});

test("system, invalid and empty web preferences follow the current OS after reload", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(dashboard.base);
    for (const value of ["system", "invalid", "", null]) {
      await page.evaluate((value) => {
        if (value === null) localStorage.removeItem("atria.appearance");
        else localStorage.setItem("atria.appearance", value);
      }, value);
      await page.reload();
      const followsSystem = value === "system";
      await expect(page.locator("html")).toHaveAttribute("data-theme", followsSystem ? "light" : "dark");
      await expect(page.locator("html")).toHaveAttribute(
        "data-appearance",
        followsSystem ? "system" : "dark"
      );
      await page.locator("#user-menu-button").click();
      await expect(
        page.locator(`[data-appearance-value="${followsSystem ? "system" : "dark"}"]`)
      ).toHaveAttribute("aria-checked", "true");
      for (const [value, label] of [
        ["system", "跟随系统"],
        ["light", "浅色"],
        ["dark", "深色"]
      ])
        await expect(page.locator(`[data-appearance-value="${value}"]`)).toContainText(label);
      await page.locator("#settings-back").click();
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await page.emulateMedia({ colorScheme: "light" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", followsSystem ? "light" : "dark");
    }
  } finally {
    await dashboard.stop();
  }
});
