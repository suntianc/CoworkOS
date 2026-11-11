import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { stopNativeBackend } from "../test/native-backend-fixture.mjs";
import { developmentExecutable } from "./desktop-runtime-helper.js";

const sky =
  "#night-sky, .night-sky, #starfield-background, .starfield-background, .meteor-canvas, canvas, #starfield-motion-toggle, #starfield-motion-description";
const assets = 'link[href*="starfield"], script[src*="starfield"]';
const skyText = /星空|流星|starfield/i;

const backdrop = (page) =>
  page.evaluate(() => {
    const read = (selector) => {
      const style = getComputedStyle(document.querySelector(selector));
      return { color: style.backgroundColor, image: style.backgroundImage };
    };
    return { html: read("html"), body: read("body"), shell: read(".app-shell") };
  });

// The top band above the title row controls, where only the page backdrop shows.
const corner = async (page) => {
  const shot = await page.screenshot({ clip: { x: 2, y: 1, width: 24, height: 5 } });
  const png = PNG.sync.read(shot);
  const colors = new Set();
  for (let index = 0; index < png.data.length; index += 4)
    colors.add(`${png.data[index]},${png.data[index + 1]},${png.data[index + 2]}`);
  return [...colors];
};

async function openSettings(page) {
  await page.locator("#user-menu-button").click();
  const settings = page.locator("#settings-entry");
  await expect(settings).toBeVisible();
  return settings;
}

const expectNoSky = async (page) => {
  await expect(page.locator(sky)).toHaveCount(0);
  await expect(page.locator(assets)).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toMatch(skyText);
};

test("Web keeps the solid per-theme backdrop without a starfield canvas or motion switch", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.addInitScript(() => localStorage.setItem("atria.appearance", "dark"));
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await expectNoSky(page);
    const dark = await backdrop(page);
    for (const layer of [dark.html, dark.body]) {
      expect(layer.color).toBe("rgb(11, 11, 12)");
      expect(layer.image).toBe("none");
    }
    // The shell only forwards the painted page, so its own background stays clear.
    expect(dark.shell).toEqual({ color: "rgba(0, 0, 0, 0)", image: "none" });
    expect(await corner(page)).toEqual(["11,11,12"]);

    const settings = await openSettings(page);
    await expect(settings).not.toContainText(skyText);
    await settings.locator('[data-appearance-value="light"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.locator("#settings-back").click();
    await expect(settings).toBeHidden();

    const light = await backdrop(page);
    for (const layer of [light.html, light.body]) {
      expect(layer.color).toBe("rgb(233, 233, 236)");
      expect(layer.image).toBe("none");
    }
    expect(light.shell).toEqual({ color: "rgba(0, 0, 0, 0)", image: "none" });
    expect(await corner(page)).toEqual(["233,233,236"]);

    const reopened = await openSettings(page);
    await reopened.locator('[data-appearance-value="dark"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator("#settings-back").click();
    await expect(reopened).toBeHidden();
    expect(await corner(page)).toEqual(["11,11,12"]);
    await expectNoSky(page);
  } finally {
    await dashboard.stop();
  }
});

test("desktop page carries no starfield canvas and stays transparent for the window material", async () => {
  test.skip(process.platform !== "darwin", "Native window material acceptance requires macOS");
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), "atria-p45-no-starfield-"));
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
    await expect(page.locator("html")).toHaveAttribute("data-window-material", "under-window");

    for (const theme of ["dark", "light"]) {
      await page.evaluate((value) => window.bookmanDesktop.appearance.set(value), theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const value = await backdrop(page);
      for (const layer of [value.html, value.body, value.shell]) {
        expect(layer.color).toBe("rgba(0, 0, 0, 0)");
        expect(layer.image).toBe("none");
      }
      await expectNoSky(page);
    }

    const settings = await openSettings(page);
    await expect(settings).not.toContainText(skyText);
  } finally {
    await native?.close();
    await stopNativeBackend(root);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
