import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";
import { pageRequest, saveTestConnection } from "../test/model-provider-fixture.mjs";
import { activeModelOf, leaveSettings, openModelParams, selectProvider } from "./model-provider-ui.js";

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

test("a model's supported levels are checked by hand for a relay and read from Pi for an official address", async ({
  page
}) => {
  const provider = await modelProtocolFixture("openai-completions", () => ({ text: "档位已确认" }));
  const dashboard = await startDashboard();
  const request = pageRequest(page, dashboard.base);
  try {
    const saved = await saveTestConnection(request, {
      profileName: "中转",
      baseUrl: provider.baseUrl,
      model: "relay-model",
      apiKey: "synthetic-levels-key",
      reasoningEffort: "high",
      supportsReasoningEffort: true
    });
    expect(saved.status).toBe(200);
    await page.goto(dashboard.base);
    await selectProvider(page, "中转");
    let params = await openModelParams(page, "relay-model");
    const chips = params.locator("[data-level-chips] input");
    await expect(chips).toHaveCount(6);
    await expect(params.locator("[data-levels-source]")).toBeHidden();

    // A relay names no levels: the person narrows them by hand.
    await params.locator('.level-chip:has([value="xhigh"])').click();
    await params.locator('.level-chip:has([value="max"])').click();
    await params.locator("[data-model-save]").click();
    await expect(params).toBeHidden();
    const status = (await request("/api/model-settings")).body;
    expect(activeModelOf(status).reasoningLevels).toEqual(["off", "low", "medium", "high"]);
    await leaveSettings(page);
    await page.locator("#model-select").click();
    await expect(page.locator("#model-menu [data-thinking-level]")).toHaveText(["关闭", "低", "中", "高"]);
    await page.keyboard.press("Escape");

    // An official address is read from Pi's table and cannot be narrowed by hand.
    await saveTestConnection(request, {
      profileName: "DeepSeek 官方",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      apiKey: "synthetic-official-key",
      activate: false
    });
    await page.reload();
    await selectProvider(page, "DeepSeek 官方");
    params = await openModelParams(page, "deepseek-v4-pro");
    await expect(params.locator("[data-levels-source]")).toHaveText("官方 · 自动");
    await expect(chips.and(page.locator(":checked"))).toHaveCount(3);
    for (const level of ["off", "high", "max"]) {
      await expect(params.locator(`[data-level-chips] input[value="${level}"]`)).toBeChecked();
      await expect(params.locator(`[data-level-chips] input[value="${level}"]`)).toBeDisabled();
    }
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});

test("a model's /models limits fill its parameters and reach the run, until a field is edited by hand", async ({
  page
}) => {
  const provider = await modelProtocolFixture("openai-completions", () => ({ text: "按模型识别已生效" }), {
    models: [
      {
        id: "limits-model",
        context_window: 40000,
        max_output_tokens: 128000,
        modalities: { input: ["text", "image"] }
      }
    ]
  });
  const dashboard = await startDashboard();
  const request = pageRequest(page, dashboard.base);
  try {
    const saved = await saveTestConnection(request, {
      profileName: "按模型识别",
      baseUrl: provider.baseUrl,
      model: "limits-model",
      apiKey: "synthetic-limits-key"
    });
    expect(saved.status).toBe(200);
    await page.goto(dashboard.base);

    // Untouched defaults follow the model: the run asks for half the 40k window.
    await page.locator("#composer-input").fill("按模型的上限完成这条消息");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("按模型识别已生效", { timeout: 30_000 });
    // Pi trims the cap to what the 40k window has left after the prompt, so the
    // request lands just under 20000 and well above the 8192 default.
    const body = provider.requests.at(-1).body;
    const asked = body.max_completion_tokens ?? body.max_tokens;
    expect(asked).toBeGreaterThan(8192);
    expect(asked).toBeLessThanOrEqual(20000);

    await selectProvider(page, "按模型识别");
    const params = await openModelParams(page, "limits-model");
    const context = params.locator('[data-model-field="contextWindow"]');
    await expect(context).toHaveValue("40000");
    await expect(params.locator('[data-auto-tag="contextWindow"]')).toBeVisible();
    await expect(params.locator('[data-model-field="mainMaxTokens"]')).toHaveValue("65536");
    const images = params.locator('[data-model-switch="supportsImages"]');
    await expect(images).toHaveAttribute("aria-checked", "true");
    await expect(params.locator('[data-auto-tag="images"]')).toBeVisible();

    // A value typed by hand wins from then on; the other fields keep following.
    await context.fill("32000");
    await expect(params.locator('[data-auto-tag="contextWindow"]')).toBeHidden();
    await images.click();
    await expect(params.locator('[data-auto-tag="images"]')).toBeHidden();
    await params.locator("[data-model-save]").click();
    await expect(params).toBeHidden();
    const active = activeModelOf((await request("/api/model-settings")).body);
    expect(active.contextWindow).toBe(32000);
    expect(active.supportsImages).toBe(false);
    expect(active.autoLimits).toEqual(["maxTokens"]);
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});
