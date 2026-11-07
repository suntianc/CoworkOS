import { test, expect } from "@playwright/test";
import { startConfiguredDashboard as startDashboard } from "../test/dashboard-fixture.mjs";

async function desktopSettingsFixture(page) {
  await page.addInitScript(() => {
    const update = {
      mode: "source",
      phase: "failed",
      currentVersion: "0.1.2-beta.10",
      error: "源码包含未提交修改或未跟踪文件，请先提交或移走这些文件后重试。更新会保留现有文件。"
    };
    window.bookmanDesktop = {
      onPrepareClose() {},
      updateStatus: async () => update,
      checkUpdates: async () => update,
      applyUpdate: async () => update
    };
  });
}

async function openOverview(page) {
  const button = page.getByRole("button", { name: "设置", exact: true });
  if (!(await button.isVisible())) await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
  await button.click();
}

async function assertContained(dialog, page) {
  await expect(dialog).toBeVisible();
  const geometry = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(geometry.x).toBeGreaterThanOrEqual(0);
  expect(geometry.y).toBeGreaterThanOrEqual(0);
  expect(geometry.x + geometry.width).toBeLessThanOrEqual(viewport.width);
  expect(geometry.y + geometry.height).toBeLessThanOrEqual(viewport.height);
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  const close = dialog.getByRole("button", { name: "关闭设置", exact: true });
  await expect(close).toBeInViewport();
  const footer = dialog.locator(".modal-actions");
  if (await footer.count()) {
    await expect(footer).toBeInViewport();
    expect(await footer.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  }
}

for (const theme of ["dark", "light"]) {
  test(`settings use solid neutral surfaces and keep their controls reachable in ${theme}`, async ({
    page
  }, testInfo) => {
    test.setTimeout(60_000);
    const dashboard = await startDashboard();
    try {
      await desktopSettingsFixture(page);
      await page.goto(dashboard.base);
      for (const width of [1440, 474, 320]) {
        await page.setViewportSize({ width, height: width === 320 ? 600 : 900 });
        await openOverview(page);
        const overview = page.getByRole("dialog", { name: "设置", exact: true });
        await overview.locator("#appearance-select").selectOption(theme);
        // Keep layout changes from leaving the pointer over a button during palette checks.
        await overview.locator(".settings-heading h2").hover();
        await assertContained(overview, page);
        await expect(overview.locator("[data-update-error]")).toContainText("未提交修改");
        const surface = await overview.evaluate((node) => {
          const style = getComputedStyle(node);
          return {
            background: style.backgroundColor,
            image: style.backgroundImage,
            filter: style.backdropFilter,
            text: style.color
          };
        });
        expect(surface.background).toBe(theme === "dark" ? "rgb(25, 25, 25)" : "rgb(255, 255, 255)");
        expect(surface.image).toBe("none");
        expect(surface.filter).toBe("none");
        expect(surface.text).toBe(theme === "dark" ? "rgb(238, 238, 238)" : "rgb(36, 36, 36)");
        await expect(overview.locator("#profile-close")).toHaveCSS(
          "color",
          theme === "dark" ? "rgb(194, 194, 199)" : "rgb(85, 86, 90)"
        );
        await expect(overview.locator("#desktop-model-settings")).toHaveCSS(
          "color",
          theme === "dark" ? "rgb(194, 194, 199)" : "rgb(85, 86, 90)"
        );
        await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-overview.png`) });

        await overview.getByRole("button", { name: "管理模型连接", exact: true }).click();
        const model = page.getByRole("dialog", { name: "连接模型", exact: true });
        await assertContained(model, page);
        await model.locator('[name="model"]').fill("保留模型设置草稿");
        if ((await model.locator("details").getAttribute("open")) === null)
          await model.getByText("高级连接参数", { exact: true }).click();
        const heading = await model.locator(".settings-heading").boundingBox();
        const actions = await model.locator(".modal-actions").boundingBox();
        await model.locator('[name="subagentMaxTokens"]').scrollIntoViewIfNeeded();
        await expect(model.locator('[name="subagentMaxTokens"]')).toBeInViewport();
        expect(await model.locator(".settings-heading").boundingBox()).toEqual(heading);
        expect(await model.locator(".modal-actions").boundingBox()).toEqual(actions);
        await assertContained(model, page);
        await model.locator(".settings-scroll").evaluate((node) => (node.scrollTop = 0));
        await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-model.png`) });
        await model.getByRole("button", { name: "关闭设置", exact: true }).click();

        await openOverview(page);
        await overview.getByRole("button", { name: "管理联网搜索", exact: true }).click();
        const search = page.getByRole("dialog", { name: "联网搜索", exact: true });
        await assertContained(search, page);
        await expect(search.locator('[name="provider"]')).toHaveCSS("min-height", "40px");
        await expect(search.locator('[name="provider"]')).toHaveCSS("font-size", "14px");
        if ((await search.locator("details").getAttribute("open")) === null)
          await search.getByText("高级设置 · 可选认证", { exact: true }).click();
        await search.locator('[name="exaApiKey"]').fill("synthetic-settings-draft");
        await search.locator('[name="clearExaApiKey"]').scrollIntoViewIfNeeded();
        await assertContained(search, page);
        await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-search.png`) });
        await page.keyboard.press("Escape");
        await expect(search).toBeHidden();
        await expect(page.getByRole("button", { name: "设置", exact: true })).toBeFocused();
      }
    } finally {
      await dashboard.stop();
    }
  });
}

test("settings stay solid with reduced transparency and keep keyboard focus inside the dialog", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-reduced-transparency", value: "reduce" },
        { name: "prefers-color-scheme", value: "dark" }
      ]
    });
    await page.goto(dashboard.base);
    await openOverview(page);
    const dialog = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(dialog).toHaveCSS("backdrop-filter", "none");
    await expect(dialog).toHaveCSS("background-color", "rgb(25, 25, 25)");
    await expect(dialog).toHaveCSS("background-image", "none");
    await page.locator("#profile-close").focus();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "管理科学环境", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#profile-close")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.locator("#appearance-select")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "设置", exact: true })).toBeFocused();
  } finally {
    await client.detach();
    await dashboard.stop();
  }
});
