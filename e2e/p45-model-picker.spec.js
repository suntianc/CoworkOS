import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";
import { openModelConnectionEditor } from "./settings-helper.js";

/**
 * The composer's model and reasoning popover (#27). The rail shows only the
 * levels the current model accepts; switching to a model that does not take
 * the picked level moves it to the nearest one and says so once.
 */

test("the reasoning rail follows each model's levels, keys move it, and a model switch keeps the nearest level", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.route("**/api/models", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          configured: true,
          current: "wide-model",
          models: ["wide-model", "narrow-model"],
          levels: {
            "wide-model": { levels: ["off", "low", "medium", "high", "xhigh", "max"], source: "manual" },
            "narrow-model": { levels: ["off", "high", "max"], source: "endpoint" }
          }
        }
      });
    });
    await page.goto(dashboard.base);
    await expect(page.locator("#model-select .model-name")).toHaveText("wide-model");

    await page.locator("#model-select").click();
    const menu = page.locator("#model-menu");
    const rail = menu.locator(".effort-rail");
    await expect(rail).toBeFocused();
    await expect(menu.locator("[data-thinking-level]")).toHaveCount(6);
    await expect(menu.locator(".effort-level small")).toHaveText("默认");

    // Keys move the level and the choice applies at once.
    await page.keyboard.press("Home");
    await expect(rail).toHaveAttribute("aria-valuetext", "关闭");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(rail).toHaveAttribute("aria-valuetext", "中");
    await expect(page.locator("#model-select .reasoning-name")).toHaveText("中");
    await expect(menu.locator("[data-effort-reset]")).toBeVisible();
    await expect(menu.locator(".effort-level small")).toHaveCount(0);

    // The model list is the second page; ArrowLeft returns to the rail.
    await menu.locator(".effort-model").click();
    await expect(menu.locator('[data-model="wide-model"]')).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowLeft");
    await expect(rail).toBeFocused();

    // 中 is not offered by the narrow model: the nearest level (高) is kept and noted.
    await menu.locator(".effort-model").click();
    await menu.locator('[data-model="narrow-model"]').click();
    await expect(menu).toBeVisible();
    await expect(menu.locator("[data-thinking-level]")).toHaveText(["关闭", "高", "最大"]);
    await expect(rail).toHaveAttribute("aria-valuetext", "高");
    await expect(menu.locator(".effort-foot")).toHaveText("此模型不支持「中」，已改为「高」。");
    await expect(page.locator("#model-select .model-name")).toHaveText("narrow-model");
    await expect(page.locator("#model-select .reasoning-name")).toHaveText("高");

    await page.keyboard.press("End");
    await expect(rail).toHaveAttribute("aria-valuetext", "最大");
    await expect(menu.locator(".effort-foot")).toHaveText("只影响这个会话。");

    // A click on a notch label picks it; 恢复默认 returns to the connection's level.
    await menu.locator('[data-thinking-level="off"]').click();
    await expect(page.locator("#model-select .reasoning-name")).toHaveText("关闭");
    await menu.locator("[data-effort-reset]").click();
    await expect(menu.locator(".effort-level small")).toHaveText("默认");

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(page.locator("#model-select")).toBeFocused();
  } finally {
    await dashboard.stop();
  }
});

test("a connection's supported levels are checked by hand for a relay and read from Pi for an official address", async ({
  page
}) => {
  const provider = await modelProtocolFixture("openai-completions", () => ({ text: "档位已确认" }));
  const dashboard = await startDashboard();
  try {
    const saved = await page.request.post(`${dashboard.base}/api/model-settings`, {
      data: {
        baseUrl: provider.baseUrl,
        api: "openai-completions",
        model: "relay-model",
        apiKey: "synthetic-levels-key",
        reasoningEffort: "high",
        supportsReasoningEffort: true
      }
    });
    expect(saved.ok()).toBe(true);
    await page.goto(dashboard.base);
    const dialog = await openModelConnectionEditor(page);
    await dialog.getByText("高级连接参数", { exact: true }).click();
    const field = dialog.locator("[data-model-levels]");
    const chips = field.locator('[name="reasoningLevels"]');
    await expect(chips).toHaveCount(6);
    await expect(field.locator("[data-levels-source]")).toBeHidden();

    // A relay names no levels: unchecked ones leave the default's choices too.
    await field.locator('.settings-level-chip:has([value="xhigh"])').click();
    await field.locator('.settings-level-chip:has([value="max"])').click();
    const effort = dialog.locator('[name="reasoningEffort"]');
    expect(
      await effort.locator("option:not(:disabled)").evaluateAll((nodes) => nodes.map((n) => n.value))
    ).toEqual(["off", "low", "medium", "high"]);
    await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
    await expect(dialog.locator("[data-model-result]")).toContainText("连接通过");
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog).toBeHidden();
    const status = await (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
    expect(status.profiles.find((profile) => profile.active).reasoningLevels).toEqual([
      "off",
      "low",
      "medium",
      "high"
    ]);
    await page.locator("#settings-back").click();
    await page.locator("#model-select").click();
    await expect(page.locator("#model-menu [data-thinking-level]")).toHaveText(["关闭", "低", "中", "高"]);
    await page.keyboard.press("Escape");

    // An official address is read from Pi's table and cannot be narrowed by hand.
    const again = await openModelConnectionEditor(page);
    await again.getByText("高级连接参数", { exact: true }).click();
    await again.locator('[name="baseUrl"]').fill("https://api.deepseek.com");
    await again.locator('[name="model"]').fill("deepseek-v4-pro");
    await expect(field.locator("[data-levels-source]")).toHaveText("官方 · 自动");
    await expect(field.locator("[data-levels-value]")).toHaveText("关闭 · 高 · 最大");
    await expect(field.locator("[data-levels-chips]")).toBeHidden();
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});
