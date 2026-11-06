import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("shared action menus style plain rows and skip hidden groups during keyboard navigation", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await page.evaluate(async () => {
      const { createMenu } = await import("/assets/ui/menu.js");
      const host = document.createElement("div");
      host.className = "ui-menu-anchor";
      host.style.cssText = "position:fixed;top:100px;left:20px;z-index:2000";
      host.innerHTML =
        '<button id="design-menu-trigger">文件操作</button><div class="ui-menu" id="design-menu" hidden><button>打开文件</button><div role="group" hidden><button>不可用的隐藏操作</button></div><button>保存副本</button></div>';
      document.body.append(host);
      createMenu(host.querySelector("button"), host.querySelector(".ui-menu"));
    });
    const trigger = page.locator("#design-menu-trigger");
    const menu = page.locator("#design-menu");
    await trigger.click();
    await expect(menu.getByRole("button", { name: "打开文件", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("button", { name: "保存副本", exact: true })).toBeFocused();
    await expect(menu.getByRole("button", { name: "保存副本", exact: true })).toHaveCSS("font-size", "14px");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
  } finally {
    await dashboard.stop();
  }
});
