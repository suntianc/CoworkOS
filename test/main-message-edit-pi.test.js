import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { startDashboard } from "./dashboard-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";
import { MainRequestStore, mainRequestPath } from "../dist/src/storage/main-request-store.js";

async function fixture(t, api, handle) {
  const requests = [];
  const provider = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ data: [{ id: "edit-fixture" }] }));
    }
    let raw = "";
    for await (const chunk of request.setEncoding("utf8")) raw += chunk;
    requests.push({ path: request.url, raw, body: JSON.parse(raw) });
    const reply = await handle(requests);
    if (reply.reject) {
      response.writeHead(400, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: { message: "isolated rejected original" } }));
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(protocolStream(api, reply));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const dashboard = await startDashboard({
    modelEndpoint: `http://127.0.0.1:${provider.address().port}`,
    model: "edit-fixture",
    defaultProject: false
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
  async function call(path, body) {
    const response = await fetch(`${dashboard.base}/api/tasks/edit-task${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, payload: await response.json() };
  }
  async function detail() {
    return (await fetch(`${dashboard.base}/api/tasks/edit-task`)).json();
  }
  async function settle(expected) {
    for (let attempt = 0; attempt < 500; attempt++) {
      const value = await detail();
      if (!value.runtime.active) {
        assert.equal(value.task.status, expected, JSON.stringify(value));
        return value;
      }
      await delay(50);
    }
    assert.fail("Real Pi edit run did not settle");
  }
  const created = await fetch(`${dashboard.base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "edit-task", goal: "PREFIX_INPUT" })
  });
  assert.equal(created.status, 201);
  const edit = (value, body, ids = [], editId = randomUUID()) =>
    call("/messages/edit", { ...value.editableMessage, body, attachmentIds: ids, editId });
  return { dashboard, requests, call, detail, settle, edit };
}
for (const api of ["openai-completions", "openai-responses"]) {
  for (const pause of ["restart", "stop"]) {
    test(`real Pi ${api}: editing a human question after ${pause} retires it with the old branch`, async (t) => {
      const f = await fixture(t, api, async (requests) =>
        requests.length === 1
          ? { name: "askhuman", arguments: { question: "OLD_CITY_QUESTION" } }
          : { text: "NEW_WEATHER_ANSWER" }
      );
      assert.equal(
        (await f.call("/run", { prompt: "OLD_WEATHER_INPUT", body: "OLD_WEATHER_INPUT" })).status,
        202
      );
      let original;
      for (let attempt = 0; attempt < 500; attempt++) {
        original = await f.detail();
        if (original.humanRequests.some((question) => question.status === "pending")) break;
        await delay(50);
      }
      assert.equal(original.runtime.active, true);
      assert.equal(original.humanRequests[0]?.status, "pending");
      const question = original.humanRequests[0];
      // A restart can leave a durable question after its waiting process has exited.
      if (pause === "restart") await f.dashboard.restart();
      else assert.equal((await f.call("/action", { action: "cancel" })).status, 200);
      original = await f.settle(pause === "restart" ? "waiting" : "cancelled");
      assert.equal(original.humanRequests[0].status, "pending");
      const continuation = await f.call("/run", { prompt: "ORDINARY_CONTINUATION" });
      assert.equal(continuation.status, 400);
      assert.match(continuation.payload.error, /请先回答/);
      const stale = await f.edit(
        { ...original, editableMessage: { ...original.editableMessage, scopeToken: "0".repeat(64) } },
        "STALE_EDIT"
      );
      assert.equal(stale.status, 409);
      assert.equal((await f.detail()).humanRequests[0].status, "pending");
      const editId = randomUUID();
      const accepted = await f.edit(original, "NEW_WEATHER_INPUT_BEIJING", [], editId);
      assert.equal(accepted.status, 202, JSON.stringify(accepted));
      const edited = await f.settle("completed");
      assert.equal(edited.humanRequests[0].status, "cancelled");
      assert.equal(edited.humanResumePending, false);
      assert.equal(f.requests.length, 2);
      const context = JSON.stringify(f.requests[1].body.input ?? f.requests[1].body.messages);
      assert.match(context, /NEW_WEATHER_INPUT_BEIJING/);
      assert.doesNotMatch(context, /OLD_WEATHER_INPUT|OLD_CITY_QUESTION/);
      assert.equal(
        (await f.call(`/human/${question.requestId}/answer`, { answer: "STALE_CITY_ANSWER" })).status,
        409
      );
      assert.equal((await f.edit(original, "NEW_WEATHER_INPUT_BEIJING", [], editId)).status, 202);
      assert.equal(f.requests.length, 2);
      const archive = await (
        await fetch(
          `${f.dashboard.base}/api/tasks/edit-task/message-versions/${edited.conversationVersions[0].versionId}`
        )
      ).json();
      assert.match(JSON.stringify(archive), /OLD_CITY_QUESTION/);
      await f.dashboard.restart();
      assert.equal((await f.detail()).humanRequests[0].status, "cancelled");
      assert.equal(
        (await f.call("/run", { prompt: "FOLLOWING_INPUT", body: "FOLLOWING_INPUT" })).status,
        202
      );
      await f.settle("completed");
      assert.equal(f.requests.length, 3);
      assert.doesNotMatch(
        JSON.stringify(f.requests[2].body.input ?? f.requests[2].body.messages),
        /OLD_WEATHER_INPUT|OLD_CITY_QUESTION|STALE_CITY_ANSWER/
      );
    });
  }
  test(`real Pi ${api}: edited branch excludes old input, assistant and tool results through restart`, async (t) => {
    const f = await fixture(t, api, async (requests) =>
      requests.length === 1
        ? { text: "PREFIX_ANSWER" }
        : requests.length === 2
          ? { name: "bash", arguments: { command: "printf OLD_TOOL_RESULT" } }
          : { text: requests.length === 3 ? "OLD_ANSWER" : "NEW_ANSWER" }
    );
    assert.equal((await f.call("/run", { prompt: "PREFIX_INPUT", body: "PREFIX_INPUT" })).status, 202);
    await f.settle("completed");
    assert.equal(
      (await f.call("/run", { prompt: "OLD_INPUT\nLINE_TWO", body: "OLD_INPUT\nLINE_TWO" })).status,
      202
    );
    const original = await f.settle("completed");
    assert.equal(f.requests.length, 3);
    assert.match(f.requests[2].raw, /OLD_TOOL_RESULT/);
    const sourceMessageId = original.editableMessage.messageId;
    const accepted = await f.edit(original, "NEW_INPUT\nNEW_LINE");
    assert.equal(accepted.status, 202, JSON.stringify(accepted));
    const edited = await f.settle("completed");
    assert.equal(f.requests.length, 4);
    const context = JSON.stringify(
      api === "openai-responses" ? f.requests[3].body.input : f.requests[3].body.messages
    );
    for (const included of ["PREFIX_INPUT", "PREFIX_ANSWER", "NEW_INPUT", "NEW_LINE"])
      assert.match(context, new RegExp(included));
    for (const excluded of ["OLD_INPUT", "LINE_TWO", "OLD_ANSWER", "OLD_TOOL_RESULT"])
      assert.doesNotMatch(context, new RegExp(excluded));
    assert.equal(edited.conversationVersions[0].currentMessageId, edited.editableMessage.messageId);
    assert.equal(edited.conversationVersions[0].messages, undefined);
    assert.equal(edited.conversationVersions[0].runtimeEvents, undefined);
    const archiveResponse = await fetch(
      `${f.dashboard.base}/api/tasks/edit-task/message-versions/${edited.conversationVersions[0].versionId}`
    );
    assert.equal(archiveResponse.status, 200);
    const archive = await archiveResponse.json();
    assert.ok(archive.messages.some((message) => message.id === sourceMessageId));
    assert.match(JSON.stringify(archive), /OLD_ANSWER/);
    const missing = await fetch(`${f.dashboard.base}/api/tasks/edit-task/message-versions/${randomUUID()}`);
    assert.equal(missing.status, 404);
    const malformed = await fetch(`${f.dashboard.base}/api/tasks/edit-task/message-versions/invalid%2Fpath`);
    assert.equal(malformed.status, 400);
    assert.doesNotMatch(JSON.stringify(edited.messages), /OLD_INPUT|OLD_ANSWER/);
    const versions = JSON.parse(
      await readFile(
        join(f.dashboard.workspaceRoot, "edit-task", "sessions", "main", "versions.json"),
        "utf8"
      )
    );
    assert.match(await readFile(versions.archives[0].sessionFile, "utf8"), /OLD_TOOL_RESULT/);
    assert.match(await readFile(versions.archives[0].retrySnapshotPath, "utf8"), /OLD_INPUT/);
    await f.dashboard.restart();
    assert.equal((await f.call("/run", { prompt: "FOLLOWING_INPUT", body: "FOLLOWING_INPUT" })).status, 202);
    await f.settle("completed");
    const following = JSON.stringify(
      api === "openai-responses" ? f.requests[4].body.input : f.requests[4].body.messages
    );
    assert.match(following, /NEW_INPUT/);
    assert.match(following, /NEW_ANSWER/);
    assert.doesNotMatch(following, /OLD_INPUT|OLD_TOOL_RESULT|OLD_ANSWER/);
    const stale = await f.edit(original, "MISDIRECTED");
    assert.equal(stale.status, 409);
    assert.equal(f.requests.length, 5);
  });
  test(`real Pi ${api}: original exact retry and modified resend keep independent request bodies`, async (t) => {
    const f = await fixture(t, api, async (requests) =>
      requests.length <= 2 ? { reject: true } : { text: "MODIFIED_ANSWER" }
    );
    await f.call("/run", { prompt: "FAILED_ORIGINAL", body: "FAILED_ORIGINAL" });
    const failed = await f.settle("failed");
    assert.equal(failed.editableMessage.body, "FAILED_ORIGINAL");
    assert.equal(
      (await f.call("/run", { resume: true, retryRequestId: failed.retryRequest.requestId })).status,
      202
    );
    const retried = await f.settle("failed");
    assert.equal(f.requests[1].raw, f.requests[0].raw);
    const editId = randomUUID();
    const modified = await f.edit(retried, "MODIFIED_INPUT", [], editId);
    assert.equal(
      modified.status,
      202,
      JSON.stringify({ modified, editable: retried.editableMessage, error: retried.editableMessageError })
    );
    await f.settle("completed");
    const context = JSON.stringify(
      api === "openai-responses" ? f.requests[2].body.input : f.requests[2].body.messages
    );
    assert.match(context, /MODIFIED_INPUT/);
    assert.doesNotMatch(context, /FAILED_ORIGINAL/);
    assert.notEqual(f.requests[2].raw, f.requests[0].raw);
    const duplicate = await f.edit(retried, "MODIFIED_INPUT", [], editId);
    assert.equal(duplicate.status, 202);
    assert.equal(f.requests.length, 3);
    const originalRetry = await f.call("/run", {
      resume: true,
      retryRequestId: failed.retryRequest.requestId
    });
    assert.equal(originalRetry.status, 400);
    const current = await new MainRequestStore(
      mainRequestPath(f.dashboard.workspaceRoot, "edit-task"),
      "edit-task"
    ).read();
    assert.equal(current.state, "completed");
    assert.match(current.body, /MODIFIED_INPUT/);
  });
}
