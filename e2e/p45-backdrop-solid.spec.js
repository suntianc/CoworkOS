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
    expectSolidBackdrop(dark, "rgb(11, 11, 12)");
    // Layers (#30): the conversation nearly solid, the task panel clearer.
    expect(dark.conversation.color).toBe("rgba(22, 22, 25, 0.92)");
    expect(dark.conversation.blur).toBe("blur(24px)");
    expect(dark.taskPanel.color).toBe("rgba(20, 20, 23, 0.8)");
    expect(dark.taskPanel.blur).toBe("blur(32px)");
    for (const panel of [dark.conversation, dark.taskPanel]) {
      expect(panel.image).toContain("linear-gradient");
      expect(panel.radius).toBe("16px");
    }

    await page.locator("#user-menu-button").click();
    const settings = page.locator("#settings-entry");
    await expect(settings).toBeVisible();
    await settings.locator('[data-appearance-value="light"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    const light = await surfaces(page);
    expectSolidBackdrop(light, "rgb(233, 233, 236)");
    expect(light.conversation.color).toBe("rgba(255, 255, 255, 0.95)");
    expect(light.conversation.blur).toBe("blur(24px)");
    expect(light.taskPanel.color).toBe("rgba(250, 250, 251, 0.78)");
    expect(light.taskPanel.blur).toBe("blur(32px)");
    for (const panel of [light.conversation, light.taskPanel]) {
      expect(panel.image).toContain("linear-gradient");
      expect(panel.radius).toBe("16px");
    }

    // Switching back keeps the painted page solid and the panels untouched.
    await settings.locator('[data-appearance-value="dark"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expectSolidBackdrop(await surfaces(page), "rgb(11, 11, 12)");
  } finally {
    await dashboard.stop();
  }
});
