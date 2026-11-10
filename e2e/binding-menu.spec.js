import { test, expect } from "@playwright/test";
import { mkdir, rm } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("compact binding rows stay readable, scrollable and keyboard focused during polling", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.route("**/app.js", (route) =>
      route.fulfill({ contentType: "application/javascript", body: "// isolated binding fixture" })
    );
    await page.goto(dashboard.base);
    await page.evaluate(async () => {
      const { createBindingControl } = await import("/assets/workbench/binding.js");
      const { createMenu } = await import("/assets/ui/menu.js");
      const button = document.querySelector("#app-bind-select");
      const menu = document.querySelector("#app-bind-menu");
      const instances = Array.from({ length: 12 }, (_, i) => ({
        appInstanceId: `app-${i}`,
        resourceId: `res-${i}`,
        status: "open",
        appType: "cad",
        standalone: i !== 0,
        elsewhere: i !== 0,
        title: i === 0 ? "直列四缸四冲程发动机运动装配.cad.json" : `另一个对话的长文档名称-${i}.cad.json`,
        taskGoal: "帮我做一个介绍这个 harness 的解读和模型协作交互方案，然后继续完善文档"
      }));
      const snapshot = {
        instances,
        boundResourceId: "res-0",
        applications: [{ appType: "cad", displayName: "参数化 CAD" }]
      };
      const control = createBindingControl({
        button,
        menu,
        label: button.querySelector(".app-bind-name"),
        getTaskId: () => "task-a",
        api: {},
        onSelect() {}
      });
      createMenu(button, menu, { toggleOnClick: false });
      button.addEventListener("click", () => control.toggle());
      control.update(snapshot);
      window.bindingFixture = { control, snapshot };
    });
    for (const width of [1440, 768, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await page.locator("#app-bind-select").click();
      const menu = page.locator("#app-bind-menu");
      await expect(menu).toBeVisible();
      const surface = await menu.evaluate((node) => {
        const sample = document.createElement("span");
        sample.style.backgroundColor = "var(--popover-fill)";
        node.append(sample);
        const color = getComputedStyle(sample).backgroundColor;
        sample.remove();
        return color;
      });
      const geometry = await menu.evaluate((node) => ({
        box: node.getBoundingClientRect().toJSON(),
        color: getComputedStyle(node).backgroundColor,
        scrollable: node.scrollHeight > node.clientHeight,
        rows: [...node.querySelectorAll("[data-bind-instance]")].map((row) => {
          const box = row.getBoundingClientRect();
          const content = row.querySelector(".model-option-name").getBoundingClientRect();
          return { top: box.top, bottom: box.bottom, contentBottom: content.bottom };
        })
      }));
      expect(geometry.box.x).toBeGreaterThanOrEqual(0);
      expect(geometry.box.right).toBeLessThanOrEqual(width);
      expect(geometry.box.y).toBeGreaterThanOrEqual(0);
      expect(geometry.color).toBe(surface);
      expect(geometry.scrollable).toBe(true);
      for (let i = 0; i < geometry.rows.length; i++) {
        expect(geometry.rows[i].contentBottom).toBeLessThanOrEqual(geometry.rows[i].bottom);
        if (i) expect(geometry.rows[i].top).toBeGreaterThanOrEqual(geometry.rows[i - 1].bottom);
      }
      await page.locator("[data-bind-instance='app-6']").focus();
      const previous = await menu.evaluate((node) => node.scrollTop);
      await page.evaluate(() => window.bindingFixture.control.update(window.bindingFixture.snapshot));
      await expect(page.locator("[data-bind-instance='app-6']")).toBeFocused();
      expect(await menu.evaluate((node) => node.scrollTop)).toBe(previous);
      await page.keyboard.press("ArrowDown");
      await expect(page.locator("[data-bind-instance='app-7']")).toBeFocused();
      if (width === 1440) {
        await menu.evaluate((node) => {
          node.scrollTop = 0;
        });
        await mkdir(".tmp/binding-verification", { recursive: true });
        await menu.screenshot({ path: test.info().outputPath("menu.png") });
      }
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    }
  } finally {
    await dashboard.stop();
  }
});
