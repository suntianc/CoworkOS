import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { PROJECT_EXPERIENCE_ENABLED } from "../dist/src/domain/project-experience.js";

// Project experience is switched off as a whole (#33): its screens are gone and
// its routes do not answer. The disabled state is checked in secondary-surfaces;
// these return with the switch or are deleted in the P9 cleanup.
test.skip(!PROJECT_EXPERIENCE_ENABLED, "项目经验已整套停用（#33），P9 清理时随代码删除");

async function createProject(page, dashboard, name) {
  const projectDirectory = join(dashboard.root, name);
  await mkdir(projectDirectory, { recursive: true });
  const response = await page.request.post(`${dashboard.base}/api/projects`, {
    data: { projectName: name, projectDirectory }
  });
  expect(response.status()).toBe(201);
  return (await response.json()).project;
}
const dialogFor = (page) => page.getByRole("dialog", { name: "项目经验", exact: true });
async function openExperience(page, project) {
  await page.locator(`[data-project="${project.projectId}"] .project-heading`).hover();
  await page.locator(`[data-project-settings="${project.projectId}"]`).click();
  await page
    .getByRole("dialog", { name: "项目设置", exact: true })
    .getByRole("button", { name: "项目经验", exact: true })
    .click();
  const dialog = dialogFor(page);
  await expect(dialog.getByRole("button", { name: "新增经验", exact: true })).toBeEnabled();
  return dialog;
}
async function closeExperience(page) {
  await dialogFor(page).getByRole("button", { name: "关闭项目经验", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "项目设置", exact: true });
  if (await settings.isVisible()) await settings.getByRole("button", { name: "取消", exact: true }).click();
}
async function saveItem(dialog, name, content) {
  await dialog.getByRole("textbox", { name: "经验或技能名称", exact: true }).fill(name);
  await dialog.getByRole("textbox", { name: "适用情形", exact: true }).fill("处理当前项目中的重复任务时");
  await dialog.getByRole("textbox", { name: "经验或技能内容", exact: true }).fill(content);
  await dialog.getByRole("button", { name: "保存内容", exact: true }).click();
  await expect(dialog.locator("[data-editor]")).toBeHidden();
  await expect(dialog.locator("[data-error]")).toBeEmpty();
}
const itemFor = (dialog, title) =>
  dialog.locator("[data-experience-id]").filter({
    has: dialog.page().getByRole("heading", { name: title, exact: true })
  });

test("project experiences and skills support manual versions, controls, restart and project isolation", async ({
  page
}, testInfo) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    const a = await createProject(page, dashboard, "经验项目甲");
    const b = await createProject(page, dashboard, "经验项目乙");
    await page.goto(dashboard.base);
    let dialog = await openExperience(page, a);
    for (const name of ["使用项目经验", "自动沉淀", "自动启用已验证经验与技能"]) {
      await expect(dialog.getByRole("checkbox", { name, exact: true })).not.toBeChecked();
    }
    await page.screenshot({ path: testInfo.outputPath("project-experience-overview.png"), fullPage: true });
    await dialog.getByRole("checkbox", { name: "使用项目经验", exact: true }).check();
    await dialog.getByText("后台整理设置", { exact: true }).click();
    await dialog.getByRole("textbox", { name: "项目后台模型", exact: true }).fill("project-background-small");
    await dialog.getByRole("spinbutton", { name: "项目每小时请求上限", exact: true }).fill("4");
    await dialog.getByRole("spinbutton", { name: "项目单次输出上限", exact: true }).fill("1024");
    await dialog.getByRole("button", { name: "保存项目经验设置", exact: true }).click();
    await expect(dialog.locator("[data-status]")).toHaveText("已保存");
    await dialog.getByRole("button", { name: "新增经验", exact: true }).click();
    await saveItem(dialog, "项目检查约定", "修改项目文件后，先运行当前模块的检查。");
    await expect(itemFor(dialog, "项目检查约定")).toBeVisible();
    await dialog.getByRole("button", { name: "新增技能", exact: true }).click();
    await saveItem(dialog, "发布前核验", "1. 检查产物。\n2. 运行本地验证。\n3. 保留结果。");
    const skill = itemFor(dialog, "发布前核验");
    await skill.getByRole("button", { name: "编辑", exact: true }).click();
    await saveItem(dialog, "发布前核验", "1. 检查产物及版本。\n2. 运行本地验证。\n3. 保留结果和恢复步骤。");
    await skill.getByRole("button", { name: "取消固定", exact: true }).click();
    await expect(skill.getByRole("button", { name: "固定版本", exact: true })).toBeVisible();
    await skill.getByRole("button", { name: "固定版本", exact: true }).click();
    await expect(skill).toContainText("已固定");
    const disable = skill.getByRole("button", { name: "停用", exact: true });
    if (await disable.count()) await disable.click();
    await expect(skill).toContainText("已停用");
    await skill.getByText("历史版本", { exact: true }).click();
    await skill.getByRole("button", { name: "回滚到此版本", exact: true }).first().click();
    await skill.getByText("查看内容", { exact: true }).click();
    await expect(skill.locator("pre")).toHaveText("1. 检查产物。\n2. 运行本地验证。\n3. 保留结果。");
    await page.screenshot({ path: testInfo.outputPath("project-experience-desktop.png"), fullPage: true });
    await closeExperience(page);
    dialog = await openExperience(page, b);
    await expect(dialog.locator("[data-experience-id]")).toHaveCount(0);
    await expect(dialog.getByRole("checkbox", { name: "使用项目经验", exact: true })).not.toBeChecked();
    await closeExperience(page);
    await dashboard.restart();
    await page.goto(dashboard.base);
    dialog = await openExperience(page, a);
    await expect(dialog.getByRole("checkbox", { name: "使用项目经验", exact: true })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: "自动沉淀", exact: true })).not.toBeChecked();
    await expect(itemFor(dialog, "项目检查约定")).toBeVisible();
    await expect(itemFor(dialog, "发布前核验")).toContainText("已固定");
    await dialog.getByText("后台整理设置", { exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "项目后台模型", exact: true })).toHaveValue(
      "project-background-small"
    );
    await dialog.getByRole("textbox", { name: "项目后台模型", exact: true }).fill("");
    await dialog.getByRole("button", { name: "保存项目经验设置", exact: true }).click();
    await expect(dialog.locator("[data-status]")).toHaveText("已保存");
    const settings = await (
      await page.request.get(`${dashboard.base}/api/projects/${a.projectId}/experience`)
    ).json();
    expect(settings.settings.model).toBeUndefined();
    await dialog.getByRole("button", { name: "新增经验", exact: true }).click();
    await dialog.getByRole("textbox", { name: "经验或技能名称", exact: true }).fill("关闭后保留的草稿");
    await dialog.getByRole("textbox", { name: "经验或技能内容", exact: true }).fill("未保存的项目内容");
    await closeExperience(page);
    dialog = await openExperience(page, a);
    await expect(dialog.getByRole("textbox", { name: "经验或技能内容", exact: true })).toHaveValue(
      "未保存的项目内容"
    );
    await dialog.getByRole("button", { name: "收起编辑", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.locator(".settings-scroll").evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("project-experience-narrow.png"), fullPage: true });
  } finally {
    await dashboard.stop();
  }
});

test("project experience conflicts preserve a browser draft until the user discards it", async ({ page }) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    const project = await createProject(page, dashboard, "冲突项目");
    await page.goto(dashboard.base);
    const dialog = await openExperience(page, project);
    await dialog.getByRole("button", { name: "新增经验", exact: true }).click();
    await saveItem(dialog, "并行编辑经验", "最初内容");
    const item = itemFor(dialog, "并行编辑经验");
    await item.getByRole("button", { name: "编辑", exact: true }).click();
    await dialog.getByRole("textbox", { name: "经验或技能内容", exact: true }).fill("当前窗口未保存内容");
    const endpoint = `${dashboard.base}/api/projects/${project.projectId}/experience`;
    const stored = await (await page.request.get(endpoint)).json();
    const source = (stored.items ?? stored.entries).find((entry) => entry.title === "并行编辑经验");
    const changed = await page.request.post(endpoint, {
      data: {
        action: "save",
        snapshotRevision: stored.revision,
        item: {
          id: source.id,
          revision: source.revision,
          kind: source.kind,
          title: source.title,
          description: source.description,
          content: "其他窗口已保存内容"
        }
      }
    });
    expect(changed.ok()).toBe(true);
    await dialog.getByRole("button", { name: "保存内容", exact: true }).click();
    await expect(dialog.locator("[data-error]")).toContainText("草稿已保留");
    await expect(dialog.getByRole("textbox", { name: "经验或技能内容", exact: true })).toHaveValue(
      "当前窗口未保存内容"
    );
    await dialog.getByRole("button", { name: "刷新列表", exact: true }).click();
    await expect(dialog.locator("[data-status]")).toBeEmpty();
    await expect(dialog.getByRole("textbox", { name: "经验或技能内容", exact: true })).toHaveValue(
      "当前窗口未保存内容"
    );
    await dialog.getByRole("button", { name: "放弃本次修改", exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "经验或技能内容", exact: true })).toHaveValue(
      "其他窗口已保存内容"
    );
  } finally {
    await dashboard.stop();
  }
});
