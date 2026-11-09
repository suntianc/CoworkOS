import { loadCurrentApplication } from "./application-context-helper.js";
import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test, expect } from "@playwright/test";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

async function createProject(page, dashboard, projectName, projectDirectory) {
  await mkdir(projectDirectory, { recursive: true });
  const response = await page.request.post(`${dashboard.base}/api/projects`, {
    data: { projectName, projectDirectory }
  });
  expect(response.status()).toBe(201);
  return (await response.json()).project;
}
const groupFor = (page, projectId) => page.locator(`.project-group[data-project="${projectId}"]`);
const settingsFor = (page, projectId) => page.locator(`[data-project-settings="${projectId}"]`);
const newConversationFor = (page, projectId) => page.locator(`[data-project-create="${projectId}"]`);
const taskDetail = async (page, dashboard, taskId) =>
  (await page.request.get(`${dashboard.base}/api/tasks/${taskId}`)).json();
async function expectTaskProject(page, dashboard, taskId, expected) {
  const detail = await taskDetail(page, dashboard, taskId);
  for (const [field, value] of Object.entries(expected))
    expect(detail[field], `Task detail ${field}`).toBe(value);
}

test("creating and editing an empty project survives a service restart without creating a conversation", async ({
  page
}) => {
  const dashboard = await startDashboard({ defaultProject: false });
  const original = join(dashboard.root, "empty-project");
  const updated = join(dashboard.root, "updated-project");
  try {
    await mkdir(original);
    await mkdir(updated);
    await page.goto(dashboard.base);
    await expect(page.locator(".project-group")).toHaveCount(0);
    await page.locator("#composer-input").fill("创建前未发送的草稿");
    await page.locator("#new-project").click();
    let dialog = page.getByRole("dialog", { name: "新建项目", exact: true });
    await dialog.getByRole("textbox", { name: "项目名称" }).fill("取消的项目");
    await dialog.getByRole("textbox", { name: "工作文件夹" }).fill(original);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("#composer-input")).toHaveValue("创建前未发送的草稿");
    expect((await (await page.request.get(`${dashboard.base}/api/tasks`)).json()).projects).toEqual([]);
    await page.evaluate((directory) => {
      window.bookmanDesktop = { chooseProject: async () => directory };
    }, original);
    await page.locator("#new-project").click();
    dialog = page.getByRole("dialog", { name: "新建项目", exact: true });
    await dialog.getByRole("textbox", { name: "项目名称" }).fill("独立项目");
    await dialog.getByRole("button", { name: "选择文件夹", exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "工作文件夹" })).toHaveValue(original);
    await page.screenshot({ path: test.info().outputPath("project-create-dialog.png") });
    await dialog.getByRole("button", { name: "创建", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".project-group")).toHaveCount(1);
    const projectId = await page.locator(".project-group").getAttribute("data-project");
    expect(projectId).toMatch(/^project_[a-f0-9-]{36}$/);
    await expect(groupFor(page, projectId)).toContainText("独立项目");
    await expect(groupFor(page, projectId)).toContainText("还没有对话");
    await page.screenshot({ path: test.info().outputPath("empty-project-sidebar.png") });
    expect((await (await page.request.get(`${dashboard.base}/api/tasks`)).json()).tasks).toEqual([]);
    await page.reload();
    await expect(groupFor(page, projectId)).toBeVisible();
    await settingsFor(page, projectId).locator("..").hover();
    await settingsFor(page, projectId).click();
    dialog = page.getByRole("dialog", { name: "项目设置", exact: true });
    await dialog.getByRole("textbox", { name: "项目名称" }).fill("重命名的项目");
    await dialog.getByRole("textbox", { name: "工作文件夹" }).fill(updated);
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toBeHidden();
    await dashboard.restart();
    await page.reload();
    await expect(groupFor(page, projectId)).toContainText("重命名的项目");
    await settingsFor(page, projectId).locator("..").hover();
    await settingsFor(page, projectId).click();
    dialog = page.getByRole("dialog", { name: "项目设置", exact: true });
    await expect(dialog.getByRole("textbox", { name: "项目名称" })).toHaveValue("重命名的项目");
    await expect(dialog.getByRole("textbox", { name: "工作文件夹" })).toHaveValue(updated);
    const catalog = await (await page.request.get(`${dashboard.base}/api/tasks`)).json();
    expect(catalog.tasks).toEqual([]);
    expect(catalog.projects).toEqual([
      expect.objectContaining({
        projectId,
        projectName: "重命名的项目",
        projectDirectory: updated,
        tasks: []
      })
    ]);
  } finally {
    await dashboard.stop();
  }
});

test("project drafts inherit the selected project and canceling settings preserves the conversation draft", async ({
  page
}) => {
  const provider = await modelProtocolFixture("openai-completions", () => ({ text: "项目会话已创建" }));
  const dashboard = await startDashboard({ defaultProject: false, modelEndpoint: provider.baseUrl });
  try {
    const a = await createProject(page, dashboard, "项目 A", join(dashboard.root, "a"));
    const b = await createProject(page, dashboard, "项目 B", join(dashboard.root, "b"));
    await page.request.post(`${dashboard.base}/api/tasks`, {
      data: { taskId: "original", goal: "原会话", projectId: a.projectId }
    });
    await page.goto(dashboard.base);
    await page.locator('.conversation-item[data-task="original"]').click();
    await page.locator("#composer-input").fill("原会话草稿");
    await settingsFor(page, a.projectId).locator("..").hover();
    await settingsFor(page, a.projectId).click();
    const dialog = page.getByRole("dialog", { name: "项目设置", exact: true });
    await dialog.getByRole("textbox", { name: "项目名称" }).fill("不应保存的名称");
    await dialog.getByRole("textbox", { name: "工作文件夹" }).fill(b.projectDirectory);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.locator(".conversation-item.active")).toHaveAttribute("data-task", "original");
    await expect(page.locator("#composer-input")).toHaveValue("原会话草稿");
    expect((await taskDetail(page, dashboard, "original")).projectDirectory).toBe(a.projectDirectory);
    await expect(groupFor(page, a.projectId)).toContainText("项目 A");
    await expect(page.locator("#workspace-button")).toHaveCount(0);
    await page.getByRole("button", { name: "会话菜单", exact: true }).click();
    await expect(page.locator('[data-session-action="workspace"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    await newConversationFor(page, b.projectId).locator("..").hover();
    await newConversationFor(page, b.projectId).click();
    await expect(page.locator(".project-group.is-selected .project-name")).toHaveText("项目 B");
    await expect(page.locator("#composer-input")).toHaveValue("");
    await page.locator("#composer-input").fill("项目 B 的新会话草稿");
    await newConversationFor(page, a.projectId).locator("..").hover();
    await newConversationFor(page, a.projectId).click();
    await page.locator("#composer-input").fill("项目 A 的新会话草稿");
    await newConversationFor(page, b.projectId).locator("..").hover();
    await newConversationFor(page, b.projectId).click();
    await expect(page.locator("#composer-input")).toHaveValue("项目 B 的新会话草稿");
    expect((await (await page.request.get(`${dashboard.base}/api/tasks`)).json()).tasks).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
    await page.locator("#new-conversation").click();
    await expect(page.locator(".project-group.is-selected .project-name")).toHaveText("项目 B");
    await page.locator("#composer-input").fill("在项目 B 中开始");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("项目会话已创建", { timeout: 30_000 });
    await expect(page.locator("#stop-button")).toBeHidden();
    const taskId = await page.locator(".conversation-item.active").getAttribute("data-task");
    await expect(groupFor(page, b.projectId).locator(`[data-task="${taskId}"]`)).toBeVisible();
    await expectTaskProject(page, dashboard, taskId, {
      projectId: b.projectId,
      projectName: "项目 B",
      projectDirectory: b.projectDirectory,
      workspaceRoot: b.projectDirectory,
      storageRoot: dashboard.workspaceRoot
    });
    await page.locator('.conversation-item[data-task="original"]').click();
    await expect(page.locator("#composer-input")).toHaveValue("原会话草稿");
    await expect(page.locator(".project-group.is-selected .project-name")).toHaveText("项目 A");
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});

test("two projects use isolated real Pi working directories and reject folder changes during a run", async ({
  page
}) => {
  test.setTimeout(90_000);
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  let blocked = false;
  const provider = await modelProtocolFixture("openai-completions", async (body) => {
    const lastUser = body.messages.findLastIndex((message) => message.role === "user");
    const turn = body.messages.slice(lastUser);
    if (JSON.stringify(turn[0]).includes("保持运行")) {
      blocked = true;
      await gate;
      return { text: "长运行已结束" };
    }
    const tool = turn.find((message) => message.role === "tool");
    if (!tool) return { name: "read", arguments: { path: "project-marker.txt" } };
    return { text: JSON.stringify(tool).includes("PROJECT_A") ? "读取到项目 A" : "读取到项目 B" };
  });
  const dashboard = await startDashboard({ defaultProject: false, modelEndpoint: provider.baseUrl });
  try {
    const a = await createProject(page, dashboard, "隔离项目 A", join(dashboard.root, "a"));
    const b = await createProject(page, dashboard, "隔离项目 B", join(dashboard.root, "b"));
    await writeFile(join(a.projectDirectory, "project-marker.txt"), "PROJECT_A");
    await writeFile(join(b.projectDirectory, "project-marker.txt"), "PROJECT_B");
    await page.goto(dashboard.base);
    const ids = [];
    for (const [project, letter] of [
      [a, "A"],
      [b, "B"]
    ]) {
      await newConversationFor(page, project.projectId).locator("..").hover();
      await newConversationFor(page, project.projectId).click();
      await page.locator("#composer-input").fill(`读取独立项目 ${letter} 的标记`);
      await page.locator("#send-button").click();
      await expect(page.locator("#conversation")).toContainText(`读取到项目 ${letter}`, { timeout: 30_000 });
      await expect(page.locator("#stop-button")).toBeHidden();
      ids.push(await page.locator(".conversation-item.active").getAttribute("data-task"));
      await expect
        .poll(async () => (await taskDetail(page, dashboard, ids.at(-1))).runtime.active)
        .toBe(false);
      const body = provider.requests.at(-1).body;
      expect(JSON.stringify(body.messages.filter((message) => message.role === "system"))).toContain(
        await realpath(project.projectDirectory)
      );
      expect(JSON.stringify(body.messages.filter((message) => message.role === "tool"))).toContain(
        `PROJECT_${letter}`
      );
    }
    expect(ids[0]).not.toBe(ids[1]);
    expect(JSON.stringify(provider.requests.at(-1).body.messages)).not.toContain("读取独立项目 A 的标记");
    await page.locator(`.conversation-item[data-task="${ids[0]}"]`).click();
    await page.locator("#composer-input").fill("再次读取项目 A 的标记");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("再次读取项目 A 的标记");
    await expect
      .poll(
        () => {
          const users = provider.requests.at(-1)?.body.messages.filter((message) => message.role === "user");
          return JSON.stringify(users?.at(-1)).includes("再次读取项目 A 的标记");
        },
        { timeout: 30_000 }
      )
      .toBe(true);
    await expect
      .poll(async () => (await taskDetail(page, dashboard, ids[0])).runtime.active, { timeout: 30_000 })
      .toBe(false);
    expect(JSON.stringify(provider.requests.at(-1).body.messages)).toContain("读取独立项目 A 的标记");
    expect(JSON.stringify(provider.requests.at(-1).body.messages)).not.toContain("读取独立项目 B 的标记");
    await page.locator("#composer-input").fill("保持运行");
    await page.locator("#send-button").click();
    await expect.poll(() => blocked, { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await taskDetail(page, dashboard, ids[0])).runtime.active).toBe(true);
    const replacement = join(dashboard.root, "replacement");
    await mkdir(replacement);
    await settingsFor(page, a.projectId).locator("..").hover();
    await settingsFor(page, a.projectId).click();
    const dialog = page.getByRole("dialog", { name: "项目设置", exact: true });
    await dialog.getByRole("textbox", { name: "工作文件夹" }).fill(replacement);
    const rejected = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === `/api/projects/${a.projectId}`
    );
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    expect((await rejected).status()).toBe(409);
    await expect(dialog.getByRole("alert")).toBeVisible();
    expect((await taskDetail(page, dashboard, ids[0])).projectDirectory).toBe(a.projectDirectory);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    release();
    await expect(page.locator("#conversation")).toContainText("长运行已结束", { timeout: 30_000 });
    await expect(page.locator("#stop-button")).toBeHidden();
  } finally {
    release();
    await dashboard.stop();
    await provider.close();
  }
});

test("legacy directory groups keep their identities while explicit empty projects remain visible", async ({
  page
}) => {
  const dashboard = await startDashboard({ defaultProject: false });
  const legacy = join(dashboard.root, "legacy-project");
  try {
    await mkdir(legacy);
    const empty = await createProject(page, dashboard, "空项目", join(dashboard.root, "empty"));
    const response = await page.request.post(`${dashboard.base}/api/tasks`, {
      data: { taskId: "legacy", goal: "旧目录会话", workspaceRoot: legacy }
    });
    expect(response.status()).toBe(201);
    expect((await response.json()).projectId).toBe(legacy);
    await page.goto(dashboard.base);
    await expect(groupFor(page, legacy).locator('[data-task="legacy"]')).toBeVisible();
    await expect(groupFor(page, empty.projectId)).toBeVisible();
    await page.locator('.conversation-item[data-task="legacy"]').click();
    await page.locator("#composer-input").fill("旧会话的未发送草稿");
    await expectTaskProject(page, dashboard, "legacy", {
      projectId: legacy,
      projectDirectory: legacy,
      workspaceRoot: legacy,
      storageRoot: legacy
    });
    expect(
      (
        await page.request.post(`${dashboard.base}/api/workspace/choose`, {
          data: { taskId: "legacy", workspaceRoot: empty.projectDirectory }
        })
      ).status()
    ).toBe(410);
    await page.reload();
    await expect(page.locator("#composer-input")).toHaveValue("旧会话的未发送草稿");
    await expect(page.locator(".project-group.is-selected .project-row")).toHaveAttribute("title", legacy);
    await page.request.patch(`${dashboard.base}/api/tasks/legacy`, { data: { archived: true } });
    await page.reload();
    await expect(groupFor(page, legacy)).toHaveCount(0);
    await expect(groupFor(page, empty.projectId)).toBeVisible();
  } finally {
    await dashboard.stop();
  }
});
