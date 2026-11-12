import { test, expect, _electron as electron } from "@playwright/test";
import { stopNativeBackend } from "../test/native-backend-fixture.mjs";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { developmentExecutable } from "../scripts/desktop-dev.mjs";
import { desktopSmokeEnvironment } from "../scripts/desktop-smoke-env.mjs";

test.skip(process.platform !== "darwin", "background mode hides the Dock icon and activation on macOS");

test("desktop windows launched by tests stay out of the foreground but still draw", async () => {
  test.setTimeout(120_000);
  // The suite defaults the switch on (playwright.config.js); the smoke environment carries it.
  expect(process.env.FORMICAND_DESKTOP_BACKGROUND).toBe("1");
  if (!existsSync("build/atria.icns"))
    execFileSync(process.execPath, ["scripts/build-desktop-icon.mjs"], { stdio: "inherit" });
  const data = await mkdtemp(join(tmpdir(), "formicand-p45-background-"));
  const env = desktopSmokeEnvironment({ data });
  expect(env.FORMICAND_DESKTOP_BACKGROUND).toBe("1");
  let native;
  try {
    native = await electron.launch({
      executablePath: await developmentExecutable(),
      args: ["--use-mock-keychain", resolve(".")],
      env,
      timeout: 90_000
    });
    const page = await native.firstWindow();
    await expect(page.locator("#composer-input")).toBeAttached({ timeout: 60_000 });
    // Give the app every chance to activate itself after load.
    await page.waitForTimeout(1_500);
    const state = await native.evaluate(({ app, BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
      return {
        dock: app.dock.isVisible(),
        windows: windows.length,
        visible: windows.some((window) => window.isVisible()),
        opacity: Math.max(...windows.map((window) => window.getOpacity())),
        focused: BrowserWindow.getFocusedWindow() !== null || windows.some((window) => window.isFocused())
      };
    });
    expect(state).toEqual({ dock: false, windows: 1, visible: true, opacity: 0, focused: false });
    // The window is real and painting: a screenshot has the page's own pixels.
    const shot = await page.screenshot();
    expect(shot.byteLength).toBeGreaterThan(1_000);
    expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
  } finally {
    await native?.close();
    // The backend outlives the window by design; stop this test's own (#35).
    await stopNativeBackend(data);
    await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
