import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { openWebSearchSettings } from "./settings-helper.js";

async function openSearch(page) {
  return openWebSearchSettings(page);
}
test("Web search is anonymous by default, can be disabled, authenticated and cleared through settings", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    const dialog = await openSearch(page);
    await expect(dialog.locator("[data-search-state]")).toContainText("已启用 · Exa · 匿名限额");
    await expect(dialog).toContainText("Exa 可匿名使用");
    await dialog.locator('[name="provider"]').selectOption("off");
    await dialog.getByRole("button", { name: "保存设置" }).click();
    await expect(dialog).toBeHidden();
    expect((await (await page.request.get(`${dashboard.base}/api/web-search-settings`)).json()).enabled).toBe(
      false
    );
    await openSearch(page);
    await dialog.locator('[name="provider"]').selectOption("exa");
    await dialog.getByText("高级设置 · 可选认证", { exact: true }).click();
    await dialog.locator('[name="exaApiKey"]').fill("optional-synthetic-secret");
    await dialog.getByRole("button", { name: "保存设置" }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    await openSearch(page);
    await expect(dialog.locator("[data-search-state]")).toContainText("自有密钥");
    await dialog.getByText("高级设置 · 可选认证", { exact: true }).click();
    await expect(dialog.locator('[name="exaApiKey"]')).toHaveValue("");
    await dialog.locator('[name="clearExaApiKey"]').check();
    await dialog.getByRole("button", { name: "保存设置" }).click();
    await expect(dialog).toBeHidden();
    await openSearch(page);
    await expect(dialog.locator("[data-search-state]")).toContainText("匿名限额");
  } finally {
    await dashboard.stop();
  }
});
test("failed search save preserves the selected provider and secret draft when reopened", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await page.route("**/api/web-search-settings", async (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 400, json: { error: "请先停止运行中的任务，再修改联网搜索设置" } })
        : route.continue()
    );
    const dialog = await openSearch(page);
    await dialog.locator('[name="provider"]').selectOption("serper");
    await dialog.getByText("高级设置 · 可选认证", { exact: true }).click();
    await dialog.locator('[name="exaApiKey"]').fill("preserved-fixture-secret");
    await dialog.getByRole("button", { name: "保存设置" }).click();
    await expect(dialog.locator("[data-search-error]")).toContainText("停止运行");
    await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
    await openSearch(page);
    await expect(dialog.locator('[name="provider"]')).toHaveValue("serper");
    await expect(dialog.locator('[name="exaApiKey"]')).toHaveValue("preserved-fixture-secret");
  } finally {
    await dashboard.stop();
  }
});

test("Web conversation discovers anonymous search, reads the source and displays a cited answer", async ({
  page
}) => {
  const { exaMcpFixture, sourceConversationFixture } = await import("../test/exa-mcp-fixture.mjs");
  const { modelProtocolFixture } = await import("../test/model-protocol-fixture.mjs");
  const exa = await exaMcpFixture();
  const provider = await modelProtocolFixture("openai-completions", sourceConversationFixture());
  let dashboard;
  try {
    dashboard = await startDashboard({ modelEndpoint: provider.baseUrl, webSearchEndpoint: exa.endpoint });
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("搜索相关论文，读取来源并附链接");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("来源读取成功", { timeout: 30_000 });
    await expect(page.locator('#conversation a[href="https://example.org/paper"]').first()).toBeVisible();
    expect(exa.calls.map((call) => call.name)).toEqual(["web_search_exa", "web_fetch_exa"]);
  } finally {
    await dashboard?.stop();
    await provider.close();
    await exa.close();
  }
});
