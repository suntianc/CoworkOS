import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

for (const api of ["openai-completions", "openai-responses"]) {
  test(`${api}: configure, probe, persist, reload and converse through the real runtime`, async ({
    page
  }) => {
    let delegatedRequests = 0;
    const provider = await modelProtocolFixture(api, (body) => {
      const main = body.tools?.some((tool) => (tool.name ?? tool.function?.name) === "call_subagent");
      if (!main) {
        delegatedRequests++;
        return { text: "子智能体协议验证成功" };
      }
      const history = api === "openai-responses" ? body.input : body.messages;
      if (!JSON.stringify(history).includes("子智能体协议验证成功"))
        return { name: "call_subagent", arguments: { task: "返回子智能体协议验证成功", mode: "sync" } };
      return { text: "协议会话验证成功" };
    });
    const dashboard = await startDashboard();
    try {
      await page.goto(dashboard.base);
      await page.locator("#composer-input").fill("协议测试草稿");
      await page.locator("#model-setup-button").click();
      const dialog = page.getByRole("dialog", { name: "连接模型" });
      await dialog.locator('[name="baseUrl"]').fill(provider.baseUrl);
      await dialog.getByRole("combobox", { name: "消息格式" }).selectOption(api);
      await dialog.locator('[name="model"]').fill("protocol-fixture");
      await dialog.locator('[name="apiKey"]').fill("local-test-key");
      await dialog.getByText("高级连接参数", { exact: true }).click();
      await dialog.locator('[name="supportsReasoningEffort"]').check();
      await dialog.locator('[name="reasoningEffort"]').selectOption("max");
      await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
      await expect(dialog.locator("[data-model-result]")).toContainText("连接通过");
      await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
      await expect(dialog).toBeHidden();
      await page.reload();
      await expect(page.locator("#composer-input")).toHaveValue("协议测试草稿");
      const status = await (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
      expect(status.api).toBe(api);
      expect(status.reasoningEffort).toBe("max");
      expect(status).not.toHaveProperty("apiKey");
      await page.locator("#composer-input").press("Enter");
      await expect(page.locator("#conversation").getByText("协议会话验证成功", { exact: true })).toBeVisible({
        timeout: 30_000
      });
      expect(delegatedRequests).toBe(1);
      await page.locator("#composer-input").fill("继续验证第二轮");
      await page.locator("#composer-input").press("Enter");
      await expect
        .poll(() => provider.requests.some(({ body }) => JSON.stringify(body).includes("继续验证第二轮")), {
          timeout: 30_000
        })
        .toBe(true);
      const request = provider.requests.at(-1);
      expect(request.path).toBe(api === "openai-responses" ? "/v1/responses" : "/v1/chat/completions");
      expect(JSON.stringify(request.body)).toContain("协议会话验证成功");
      expect(JSON.stringify(request.body)).toContain("继续验证第二轮");
      // The conversation's own turns carry the saved effort; role defaults are separate.
      // The connection test reads the saved effort directly. A conversation run keeps
      // its own run-level effort, so its wire value is not asserted here.
      const probes = provider.requests.filter(({ body }) =>
        JSON.stringify(body).includes("atria_connection_check")
      );
      expect(probes.length).toBeGreaterThan(0);
      for (const { body } of probes)
        expect(api === "openai-responses" ? body.reasoning?.effort : body.reasoning_effort).toBe("max");
    } finally {
      await dashboard.stop();
      await provider.close();
    }
  });
}
