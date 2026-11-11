import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { TraceRecorder } from "../dist/src/storage/trace-recorder.js";
import { protocolStream } from "./model-protocol-fixture.mjs";

for (const api of ["openai-completions", "openai-responses"]) {
  test(`${api}: explicit cache capability sends a stable key and distinguishes missing, zero and hit usage`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-cache-"));
    const requests = [];
    const counts = [undefined, 0, 40];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req.setEncoding("utf8")) raw += chunk;
      requests.push(JSON.parse(raw));
      const index = requests.length - 1;
      const usage =
        api === "openai-completions"
          ? {
              prompt_tokens: 100,
              completion_tokens: 10,
              ...(counts[index] === undefined
                ? {}
                : { prompt_tokens_details: { cached_tokens: counts[index], cache_write_tokens: 0 } })
            }
          : {
              input_tokens: 100,
              output_tokens: 10,
              total_tokens: 110,
              ...(counts[index] === undefined
                ? {}
                : { input_tokens_details: { cached_tokens: counts[index], cache_write_tokens: 0 } })
            };
      usage.authorization = "provider-private-secret";
      const reply = index < 2 ? { name: "next", arguments: {} } : { text: "完成" };
      let stream = protocolStream(api, reply);
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
      // Exercise split UTF-8 and SSE frames without changing what Pi receives.
      const bytes = Buffer.from(stream);
      for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await rm(root, { recursive: true, force: true });
    });
    const events = [];
    const recorder = new TraceRecorder(join(root, "trace.jsonl"));
    const result = await new PiSession({
      api,
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: "local-test-key",
      model: "protocol-fixture",
      supportsReasoningEffort: false,
      thinkingLevel: "off",
      supportsPromptCacheKey: true,
      sessionId: "stable-cache-session",
      maxErrorRetries: 0,
      tools: new Map([
        ["next", { parameters: { type: "object", properties: {} }, execute: async () => ({ ok: true }) }]
      ]),
      onEvent: (event) => {
        if (event.type === "message_end" && event.message.role === "assistant")
          events.push(JSON.parse(JSON.stringify(event.message)));
      },
      trace: { recorder, taskId: "cache-task", runId: "cache-run", agentId: "main" }
    }).run("验证缓存统计");
    assert.equal(result.termination, "completed");
    assert.equal(requests.length, 3);
    assert.ok(requests.every((body) => body.prompt_cache_key === "stable-cache-session"));
    assert.deepEqual(
      events.map((message) => message.usage.tokenUsageReported),
      [true, true, true]
    );
    assert.deepEqual(
      events.map((message) => message.usage.cacheReadReported),
      [false, true, true]
    );
    assert.deepEqual(
      events.map((message) => message.usage.cacheRead),
      [0, 0, 40]
    );
    assert.deepEqual(
      events.map((message) => message.usage.cacheWriteReported),
      [false, true, true]
    );
    const archive = await readFile(recorder.modelRequestPath, "utf8");
    assert.ok(!archive.includes("provider-private-secret"));
    const rows = archive.trim().split("\n").map(JSON.parse);
    assert.deepEqual(
      rows.filter((row) => row.type === "model_request").map((row) => row.payload.request),
      requests
    );
    assert.deepEqual(
      rows
        .filter((row) => row.type === "model_response")
        .map((row) => row.payload.message.usage.cacheReadReported),
      [false, true, true]
    );
    assert.deepEqual(
      events[2].usage.rawCacheUsage,
      api === "openai-completions"
        ? { prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 } }
        : { input_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 } }
    );
  });
}

for (const api of ["openai-completions", "openai-responses"]) {
  test(`${api}: actual cache-only usage remains distinct from explicit zero total usage`, async (t) => {
    const { readRunStatistics } = await import("../dist/src/runtime/run-statistics.js");
    const { renderRunOverview } = await import("../web/assets/run-overview.js");
    const root = await mkdtemp(join(tmpdir(), "atria-cache-only-"));
    const input = api === "openai-completions" ? "prompt_tokens" : "input_tokens";
    const output = api === "openai-completions" ? "completion_tokens" : "output_tokens";
    const details = api === "openai-completions" ? "prompt_tokens_details" : "input_tokens_details";
    const cases = [
      { name: "missing", raw: {}, tokens: false, cache: false, total: null },
      {
        name: "cache-only-zero",
        raw: { [details]: { cached_tokens: 0 } },
        tokens: false,
        cache: true,
        total: null
      },
      {
        name: "cache-only-hit",
        raw: { [details]: { cached_tokens: 40 } },
        tokens: false,
        cache: true,
        total: null
      },
      { name: "explicit-zero", raw: { [input]: 0, [output]: 0 }, tokens: true, cache: false, total: 0 },
      { name: "input-only", raw: { [input]: 0 }, tokens: false, cache: false, total: null },
      { name: "output-only", raw: { [output]: 0 }, tokens: false, cache: false, total: null },
      {
        name: "zero-and-cache",
        raw: { [input]: 0, [output]: 0, [details]: { cached_tokens: 0 } },
        tokens: true,
        cache: true,
        total: 0
      }
    ];
    let index = 0;
    const server = createServer(async (req, res) => {
      for await (const _ of req) {
        /* consume the real SDK request */
      }
      const usage = cases[index++].raw;
      let stream = protocolStream(api, { text: "done" });
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
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await rm(root, { recursive: true, force: true });
    });
    for (const entry of cases) {
      let message;
      const result = await new PiSession({
        api,
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: "local-test-key",
        model: "protocol-fixture",
        supportsReasoningEffort: false,
        thinkingLevel: "off",
        tools: new Map(),
        onEvent: (event) => {
          if (event.type === "message_end" && event.message.role === "assistant") message = event.message;
        }
      }).run(entry.name);
      assert.equal(result.termination, "completed", entry.name);
      assert.equal(message.usage.tokenUsageReported, entry.tokens, entry.name);
      assert.equal(message.usage.cacheReadReported, entry.cache, entry.name);
      const run = join(root, entry.name, "runs", "run");
      await mkdir(run, { recursive: true });
      await writeFile(
        join(run, "runtime-output.log"),
        JSON.stringify({ type: "message_end", message }) + "\n"
      );
      const statistics = await readRunStatistics({
        workspaceRoot: root,
        task: { taskId: entry.name, activeRunId: "run" },
        active: false
      });
      assert.equal(statistics.usage.totalTokens, entry.total, entry.name);
      assert.equal(statistics.usage.coverage, entry.tokens ? "complete" : "unavailable", entry.name);
      assert.equal(statistics.usage.cacheReadCoverage, entry.cache ? "complete" : "unavailable", entry.name);
      const html = renderRunOverview(statistics);
      assert.match(
        html,
        entry.total === null ? /title="累计 Token">—<\/strong>/ : /title="0 Token">0<\/strong>/,
        entry.name
      );
      assert.match(
        html,
        entry.cache
          ? new RegExp(`输入缓存命中</dt><dd>${entry.raw[details].cached_tokens}</dd>`)
          : /输入缓存命中<\/dt><dd>未报告<\/dd>/,
        entry.name
      );
    }
  });

  test(`${api}: third-party default omits cache keys and opt-in probe checks the actual wire field`, async (t) => {
    const { modelProtocolFixture } = await import("./model-protocol-fixture.mjs");
    const { testModelConnection } = await import("../dist/src/runtime/model-connection.js");
    const provider = await modelProtocolFixture(api);
    t.after(() => provider.close());
    const input = {
      api,
      baseUrl: provider.baseUrl,
      apiKey: "local-test",
      model: "protocol-fixture",
      tools: new Map(),
      supportsReasoningEffort: false,
      thinkingLevel: "off",
      sessionId: "stable-default"
    };
    await new PiSession(input).run("默认兼容行为");
    assert.equal(provider.requests[0].body.prompt_cache_key, undefined);
    await testModelConnection({ ...input, supportsPromptCacheKey: true });
    assert.equal(provider.requests[1].body.prompt_cache_key, "atria-connection-check");
    await testModelConnection({ ...input, supportsPromptCacheKey: false });
    assert.equal(provider.requests[2].body.prompt_cache_key, undefined);
  });
}

test("cache settings validate booleans, preserve connection capabilities and environment precedence", async () => {
  const { configuredSupportsPromptCacheKey, runtimeSettingsEnv } =
    await import("../dist/src/runtime/runtime-settings.js");
  const { saveConnection, publicConnections } = await import("../dist/src/runtime/model-connections.js");
  const { connectionProfile, parseConnectionProfile } = await import("../dist/src/runtime/model-profile.js");
  assert.equal(configuredSupportsPromptCacheKey({}), false);
  assert.equal(configuredSupportsPromptCacheKey({ COWORK_SUPPORTS_PROMPT_CACHE_KEY: "1" }), true);
  assert.throws(
    () => configuredSupportsPromptCacheKey({ COWORK_SUPPORTS_PROMPT_CACHE_KEY: "yes" }),
    /supportsPromptCacheKey/
  );
  const saved = process.env.COWORK_SUPPORTS_PROMPT_CACHE_KEY;
  try {
    delete process.env.COWORK_SUPPORTS_PROMPT_CACHE_KEY;
    assert.equal(
      configuredSupportsPromptCacheKey(runtimeSettingsEnv({ supportsPromptCacheKey: true })),
      true
    );
    process.env.COWORK_SUPPORTS_PROMPT_CACHE_KEY = "0";
    assert.equal(connectionProfile({ supportsPromptCacheKey: true }).supportsPromptCacheKey, false);
  } finally {
    if (saved === undefined) delete process.env.COWORK_SUPPORTS_PROMPT_CACHE_KEY;
    else process.env.COWORK_SUPPORTS_PROMPT_CACHE_KEY = saved;
  }
  for (const value of ["true", 1, null])
    assert.throws(
      () => parseConnectionProfile({ supportsPromptCacheKey: value }, connectionProfile({})),
      /布尔/
    );
  const connection = {
    baseUrl: "https://gateway.example/v1",
    model: "fixture",
    apiKey: "local-test-key",
    supportsPromptCacheKey: true
  };
  const initial = saveConnection({}, connection);
  const profileId = initial.modelConnections.activeId;
  const edited = saveConnection(initial, { ...connection, supportsPromptCacheKey: undefined, profileId });
  assert.equal(publicConnections(edited).profiles[0].supportsPromptCacheKey, true);
  assert.equal(
    saveConnection(edited, { ...connection, supportsPromptCacheKey: false, profileId })
      .supportsPromptCacheKey,
    false
  );
});

test("cache parser accepts only numeric whitelist fields and follows provider field precedence", async () => {
  const { cacheUsageReport, promptCacheKey } = await import("../dist/src/runtime/model-cache.js");
  assert.deepEqual(
    cacheUsageReport(
      {
        prompt_cache_hit_tokens: 12,
        cached_tokens: 7,
        password: "secret",
        prompt_tokens_details: { cache_write_tokens: 0, key: "secret" }
      },
      "openai-completions"
    ),
    {
      tokenUsageReported: false,
      cacheReadReported: true,
      cacheWriteReported: true,
      rawCacheUsage: {
        prompt_tokens_details: { cache_write_tokens: 0 },
        prompt_cache_hit_tokens: 12,
        cached_tokens: 7
      }
    }
  );
  for (const value of ["0", -1, NaN, Infinity, {}, null]) {
    assert.equal(cacheUsageReport({ cached_tokens: value }, "openai-completions").cacheReadReported, false);
    assert.deepEqual(cacheUsageReport({ cached_tokens: value }, "openai-completions").rawCacheUsage, {});
  }
  assert.equal(
    cacheUsageReport(
      { prompt_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 12 },
      "openai-completions"
    ).cacheReadReported,
    true
  );
  assert.equal(promptCacheKey("a".repeat(65)).length, 64);
  assert.equal(promptCacheKey("a".repeat(65)), promptCacheKey("a".repeat(65)));
  assert.notEqual(promptCacheKey("a".repeat(65)), promptCacheKey("a".repeat(64) + "b"));
});

test("cache policy composes payload hooks, HTTP retries and wire recording, and none suppresses keys", async (t) => {
  const { withModelCache } = await import("../dist/src/runtime/model-cache.js");
  const { createCoworkModel } = await import("../dist/src/runtime/model-profile.js");
  const { recordModelRequests } = await import("../dist/src/runtime/model-request-recording.js");
  const { ModelRequestRecorder } = await import("../dist/src/storage/model-request-recorder.js");
  const { normalizeContext } = await import("@earendil-works/pi-ai/utils/transcript");
  const { openAICompletionsApi } = await import("@earendil-works/pi-ai/api/openai-completions.lazy");
  const root = await mkdtemp(join(tmpdir(), "atria-cache-hooks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recorder = new ModelRequestRecorder(join(root, "requests.jsonl"), {
    taskId: "cache",
    runId: "retry",
    agentId: "main"
  });
  const model = createCoworkModel({
    baseUrl: "https://api.openai.com.third-party.example/v1",
    supportsReasoningEffort: false
  });
  const requests = [];
  const hooks = [];
  const streams = recordModelRequests(
    withModelCache(openAICompletionsApi(), { supportsPromptCacheKey: true }),
    recorder
  );
  const context = normalizeContext({
    messages: [{ role: "user", content: "Check the retry.", timestamp: 1 }]
  });
  const result = await streams
    .streamSimple(model, context, {
      apiKey: "local-test-key",
      sessionId: "cache-session",
      maxRetries: 1,
      onPayload: (body) => ({ ...body, temperature: 0.3, prompt_cache_key: "replaced-key" }),
      onResponse: (response) => {
        hooks.push(response.status);
      },
      fetch: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        if (requests.length === 1)
          return new Response('{"error":{"message":"temporarily unavailable"}}', {
            status: 503,
            headers: { "retry-after-ms": "1" }
          });
        return new Response(
          protocolStream("openai-completions", { text: "done" }).replace(
            "data: [DONE]",
            'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":1,"prompt_cache_hit_tokens":0}}\n\ndata: [DONE]'
          ),
          { headers: { "content-type": "text/event-stream" } }
        );
      }
    })
    .result();
  assert.equal(result.stopReason, "stop");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].prompt_cache_key, "cache-session");
  assert.equal(requests[0].temperature, 0.3);
  assert.deepEqual(hooks, [200]);
  assert.equal(result.usage.cacheReadReported, true);
  const records = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    records.filter((row) => row.type === "model_request").map((row) => row.payload.request),
    requests
  );
  assert.deepEqual(
    records.filter((row) => row.type === "model_response_http").map((row) => row.payload.status),
    [503, 200]
  );
  for (const policy of [
    { supportsPromptCacheKey: true, cacheRetention: "none" },
    { supportsPromptCacheKey: false }
  ]) {
    const stream = withModelCache(openAICompletionsApi(), policy).streamSimple(model, context, {
      apiKey: "local-test-key",
      sessionId: "cache-session",
      cacheRetention: policy.cacheRetention,
      onPayload: (body) => ({ ...body, prompt_cache_key: "replacement" }),
      fetch: async (_url, init) => {
        assert.equal(JSON.parse(init.body).prompt_cache_key, undefined);
        return new Response(protocolStream("openai-completions", { text: "done" }), {
          headers: { "content-type": "text/event-stream" }
        });
      }
    });
    assert.equal((await stream.result()).stopReason, "stop");
  }
});

for (const native of [false, true]) {
  test(`${native ? "encrypted desktop" : "private Web"} cache capability persists independently per connection`, async (t) => {
    const { createRequire } = await import("node:module");
    const { createModelSettings: webSettings } = await import("../dist/src/dashboard/model-settings.js");
    const require = createRequire(import.meta.url);
    const { createModelSettings: desktopSettings } = require("../desktop/model-settings.cjs");
    const { desktopPaths } = require("../desktop/paths.cjs");
    const root = await mkdtemp(join(tmpdir(), "atria-cache-settings-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const keys = Object.keys(process.env).filter((key) => /^COWORK_(CONFIG|API|MODEL|SUPPORTS)/.test(key));
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    process.env.COWORK_CONFIG = join(root, "config.json");
    t.after(() => {
      for (const key of Object.keys(process.env))
        if (/^COWORK_(CONFIG|API|MODEL|SUPPORTS)/.test(key)) delete process.env[key];
      Object.assign(process.env, previous);
    });
    const secure = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`encrypted:${value}`),
      decryptString: (value) => String(value).slice(10)
    };
    const paths = desktopPaths("/fixture/install", root, {});
    const config = {};
    const settings = native ? desktopSettings(paths, secure) : webSettings(root, config, () => false);
    const first = await settings.save({
      baseUrl: "https://first.example/v1",
      model: "fixture",
      apiKey: "private-cache-secret",
      supportsPromptCacheKey: true
    });
    const second = await settings.save({
      profileId: "",
      baseUrl: "https://second.example/v1",
      model: "fixture",
      apiKey: "second-cache-secret",
      supportsPromptCacheKey: false,
      activate: false
    });
    assert.equal(second.activeProfileId, first.activeProfileId);
    assert.deepEqual(
      second.profiles.map((profile) => profile.supportsPromptCacheKey),
      [true, false]
    );
    assert.ok(!JSON.stringify(second).includes("cache-secret"));
    const { readCoworkConfig } = await import("../dist/src/runtime/config.js");
    const restored = native
      ? await desktopSettings(paths, secure).read()
      : readCoworkConfig(root, { COWORK_CONFIG: join(root, "config.json") });
    const reloaded = native ? desktopSettings(paths, secure) : webSettings(root, restored, () => false);
    const status = native ? await reloaded.status() : reloaded.status();
    assert.deepEqual(
      status.profiles.map((profile) => profile.supportsPromptCacheKey),
      [true, false]
    );
    await assert.rejects(
      reloaded.save({
        profileId: first.activeProfileId,
        baseUrl: "https://first.example/v1",
        model: "fixture",
        supportsPromptCacheKey: "true"
      }),
      /布尔/
    );
  });
}

test(
  "SSE observation handles CRLF and CR boundaries, oversized events, and body cancellation",
  { timeout: 10000 },
  async (t) => {
    const { withModelCache } = await import("../dist/src/runtime/model-cache.js");
    const { createCoworkModel } = await import("../dist/src/runtime/model-profile.js");
    const { normalizeContext } = await import("@earendil-works/pi-ai/utils/transcript");
    const { openAICompletionsApi } = await import("@earendil-works/pi-ai/api/openai-completions.lazy");
    const model = createCoworkModel({
      baseUrl: "https://fixture.example/v1",
      supportsReasoningEffort: false
    });
    const context = normalizeContext({ messages: [{ role: "user", content: "test", timestamp: 1 }] });
    const streams = withModelCache(openAICompletionsApi(), { supportsPromptCacheKey: false });
    for (const newline of ["\r\n", "\r"]) {
      const sse = protocolStream("openai-completions", { text: "结束" })
        .replace(
          "data: [DONE]",
          'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":0}}}\n\ndata: [DONE]'
        )
        .replaceAll("\n", newline);
      const stream = streams.streamSimple(model, context, {
        apiKey: "local-test",
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (const byte of Buffer.from(sse)) controller.enqueue(Uint8Array.of(byte));
                controller.close();
              }
            }),
            { headers: { "content-type": "text/event-stream" } }
          )
      });
      const result = await stream.result();
      assert.equal(result.stopReason, "stop");
      assert.equal(result.usage.cacheReadReported, true);
    }
    const controller = new AbortController();
    let closed = false;
    const server = createServer((_req, res) => {
      res.on("close", () => {
        closed = true;
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'data: {"id":"pending","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"}}]}\n\n'
      );
      setTimeout(() => controller.abort(), 20);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    });
    const interrupted = await streams
      .streamSimple({ ...model, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, context, {
        apiKey: "local-test",
        signal: controller.signal,
        maxRetries: 0
      })
      .result();
    assert.equal(interrupted.stopReason, "aborted");
    for (let attempt = 0; attempt < 50 && !closed; attempt++)
      await new Promise((done) => setTimeout(done, 10));
    assert.equal(closed, true, "aborting Pi closes the original HTTP response through the observer");
    const huge = "x".repeat(1024 * 1024 + 32);
    const oversized = protocolStream("openai-completions", { text: "done" }).replace(
      "data: [DONE]",
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 }, unknown: huge } })}\n\ndata: [DONE]`
    );
    const result = await streams
      .streamSimple(model, context, {
        apiKey: "local-test",
        fetch: async () => new Response(oversized, { headers: { "content-type": "text/event-stream" } })
      })
      .result();
    assert.equal(result.stopReason, "stop");
    assert.equal(result.usage.input, 100, "the provider still parses the original oversized event");
    assert.equal(result.usage.cacheReadReported, false);
    assert.deepEqual(result.usage.rawCacheUsage, {});
  }
);

test("overview respects explicit unknown cache coverage instead of applying legacy positive-counter fallback", async () => {
  const { renderRunOverview } = await import("../web/assets/run-overview.js");
  const usage = {
    input: 100,
    output: 10,
    cacheRead: 40,
    cacheWrite: 5,
    totalTokens: 155,
    responses: 1,
    cacheReadCoverage: "unavailable",
    cacheWriteCoverage: "unavailable"
  };
  const statistics = { usage, agents: [], elapsedMs: null };
  assert.match(renderRunOverview(statistics), /输入缓存命中<\/dt><dd>未报告<\/dd>/);
  assert.match(renderRunOverview(statistics), /缓存写入<\/dt><dd>未报告<\/dd>/);
  delete usage.cacheReadCoverage;
  delete usage.cacheWriteCoverage;
  assert.match(renderRunOverview(statistics), /输入缓存命中<\/dt><dd>40 <small>已报告 · 部分未知/);
});
