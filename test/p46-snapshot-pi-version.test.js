import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, createProvider, normalizeContext } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { MainRequestStore, mainRequestPath } from "../dist/src/storage/main-request-store.js";
import { MainRequestRetry } from "../dist/src/runtime/main-request-retry.js";
import { ModelRequestRecorder } from "../dist/src/storage/model-request-recorder.js";
import { recordModelRequests } from "../dist/src/runtime/model-request-recording.js";
import { createCoworkModel } from "../dist/src/runtime/model-profile.js";
import { protocolStream } from "./model-protocol-fixture.mjs";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import { startDashboard } from "./dashboard-fixture.mjs";
import { installedPiVersion } from "./pi-version-fixture.mjs";

/**
 * P4.6 #07: a Main request snapshot records the Pi version that wrote it.
 *
 * An archived wire body is only exact for the Pi release that serialized it, so
 * a retry replays byte for byte only when the versions match. Anything else
 * rebuilds the context from the live session and states the reason in the retry
 * record instead of pretending the archive is still current.
 */

const archivedTool = { name: "fixture_tool", description: "Fixture tool", parameters: { type: "object" } };
const archivedBody = JSON.stringify({
  model: "fixture",
  messages: [
    { role: "system", content: "ARCHIVED_SYSTEM" },
    { role: "user", content: "ARCHIVED_INPUT" }
  ],
  temperature: 0.4,
  stream: true
});

async function fixture(t, piVersion) {
  const root = await mkdtemp(join(tmpdir(), "cowork-p46-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MainRequestStore(mainRequestPath(root, "task"), "task");
  const model = createCoworkModel({
    baseUrl: "http://fixture.test",
    model: "fixture",
    supportsReasoningEffort: false
  });
  const executionScope = { version: 1, taskStorageRoot: root, projectDirectory: root, application: null };
  const environment = { projectDirectory: root, binding: "fixture-binding" };
  await store.begin({
    runId: "run",
    requestId: "archived-request",
    model,
    context: normalizeContext({
      systemPrompt: "ARCHIVED_SYSTEM",
      tools: [archivedTool],
      messages: [{ role: "user", content: "ARCHIVED_INPUT", timestamp: 1 }]
    }),
    environment,
    executionScope,
    endpoint: "http://fixture.test/v1/chat/completions",
    body: archivedBody,
    ...(piVersion === undefined ? {} : { piVersion })
  });
  await store.settle("archived-request", "failed");
  const recorder = new ModelRequestRecorder(join(root, "archive.jsonl"), {
    taskId: "task",
    runId: "retry-run",
    agentId: "main"
  });
  const retry = new MainRequestRetry(
    store,
    "retry-run",
    async () => ({ ...environment, executionScope }),
    "archived-request"
  );
  const models = createModels();
  models.setProvider(
    createProvider({
      id: model.provider,
      name: "Snapshot fixture",
      baseUrl: model.baseUrl,
      auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "local-fixture" } }) } },
      models: [model],
      api: recordModelRequests(openAICompletionsApi(), recorder, retry)
    })
  );
  const live = normalizeContext({
    systemPrompt: "LIVE_SYSTEM",
    tools: [archivedTool],
    messages: [{ role: "user", content: "LIVE_INPUT", timestamp: 2 }]
  });
  const sent = [];
  const send = (input, init) => {
    sent.push({ url: typeof input === "string" ? input : input.url, raw: init?.body });
    return new Response(protocolStream("openai-completions", { text: "请求已发出。" }), {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };
  const archiveRows = async () =>
    (await readFile(join(root, "archive.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  return { root, store, model, retry, models, live, sent, send, archiveRows };
}

const attempt = (f) =>
  f.models.completeSimple(f.model, f.live, {
    apiKey: "local-fixture",
    maxRetries: 0,
    fetch: f.send
  });

test("a captured snapshot records the Pi version that wrote it", async (t) => {
  const f = await fixture(t, installedPiVersion);
  await f.retry.capture({
    requestId: "fresh-request",
    model: f.model,
    context: normalizeContext({
      tools: [archivedTool],
      messages: [{ role: "user", content: "LIVE_INPUT", timestamp: 2 }]
    }),
    endpoint: "http://fixture.test/v1/chat/completions",
    body: JSON.stringify({ model: "fixture", messages: [] })
  });
  const written = await f.store.read();
  assert.equal(written.piVersion, installedPiVersion);
  assert.equal(written.replaySkipped, undefined);
});

test("a snapshot from the same Pi version replays its archived body byte for byte", async (t) => {
  const f = await fixture(t, installedPiVersion);
  const result = await attempt(f);
  assert.equal(result.stopReason, "stop");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].raw, archivedBody, "the archived bytes must be resent unchanged");
  assert.equal(f.sent[0].url, "http://fixture.test/v1/chat/completions");
  const retried = await f.store.read();
  assert.equal(retried.retryOf, "archived-request");
  assert.equal(retried.piVersion, installedPiVersion);
  assert.equal(retried.replaySkipped, undefined);
  const row = (await f.archiveRows()).find((entry) => entry.type === "model_request");
  assert.equal(row.payload.retryOf, "archived-request");
  assert.deepEqual(row.payload.request, JSON.parse(archivedBody));
});

for (const [name, archivedPiVersion, reason] of [
  ["an archived body from another Pi version", "0.87.1", "pi_version_mismatch"],
  ["an archive written before snapshots recorded a version", undefined, "pi_version_missing"]
]) {
  test(`${name} rebuilds the context and states why in the retry record`, async (t) => {
    const f = await fixture(t, archivedPiVersion);
    const result = await attempt(f);
    assert.equal(result.stopReason, "stop");
    assert.equal(f.sent.length, 1, "the rebuilt request must still reach the provider");
    const rebuilt = JSON.parse(f.sent[0].raw);
    const messages = JSON.stringify(rebuilt.messages);
    assert.notEqual(f.sent[0].raw, archivedBody, "a stale archive must not be replayed");
    assert.ok(!messages.includes("ARCHIVED_INPUT"), `the archived body was reused: ${messages}`);
    assert.ok(messages.includes("LIVE_INPUT"), `the live context was not rebuilt: ${messages}`);

    const retried = await f.store.read();
    assert.equal(retried.retryOf, "archived-request");
    assert.equal(retried.piVersion, installedPiVersion);
    assert.deepEqual(retried.replaySkipped, {
      reason,
      ...(archivedPiVersion === undefined ? {} : { archivedPiVersion })
    });

    const row = (await f.archiveRows()).find((entry) => entry.type === "model_request");
    assert.equal(row.payload.retryOf, "archived-request");
    assert.equal(row.payload.replaySkipped.reason, reason);
  });
}

/** A real Dashboard whose first model request fails, as an App retry would find it. */
async function dashboard(t) {
  const received = [];
  const provider = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ data: [{ id: "original-model" }] }));
    }
    received.push(await readFixtureRequestBody(request));
    if (received.length === 1) {
      response.writeHead(400, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: { message: "isolated first failure" } }));
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(protocolStream("openai-completions", { text: "重建上下文后继续。" }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const dashboard = await startDashboard({
    modelEndpoint: `http://127.0.0.1:${provider.address().port}`,
    model: "original-model"
  });
  t.after(async () => {
    await dashboard.stop();
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
  });
  await mkdir(join(dashboard.root, "pi"), { recursive: true });
  await writeFile(
    join(dashboard.root, "pi", "settings.json"),
    JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } })
  );
  const store = new MainRequestStore(mainRequestPath(dashboard.workspaceRoot, "retry-task"), "retry-task");
  const settle = async (status) => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const detail = await (await fetch(`${dashboard.base}/api/tasks/retry-task`)).json();
      if (!detail.runtime.active) {
        assert.equal(detail.task.status, status, JSON.stringify(detail.task));
        return detail;
      }
      await delay(50);
    }
    assert.fail("the real Main process did not settle");
  };
  const call = async (body) =>
    fetch(`${dashboard.base}/api/tasks/retry-task/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  return { dashboard, received, store, settle, call };
}

test("a real retry of an archive from another Pi version rebuilds and succeeds", async (t) => {
  const f = await dashboard(t);
  await fetch(`${f.dashboard.base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "retry-task", goal: "原始输入" })
  });
  assert.equal((await f.call({ prompt: "原始输入" })).status, 202);
  const failed = await f.settle("failed");
  assert.equal(f.received.length, 1);
  assert.ok(failed.retryRequest.requestId, "the failure must offer an exact retry first");

  // Rewrite the archive the way a different Pi release left it: the stored body
  // carries text this runtime would never send, and its version is not this one.
  const saved = JSON.parse(await readFile(f.store.filePath, "utf8"));
  const marker = "ARCHIVED_FOREIGN_BODY";
  const archived = JSON.parse(saved.body);
  archived.messages = [{ role: "user", content: marker }, ...archived.messages];
  await f.store.begin({ ...saved, piVersion: "0.87.1", body: JSON.stringify(archived) });

  const retry = await f.call({ resume: true, retryRequestId: saved.requestId });
  assert.equal(retry.status, 202, await retry.text());
  const completed = await f.settle("completed");
  assert.equal(f.received.length, 2, "the rebuilt retry must reach the provider once");
  assert.ok(!f.received[1].includes(marker), "the foreign archive was replayed");
  assert.ok(f.received[1].includes("原始输入"), "the rebuilt request must continue the same conversation");
  assert.equal(completed.retryRequest, undefined, "a completed retry stops offering the slot");
  const retried = await f.store.read();
  assert.equal(retried.retryOf, saved.requestId);
  assert.equal(retried.piVersion, installedPiVersion);
  assert.deepEqual(retried.replaySkipped, {
    reason: "pi_version_mismatch",
    archivedPiVersion: "0.87.1"
  });
});
