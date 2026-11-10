import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

/**
 * The composer's reasoning control follows the Main connection.
 *
 * A saved strength is what the next run sends; the control shows it and sends
 * nothing of its own until the person picks one. Picking is scoped to this
 * conversation, so the wire value is the proof in both halves.
 */

const connection = (baseUrl, { name, model, reasoningEffort }) => ({
  profileId: "",
  profileName: name,
  baseUrl,
  model,
  api: "openai-completions",
  apiKey: "synthetic-connection-key",
  reasoningEffort,
  supportsReasoningEffort: true
});

test("the composer shows and sends the Main connection's reasoning strength, and an explicit pick wins for that run", async ({
  page
}) => {
  const provider = await modelProtocolFixture("openai-completions", () => ({ text: "推理强度已确认" }));
  const dashboard = await startDashboard({
    config: {
      modelConnections: {
        version: 1,
        activeId: "save-max",
        profiles: [
          {
            id: "save-max",
            name: "最大连接",
            baseUrl: provider.baseUrl,
            apiKey: "synthetic-connection-key",
            model: "max-model",
            api: "openai-completions",
            reasoningEffort: "max",
            supportsReasoningEffort: true,
            supportsPromptCacheKey: false,
            mainMaxTokens: 8192,
            subagentMaxTokens: 8192,
            contextWindow: 256000,
            supportsImages: false
          }
        ]
      }
    }
  });
  try {
    // A second connection the person can bind as Main; it is not the active one.
    const saved = await page.request.post(`${dashboard.base}/api/model-settings`, {
      data: connection(provider.baseUrl, { name: "低连接", model: "low-model", reasoningEffort: "low" })
    });
    expect(saved.ok()).toBe(true);

    await page.goto(dashboard.base);
    const reasoning = page.locator("#reasoning-select");
    // Nothing has been picked here: the label names the connection's saved strength.
    await expect(reasoning).toHaveAttribute("aria-label", "推理强度：最大");

    const beforeFirst = provider.requests.length;
    await page.locator("#composer-input").fill("用连接保存的推理强度完成这条消息");
    await page.locator("#send-button").click();
    await expect.poll(() => provider.requests.length, { timeout: 30_000 }).toBe(beforeFirst + 1);
    expect(provider.requests.at(-1).body.reasoning_effort).toBe("max");

    // Switching the Main connection to another saved strength moves the label
    // without a reload: the settings page tells the composer to re-read it.
    await page.locator("#user-menu-button").click();
    await page.locator('[data-settings-section="models"]').click();
    const mainRole = page.locator('[data-role-model="main"]');
    await expect(mainRole).toBeVisible();
    await mainRole.selectOption({ label: "低连接 / low-model" });
    await expect
      .poll(async () => {
        const status = await (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
        return status.modelRoles.roles.find((entry) => entry.role === "main")?.host?.profileId;
      })
      .not.toBeUndefined();
    await page.locator("#settings-back").click();
    await expect(reasoning).toHaveAttribute("aria-label", "推理强度：低");

    // An explicit pick is sent for this conversation; the connection stays as saved.
    await reasoning.click();
    await page.locator('#reasoning-menu [data-thinking-level="high"]').click();
    await expect(reasoning).toHaveAttribute("aria-label", "推理强度：高");
    const beforeSecond = provider.requests.length;
    await page.locator("#composer-input").fill("这次用显式选择的推理强度");
    await page.locator("#send-button").click();
    await expect.poll(() => provider.requests.length, { timeout: 30_000 }).toBe(beforeSecond + 1);
    expect(provider.requests.at(-1).body.reasoning_effort).toBe("high");

    const status = await (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
    expect(status.profiles.find((profile) => profile.name === "低连接").reasoningEffort).toBe("low");
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});
