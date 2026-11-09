import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const require = createRequire(import.meta.url);
const { windowMaterial } = require("../desktop/window-material.cjs");
// The host decides the macOS material; the renderer only mirrors that capability.
const host = windowMaterial("darwin");
const material = host.material;

const layers = (page) =>
  page.evaluate(() => {
    const read = (selector) => {
      const style = getComputedStyle(document.querySelector(selector));
      return { color: style.backgroundColor, image: style.backgroundImage };
    };
    const conversation = getComputedStyle(document.querySelector(".chat-pane"));
    const taskPanel = getComputedStyle(document.querySelector(".agent-pane"));
    return {
      html: read("html"),
      body: read("body"),
      shell: read(".app-shell"),
      conversation: { blur: conversation.backdropFilter, image: conversation.backgroundImage },
      taskPanel: { blur: taskPanel.backdropFilter, image: taskPanel.backgroundImage }
    };
  });

const expectClearPage = (value) => {
  for (const layer of [value.html, value.body, value.shell]) {
    expect(layer.color).toBe("rgba(0, 0, 0, 0)");
    expect(layer.image).toBe("none");
  }
  for (const panel of [value.conversation, value.taskPanel]) {
    expect(panel.blur).toContain("blur(");
    expect(panel.image).toContain("linear-gradient");
  }
};

test("a macOS window material shows the desktop through the page and keeps the glass panels", async ({
  page
}) => {
  test.skip(process.platform !== "darwin", "Native window material acceptance requires macOS");
  expect(material).toBe("under-window");
  // A clear native canvas is what lets the material show through the window.
  expect(host.options).toMatchObject({ transparent: true, backgroundColor: "#00000000" });
  const dashboard = await startDashboard();
  try {
    // Preload hands the host material to the renderer before the first paint.
    await page.addInitScript((value) => {
      window.bookmanDesktop = { windowMaterial: { material: value } };
    }, material);
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-window-material", "under-window");

    expectClearPage(await layers(page));

    await page.evaluate(() => localStorage.setItem("atria.appearance", "light"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator("html")).toHaveAttribute("data-window-material", "under-window");
    expectClearPage(await layers(page));
  } finally {
    await dashboard.stop();
  }
});
