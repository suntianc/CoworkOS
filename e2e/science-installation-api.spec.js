import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("real installation failure preserves settings and drafts while ordinary navigation remains usable", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const settings = async () => (await page.request.get(`${dashboard.base}/api/science-settings`)).json();
  const environments = async () =>
    (await page.request.get(`${dashboard.base}/api/science-settings/environments`)).json();
  try {
    const configPath = join(dashboard.root, "config.json");
    const originalConfig = await readFile(configPath, "utf8");
    const before = await settings();
    expect(before.enabled).toBe(false);
    expect((await environments()).general.state).toBe("absent");
    await page.goto(dashboard.base);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "管理科学环境", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "科学计算", exact: true });
    await expect(dialog.getByRole("checkbox", { name: "启用科学工具" })).not.toBeChecked();
    const missing = join(dashboard.root, "not-installed-host-python");
    await dialog.getByLabel("基础 Python", { exact: true }).fill(missing);

    const accepted = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/science-settings/install") && response.request().method() === "POST"
    );
    const failedProgress = page.waitForResponse(
      async (response) =>
        response.url().endsWith("/api/science-settings/environments") &&
        response.request().method() === "GET" &&
        (await response.json()).general.state === "failed"
    );
    await dialog.getByRole("button", { name: "安装基础环境", exact: true }).click();
    const started = await accepted;
    expect(started.status()).toBe(202);
    expect(started.request().postDataJSON()).toEqual({ target: "general", pythonExecutable: missing });
    const observed = await failedProgress;
    expect(observed.status()).toBe(200);
    expect((await observed.json()).general).toMatchObject({
      target: "general",
      state: "failed",
      error: { code: "python_unavailable" }
    });
    const card = dialog.locator('[data-environment="general"]');
    await expect(card).toContainText("无法启动所选 Python");
    await expect(dialog.getByRole("button", { name: "重试安装基础环境", exact: true })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: "使用基础环境", exact: true })).toBeHidden();
    await expect(dialog.getByLabel("基础 Python", { exact: true })).toHaveValue(missing);
    expect(await settings()).toEqual(before);
    expect(await readFile(configPath, "utf8")).toBe(originalConfig);

    const failedState = await environments();
    for (const extra of [
      { packages: ["unreviewed-package"] },
      { extraIndexUrl: "https://unreviewed.invalid/simple" }
    ]) {
      const rejected = await page.request.post(`${dashboard.base}/api/science-settings/install`, {
        data: { target: "general", pythonExecutable: missing, ...extra }
      });
      expect(rejected.status()).toBe(400);
      expect((await rejected.json()).code).toBe("invalid_arguments");
      expect(await environments()).toEqual(failedState);
    }
    expect(await settings()).toEqual(before);
    await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("#apps-nav")).toBeHidden();
    await page.locator("#new-conversation").click();
    await expect(page.locator("#composer-input")).toBeEditable();
    await page.locator("#composer-input").fill("普通任务草稿仍可编辑");
    await expect(page.locator("#composer-input")).toHaveValue("普通任务草稿仍可编辑");
    expect(await settings()).toEqual(before);
    expect(await readFile(configPath, "utf8")).toBe(originalConfig);
  } finally {
    await dashboard.stop();
  }
});
