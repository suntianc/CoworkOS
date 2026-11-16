import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { developmentExecutable } from "./desktop-runtime-helper.js";
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

const layers = (page) =>
  page.evaluate(() => {
    const read = (selector) => {
      const style = getComputedStyle(document.querySelector(selector));
      return { color: style.backgroundColor, image: style.backgroundImage };
    };
    const conversation = getComputedStyle(document.querySelector(".chat-pane"));
    const taskPanel = getComputedStyle(document.querySelector(".agent-pane"));
    return {
      material: window.bookmanDesktop.windowMaterial,
      title: document.title,
      html: read("html"),
      body: read("body"),
      shell: read(".app-shell"),
      conversation: { blur: conversation.backdropFilter, image: conversation.backgroundImage },
      taskPanel: { blur: taskPanel.backdropFilter, image: taskPanel.backgroundImage }
    };
  });

// Light mode lays one faint white wash on the body so the material reads as a
// pale sheet; the other layers stay clear and nothing paints a gradient.
const expectClearPage = (value, theme) => {
  for (const layer of [value.html, value.body, value.shell]) {
    const wash = layer === value.body && theme === "light";
    expect(layer.color).toBe(wash ? "rgba(255, 255, 255, 0.4)" : "rgba(0, 0, 0, 0)");
    expect(layer.image).toBe("none");
  }
  for (const panel of [value.conversation, value.taskPanel]) {
    expect(panel.blur).toContain("blur(");
    expect(panel.image).toContain("linear-gradient");
  }
};

test("macOS window material shows the desktop through the page, keeps the glass panels and names Formicand while packages stay", async () => {
  test.skip(process.platform !== "darwin", "Native window material acceptance requires macOS");
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), "atria-backdrop-desktop-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(?:COWORK_|ATRIA_|PI_|EXA_|SERPER_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(key)
    )
  );
  Object.assign(env, {
    COWORK_DESKTOP_DATA: root,
    ATRIA_HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    COWORK_DISABLE_MAIN_GUARDIAN: "1",
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
    await expect(page.locator("html")).toHaveAttribute("data-window-material", "under-window");
    // The page adds no canvas layer over the native material.
    await expect(page.locator("canvas")).toHaveCount(0);

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

    // The real host exposes the material and switches appearance through IPC.
    for (const theme of ["dark", "light"]) {
      await page.evaluate((value) => window.bookmanDesktop.appearance.set(value), theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("html")).toHaveAttribute("data-window-material", "under-window");
      const value = await layers(page);
      expect(value.material).toEqual({ material: "under-window" });
      expect(value.title).toBe("Formicand");
      expectClearPage(value, theme);
      await expect(page.locator("canvas")).toHaveCount(0);
    }
  } finally {
    await native?.close();
    await stopNativeBackend(root);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
