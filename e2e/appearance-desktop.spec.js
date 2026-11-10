import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "./desktop-runtime-helper.js";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";
import { stopNativeBackend } from "../test/native-backend-fixture.mjs";

test("desktop appearance applies natively and preserves the live backend across normal quit", async () => {
  test.skip(process.platform !== "darwin", "Native desktop acceptance requires macOS");
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "atria-appearance-desktop-"));
  const provider = await modelProtocolFixture("openai-completions", () => ({ text: "外观切换后服务正常" }));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(?:COWORK_|ATRIA_|PI_|EXA_|SERPER_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(key)
    )
  );
  Object.assign(env, {
    COWORK_DESKTOP_DATA: root,
    ATRIA_HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_OFFLINE: "1"
  });
  const executablePath = await developmentExecutable();
  let native;
  const launch = async () => {
    native = await electron.launch({
      executablePath,
      args: ["--use-mock-keychain", resolve(".")],
      env,
      timeout: 60_000
    });
    await native.evaluate(({ app, BrowserWindow }) => {
      app.hide();
      BrowserWindow.getAllWindows().forEach((window) => window.hide());
    });
    const page = await native.firstWindow();
    await expect(page.locator("#composer-input")).toBeAttached();
    return page;
  };
  const nativeState = () =>
    native.evaluate(({ nativeTheme, BrowserWindow }) => ({
      source: nativeTheme.themeSource,
      dark: nativeTheme.shouldUseDarkColors,
      background: BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase()
    }));
  const expectSystemAppearance = async (page) => {
    // themeSource switches to the OS value one tick later, so wait until the
    // host state and the rendered theme agree instead of sampling once.
    await expect
      .poll(async () => {
        const state = await nativeState();
        const rendered = await page.evaluate(() => document.documentElement.dataset.theme);
        return (
          state.source === "system" && state.background === "#000000" && state.dark === (rendered === "dark")
        );
      })
      .toBe(true);
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "system");
  };
  try {
    let page = await launch();
    await expectSystemAppearance(page);
    const model = page.getByRole("dialog", { name: "连接模型" });
    await expect(model).toBeVisible();
    await model.locator('[name="baseUrl"]').fill(provider.baseUrl);
    await model.locator('[name="api"]').selectOption("openai-completions");
    await model.locator('[name="model"]').fill("appearance-fixture");
    await model.locator('[name="apiKey"]').fill("local-appearance-fixture");
    await model.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(model).toBeHidden();
    await page.locator("#new-project").click();
    await page.locator("#add-project-name").fill("外观验收");
    await page.locator("#add-project-directory").fill(root);
    await page.locator("#add-project-submit").click();
    await page.locator("#composer-input").fill("切换前发送");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("外观切换后服务正常", { timeout: 30_000 });
    const origin = page.url();
    await page.locator("#composer-input").fill("退出后保留的外观草稿");
    await page.locator("#user-menu-button").click();
    await page.locator('[data-appearance-value="dark"]').click();
    await expect.poll(nativeState).toEqual({ source: "dark", dark: true, background: "#000000" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(page.url()).toBe(origin);
    await page.screenshot({ path: test.info().outputPath("native-dark.png"), fullPage: true });
    await expect(page.locator("#composer-input")).toHaveValue("退出后保留的外观草稿");
    expect(JSON.parse(await readFile(join(root, "appearance.json"), "utf8")).preference).toBe("dark");
    await page.locator("#settings-back").click();
    await native.close();
    native = undefined;
    page = await launch();
    await expect.poll(() => page.url()).toBe(origin);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect.poll(nativeState).toEqual({ source: "dark", dark: true, background: "#000000" });
    await expect(page.locator("#composer-input")).toHaveValue("退出后保留的外观草稿");
    await page.locator("#user-menu-button").click();
    await page.locator('[data-appearance-value="light"]').click();
    await expect.poll(nativeState).toEqual({ source: "light", dark: false, background: "#000000" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.screenshot({ path: test.info().outputPath("native-light.png"), fullPage: true });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect.poll(nativeState).toEqual({ source: "light", dark: false, background: "#000000" });
    await page.locator("#settings-back").click();
    await native.close();
    native = undefined;
    page = await launch();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect.poll(nativeState).toEqual({ source: "light", dark: false, background: "#000000" });
    await expect(page.locator("#conversation")).toContainText("外观切换后服务正常");
    await page.locator("#composer-input").fill("切换后继续发送");
    await page.locator("#send-button").click();
    await expect
      .poll(() => provider.requests.some(({ body }) => JSON.stringify(body).includes("切换后继续发送")))
      .toBe(true);
    await page.locator("#composer-input").fill("跟随系统后保留的外观草稿");
    const systemOrigin = page.url();
    await page.locator("#user-menu-button").click();
    await page.locator('[data-appearance-value="system"]').click();
    await expectSystemAppearance(page);
    await expect(page.locator('[data-appearance-value="system"]')).toHaveAttribute("aria-checked", "true");
    expect(JSON.parse(await readFile(join(root, "appearance.json"), "utf8")).preference).toBe("system");
    for (const dark of [true, false]) {
      // Inject only the native updated-event boundary inside this disposable Electron process.
      // This does not change macOS appearance or claim to exercise the operating system event.
      await native.evaluate(({ nativeTheme }, useDarkColors) => {
        Object.defineProperty(nativeTheme, "shouldUseDarkColors", {
          configurable: true,
          get: () => useDarkColors
        });
        nativeTheme.emit("updated");
      }, dark);
      await expectSystemAppearance(page);
      await expect(page.locator('[data-appearance-value="system"]')).toHaveAttribute("aria-checked", "true");
      await expect(page.locator("#composer-input")).toHaveValue("跟随系统后保留的外观草稿");
      expect(page.url()).toBe(systemOrigin);
    }
    await page.locator("#settings-back").click();
    await native.close();
    native = undefined;
    page = await launch();
    await expect.poll(() => page.url()).toBe(systemOrigin);
    await expectSystemAppearance(page);
    await expect(page.locator("#composer-input")).toHaveValue("跟随系统后保留的外观草稿");
    await page.locator("#user-menu-button").click();
    await expect(page.locator('[data-appearance-value="system"]')).toHaveAttribute("aria-checked", "true");
    expect(JSON.parse(await readFile(join(root, "appearance.json"), "utf8")).preference).toBe("system");
  } finally {
    await native?.close();
    await stopNativeBackend(root);
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});
