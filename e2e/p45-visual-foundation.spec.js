import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const dark = {
  "--color-bg": "#0e0e0f",
  "--color-surface": "#ffffff0a",
  "--color-surface-2": "#ffffff0f",
  "--color-surface-3": "#ffffff1a",
  "--color-line": "#ffffff14",
  "--color-text": "#ececee",
  "--color-text-2": "#a1a1a8",
  "--color-text-3": "#6e6e76",
  "--color-accent": "#8b93ff",
  "--color-accent-soft": "#8b93ff22",
  "--color-ok": "#5bd08a",
  "--color-ok-soft": "#5bd08a1f",
  "--color-warn": "#f2b54b",
  "--color-warn-soft": "#f2b54b1f",
  "--color-danger": "#f27272",
  "--color-danger-soft": "#f272721f",
  "--color-review": "#c08bff",
  "--color-review-soft": "#c08bff22",
  "--color-glass": "#ffffff0d",
  "--color-glass-edge": "#ffffff24"
};

const light = {
  "--color-bg": "#f4f4f8",
  "--color-surface": "#ffffff8c",
  "--color-surface-2": "#0000000a",
  "--color-surface-3": "#00000012",
  "--color-line": "#00000014",
  "--color-text": "#1c1c22",
  "--color-text-2": "#565663",
  "--color-text-3": "#8a8a96",
  "--color-accent": "#5b63e6",
  "--color-accent-soft": "#5b63e61f",
  "--color-ok": "#1e9b55",
  "--color-ok-soft": "#1e9b551a",
  "--color-warn": "#b97a06",
  "--color-warn-soft": "#e3a0201f",
  "--color-danger": "#d64545",
  "--color-danger-soft": "#d645451a",
  "--color-review": "#8a4fd6",
  "--color-review-soft": "#8a4fd61f",
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
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
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
        brandColor: style(".brand-lockup strong").color
      };
    });
    // The browser has no window material, so the page paints one solid backdrop.
    expect(surface.backdrop.image).toBe("none");
    expect(surface.backdrop.color).toBe("rgb(14, 14, 15)");
    for (const panel of [surface.conversation, surface.taskPanel]) {
      expect(panel.color).toBe("rgba(255, 255, 255, 0.06)");
      expect(panel.image).toContain("linear-gradient");
      expect(panel.blur).toBe("blur(20px)");
      expect(panel.radius).toBe("16px");
    }
    expect(surface.brandColor).toBe("rgb(236, 236, 238)");

    // Switching the existing preference keeps the same component tokens.
    const dialog = await openSettings(page);
    await dialog.locator("#appearance-select").selectOption("light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(await tokens(page)).toEqual(light);
    const lightBackdrop = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      return {
        image: body.backgroundImage,
        color: body.backgroundColor,
        panel: getComputedStyle(document.querySelector(".chat-pane")).backgroundColor,
        text: getComputedStyle(document.querySelector(".brand-lockup strong")).color
      };
    });
    expect(lightBackdrop.image).toBe("none");
    expect(lightBackdrop.color).toBe("rgb(244, 244, 248)");
    expect(lightBackdrop.panel).toBe("rgba(255, 255, 255, 0.55)");
    expect(lightBackdrop.text).toBe("rgb(28, 28, 34)");
    await dialog.locator("#appearance-select").selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  } finally {
    await dashboard.stop();
  }
});

test("Formicand replaces the old name in the title, sidebar, mark and about row", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();

    await expect(page).toHaveTitle("Formicand");
    const brand = page.locator(".brand-lockup");
    await expect(brand).toContainText("Formicand");
    await expect(brand.locator(".brand-symbol use")).toHaveAttribute("href", "#i-formicand-mark");

    const icon = await page.locator('link[rel="icon"]').getAttribute("href");
    expect(icon).toBe("/assets/brand/app-icon.svg");
    const iconResponse = await page.request.get(new URL(icon, page.url()).href);
    expect(iconResponse.ok()).toBe(true);
    expect(iconResponse.headers()["content-type"]).toContain("svg");

    const dialog = await openSettings(page);
    const about = dialog.locator(".about-product");
    await expect(about).toContainText("Formicand");
    await expect(about.locator(".about-mark use")).toHaveAttribute("href", "#i-formicand-mark");
    await expect(about.locator("[data-update-action]")).toBeHidden();

    // Visible product copy no longer carries the vendor name.
    expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/CoworkOS/);
  } finally {
    await dashboard.stop();
  }
});
