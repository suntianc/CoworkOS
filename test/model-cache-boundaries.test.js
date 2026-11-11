import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createCoworkModel } from "../dist/src/runtime/model-profile.js";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { readRunStatistics } from "../dist/src/runtime/run-statistics.js";
import { TraceRecorder } from "../dist/src/storage/trace-recorder.js";
import { renderRunOverview } from "../web/assets/run-overview.js";
import { protocolStream } from "./model-protocol-fixture.mjs";

const frame = (event, name) => `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(event)}\n\n`;
const rawUsage = (api, cached = 40) =>
  api === "openai-responses"
    ? {
        input_tokens: cached ? 100 : 0,
        output_tokens: cached ? 10 : 0,
        total_tokens: cached ? 110 : 0,
        input_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 },
        authorization: "provider-boundary-secret"
      }
    : {
        prompt_tokens: cached ? 100 : 0,
        completion_tokens: cached ? 10 : 0,
        prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 },
        authorization: "provider-boundary-secret"
      };

for (const api of ["openai-completions", "openai-responses"]) {
  test(`${api}: real HTTP usage coverage follows SDK framing and consumed counts`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-cache-boundaries-"));
    const basic = protocolStream(api, { text: "done" });
    const prefix =
      api === "openai-responses"
        ? basic.replace(/event: response.completed[\s\S]*/, "")
        : basic.replace("data: [DONE]\n\n", "");
    const report = (usage) =>
      api === "openai-responses"
        ? {
            type: "response.completed",
            response: { id: "resp_protocol", status: "completed", output: [], usage }
          }
        : { choices: [], usage };
    const usageFrame = (usage) =>
      frame(report(usage), api === "openai-responses" ? "response.completed" : undefined);
    const hit = prefix + usageFrame(rawUsage(api)) + "data: [DONE]\n\n";
    const unknown = { tokens: false, cache: false, total: null, read: 0 };
    const known = { tokens: true, cache: true, total: 110, read: 40 };
    const baseline =
      api === "openai-responses" ? { tokens: true, cache: false, total: 20, read: 0 } : unknown;
    const cases = [
      { name: "mixed-case-media-type", sse: hit, contentType: "Text/Event-Stream; charset=utf-8", ...known },
      {
        name: "uppercase-media-type-zero",
        sse: prefix + usageFrame(rawUsage(api, 0)),
        contentType: "TEXT/EVENT-STREAM; Charset=UTF-8",
        tokens: true,
        cache: true,
        total: 0,
        read: 0
      },
      { name: "after-done", sse: basic + usageFrame(rawUsage(api)), ...baseline },
      { name: "after-done-zero", sse: basic + usageFrame(rawUsage(api, 0)), ...baseline },
      { name: "eof-no-delimiter", sse: prefix + usageFrame(rawUsage(api)).trimEnd(), ...unknown },
      {
        name: "eof-single-newline-zero",
        sse: prefix + usageFrame(rawUsage(api, 0)).trimEnd() + "\n",
        ...unknown
      },
      {
        name: "thread-event-ignored",
        sse: prefix + frame(report(rawUsage(api)), "thread.synthetic") + "data: [DONE]\n\n",
        ...unknown
      },
      {
        name: "empty-event-resets-thread-wrapper",
        sse:
          prefix +
          `event: thread.synthetic\nevent\ndata: ${JSON.stringify(report(rawUsage(api)))}\n\ndata: [DONE]\n\n`,
        ...known
      },
      {
        name: "error-stops-lookahead",
        sse:
          prefix +
          frame({ error: { message: "synthetic failure", code: "server_error" } }) +
          usageFrame(rawUsage(api, 0)),
        ...unknown
      },
      {
        name: "malformed-stops-lookahead",
        sse: prefix + "data: null {\n\n" + usageFrame(rawUsage(api, 0)),
        ...unknown
      },
      {
        name: "empty-data-stops-lookahead",
        sse: prefix + "data\n\n" + usageFrame(rawUsage(api, 0)),
        ...unknown
      },
      { name: "known-before-done-tail", sse: hit + usageFrame(rawUsage(api, 0)), ...known },
      {
        name: "known-before-done-oversized-tail",
        sse: hit + usageFrame({ ...rawUsage(api, 0), ignored: "x".repeat(1024 * 1024 + 32) }),
        ...known
      }
    ];
    if (api === "openai-responses") {
      const failed = (usage) =>
        frame(
          {
            type: "response.failed",
            response: {
              id: "resp_protocol",
              status: "failed",
              output: [],
              error: { message: "synthetic failed response", code: "server_error" },
              usage
            }
          },
          "response.failed"
        );
      const nonterminal = (usage) =>
        frame(
          { type: "response.in_progress", response: { status: "in_progress", usage } },
          "response.in_progress"
        );
      const filtered = (usage) =>
        frame(
          {
            type: "response.incomplete",
            response: {
              id: "resp_protocol",
              status: "incomplete",
              incomplete_details: { reason: "content_filter" },
              output: [],
              usage
            }
          },
          "response.incomplete"
        );
      cases.push(
        {
          name: "content-filter-explicit-zero",
          sse: prefix + filtered(rawUsage(api, 0)),
          tokens: true,
          cache: true,
          total: 0,
          read: 0
        },
        {
          name: "content-filter-cache-only-zero",
          sse: prefix + filtered({ input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }),
          tokens: false,
          cache: true,
          total: null,
          read: 0
        },
        { name: "content-filter-missing-usage", sse: prefix + filtered(undefined), ...unknown },
        {
          name: "parser-error-before-filtered-zero",
          sse:
            prefix +
            frame(
              { type: "response.output_item.added", output_index: 0, item: null },
              "response.output_item.added"
            ) +
            filtered(rawUsage(api, 0)),
          ...unknown
        },
        { name: "failed-usage", sse: prefix + failed(rawUsage(api)), ...unknown },
        {
          name: "failed-usage-zero",
          sse: prefix + failed(rawUsage(api, 0)) + usageFrame(rawUsage(api, 0)),
          ...unknown
        },
        { name: "nonterminal-only", sse: prefix + nonterminal(rawUsage(api)), ...unknown },
        { name: "nonterminal-after-completed", sse: basic + nonterminal(rawUsage(api)), ...baseline },
        {
          name: "known-before-nonterminal",
          sse: prefix + usageFrame(rawUsage(api)) + nonterminal(rawUsage(api, 0)),
          ...known
        },
        {
          name: "incomplete-consumed",
          sse: (prefix + usageFrame(rawUsage(api)))
            .replaceAll("response.completed", "response.incomplete")
            .replace(
              '"status":"completed"',
              '"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}'
            ),
          ...known
        },
        {
          name: "parser-error-before-zero-usage",
          sse:
            prefix +
            frame(
              { type: "response.output_item.added", output_index: 0, item: null },
              "response.output_item.added"
            ) +
            usageFrame(rawUsage(api, 0)),
          ...unknown
        }
      );
      // Responses streams have no implicit [DONE]; its SDK still honors one if a service sends it.
      for (const entry of cases.filter((entry) => entry.name.startsWith("after-done")))
        entry.sse =
          basic + "data: [DONE]\n\n" + usageFrame(rawUsage(api, entry.name.endsWith("zero") ? 0 : 40));
    }
    let current;
    const requests = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req.setEncoding("utf8")) raw += chunk;
      requests.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": current.contentType ?? "text/event-stream" });
      // One server write exposes diagnostic lookahead ahead of SDK parser failures.
      res.end(current.sse);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await rm(root, { recursive: true, force: true });
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const model = createCoworkModel({
      api,
      baseUrl,
      model: "protocol-fixture",
      supportsReasoningEffort: false
    });
    const provider = api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi();
    const context = normalizeContext({ messages: [{ role: "user", content: "test framing", timestamp: 1 }] });
    for (const entry of cases)
      await t.test(entry.name, async () => {
        current = entry;
        // Compare actual native SDK counters before checking product metadata and durable consumers.
        const native = await provider
          .streamSimple(model, context, { apiKey: "local-test-key", maxRetries: 0 })
          .result();
        const run = join(root, entry.name, "runs", "run");
        await mkdir(run, { recursive: true });
        const recorder = new TraceRecorder(join(root, entry.name, "trace.jsonl"));
        let message;
        await new PiSession({
          api,
          baseUrl,
          model: "protocol-fixture",
          apiKey: "local-test-key",
          supportsReasoningEffort: false,
          thinkingLevel: "off",
          supportsPromptCacheKey: true,
          sessionId: "boundary-stable-session",
          maxErrorRetries: 0,
          tools: new Map(),
          trace: { recorder, taskId: entry.name, runId: "run", agentId: "main" },
          onEvent: (event) => {
            if (event.type === "message_end" && event.message.role === "assistant") message = event.message;
          }
        }).run("test framing");
        assert.ok(message);
        assert.equal(message.stopReason, native.stopReason);
        for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"])
          assert.equal(message.usage[field], native.usage[field], `original SDK ${field} remains unchanged`);
        assert.equal(message.usage.tokenUsageReported, entry.tokens);
        assert.equal(message.usage.cacheReadReported, entry.cache);
        assert.equal(message.usage.cacheWriteReported, entry.cache);
        await writeFile(
          join(run, "runtime-output.log"),
          JSON.stringify({ type: "message_end", message }) + "\n"
        );
        const statistics = await readRunStatistics({
          workspaceRoot: root,
          task: { taskId: entry.name, activeRunId: "run" },
          active: false
        });
        assert.equal(statistics.usage.totalTokens, entry.total);
        assert.equal(statistics.usage.coverage, entry.tokens ? "complete" : "unavailable");
        assert.equal(statistics.usage.cacheReadCoverage, entry.cache ? "complete" : "unavailable");
        assert.equal(statistics.usage.cacheRead, entry.read);
        const html = renderRunOverview(statistics);
        assert.match(
          html,
          entry.total === null
            ? /title="累计 Token">—<\/strong>/
            : new RegExp(`title="${entry.total} Token">${entry.total}</strong>`)
        );
        assert.match(
          html,
          entry.cache
            ? new RegExp(`输入缓存命中</dt><dd>${entry.read}</dd>`)
            : /输入缓存命中<\/dt><dd>未报告<\/dd>/
        );
        const archive = await readFile(recorder.modelRequestPath, "utf8");
        assert.ok(!archive.includes("provider-boundary-secret"));
        const rows = archive.trim().split("\n").map(JSON.parse);
        const archivedRequest = rows.find((row) => row.type === "model_request").payload.request;
        assert.deepEqual(archivedRequest, requests.at(-1));
        assert.equal(archivedRequest.prompt_cache_key, "boundary-stable-session");
        assert.deepEqual(
          rows.find((row) => row.type === "model_response").payload.message.usage,
          message.usage
        );
      });
  });
}
