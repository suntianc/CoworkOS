import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { protocolStream } from "../test/model-protocol-fixture.mjs";
import { openModelConnectionEditor } from "./settings-helper.js";

for (const api of ["openai-completions", "openai-responses"]) {
  test(`${api}: the cache opt-in persists and every turn sends the same cache key`, async ({ page }) => {
    const requests = [];
    let turns = 0;
    const provider = createServer(async (req, res) => {
      if (req.method === "GET") {
        res.setHeader("content-type", "application/json");
        return res.end('{"data":[{"id":"protocol-fixture"}]}');
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      const probe = body.tools?.some(
        (tool) => (tool.name ?? tool.function?.name) === "atria_connection_check"
      );
      const usage =
        api === "openai-completions"
          ? { prompt_tokens: 100, completion_tokens: 10 }
          : { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
      if (!probe && ++turns > 1)
        usage[api === "openai-completions" ? "prompt_tokens_details" : "input_tokens_details"] = {
          cached_tokens: 0,
          cache_write_tokens: 0
        };
      let stream = protocolStream(
        api,
        probe
          ? {
              name: "atria_connection_check",
              arguments: { status: "connected", color: "none", code: "none" }
            }
          : { text: `第${turns}轮缓存验证完成` }
      );
      if (api === "openai-completions")
        stream = stream.replace(
          "data: [DONE]",
          `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]`
        );
      else
        stream = stream.replace(
          '"usage":{"input_tokens":10,"output_tokens":10,"total_tokens":20}',
          `"usage":${JSON.stringify(usage)}`
        );
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(stream);
    });
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const dashboard = await startDashboard();
    try {
      await page.goto(dashboard.base);
      await page.locator("#model-setup-button").click();
      const dialog = page.getByRole("dialog", { name: "连接模型" });
      await dialog.locator('[name="baseUrl"]').fill(`http://127.0.0.1:${provider.address().port}/v1`);
      await dialog.locator('[name="model"]').fill("protocol-fixture");
      await dialog.locator('[name="apiKey"]').fill("local-test-key");
      await dialog.locator('[name="api"]').selectOption(api);
      await dialog.getByText("高级连接参数", { exact: true }).click();
      await expect(dialog.locator('[name="supportsPromptCacheKey"]')).not.toBeChecked();
      await dialog.locator('[name="supportsPromptCacheKey"]').check();
      await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
      await expect(dialog.locator("[data-model-result]")).toContainText("连接通过");
      expect(requests[0].prompt_cache_key).toBe("atria-connection-check");
      await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
      await expect(dialog).toBeHidden();
      await page.reload();
      const status = await (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
      expect(status.supportsPromptCacheKey).toBe(true);
      expect(status.profiles[0].supportsPromptCacheKey).toBe(true);
      await openModelConnectionEditor(page);
      await dialog.getByText("高级连接参数", { exact: true }).click();
      await expect(dialog.locator('[name="supportsPromptCacheKey"]')).toBeChecked();
      await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
      await page.locator("#settings-back").click();
      await page.locator("#composer-input").fill("验证缓存第一轮");
      await page.locator("#composer-input").press("Enter");
      await expect(
        page.locator("#conversation").getByText("第1轮缓存验证完成", { exact: true })
      ).toBeVisible();
      // The requirement panel reports totals only, so the cache key stability is read
      // from what the provider received across two turns of the same conversation.
      await page.locator("#composer-input").fill("验证缓存第二轮");
      await page.locator("#composer-input").press("Enter");
      await expect(
        page.locator("#conversation").getByText("第2轮缓存验证完成", { exact: true })
      ).toBeVisible();
      expect(requests.at(-1).prompt_cache_key).toBe(requests[1].prompt_cache_key);
    } finally {
      await dashboard.stop();
      provider.closeAllConnections();
      await new Promise((done) => provider.close(done));
    }
  });
}
