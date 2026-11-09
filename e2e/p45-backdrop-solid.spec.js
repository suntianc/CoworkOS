import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const surfaces = (page) =>
  page.evaluate(() => {
    const style = (selector) => getComputedStyle(document.querySelector(selector));
    const read = (element) => ({
      color: element.backgroundColor,
      image: element.backgroundImage
    });
    const conversation = style(".chat-pane");
    const taskPanel = style(".agent-pane");
    return {
      root: getComputedStyle(document.documentElement).getPropertyValue("--backdrop-image").trim(),
      windowWash: getComputedStyle(document.documentElement).getPropertyValue("--window-wash").trim(),
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

const expectSolidBackdrop = (value, color) => {
  for (const layer of [value.html, value.body, value.shell]) expect(layer.image).toBe("none");
  expect(value.root).toBe("");
  expect(value.windowWash).toBe("");
  expect(value.html.color).toBe(color);
  expect(value.body.color).toBe(color);
  // The shell only forwards the page behind it, so its own background stays clear.
  expect(value.shell.color).toBe("rgba(0, 0, 0, 0)");
};

test("Web paints one solid backdrop per theme with no gradients and keeps the glass panels", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.addInitScript(() => localStorage.setItem("atria.appearance", "dark"));
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-window-material", "none");

    const dark = await surfaces(page);
    expectSolidBackdrop(dark, "rgb(14, 14, 15)");
    for (const panel of [dark.conversation, dark.taskPanel]) {
      expect(panel.color).toBe("rgba(255, 255, 255, 0.06)");
      expect(panel.image).toContain("linear-gradient");
      expect(panel.blur).toBe("blur(20px)");
      expect(panel.radius).toBe("16px");
    }

    await page.locator("#user-menu-button").click();
    const dialog = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.locator("#appearance-select").selectOption("light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    const light = await surfaces(page);
    expectSolidBackdrop(light, "rgb(244, 244, 248)");
    for (const panel of [light.conversation, light.taskPanel]) {
      expect(panel.color).toBe("rgba(255, 255, 255, 0.55)");
      expect(panel.image).toContain("linear-gradient");
      expect(panel.blur).toBe("blur(20px)");
      expect(panel.radius).toBe("16px");
    }

    // Switching back keeps the painted page solid and the panels untouched.
    await dialog.locator("#appearance-select").selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expectSolidBackdrop(await surfaces(page), "rgb(14, 14, 15)");
  } finally {
    await dashboard.stop();
  }
});
