import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { openSettings } from "./settings-helper.js";

// One token set drives both themes.
const darkTokens = {
  "--color-bg": "#0b0b0c",
  "--color-surface": "#ffffff0a",
  "--color-surface-2": "#ffffff0f",
  "--color-surface-3": "#ffffff1a",
  "--color-line": "#ffffff14",
  "--color-text": "#ededef",
  "--color-text-2": "#a1a1a8",
  "--color-text-3": "#8a8a92",
  "--color-accent": "#ededef",
  "--color-accent-soft": "#ffffff12",
  "--color-ok": "#4cc38a",
  "--color-ok-soft": "#4cc38a1f",
  "--color-warn": "#e8b04b",
  "--color-warn-soft": "#e8b04b1f",
  "--color-danger": "#f0706b",
  "--color-danger-soft": "#f0706b1f",
  "--color-review": "#6cb0f0",
  "--color-review-soft": "#6cb0f01f",
  "--color-glass": "#ffffff0d",
  "--color-glass-edge": "#ffffff1c"
};

const lightTokens = {
  "--color-bg": "#f2f2f4",
  "--color-surface": "#ffffff8c",
  "--color-surface-2": "#0000000a",
  "--color-surface-3": "#00000012",
  "--color-line": "#0000000f",
  "--color-text": "#18181b",
  "--color-text-2": "#52525b",
  "--color-text-3": "#64646d",
  "--color-accent": "#18181b",
  "--color-accent-soft": "#0000000a",
  "--color-ok": "#157f45",
  "--color-ok-soft": "#157f451a",
  "--color-warn": "#8a5a04",
  "--color-warn-soft": "#b9780a1a",
  "--color-danger": "#c03a3a",
  "--color-danger-soft": "#c03a3a14",
  "--color-review": "#1f6fb8",
  "--color-review-soft": "#1f6fb81a",
  "--color-glass": "#ffffff99",
  "--color-glass-edge": "#ffffffd9"
};

// The Web page paints one solid colour per theme; only the glass panels layer over it.
const dark = {
  page: "rgb(11, 11, 12)",
  brand: "rgb(237, 237, 239)",
  conversation: { color: "rgba(22, 22, 25, 0.82)", blur: "blur(24px)" },
  taskPanel: { color: "rgba(20, 20, 23, 0.8)", blur: "blur(32px)" }
};

const light = {
  page: "rgb(242, 242, 244)",
  brand: "rgb(24, 24, 27)",
  conversation: { color: "rgba(255, 255, 255, 0.82)", blur: "blur(24px)" },
  taskPanel: { color: "rgba(250, 250, 251, 0.78)", blur: "blur(32px)" }
};

const tokens = (page) =>
  page.evaluate((names) => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]));
  }, Object.keys(darkTokens));

const surfaces = (page) =>
  page.evaluate(() => {
    const style = (selector) => getComputedStyle(document.querySelector(selector));
    const read = (element) => ({ color: element.backgroundColor, image: element.backgroundImage });
    const conversation = style(".chat-pane");
    const taskPanel = style(".agent-pane");
    return {
      root: getComputedStyle(document.documentElement).getPropertyValue("--backdrop-image").trim(),
      windowWash: getComputedStyle(document.documentElement).getPropertyValue("--window-wash").trim(),
      brand: style("#topbar-task").color,
      html: read(style("html")),
      body: read(style("body")),
      shell: read(style(".app-shell")),
      conversation: {
        ...read(conversation),
        blur: conversation.backdropFilter,
        radius: conversation.borderTopLeftRadius
      },
      taskPanel: {
        ...read(taskPanel),
        blur: taskPanel.backdropFilter,
        radius: taskPanel.borderTopLeftRadius
      }
    };
  });

const expectSolidBackdrop = (value, theme) => {
  for (const layer of [value.html, value.body, value.shell]) expect(layer.image).toBe("none");
  expect(value.root).toBe("");
  expect(value.windowWash).toBe("");
  expect(value.html.color).toBe(theme.page);
  expect(value.body.color).toBe(theme.page);
  // The shell only forwards the page behind it, so its own background stays clear.
  expect(value.shell.color).toBe("rgba(0, 0, 0, 0)");
  expect(value.brand).toBe(theme.brand);
  // Layers (#30): the conversation nearly solid, the task panel clearer.
  for (const [panel, glass] of [
    [value.conversation, theme.conversation],
    [value.taskPanel, theme.taskPanel]
  ]) {
    expect(panel.color).toBe(glass.color);
    expect(panel.blur).toBe(glass.blur);
    expect(panel.image).toContain("linear-gradient");
    expect(panel.radius).toBe("16px");
  }
};

// The top band above the title row controls, where only the page backdrop shows.
const corner = async (page) => {
  const shot = await page.screenshot({ clip: { x: 2, y: 1, width: 24, height: 5 } });
  const png = PNG.sync.read(shot);
  const colors = new Set();
  for (let index = 0; index < png.data.length; index += 4)
    colors.add(`${png.data[index]},${png.data[index + 1]},${png.data[index + 2]}`);
  return [...colors];
};

test("Web paints one solid per-theme backdrop under one token set, with glass panels and no canvas layer", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.addInitScript(() => localStorage.setItem("atria.appearance", "dark"));
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-window-material", "none");
    // A browser has no window material and the page draws no canvas of its own.
    await expect(page.locator("canvas")).toHaveCount(0);

    expect(await tokens(page)).toEqual(darkTokens);
    expectSolidBackdrop(await surfaces(page), dark);
    expect(await corner(page)).toEqual(["11,11,12"]);

    const settings = await openSettings(page);
    await settings.locator('[data-appearance-value="light"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.locator("#settings-back").click();
    await expect(settings).toBeHidden();

    expect(await tokens(page)).toEqual(lightTokens);
    expectSolidBackdrop(await surfaces(page), light);
    expect(await corner(page)).toEqual(["242,242,244"]);

    // Switching the existing preference back keeps the painted page solid.
    const reopened = await openSettings(page);
    await reopened.locator('[data-appearance-value="dark"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator("#settings-back").click();
    await expect(reopened).toBeHidden();
    expectSolidBackdrop(await surfaces(page), dark);
    expect(await corner(page)).toEqual(["11,11,12"]);
    await expect(page.locator("canvas")).toHaveCount(0);
  } finally {
    await dashboard.stop();
  }
});
