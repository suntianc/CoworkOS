import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { testModelConnection } from "../dist/src/runtime/model-connection.js";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { protocolStream } from "./model-protocol-fixture.mjs";

for (const path of ["/api/paas/v4", "/api/coding/paas/v4"]) {
  for (const suffix of ["", "/"]) {
    test(`Zhipu ${path}${suffix}: connection probe and real Pi keep the API path`, async (t) => {
      // Keep the real SDK and HTTP exchange; redirect only the fixture hostname.
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
        const previous = process.env[key];
        delete process.env[key];
        t.after(() => {
          if (previous === undefined) delete process.env[key];
          else process.env[key] = previous;
        });
      }
      const requests = [];
      const server = createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req.setEncoding("utf8")) raw += chunk;
        const body = JSON.parse(raw);
        requests.push({ path: req.url, body });
        if (req.method !== "POST" || req.url !== `${path}/chat/completions` || !body.stream) {
          res.writeHead(404);
          return res.end('{"error":{"message":"wrong API path"}}');
        }
        const probe = body.tools?.some((tool) => tool.function.name === "atria_connection_check");
        const reply = probe
          ? {
              name: "atria_connection_check",
              arguments: { status: "connected", color: "none", code: "none" }
            }
          : requests.length === 2
            ? { name: "verify_endpoint", arguments: { value: "round-trip" } }
            : { text: "Endpoint verified" };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(protocolStream("openai-completions", reply));
      });
      t.after(async () => {
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const origin = `http://127.0.0.1:${server.address().port}`;
      const fetch = globalThis.fetch;
      t.mock.method(globalThis, "fetch", (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        assert.equal(url.origin, "https://open.bigmodel.cn");
        return fetch(new URL(url.pathname + url.search, origin), init);
      });
      const options = {
        api: "openai-completions",
        baseUrl: `https://open.bigmodel.cn${path}${suffix}`,
        apiKey: "local-test",
        model: "protocol-fixture",
        supportsReasoningEffort: false,
        supportsPromptCacheKey: false
      };
      assert.equal((await testModelConnection(options)).ok, true);
      let executed = 0;
      const result = await new PiSession({
        ...options,
        thinkingLevel: "off",
        maxErrorRetries: 0,
        maxTurns: 3,
        timeoutMs: 5000,
        tools: new Map([
          [
            "verify_endpoint",
            {
              parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
              execute: async ({ value }) => {
                assert.equal(value, "round-trip");
                executed++;
                return { receipt: "verified" };
              }
            }
          ]
        ])
      }).run("Verify the endpoint with a tool call.");
      assert.equal(result.termination, "completed");
      assert.equal(result.lastStopReason, "stop");
      assert.equal(executed, 1);
      assert.equal(requests.length, 3);
      assert.ok(JSON.stringify(requests[2].body.messages).includes("verified"));
    });
  }
}

test("other API endpoints retain their existing v1 routing", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    requests.push(String(input));
    return new Response(
      protocolStream("openai-completions", {
        name: "atria_connection_check",
        arguments: { status: "connected", color: "none", code: "none" }
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
  });
  for (const [baseUrl, expected] of [
    ["https://api.deepseek.com", "https://api.deepseek.com/v1"],
    ["https://api.deepseek.com/v1/", "https://api.deepseek.com/v1"],
    ["https://gateway.example/api/paas/v4", "https://gateway.example/api/paas/v4/v1"],
    ["https://open.bigmodel.cn/v1", "https://open.bigmodel.cn/v1"]
  ]) {
    assert.equal(
      (
        await testModelConnection({
          baseUrl,
          model: "protocol-fixture",
          apiKey: "local-test",
          supportsReasoningEffort: false
        })
      ).ok,
      true
    );
    assert.equal(requests.at(-1), `${expected}/chat/completions`);
  }
});
