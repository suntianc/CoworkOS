import { test, expect, _electron as electron } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

test("desktop response links leave through the system browser and local viewers stay unprivileged", async () => {
  test.skip(process.platform !== "darwin", "Native desktop acceptance requires macOS");
  test.setTimeout(90000);
  const root = await mkdtemp(join(tmpdir(), "atria-desktop-links-"));
  const project = join(root, "project");
  await mkdir(project);
  const provider = await modelProtocolFixture("openai-completions", () => ({
    text: "参考资料：[产品文档](https://example.com/reference?q=atria#section)"
  }));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(?:COWORK_|ATRIA_|PI_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(name)
    )
  );
  Object.assign(env, {
    COWORK_DESKTOP_DATA: join(root, "profile"),
    ATRIA_HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_OFFLINE: "1"
  });
  let native;
  const errors = [];
  try {
    native = await electron.launch({
      executablePath: createRequire(import.meta.url)("electron"),
      args: ["--use-mock-keychain", resolve(".")],
      env,
      timeout: 60000
    });
    const page = await native.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    const dialog = page.getByRole("dialog", { name: "连接模型" });
    await dialog.locator('[name="api"]').selectOption("openai-completions");
    await dialog.locator('[name="baseUrl"]').fill(provider.baseUrl);
    await dialog.locator('[name="model"]').fill("protocol-fixture");
    await dialog.locator('[name="apiKey"]').fill("local-external-link-fixture");
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    // Saving applies the connection in place; the window keeps its origin.
    await expect(dialog).toBeHidden();
    await expect(page.locator("#model-select")).toContainText("protocol-fixture");
    await page.locator("#new-project").click();
    await page.locator("#add-project-name").fill("链接验收项目");
    await page.locator("#add-project-directory").fill(project);
    await page.locator("#add-project-submit").click();
    await expect(page.locator("#add-project-modal")).toBeHidden();
    await native.evaluate(({ shell }) => {
      globalThis.openedExternalLinks = [];
      // Observe routing without launching or navigating the user's browser.
      shell.openExternal = async (url) => globalThis.openedExternalLinks.push(url);
    });
    await page.locator("#composer-input").fill("请显示普通参考资料链接。");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("参考资料");
    await expect(page.locator("#stop-button")).toBeHidden();
    await page.getByRole("link", { name: "产品文档", exact: true }).click();
    await expect
      .poll(() => native.evaluate(() => globalThis.openedExternalLinks))
      .toEqual(["https://example.com/reference?q=atria#section"]);
    expect(await native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

    const opened = native.waitForEvent("window");
    // Any served local file proves the local viewer window is unprivileged.
    await page.evaluate(() => window.open("/assets/ui/language-en.js", "_blank"));
    const viewer = await opened;
    viewer.on("pageerror", (error) => errors.push(error.message));
    await expect(viewer.locator("body")).toContainText("Back to settings");
    expect(await viewer.evaluate(() => typeof window.bookmanDesktop)).toBe("undefined");
    expect(
      await native.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find(
          (entry) => !entry.webContents.getURL().endsWith("/")
        );
        const preferences = window.webContents.getLastWebPreferences();
        return {
          nodeIntegration: preferences.nodeIntegration,
          contextIsolation: preferences.contextIsolation,
          sandbox: preferences.sandbox,
          hasPreload: Boolean(preferences.preload)
        };
      })
    ).toEqual({ nodeIntegration: false, contextIsolation: true, sandbox: true, hasPreload: false });
    expect(errors).toEqual([]);
  } finally {
    await native?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
