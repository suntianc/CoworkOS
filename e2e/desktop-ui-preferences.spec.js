import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";
import { pageRequest, saveTestConnection } from "../test/model-provider-fixture.mjs";

const require = createRequire(import.meta.url);
const { createComposerDraftStore } = require("../desktop/composer-drafts.cjs");
const { createUiPreferenceStore } = require("../desktop/ui-preferences.cjs");
const preload = await readFile("desktop/preload.cjs", "utf8");

/** The desktop preload over Playwright, with the two profile stores behind it. */
async function installDesktopBridge(page, drafts, preferences) {
  await page.exposeFunction("__savePreferences", (entries, origin) => preferences.save(entries, origin));
  await page.addInitScript({
    content: `(() => {
    const drafts = ${JSON.stringify(drafts.snapshot())};
    const preferences = ${JSON.stringify(preferences.snapshot())};
    const electron = {
      contextBridge: { exposeInMainWorld: (name, value) => { window[name] = value; } },
      ipcRenderer: {
        sendSync: (channel) => (channel === "bookman:ui-preferences" ? preferences : drafts),
        on: () => {},
        invoke: async (channel, ...args) => {
          if (channel === "bookman:save-ui-preferences") return window.__savePreferences(args[0], location.origin);
          if (channel === "bookman:model-status") return { baseUrl: "https://fixture.example", model: "fixture", configured: true };
        }
      }
    };
    (function(require, process) { ${preload} })(() => electron, { platform: "darwin", env: {} });
  })();`
  });
}

test("the desktop profile hands the page's remembered choices to a new origin after a restart", async ({
  page,
  context
}) => {
  const root = await mkdtemp(join(tmpdir(), "atria-ui-preferences-"));
  const dashboard = await startDashboard();
  const drafts = createComposerDraftStore(root);
  await drafts.load();
  const preferences = createUiPreferenceStore(root);
  await preferences.load();
  const remembered = {
    "atria.model.level-by-task": JSON.stringify({ "task-1": "high" }),
    "atria.model.model-by-task": JSON.stringify({ "task-1": "other-model" }),
    "atria.time-format": "24h"
  };
  try {
    await installDesktopBridge(page, drafts, preferences);
    await page.goto(dashboard.base);
    await page.evaluate((entries) => {
      for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
      localStorage.setItem("not-ours", "stays-with-its-origin");
    }, remembered);
    // The copy follows a change the page made to its own storage.
    await expect
      .poll(() => preferences.snapshot().entries, { timeout: 10_000 })
      .toEqual(expect.objectContaining(remembered));
    expect(preferences.snapshot().entries["not-ours"]).toBeUndefined();
    expect(
      Object.keys(preferences.snapshot().entries).some((key) => key.startsWith("atria.composer.v1:"))
    ).toBe(false);
    await page.close();

    // The backend comes back on another port: a new origin with empty storage.
    const previousOrigin = dashboard.base;
    await dashboard.restart({ newPort: true });
    expect(dashboard.base).not.toBe(previousOrigin);
    const restored = await context.newPage();
    await installDesktopBridge(restored, drafts, preferences);
    await restored.goto(dashboard.base);
    for (const [key, value] of Object.entries(remembered))
      expect(await restored.evaluate((name) => localStorage.getItem(name), key)).toBe(value);
    expect(await restored.evaluate(() => localStorage.getItem("not-ours"))).toBeNull();
  } finally {
    await dashboard.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a conversation keeps the model picked for it when the page starts again", async ({ page }) => {
  const provider = await modelProtocolFixture("openai-completions", () => ({ text: "已收到" }));
  const dashboard = await startDashboard();
  try {
    // A connection saved in settings, as people use it: the conversation's
    // model then comes from the page's own memory, not the task record.
    const saved = await saveTestConnection(pageRequest(page, dashboard.base), {
      profileName: "主连接",
      baseUrl: provider.baseUrl,
      model: "pref-model",
      api: "openai-completions",
      apiKey: "synthetic-connection-key"
    });
    expect(saved.status).toBe(200);
    // A second connection whose model is offered in the picker beside Main's.
    const other = await saveTestConnection(pageRequest(page, dashboard.base), {
      profileName: "另一连接",
      baseUrl: provider.baseUrl,
      model: "other-model",
      api: "openai-completions",
      apiKey: "synthetic-other-key",
      activate: false
    });
    expect(other.status).toBe(200);
    await page.goto(dashboard.base);
    const model = page.locator("#model-select .model-name");
    await expect(model).toHaveText("pref-model");
    await page.locator("#composer-input").fill("这个会话换一个模型");
    await page.locator("#model-select").click();
    await page.locator("#model-menu .effort-model").click();
    await page.locator('#model-menu [data-model="other-model"]').click();
    await expect(model).toHaveText("other-model");
    const sent = provider.requests.length;
    await page.locator("#send-button").click();
    await expect.poll(() => provider.requests.length, { timeout: 30_000 }).toBe(sent + 1);
    expect(provider.requests.at(-1).body.model).toBe("other-model");
    await expect(page.locator("#stop-button")).toBeHidden({ timeout: 30_000 });

    await page.reload();
    await expect(model).toHaveText("other-model");
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});
