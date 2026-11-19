import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compact, generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream, normalizeContext } from "@earendil-works/pi-ai";
import { guardCompactionSummaries } from "../dist/src/runtime/compaction-summary-guard.js";
import { createCoworkModel } from "../dist/src/runtime/model-profile.js";
import { createModelStreams } from "../dist/src/runtime/model-provider.js";
import { recordModelRequests } from "../dist/src/runtime/model-request-recording.js";
import { ModelRequestRecorder, parseModelRequestArchive } from "../dist/src/storage/model-request-recorder.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const model = createCoworkModel({
  baseUrl: "http://127.0.0.1/v1",
  api: "openai-completions",
  model: "protocol-fixture",
  supportsReasoningEffort: false
});
const history = [{ role: "user", content: "Implement counter.js, then verify the tests.", timestamp: 1 }];
const usage = {
  input: 120,
  output: 15,
  cacheRead: 8,
  cacheWrite: 0,
  totalTokens: 143,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};
const message = (content, stopReason = "stop", errorMessage) => ({
  role: "assistant",
  content,
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage,
  stopReason,
  ...(errorMessage ? { errorMessage } : {}),
  timestamp: 2
});
const valid = () =>
  message([{ type: "text", text: "Counter implemented; tests passed; documentation is next." }]);
const eventStream = (response) => {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: "start", partial: response });
  stream.push(
    ["error", "aborted"].includes(response.stopReason)
      ? { type: "error", reason: response.stopReason, error: response }
      : { type: "done", reason: response.stopReason, message: response }
  );
  stream.end();
  return stream;
};
const streamsReturning = (response, onCall) => {
  const call = (requestModel, context, options) => {
    onCall?.(requestModel, context, options);
    return eventStream(typeof response === "function" ? response() : response);
  };
  return { stream: call, streamSimple: call };
};
const nativeSummary = (streamFn, { requestModel = model, retry, signal } = {}) =>
  generateSummaryWithUsage(
    history,
    requestModel,
    1024,
    "isolated-summary-fixture",
    undefined,
    signal,
    undefined,
    undefined,
    "off",
    streamFn,
    undefined,
    retry
  );

// Obtain the real SDK request context rather than duplicating its private prompt.
async function summaryContext() {
  let captured;
  await nativeSummary(streamsReturning(valid(), (_model, context) => (captured = context)).streamSimple);
  return captured;
}

for (const method of ["stream", "streamSimple"]) {
  for (const [kind, content] of [
    ["empty", []],
    ["whitespace", [{ type: "text", text: " \n\t " }]],
    ["thinking-only", [{ type: "thinking", thinking: "I should summarize the work." }]]
  ]) {
    test(`${method}: native summarization rejects ${kind} text and retains response usage`, async () => {
      const response = Object.freeze(message(content));
      const guarded = guardCompactionSummaries(streamsReturning(response));
      const stream = guarded[method](model, await summaryContext(), {});
      const events = [];
      for await (const event of stream) events.push(event);
      const result = await stream.result();
      assert.equal(events.at(-1).type, "error");
      assert.equal(result.stopReason, "error");
      assert.match(result.errorMessage, /summarization.*(?:empty|non-whitespace|no .*text)/i);
      assert.deepEqual(result.content, response.content);
      assert.deepEqual(result.usage, usage, "validation must not zero billed provider usage");
      assert.equal(result.timestamp, response.timestamp);
      assert.equal(response.stopReason, "stop", "retain the original provider evidence");
      await assert.rejects(nativeSummary(guarded[method]), /summarization/i);
    });
  }

  test(`${method}: valid native summaries and ordinary empty or tool-only turns pass through`, async () => {
    const response = valid();
    const result = await nativeSummary(guardCompactionSummaries(streamsReturning(response))[method]);
    assert.equal(result.text, response.content[0].text);
    assert.deepEqual(result.usage, usage);
    for (const [context, ordinary] of [
      [normalizeContext({ systemPrompt: "Answer the user's request.", messages: history }), message([])],
      [
        normalizeContext({
          systemPrompt: "Run the requested task.",
          tools: [{ name: "verify", description: "Verify.", parameters: { type: "object", properties: {} } }],
          messages: history
        }),
        message([{ type: "toolCall", id: "verify-call", name: "verify", arguments: {} }], "toolUse")
      ]
    ]) {
      const stream = guardCompactionSummaries(streamsReturning(ordinary))[method](model, context, {});
      assert.deepEqual(await stream.result(), ordinary);
    }
  });

  test(`${method}: existing provider errors, cancellation and length stops stay unchanged`, async () => {
    const context = await summaryContext();
    for (const response of [
      message([], "error", "Fixture upstream unavailable 503"),
      message([], "aborted"),
      message([], "length")
    ]) {
      const controller = new AbortController();
      if (response.stopReason === "aborted") controller.abort();
      const guarded = guardCompactionSummaries(
        streamsReturning(response, (_model, _context, options) => {
          assert.equal(options.signal, controller.signal);
        })
      );
      const stream = guarded[method](model, context, { signal: controller.signal });
      assert.deepEqual(await stream.result(), response);
    }
  });

  test(`${method}: a summary-like prompt does not classify tool-bearing or multi-turn chat as compaction`, async () => {
    const native = await summaryContext();
    const withTools = {
      messages: native.messages.map((entry) =>
        entry.role === "system"
          ? {
              ...entry,
              toolsAdded: [
                { name: "verify", description: "Verify.", parameters: { type: "object", properties: {} } }
              ]
            }
          : entry
      )
    };
    const multiTurn = { messages: [...native.messages, ...history] };
    for (const context of [withTools, multiTurn]) {
      const response = message([]);
      const stream = guardCompactionSummaries(streamsReturning(response))[method](model, context, {});
      assert.deepEqual(await stream.result(), response);
    }
  });
}

test("a split-turn checkpoint cannot hide an empty prefix behind previous state and file lists", async () => {
  const guarded = guardCompactionSummaries(streamsReturning(message([])));
  await assert.rejects(
    compact(
      {
        firstKeptEntryId: "kept-message",
        messagesToSummarize: [],
        turnPrefixMessages: history,
        isSplitTurn: true,
        tokensBefore: 50000,
        previousSummary: "<atria_main_compaction_state>Persisted task state</atria_main_compaction_state>",
        fileOps: { read: new Set(["counter.spec.js"]), written: new Set(["counter.js"]), edited: new Set() },
        settings: { enabled: true, reserveTokens: 1024, keepRecentTokens: 32 }
      },
      model,
      "isolated-summary-fixture",
      undefined,
      undefined,
      undefined,
      "off",
      guarded.streamSimple
    ),
    /summarization/i
  );
});

test("native transient retries still recover while empty summaries fail without repeated requests", async () => {
  let calls = 0;
  const retry = { enabled: true, maxRetries: 2, baseDelayMs: 1 };
  const recovered = guardCompactionSummaries(
    streamsReturning(() =>
      ++calls === 1 ? message([], "error", "Fixture upstream unavailable 503") : valid()
    )
  );
  assert.equal((await nativeSummary(recovered.streamSimple, { retry })).text, valid().content[0].text);
  assert.equal(calls, 2);
  calls = 0;
  const empty = guardCompactionSummaries(streamsReturning(message([]), () => calls++));
  await assert.rejects(nativeSummary(empty.streamSimple, { retry }), /summarization/i);
  assert.equal(calls, 1, "deterministic validation failure should not burn retry tokens");
});

for (const api of ["openai-completions", "openai-responses"]) {
  test(`${api}: rejected native summary retains the raw provider response and token record`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-summary-guard-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const provider = await modelProtocolFixture(api, () => ({ text: "" }));
    t.after(() => provider.close());
    const requestModel = createCoworkModel({
      baseUrl: provider.baseUrl,
      api,
      model: "protocol-fixture",
      supportsReasoningEffort: false
    });
    const path = join(root, "requests.jsonl");
    const recorded = recordModelRequests(
      createModelStreams(api),
      new ModelRequestRecorder(path, { taskId: "task", runId: "run", agentId: "main" })
    );
    let response;
    const guarded = guardCompactionSummaries(recorded);
    await assert.rejects(
      nativeSummary(
        (...args) => {
          const stream = guarded.streamSimple(...args);
          stream.result().then((result) => (response = result));
          return stream;
        },
        { requestModel }
      ),
      /summarization/i
    );
    const rows = parseModelRequestArchive(await readFile(path, "utf8"));
    assert.equal(provider.requests.length, 1);
    assert.equal(rows.filter((row) => row.type === "model_request").length, 1);
    const raw = rows.find((row) => row.type === "model_response").payload.message;
    assert.equal(raw.stopReason, "stop", "archive records the actual provider outcome");
    assert.equal(raw.errorMessage, undefined);
    assert.equal(response.stopReason, "error");
    assert.deepEqual(response.usage, raw.usage);
    assert.deepEqual(response.content, raw.content);
    if (api === "openai-responses") assert.equal(raw.usage.totalTokens, 20);
  });
}
