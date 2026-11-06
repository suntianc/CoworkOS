import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("collaboration menu separates historical, other and new conversations within the instance workspace", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.route("**/app.js", (route) =>
      route.fulfill({ contentType: "application/javascript", body: "// picker fixture" })
    );
    await page.goto(dashboard.base);
    await page.evaluate(async () => {
      const { chooseConversation } = await import("/assets/workbench/conversation-picker.js");
      const anchor = document.createElement("button");
      anchor.textContent = "协作选项";
      anchor.style.cssText = "position:fixed;top:20px;right:20px;z-index:10";
      document.body.append(anchor);
      const tasks = [
        { taskId: "a-old", goal: "A 曾加载过", workspaceRoot: "/A" },
        { taskId: "b-old", goal: "B 正在加载", workspaceRoot: "/B" },
        { taskId: "a-other", goal: "A 其他会话", workspaceRoot: "/project-display", storageRoot: "/A" },
        { taskId: "b-other", goal: "B 其他会话", workspaceRoot: "/B" }
      ];
      anchor.onclick = async () => {
        window.pickerChoice = await chooseConversation({
          anchor,
          title: "演示文稿",
          instanceWorkspaceRoot: "/A",
          tasks,
          projects: [
            { projectName: "项目 A", workspaceRoot: "/A" },
            { projectName: "项目 B", workspaceRoot: "/B" }
          ],
          relatedConversations: [{ taskId: "a-old" }],
          loadedConversations: [{ taskId: "b-old" }]
        });
      };
    });
    await page.getByRole("button", { name: "协作选项" }).click();
    const menu = page.getByRole("menu", { name: "与 AI 协作" });
    await expect(menu.locator(".ui-menu-label")).toHaveText([
      "演示文稿",
      "已关联过的会话",
      "关联其他已有会话",
      "新建会话"
    ]);
    await expect(menu.locator(".collaboration-project")).toHaveText(["工作区：项目 A"]);
    await expect(menu.locator("[role=menuitem]")).toHaveText([
      "A 曾加载过",
      "A 其他会话",
      "＋ 在此工作区新建会话"
    ]);
    await page.locator('[data-collaboration-loaded-task="a-old"]').click();
    expect(await page.evaluate(() => window.pickerChoice)).toEqual({ taskId: "a-old" });
    await page.getByRole("button", { name: "协作选项" }).click();
    await page.locator('[data-collaboration-existing="a-other"]').click();
    expect(await page.evaluate(() => window.pickerChoice)).toEqual({ taskId: "a-other" });
    await page.getByRole("button", { name: "协作选项" }).click();
    await page.locator("[data-collaboration-new]").last().click();
    expect(await page.evaluate(() => window.pickerChoice)).toEqual({ create: true, workspaceRoot: "/A" });
  } finally {
    await dashboard.stop();
  }
});
