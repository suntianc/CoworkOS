import { test, expect, _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { developmentExecutable } from "../scripts/desktop-dev.mjs";
import { stopNativeBackend } from "../test/native-backend-fixture.mjs";

function iconPixels(png) {
  let light = 0;
  let dark = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    const [red, green, blue, alpha] = png.data.subarray(index, index + 4);
    if (alpha !== 255) continue;
    if (red > 200 && green > 200 && blue > 200) light++;
    if (red < 40 && green < 40 && blue < 40) dark++;
  }
  return { light, dark };
}

test("desktop window uses the native material and shows Formicand while package names stay", async () => {
  test.skip(process.platform !== "darwin", "Native window material acceptance requires macOS");
  test.setTimeout(180_000);
  if (!existsSync("build/atria.icns"))
    execFileSync(process.execPath, ["scripts/build-desktop-icon.mjs"], { stdio: "inherit" });
  const root = await mkdtemp(join(tmpdir(), "atria-formicand-desktop-"));
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
  try {
    native = await electron.launch({
      executablePath,
      args: ["--use-mock-keychain", resolve(".")],
      env,
      timeout: 90_000
    });
    await native.evaluate(({ app, BrowserWindow }) => {
      app.hide();
      BrowserWindow.getAllWindows().forEach((window) => window.hide());
    });
    const page = await native.firstWindow();
    await expect(page.locator("#composer-input")).toBeAttached();

    const window = await native.evaluate(({ app, BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0];
      return {
        name: app.getName(),
        title: main.getTitle(),
        background: main.getBackgroundColor().toLowerCase(),
        userData: app.getPath("userData")
      };
    });
    expect(window.name).toBe("Formicand");
    expect(window.title).toBe("Formicand");
    // The clear canvas is what lets the macOS material show through. Electron
    // reports a fully transparent color without its alpha channel.
    expect(window.background).toBe("#000000");
    expect(window.userData).toBe(root);

    await expect(page.locator("html")).toHaveAttribute("data-window-material", "under-window");
    expect(await page.evaluate(() => window.bookmanDesktop.windowMaterial)).toEqual({
      material: "under-window"
    });
    const renderer = await page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      wash: getComputedStyle(document.querySelector(".app-shell")).backgroundImage,
      title: document.title,
      brand: document.querySelector(".brand-lockup strong").textContent.trim()
    }));
    expect(renderer.body).toBe("rgba(0, 0, 0, 0)");
    expect(renderer.wash).toContain("linear-gradient");
    expect(renderer.title).toBe("Formicand");
    expect(renderer.brand).toBe("Formicand");

    const icon = PNG.sync.read(await readFile("build/atria-icon.png"));
    expect(icon.width).toBe(1024);
    expect(icon.height).toBe(1024);
    const alpha = (x, y) => icon.data[(y * icon.width + x) * 4 + 3];
    for (const [x, y] of [
      [0, 0],
      [1023, 0],
      [0, 1023],
      [1023, 1023]
    ])
      expect(alpha(x, y)).toBe(0);
    const pixels = iconPixels(icon);
    expect(pixels.dark).toBeGreaterThan(300_000);
    expect(pixels.light).toBeGreaterThan(50_000);

    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    expect(packageJson.name).toBe("coworkos");
    expect(packageJson.bin).toEqual({ coworkos: "scripts/atria.mjs", atria: "scripts/atria.mjs" });
    const builder = await import("../electron-builder.config.cjs");
    expect(builder.default.productName).toBe("CoworkOS");
    expect(builder.default.dmg.title).toContain("CoworkOS");
  } finally {
    await native?.close();
    await stopNativeBackend(root);
    await rm(root, { recursive: true, force: true });
  }
});
