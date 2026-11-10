import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

async function contained(dialog, page) {
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
}

test("adding a project keeps a quiet two-mode dialog in both themes and sizes", async ({ page }, info) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    const directory = join(dashboard.root, "new-project");
    await mkdir(directory);
    await page.addInitScript(() => localStorage.setItem("atria.appearance", "system"));
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("创建项目之前的草稿");
    await page.evaluate((directory) => {
      window.bookmanDesktop = { chooseProject: async () => directory };
    }, directory);
    for (const theme of ["light", "dark"]) {
      for (const width of [1440, 320]) {
        // The narrow work sidebar is off-canvas; open from the desktop width
        // and shrink the open dialog, which is the surface this test owns.
        await page.setViewportSize({ width: 1440, height: 720 });
        await page.emulateMedia({ colorScheme: theme });
        await page.locator("#new-project").click();
        if (width !== 1440) await page.setViewportSize({ width, height: 720 });
        const dialog = page.getByRole("dialog", { name: "添加项目", exact: true });
        const name = dialog.getByRole("textbox", { name: "项目名称", exact: true });
        const folder = dialog.getByRole("textbox", { name: "工作文件夹", exact: true });
        const choose = dialog.getByRole("button", { name: "选择文件夹", exact: true });
        const cancel = dialog.getByRole("button", { name: "取消", exact: true });
        await contained(dialog, page);
        await expect(name).toBeFocused();
        await expect(dialog).toHaveCSS("border-top-width", "1px");
        await expect(dialog).toHaveCSS("border-radius", "18px");
        await name.fill("新的研究项目");
        await name.press("Tab");
        await expect(folder).toBeFocused();
        await folder.press("Tab");
        await expect(choose).toBeFocused();
        await choose.click();
        await expect(folder).toHaveValue(directory);
        await dialog.getByRole("tab", { name: "Git 地址" }).click();
        await expect(dialog.getByRole("textbox", { name: "仓库地址" })).toBeVisible();
        await expect(dialog.getByRole("textbox", { name: "分支 可选" })).toBeVisible();
        await expect(dialog.getByRole("button", { name: "克隆并添加", exact: true })).toBeInViewport();
        await dialog.getByRole("tab", { name: "本地目录" }).click();
        await expect(name).toHaveValue("新的研究项目");
        await expect(dialog.getByRole("button", { name: "添加项目", exact: true })).toBeInViewport();
        await dialog.locator("h2").click();
        await page.screenshot({ path: info.outputPath(`add-project-${theme}-${width}.png`) });
        await cancel.click();
        await expect(dialog).toBeHidden();
        await expect(page.locator("#composer-input")).toHaveValue("创建项目之前的草稿");
      }
    }
    expect((await (await page.request.get(`${dashboard.base}/api/tasks`)).json()).projects).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("project dialogs and project experience confirmations use shared controls without native prompts", async ({
  page
}, info) => {
  const dashboard = await startDashboard({ defaultProject: false });
  let nativeDialogs = 0;
  page.on("dialog", async (dialog) => {
    nativeDialogs++;
    await dialog.dismiss();
  });
  try {
    const projectDirectory = join(dashboard.root, "project");
    await mkdir(projectDirectory);
    const created = await page.request.post(`${dashboard.base}/api/projects`, {
      data: { projectName: "视觉检查项目", projectDirectory }
    });
    const { project } = await created.json();
    await page.addInitScript(() => localStorage.setItem("atria.appearance", "system"));
    await page.goto(dashboard.base);
    await expect(page.locator(`[data-project="${project.projectId}"]`)).toBeVisible();
    for (const [width, theme] of [
      [1440, "light"],
      [320, "light"],
      [1440, "dark"],
      [320, "dark"]
    ]) {
      await page.setViewportSize({ width, height: 720 });
      await page.emulateMedia({ colorScheme: theme });
      const trigger = page.locator(`[data-project-settings="${project.projectId}"]`);
      await trigger.locator("..").hover();
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "项目设置", exact: true });
      await contained(dialog, page);
      await expect(dialog.getByRole("textbox", { name: "项目名称" })).toHaveCSS("font-size", "14px");
      await expect(dialog.getByRole("button", { name: "保存", exact: true })).toHaveCSS("font-size", "14px");
      await expect(dialog.getByRole("button", { name: "保存", exact: true })).toHaveCSS(
        "background-color",
        theme === "dark" ? "rgb(236, 236, 238)" : "rgb(28, 28, 34)"
      );
      await page.screenshot({ path: info.outputPath(`project-${theme}-${width}.png`) });
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.locator(`[data-project-settings="${project.projectId}"]`).locator("..").hover();
    await page.locator(`[data-project-settings="${project.projectId}"]`).click();
    await page
      .getByRole("dialog", { name: "项目设置", exact: true })
      .getByRole("button", { name: "项目经验", exact: true })
      .click();
    const experience = page.getByRole("dialog", { name: "项目经验", exact: true });
    await experience.getByRole("button", { name: "新增经验", exact: true }).click();
    await experience.getByRole("textbox", { name: "经验或技能名称", exact: true }).fill("检查约定");
    await experience.getByRole("textbox", { name: "经验或技能内容", exact: true }).fill("运行当前模块检查。");
    await experience.getByRole("button", { name: "保存内容", exact: true }).click();
    await expect(experience.locator("[data-editor]")).toBeHidden();
    const item = experience.locator("[data-experience-id]");
    await item.getByRole("button", { name: "删除", exact: true }).click();
    const confirmation = item.getByRole("group", { name: "删除确认" });
    await expect(confirmation).toContainText("删除后无法恢复");
    await expect(confirmation.getByRole("button", { name: "取消", exact: true })).toBeFocused();
    await expect(item).toHaveCSS("border-top-style", "solid");
    await page.setViewportSize({ width: 320, height: 720 });
    await contained(experience, page);
    await confirmation.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("project-experience-confirm-320.png") });
    await confirmation.getByRole("button", { name: "取消", exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(item.getByRole("button", { name: "删除", exact: true })).toBeFocused();
    await item.getByRole("button", { name: "删除", exact: true }).click();
    await item.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(item).toHaveCount(0);
    expect(nativeDialogs).toBe(0);
  } finally {
    await dashboard.stop();
  }
});

test("attachment previews retain file content and styled page controls at desktop and narrow widths", async ({
  page
}, info) => {
  const dashboard = await startDashboard();
  try {
    await page.addInitScript(() => localStorage.setItem("atria.appearance", "system"));
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("预览结束后保留的草稿");
    await page.locator("#file-input").setInputFiles({
      name: "一份标题比较长的预览资料.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("预览正文\n保留原文件内容。")
    });
    await expect(page.locator("#attachment-strip")).toContainText("已添加");
    let preview;
    await page.route("**/api/uploads/*/preview?*", async (route) => {
      const current = Number(new URL(route.request().url()).searchParams.get("page"));
      if (current === 3) return route.fulfill({ status: 503, json: { error: "预览暂时不可用" } });
      preview ??= await (await route.fetch()).json();
      return route.fulfill({ json: { ...preview, pages: 3, text: `第 ${current} 页：预览正文` } });
    });
    for (const [width, theme] of [
      [1440, "light"],
      [320, "dark"]
    ]) {
      await page.setViewportSize({ width, height: 720 });
      await page.emulateMedia({ colorScheme: theme });
      const trigger = page.locator("[data-upload-preview]");
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "一份标题比较长的预览资料.txt", exact: true });
      await contained(dialog, page);
      await expect(dialog.locator("[data-preview-content]")).toContainText("第 1 页：预览正文");
      await expect(dialog.locator("[data-previous-page]")).toBeDisabled();
      await expect(dialog.locator("[data-next-page]")).toHaveCSS("font-size", "14px");
      await expect(dialog.locator("[data-preview-close]")).toHaveCSS("width", "32px");
      await expect(page.locator(".attachment-preview")).toHaveCSS("backdrop-filter", "none");
      await expect(dialog.locator("[data-preview-download]")).toBeInViewport();
      await page.screenshot({ path: info.outputPath(`attachment-${theme}-${width}.png`) });
      await dialog.locator("[data-next-page]").click();
      await expect(dialog.locator("[data-preview-content]")).toContainText("第 2 页：预览正文");
      await expect(dialog.locator("[data-previous-page]")).toBeEnabled();
      await dialog.locator("[data-next-page]").click();
      await expect(dialog.getByRole("alert")).toContainText("可下载原文件查看");
      await expect(dialog.locator("[data-preview-download]")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      await expect(page.locator("#composer-input")).toHaveValue("预览结束后保留的草稿");
    }
  } finally {
    await dashboard.stop();
  }
});
