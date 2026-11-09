import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("project rows keep disclosure, titles and actions aligned across widths and themes", async ({
  page
}) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    for (const [index, projectName] of [
      "短项目",
      "Orbital Observatory",
      "Courtyard House · Full Project"
    ].entries()) {
      const projectDirectory = join(dashboard.root, `project-${index}`);
      await mkdir(projectDirectory);
      const response = await page.request.post(`${dashboard.base}/api/projects`, {
        data: { projectName, projectDirectory }
      });
      expect(response.status()).toBe(201);
      const { project } = await response.json();
      const task = await page.request.post(`${dashboard.base}/api/tasks`, {
        data: {
          taskId: `sidebar-${index}`,
          goal: `${projectName} — build with an agent team`,
          projectId: project.projectId
        }
      });
      expect(task.ok()).toBeTruthy();
    }
    await page.addInitScript(() => localStorage.setItem("atria.appearance", "system"));
    await page.goto(dashboard.base);
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector(".project-list")).transform === "none"
    );
    const headings = page.locator(".project-heading");
    await expect(headings).toHaveCount(3);
    for (const width of [1440, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme });
        await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
        const first = headings.first();
        for (const heading of await headings.all()) {
          await page.mouse.move(width - 10, 10);
          const before = await heading.locator(".project-name").boundingBox();
          await heading.hover();
          const after = await heading.locator(".project-name").boundingBox();
          expect(after).toEqual(before);
          const disclosure = await heading.locator(".project-disclosure").boundingBox();
          expect(disclosure.x + disclosure.width).toBeLessThanOrEqual(after.x);
          const settings = await heading.locator(".project-settings").boundingBox();
          const create = await heading.locator(".project-create").boundingBox();
          expect(settings.width).toBe(32);
          expect(settings.height).toBe(32);
          expect(create.width).toBe(32);
          expect(create.height).toBe(32);
          expect(settings.y).toBe(create.y);
          expect(settings.x + settings.width).toBeLessThanOrEqual(create.x);
          expect(create.x).toBe((await first.locator(".project-create").boundingBox()).x);
        }
        await first.hover();
        await expect(first.locator(".project-chevron")).toBeVisible();
        await first.locator(".project-row").click();
        await expect(first.locator(".project-row")).toHaveAttribute("aria-expanded", "false");
        await first.locator(".project-row").press("Enter");
        await expect(first.locator(".project-row")).toHaveAttribute("aria-expanded", "true");
        await first.locator(".project-row").press("Tab");
        await expect(first.locator(".project-settings")).toBeFocused();
        await page.screenshot({ path: test.info().outputPath(`sidebar-${width}-${colorScheme}.png`) });
      }
    }
    await headings.first().hover();
    await headings.first().locator(".project-create").click();
    await expect(page.locator(".project-group.is-selected")).toHaveCount(1);
    await headings.first().hover();
    await headings.first().locator(".project-settings").click();
    await expect(page.getByRole("dialog", { name: "项目设置", exact: true })).toBeVisible();
  } finally {
    await dashboard.stop();
  }
});
