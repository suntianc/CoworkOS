import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { openModelConnectionEditor } from "./settings-helper.js";

test("image analysis profile saves its role while the text chat connection stays active", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await page.locator("#model-setup-button").click();
    const dialog = page.getByRole("dialog", { name: "连接模型" });
    const fill = async (name, url, images) => {
      await dialog.locator('[name="profileName"]').fill(name);
      await dialog.locator('[name="baseUrl"]').fill(url);
      await dialog.locator('[name="model"]').fill(name);
      await dialog.locator('[name="apiKey"]').fill("local-fixture-key");
      await dialog.locator('[name="supportsImages"]').setChecked(images);
    };
    await fill("chat", "https://chat.example/v1", false);
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog).toBeHidden();
    const status = () => page.evaluate(async () => (await fetch("/api/model-settings")).json());
    const original = await status();
    await openModelConnectionEditor(page);
    await dialog.locator("[data-model-profiles]").selectOption("");
    await fill("vision", "https://vision.example/v1", true);
    await dialog.locator('[name="vision"]').check();
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog).toBeHidden();
    const saved = await status();
    assertProfile(saved, original.activeProfileId);
    await page.reload();
    await openModelConnectionEditor(page);
    await dialog.locator("[data-model-profiles]").selectOption(saved.visionProfileId);
    await expect(dialog.locator('[name="vision"]')).toBeChecked();
    await expect(dialog.locator('[name="apiKey"]')).toHaveValue("");
  } finally {
    await dashboard.stop();
  }
});
function assertProfile(value, active) {
  expect(value.activeProfileId).toBe(active);
  expect(value.visionProfileId).not.toBe(active);
  expect(value.profiles.find((p) => p.id === value.visionProfileId).vision).toBe(true);
}

test("thinking format belongs to its saved connection and new profiles retain automatic detection", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await page.locator("#model-setup-button").click();
    const dialog = page.getByRole("dialog", { name: "连接模型" });
    await dialog.locator("details > summary").click();
    await expect(dialog.locator('[name="thinkingFormat"]')).toHaveValue("auto");
    await dialog.locator('[name="profileName"]').fill("GLM gateway");
    await dialog.locator('[name="baseUrl"]').fill("https://gateway.example/v1");
    await dialog.locator('[name="model"]').fill("glm-fixture");
    await dialog.locator('[name="apiKey"]').fill("local-fixture-key");
    await dialog.locator('[name="thinkingFormat"]').selectOption("zai");
    await dialog.locator('[name="supportsReasoningEffort"]').check();
    await dialog.locator('[name="reasoningEffort"]').selectOption("max");
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    await openModelConnectionEditor(page);
    await expect(dialog.locator('[name="thinkingFormat"]')).toHaveValue("zai");
    await dialog.locator("[data-model-profiles]").selectOption("");
    await expect(dialog.locator('[name="thinkingFormat"]')).toHaveValue("auto");
    const status = await page.evaluate(async () => (await fetch("/api/model-settings")).json());
    expect(status.profiles.find((profile) => profile.id === status.activeProfileId).thinkingFormat).toBe(
      "zai"
    );
    await dialog.locator("[data-model-profiles]").selectOption(status.activeProfileId);
    await expect(dialog.locator('[name="thinkingFormat"]')).toHaveValue("zai");
  } finally {
    await dashboard.stop();
  }
});
