import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import assert from "node:assert/strict";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { once } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";
import { MainRequestStore, mainRequestPath } from "../dist/src/storage/main-request-store.js";
import { providerConfig } from "./model-provider-fixture.mjs";
const readSnapshot = (path) => new MainRequestStore(path, "retry-task").read();

async function fixture(t, api, handle) {
  const received = [];
  let dashboard;
  const provider = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ data: [{ id: "original-model" }] }));
    }
    const raw = await readFixtureRequestBody(request);
    const snapshot = await readSnapshot(mainRequestPath(dashboard.workspaceRoot, "retry-task"));
    received.push({ raw, path: request.url, body: JSON.parse(raw), snapshot });
    await handle({ response, received, dashboard });
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  dashboard = await startDashboard({
    modelEndpoint: `http://127.0.0.1:${provider.address().port}`,
    model: "original-model",
    supportsImages: true
  });
  await writeFile(join(dashboard.root, "config.json"), JSON.stringify({ api, mainMaxTokens: 64 }));
  await mkdir(join(dashboard.root, "pi"), { recursive: true });
  await writeFile(
    join(dashboard.root, "pi", "settings.json"),
    JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } })
  );
  t.after(async () => {
    await dashboard.stop();
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
  });
  const call = async (body) => {
    const response = await fetch(`${dashboard.base}/api/tasks/retry-task/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, payload: await response.json() };
  };
  const detail = async () => (await fetch(`${dashboard.base}/api/tasks/retry-task`)).json();
  const settle = async (status) => {
    for (let attempt = 0; attempt < 600; attempt++) {
      const value = await detail();
      if (!value.runtime.active) {
        assert.equal(value.task.status, status, JSON.stringify(value.task));
        return value;
      }
      await delay(50);
    }
    assert.fail("The real Main process did not settle");
  };
  await fetch(`${dashboard.base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "retry-task", goal: "你好！" })
  });
  return { dashboard, received, call, detail, settle };
}

function answer(response, api, reply) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(protocolStream(api, reply));
}
function reject(response) {
  response.writeHead(400, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message: "isolated original request failure" } }));
}
function assertPreserved(first, next) {
  assert.equal(next.raw, first.raw, "replay the exact serialized body, including all generation parameters");
  assert.equal(next.path, first.path, "replay the original API endpoint");
  assert.equal(next.snapshot.body, next.raw, "persist raw bytes before the real HTTP receipt");
  assert.deepEqual(next.snapshot.context, first.snapshot.context);
  assert.deepEqual(next.snapshot.model, first.snapshot.model);
  assert.deepEqual(next.snapshot.tools, first.snapshot.tools);
  assert.equal(next.snapshot.sessionId, first.snapshot.sessionId);
  assert.equal(next.snapshot.retryOf, first.snapshot.retryOf ?? first.snapshot.requestId);
}

function assertPublicRetryDetail(detail, request) {
  assert.deepEqual(detail.retryRequest, {
    requestId: request.snapshot.requestId,
    model: request.snapshot.model.id
  });
  assert.equal(detail.editableMessage.body, "你好！", "editing exposes the original user text");
  // User editing has a public body field; only the provider wire body and
  // execution snapshot are private. Inspect the whole response, not just its summary.
  const privateValues = [
    request.raw,
    request.body,
    request.snapshot,
    request.snapshot.model,
    request.snapshot.context,
    request.snapshot.executionScope,
    ...(request.body.tools?.length ? [request.body.tools] : [])
  ].map((value) => JSON.stringify(value));
  const bodyPaths = [];
  function inspect(value, path) {
    assert.ok(!privateValues.includes(JSON.stringify(value)), `private request value exposed at ${path}`);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (key === "body") bodyPaths.push(childPath);
      inspect(child, childPath);
    }
  }
  inspect(detail, "detail");
  assert.deepEqual(bodyPaths, ["detail.editableMessage.body"], "no private raw request body fields");
  const serialized = JSON.stringify(detail);
  for (const value of [request.snapshot.bodySha256, request.snapshot.checksum]) {
    assert.ok(!serialized.includes(value), "private request integrity data stays outside task detail");
  }
}

for (const api of ["openai-completions", "openai-responses"]) {
  test(
    `${api}: greeting retries preserve raw body, model, attachments and parameters across repeated failure/restart`,
    { timeout: 60_000 },
    async (t) => {
      const f = await fixture(t, api, ({ response, received }) =>
        received.length < 3 ? reject(response) : answer(response, api, { text: "你好！原请求已恢复。" })
      );
      const upload = await fetch(`${f.dashboard.base}/api/uploads?name=source.txt`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: "ORIGINAL_ATTACHMENT_BODY"
      });
      const { uploadId } = await upload.json();
      assert.equal(upload.status, 201);
      assert.equal((await f.call({ prompt: "你好！", attachmentIds: [uploadId] })).status, 202);
      let failed = await f.settle("failed");
      assert.equal(failed.messages.filter((message) => message.role === "user").length, 1);
      assert.ok(failed.retryRequest.requestId);
      assert.equal(
        (await stat(mainRequestPath(f.dashboard.workspaceRoot, "retry-task"))).mode & 0o777,
        0o600
      );
      assertPublicRetryDetail(failed, f.received[0]);
      // Regeneration would change both the protocol and output limit. A selected
      // model and an edited resource must not affect the archived failed request.
      await writeFile(
        join(f.dashboard.root, "config.json"),
        JSON.stringify({
          api: api === "openai-completions" ? "openai-responses" : "openai-completions",
          mainMaxTokens: 128,
          ...providerConfig([
            {
              id: "rotated-test-context",
              name: "isolated rotated provider",
              baseUrl: f.received[0].snapshot.model.baseUrl,
              model: "different-model",
              api: api === "openai-completions" ? "openai-responses" : "openai-completions",
              reasoningEffort: "off",
              supportsReasoningEffort: false,
              supportsImages: false,
              mainMaxTokens: 128,
              subagentMaxTokens: 64
            }
          ])
        })
      );
      await f.dashboard.restart({ newPort: true });
      assert.equal(
        (
          await f.call({
            resume: true,
            model: "different-model",
            retryRequestId: failed.retryRequest.requestId
          })
        ).status,
        202
      );
      failed = await f.settle("failed");
      assert.equal(
        f.received.length,
        2,
        await readFile(
          join(
            f.dashboard.workspaceRoot,
            "retry-task",
            "runs",
            failed.task.activeRunId,
            "runtime-stderr.log"
          ),
          "utf8"
        ).catch(() => JSON.stringify(failed.task))
      );
      assertPreserved(f.received[0], f.received[1]);
      assertPublicRetryDetail(failed, f.received[1]);
      assert.notEqual(failed.retryRequest.requestId, f.received[0].snapshot.requestId);
      assert.equal(
        (await f.call({ resume: true, retryRequestId: f.received[0].snapshot.requestId })).status,
        400,
        "stale clicks cannot claim a later failure"
      );
      assert.equal(
        (await f.call({ resume: true, retryRequestId: failed.retryRequest.requestId, prompt: "new input" }))
          .status,
        400
      );
      await f.dashboard.restart();
      assert.equal(
        (
          await f.call({
            resume: true,
            runId: failed.task.activeRunId,
            retryRequestId: failed.retryRequest.requestId
          })
        ).status,
        202
      );
      const completed = await f.settle("completed");
      assertPreserved(f.received[1], f.received[2]);
      assert.equal(completed.messages.filter((message) => message.role === "user").length, 1);
      assert.equal(completed.messages.at(-1).stopReason, "stop");
      assert.equal(completed.retryRequest, undefined);
      assert.equal(
        completed.retryRequestUnavailable,
        undefined,
        "completed retries cannot retain an old failure notice when a Run ID is reused"
      );
      const rows = (
        await readFile(
          join(
            f.dashboard.workspaceRoot,
            "retry-task",
            "sessions",
            "main",
            `${completed.task.activeRunId}-requests.jsonl`
          ),
          "utf8"
        )
      )
        .trim()
        .split("\n")
        .map(JSON.parse);
      const request = rows.filter((row) => row.type === "model_request").at(-1);
      assert.deepEqual(request.payload.request, f.received[0].body);
      assert.equal(request.payload.retryOf, f.received[0].snapshot.requestId);
    }
  );

  test(
    `${api}: retry the failing tool-loop call once, then serialize new results normally`,
    { timeout: 60_000 },
    async (t) => {
      let marker;
      const f = await fixture(t, api, ({ response, received }) => {
        if (received.length === 1)
          return answer(response, api, {
            name: "bash",
            arguments: { command: `printf 'done\\n' >> '${marker}'` }
          });
        if (received.length === 2) {
          if (api === "openai-responses") return reject(response);
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(
            `data: ${JSON.stringify({ id: "partial", object: "chat.completion.chunk", created: 1, model: "original-model", choices: [{ index: 0, delta: { role: "assistant", content: "PARTIAL_DIAGNOSTIC" }, finish_reason: null }] })}\n\n`
          );
          return response.end(
            `data: ${JSON.stringify({ error: { message: "isolated-stream-interruption" } })}\n\n`
          );
        }
        if (received.length === 3)
          return answer(response, api, { name: "read", arguments: { path: marker } });
        return answer(response, api, { text: "工具结果已经保存，仅重试了失败的模型调用。" });
      });
      marker = join(f.dashboard.workspaceRoot, "retry-task", "agents", "main", "work", "effect.txt");
      await mkdir(join(marker, ".."), { recursive: true });
      assert.equal((await f.call({ prompt: "记录一次结果，然后回答。" })).status, 202);
      const failed = await f.settle("failed");
      assert.equal(await readFile(marker, "utf8"), "done\n");
      await f.dashboard.restart();
      assert.equal(
        (await f.call({ resume: true, retryRequestId: failed.retryRequest.requestId })).status,
        202
      );
      const completed = await f.settle("completed");
      assert.equal(f.received.length, 4);
      assertPreserved(f.received[1], f.received[2]);
      assert.notEqual(f.received[3].raw, f.received[2].raw, "new tool results must not resend an older body");
      assert.equal(
        await readFile(marker, "utf8"),
        "done\n",
        "do not execute the completed side effect twice"
      );
      assert.equal(completed.messages.filter((message) => message.role === "user").length, 1);
      assert.equal(
        completed.runtimeEvents.filter(
          (event) => event.payload.type === "tool_execution_end" && event.payload.toolName === "bash"
        ).length,
        1
      );
      if (api === "openai-completions") {
        const partial = completed.messages.filter((message) => message.stopReason === "error");
        assert.equal(partial.length, 1, "preserve interrupted output as a separate diagnostic");
        assert.ok(JSON.stringify(partial).includes("PARTIAL_DIAGNOSTIC"));
        assert.ok(!JSON.stringify(completed.messages.at(-1)).includes("PARTIAL_DIAGNOSTIC"));
      }
    }
  );
}

test(
  "concurrent manual retries claim one original request; cancellation blocks stale retries",
  { timeout: 60_000 },
  async (t) => {
    let hold = false;
    let held = false;
    const f = await fixture(t, "openai-completions", ({ response }) => {
      if (!hold) return reject(response);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ id: "held", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "RETRY_PARTIAL" }, finish_reason: null }] })}\n\n`
      );
      held = true;
    });
    await f.call({ prompt: "你好！" });
    const failed = await f.settle("failed");
    hold = true;
    const attempts = await Promise.all([
      f.call({ resume: true, retryRequestId: failed.retryRequest.requestId }),
      f.call({ resume: true, retryRequestId: failed.retryRequest.requestId })
    ]);
    assert.deepEqual(attempts.map((result) => result.status).sort(), [202, 400]);
    for (let count = 0; !held && count < 600; count++) await delay(50);
    assert.equal(held, true);
    assertPreserved(f.received[0], f.received[1]);
    const response = await fetch(`${f.dashboard.base}/api/tasks/retry-task/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "cancel" })
    });
    assert.equal(response.status, 200);
    const cancelled = await f.settle("cancelled");
    assert.equal(cancelled.retryRequest, undefined);
    assert.equal((await f.call({ resume: true, retryRequestId: failed.retryRequest.requestId })).status, 400);
    assert.equal(f.received.length, 2);
    assert.equal(cancelled.messages.filter((message) => message.role === "user").length, 1);
  }
);

for (const api of ["openai-completions", "openai-responses"])
  test(
    `${api}: preserve serialized attachment pixels without reading the image twice`,
    { timeout: 60_000 },
    async (t) => {
      let imageId;
      const f = await fixture(t, api, ({ response, received }) => {
        if (received.length === 1)
          return answer(response, api, { name: "read_attachment", arguments: { id: imageId } });
        if (received.length === 2) return reject(response);
        return answer(response, api, { text: "原图片请求已恢复。" });
      });
      const pixels =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      const upload = await fetch(`${f.dashboard.base}/api/uploads?name=image.png`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: Buffer.from(pixels, "base64")
      });
      imageId = (await upload.json()).uploadId;
      assert.equal(upload.status, 201);
      await f.call({ prompt: "读取原图，然后回答。", attachmentIds: [imageId] });
      const failed = await f.settle("failed");
      assert.ok(
        f.received[1].raw.includes(pixels),
        "the real image tool must supply native pixels to the failed request"
      );
      await f.call({ resume: true, retryRequestId: failed.retryRequest.requestId });
      const completed = await f.settle("completed");
      assertPreserved(f.received[1], f.received[2]);
      assert.equal(
        completed.runtimeEvents.filter(
          (event) =>
            event.payload.type === "tool_execution_end" && event.payload.toolName === "read_attachment"
        ).length,
        1
      );
      assert.equal(completed.messages.filter((message) => message.role === "user").length, 1);
    }
  );

test(
  "a retry startup failure retains the same original request for another attempt",
  { timeout: 60_000 },
  async (t) => {
    const api = "openai-completions";
    const f = await fixture(t, api, ({ response, received }) =>
      received.length === 1 ? reject(response) : answer(response, api, { text: "启动失败后仍恢复原请求。" })
    );
    await f.call({ prompt: "你好！" });
    const first = await f.settle("failed");
    // A config parse failure occurs before Pi or the provider opens HTTP.
    await writeFile(join(f.dashboard.root, "config.json"), "damaged launch fixture");
    assert.equal(
      (
        await f.call({
          resume: true,
          runId: "retry-startup-failure",
          retryRequestId: first.retryRequest.requestId
        })
      ).status,
      202
    );
    const failedLaunch = await f.settle("failed");
    assert.equal(f.received.length, 1);
    assert.equal(failedLaunch.task.activeRunId, "retry-startup-failure");
    assert.equal(failedLaunch.retryRequest.requestId, first.retryRequest.requestId);
    await writeFile(join(f.dashboard.root, "config.json"), JSON.stringify({ api, mainMaxTokens: 256 }));
    assert.equal(
      (await f.call({ resume: true, retryRequestId: failedLaunch.retryRequest.requestId })).status,
      202
    );
    const completed = await f.settle("completed");
    assertPreserved(f.received[0], f.received[1]);
    assert.equal(completed.messages.filter((message) => message.role === "user").length, 1);
  }
);

test(
  "a damaged request archive cannot silently become a regenerated continuation",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t, "openai-completions", ({ response }) => reject(response));
    await f.call({ prompt: "你好！" });
    const failed = await f.settle("failed");
    const path = mainRequestPath(f.dashboard.workspaceRoot, "retry-task");
    await writeFile(path, "damaged original fixture");
    const detail = await f.detail();
    assert.equal(detail.retryRequestUnavailable, true);
    assert.equal(detail.retryRequest, undefined);
    assert.equal((await f.call({ resume: true, retryRequestId: failed.retryRequest.requestId })).status, 400);
    assert.equal(await readFile(path, "utf8"), "damaged original fixture");
    assert.equal(f.received.length, 1);
  }
);

for (const api of ["openai-completions", "openai-responses"])
  test(
    `${api}: restored optional tools execute after replay without re-enabling the group`,
    { timeout: 60_000 },
    async (t) => {
      const f = await fixture(t, api, ({ response, received }) => {
        if (received.length === 1)
          return answer(response, api, { name: "enable_tools", arguments: { groups: ["delivery"] } });
        if (received.length === 2) return reject(response);
        if (received.length === 3)
          return answer(response, api, { name: "publish_artifact", arguments: { sourcePath: "report.md" } });
        return answer(response, api, { text: "已恢复交付工具并发布产物。" });
      });
      await writeFile(join(f.dashboard.workspaceRoot, "report.md"), "已核对。\n");
      await f.call({ prompt: "启用交付工具并发布产物。" });
      const failed = await f.settle("failed");
      assert.ok(
        getCurrentTools(f.received[1].snapshot.context.messages).some(
          (tool) => tool.name === "publish_artifact"
        )
      );
      await f.dashboard.restart();
      await f.call({ resume: true, retryRequestId: failed.retryRequest.requestId });
      const completed = await f.settle("completed");
      assertPreserved(f.received[1], f.received[2]);
      const executions = completed.runtimeEvents.filter(
        (event) => event.payload.type === "tool_execution_end"
      );
      assert.equal(executions.filter((event) => event.payload.toolName === "enable_tools").length, 1);
      assert.equal(executions.filter((event) => event.payload.toolName === "publish_artifact").length, 1);
      assert.equal(
        executions.find((event) => event.payload.toolName === "publish_artifact").payload.isError,
        false
      );
      assert.ok(
        getCurrentTools(f.received[3].snapshot.context.messages).some(
          (tool) => tool.name === "publish_artifact"
        )
      );
      assert.equal(completed.messages.filter((message) => message.role === "user").length, 1);
    }
  );
