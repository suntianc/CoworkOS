import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

/**
 * The palette (#34): overlays are solid (#28), emphasis is black and white
 * rather than a hue (#29), the layers grade from clear to solid (#30), and
 * each theme has its own selected look (#31).
 */
const overlays = [
  "reply-time-full",
  "block-zoom",
  "ui-menu",
  "session-menu",
  "model-menu",
  "toast",
  "toast-card",
  "settings-node-menu",
  "add-project-dialog",
  "run-cancel-confirm",
  "artifact-drawer"
];

const paint = (page) =>
  page.evaluate((classes) => {
    const alpha = (color) => {
      const slash = /\/\s*([\d.]+)\)$/.exec(color);
      if (slash) return Number.parseFloat(slash[1]);
      const match = /rgba?\(([^)]+)\)/.exec(color);
      const parts = match[1].split(",").map((part) => Number.parseFloat(part));
      return parts.length > 3 ? parts[3] : 1;
    };
    const probe = (className, parent = document.body) => {
      const node = document.createElement("div");
      node.className = className;
      node.textContent = "探针";
      parent.append(node);
      const style = getComputedStyle(node);
      const result = {
        background: style.backgroundColor,
        alpha: alpha(style.backgroundColor),
        blur: style.backdropFilter,
        shadow: style.boxShadow,
        color: style.color
      };
      node.remove();
      return result;
    };
    const row = document.createElement("div");
    row.className = "conversation-row";
    row.innerHTML = '<button class="conversation-item active">选中</button>';
    document.querySelector("#project-list").append(row);
    const rowStyle = getComputedStyle(row);
    const selected = { background: rowStyle.backgroundColor, shadow: rowStyle.boxShadow };
    row.remove();
    const send = getComputedStyle(document.querySelector("#send-button"));
    const stopLook = getComputedStyle(document.querySelector("#stop-button"));
    const stop = {
      background: stopLook.backgroundColor,
      alpha: alpha(stopLook.backgroundColor),
      color: stopLook.color
    };
    const sendIcon = document.querySelector("#send-button use").getAttribute("href");
    const pane = (selector) => alpha(getComputedStyle(document.querySelector(selector)).backgroundColor);
    return {
      overlays: Object.fromEntries(classes.map((name) => [name, probe(name)])),
      selected,
      primary: { background: send.backgroundColor, color: send.color },
      stop,
      sendIcon,
      layers: { main: pane(".chat-pane"), side: pane(".agent-pane"), composer: pane(".composer") }
    };
  }, overlays);

for (const theme of ["dark", "light"])
  test(`the ${theme} palette keeps overlays solid, emphasis neutral and its own selected look`, async ({
    page
  }) => {
    const dashboard = await startDashboard();
    try {
      await page.addInitScript((value) => localStorage.setItem("atria.appearance", value), theme);
      await page.goto(dashboard.base);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const result = await paint(page);

      for (const [name, overlay] of Object.entries(result.overlays)) {
        expect(overlay.alpha, name).toBe(1);
        expect(overlay.blur, name).toBe("none");
      }

      // Primary actions are the text colour on its opposite, with no hue.
      const [r, g, b] = result.primary.background.match(/\d+/g).map(Number);
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(3);
      expect(result.primary.background).toBe(theme === "dark" ? "rgb(237, 237, 239)" : "rgb(24, 24, 27)");

      // The composer's key (#25): an up arrow to send; stopping is a quiet
      // square on a faint fill in the text colour, not a second primary.
      expect(result.sendIcon).toBe("#i-arrow-up");
      expect(result.stop.color).toBe(theme === "dark" ? "rgb(237, 237, 239)" : "rgb(24, 24, 27)");
      expect(result.stop.alpha).toBeLessThan(0.25);

      // The main panel is more solid than the side panel; the composer is solid.
      expect(result.layers.main).toBeGreaterThan(result.layers.side);
      expect(result.layers.composer).toBe(1);

      if (theme === "dark") {
        // A brighter fill, with no edge or drop shadow.
        expect(result.selected.background).toBe("rgba(255, 255, 255, 0.1)");
        expect(result.selected.shadow).not.toMatch(/rgba\(0, 0, 0, 0\.\d+\) 0px [1-9]/);
      } else {
        // A raised white card: solid white, a hairline and a soft shadow.
        expect(result.selected.background).toBe("rgb(255, 255, 255)");
        expect(result.selected.shadow).toContain("0px 1px 3px");
      }
    } finally {
      await dashboard.stop();
    }
  });
