import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { protocolStream } from "../test/model-protocol-fixture.mjs";
import {
  addProviderThroughUi,
  checkProvider,
  leaveSettings,
  openModelSettings,
  saveProviderEdits
} from "./model-provider-ui.js";

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
      for await (const chunk of req.setEncoding("utf8")) raw += chunk;
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
      await addProviderThroughUi(page, {
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
        api,
        model: "protocol-fixture",
        apiKey: "local-test-key"
      });
      const advanced = page.locator(".provider-advanced > summary");
      const cacheKey = page.locator('[data-field-switch="supportsPromptCacheKey"]');
      await advanced.click();
      await expect(cacheKey).toHaveAttribute("aria-checked", "false");
      await cacheKey.click();
      await saveProviderEdits(page);
      await expect(page.locator("[data-provider-save]")).toBeHidden();
      await expect(await checkProvider(page)).toContainText("连接通过");
      expect(requests[0].prompt_cache_key).toBe("atria-connection-check");
      await page.reload();
      const status = await (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
      expect(status.providers[0].supportsPromptCacheKey).toBe(true);
      await openModelSettings(page);
      await advanced.click();
      await expect(cacheKey).toHaveAttribute("aria-checked", "true");
      await leaveSettings(page);
      await page.locator("#composer-input").fill("验证缓存第一轮");
      await page.locator("#composer-input").press("Enter");
      await expect(
        page.locator("#conversation").getByText("第1轮缓存验证完成", { exact: true })
      ).toBeVisible();
      // The next turn is only a new request once the previous run has settled.
      await expect(page.locator("#stop-button")).toBeHidden();
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
