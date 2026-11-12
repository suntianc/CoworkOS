import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const dark = {
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

const light = {
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

const tokens = (page) =>
  page.evaluate((names) => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]));
  }, Object.keys(dark));

async function openSettings(page) {
  await page.locator("#user-menu-button").click();
  await expect(page.locator("#settings-entry")).toBeVisible();
  return page.locator("#settings-entry");
}

test("Web keeps one token set for both themes and floats glass panels over its solid backdrop", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.addInitScript(() => localStorage.setItem("atria.appearance", "dark"));
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-window-material", "none");

    expect(await tokens(page)).toEqual(dark);

    const surface = await page.evaluate(() => {
      const style = (selector) => getComputedStyle(document.querySelector(selector));
      const body = style("body");
      const conversation = style(".chat-pane");
      const taskPanel = style(".agent-pane");
      return {
        backdrop: { color: body.backgroundColor, image: body.backgroundImage },
        conversation: {
          color: conversation.backgroundColor,
          image: conversation.backgroundImage,
          blur: conversation.backdropFilter,
          radius: conversation.borderTopLeftRadius
        },
        taskPanel: {
          color: taskPanel.backgroundColor,
          image: taskPanel.backgroundImage,
          blur: taskPanel.backdropFilter,
          radius: taskPanel.borderTopLeftRadius
        },
        brandColor: style("#topbar-task").color
      };
    });
    // The browser has no window material, so the page paints one solid backdrop.
    expect(surface.backdrop.image).toBe("none");
    expect(surface.backdrop.color).toBe("rgb(11, 11, 12)");
    // Layers (#30): the conversation is nearly solid, the task panel clearer.
    expect(surface.conversation.color).toBe("rgba(22, 22, 25, 0.82)");
    expect(surface.conversation.blur).toBe("blur(24px)");
    expect(surface.taskPanel.color).toBe("rgba(20, 20, 23, 0.8)");
    expect(surface.taskPanel.blur).toBe("blur(32px)");
    for (const panel of [surface.conversation, surface.taskPanel]) {
      expect(panel.image).toContain("linear-gradient");
      expect(panel.radius).toBe("16px");
    }
    expect(surface.brandColor).toBe("rgb(237, 237, 239)");

    // Switching the existing preference keeps the same component tokens.
    const settings = await openSettings(page);
    await settings.locator('[data-appearance-value="light"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(await tokens(page)).toEqual(light);
    const lightBackdrop = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      return {
        image: body.backgroundImage,
        color: body.backgroundColor,
        panel: getComputedStyle(document.querySelector(".chat-pane")).backgroundColor,
        text: getComputedStyle(document.querySelector("#topbar-task")).color
      };
    });
    expect(lightBackdrop.image).toBe("none");
    expect(lightBackdrop.color).toBe("rgb(242, 242, 244)");
    expect(lightBackdrop.panel).toBe("rgba(255, 255, 255, 0.82)");
    expect(lightBackdrop.text).toBe("rgb(24, 24, 27)");
    await settings.locator('[data-appearance-value="dark"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  } finally {
    await dashboard.stop();
  }
});

test("Formicand replaces the old name in the title, mark and about row", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();

    await expect(page).toHaveTitle("Formicand");
    // The sidebar carries no brand row; the window title, icon and about row name the product.
    await expect(page.locator("#conversation-sidebar .brand-lockup")).toHaveCount(0);

    const icon = await page.locator('link[rel="icon"]').getAttribute("href");
    expect(icon).toBe("/assets/brand/app-icon.svg");
    const iconResponse = await page.request.get(new URL(icon, page.url()).href);
    expect(iconResponse.ok()).toBe(true);
    expect(iconResponse.headers()["content-type"]).toContain("svg");

    const settings = await openSettings(page);
    const about = settings.locator(".about-product");
    await expect(about).toContainText("Formicand");
    await expect(about.locator(".about-mark use")).toHaveAttribute("href", "#i-formicand-mark");
    await expect(about.locator("[data-update-action]")).toBeHidden();

    // Visible product copy no longer carries the vendor name.
    expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/CoworkOS/);
  } finally {
    await dashboard.stop();
  }
});
