import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";

function stream(response, delta, finishReason = null) {
  response.write(
    `data: ${JSON.stringify({
      id: "p45-run-pause-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    })}\n\n`
  );
}

function complete(response, text) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  stream(response, { role: "assistant", content: text });
  stream(response, {}, "stop");
  response.end("data: [DONE]\n\n");
}

function toolCall(response, { id, command }) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  stream(response, { role: "assistant" });
  stream(response, {
    tool_calls: [
      {
        index: 0,
        id,
        type: "function",
        function: { name: "bash", arguments: JSON.stringify({ command }) }
      }
    ]
  });
  stream(response, {}, "tool_calls");
  response.end("data: [DONE]\n\n");
}

async function fixture(t, handle) {
  const requests = [];
  let dashboard;
  const provider = createServer(async (request, response) => {
    try {
      const raw = await readFixtureRequestBody(request);
      if (request.method !== "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
        return;
      }
      const body = JSON.parse(raw);
      requests.push(body);
      await handle({ body, response, requests });
    } catch (error) {
      response.destroy(error);
    }
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  dashboard = await startDashboard({
    modelEndpoint: `http://127.0.0.1:${provider.address().port}`,
    model: "fixture-model"
  });
  await mkdir(join(dashboard.root, "pi"), { recursive: true });
  await writeFile(join(dashboard.root, "pi", "settings.json"), JSON.stringify({ retry: { baseDelayMs: 1 } }));
  t.after(async () => {
    await dashboard.stop();
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
  });
  const api = async (path, body) => {
    const response = await fetch(`${dashboard.base}${path}`, {
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          }),
      signal: AbortSignal.timeout(5_000)
    });
    const payload = await response.json();
    assert.ok(response.ok, JSON.stringify(payload));
    return payload;
  };
  const status = async (taskId) => (await api(`/api/tasks/${taskId}`)).task;
  const settle = async (taskId, expected) => {
    const until = Date.now() + 40_000;
    let detail;
    while (Date.now() < until) {
      detail = await api(`/api/tasks/${taskId}`);
      if (!detail.runtime.active && detail.task.status === expected) return detail;
      if (!detail.runtime.active && detail.task.status !== "running") return detail;
      await delay(50);
    }
    assert.fail(`Main did not settle as ${expected}: ${JSON.stringify(detail?.task)}`);
  };
  const waitFor = async (check, message) => {
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      if (await check()) return;
      await delay(40);
    }
    assert.fail(message);
  };
  return { ...dashboard, api, status, settle, waitFor, requests };
}

const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

test(
  "a paused Main finishes the current tool call, starts no new step and continues from that point",
  { timeout: 90_000 },
  async (t) => {
    const local = await fixture(t, ({ response, requests }) => {
      // The first model reply starts one slow tool call. A paused Main must let
      // it finish, then stop instead of asking the model for the next step.
      if (requests.length === 1) {
        toolCall(response, {
          id: "pause-step-one",
          command: `mkdir -p ${shellQuote(join(localWorkspace, "agents", "main", "work"))}; touch ${shellQuote(join(localWorkspace, "agents", "main", "work", "started"))}; sleep 1.2; printf 'step-1\\n' >> ${shellQuote(marker)}`
        });
        return;
      }
      complete(response, "已在暂停处继续。");
    });
    const taskId = "pause-mid-step";
    const localWorkspace = join(local.workspaceRoot, taskId);
    const marker = join(localWorkspace, "agents", "main", "work", "steps.txt");
    await local.api("/api/tasks", { taskId, goal: "先记录第一步，再停下来" });
    const prompt = "先记录第一步，再停下来。";
    const started = await local.api(`/api/tasks/${taskId}/run`, { prompt });
    await local.waitFor(
      async () =>
        local.requests.length === 1 &&
        (await readFile(join(localWorkspace, "agents", "main", "work", "started"), "utf8")
          .then(() => true)
          .catch(() => false)),
      "the first tool call never started"
    );
    // A pending candidate and requirement record must survive the pause.
    await mkdir(join(localWorkspace, "agents", "main", "work", "candidates"), { recursive: true });
    await writeFile(join(localWorkspace, "agents", "main", "work", "candidates", "plan.md"), "候选方案\n");
    const paused = await local.api(`/api/tasks/${taskId}/action`, { action: "pause" });
    assert.equal(paused.status, "running", "pause is requested while the current step still runs");
    assert.equal(typeof paused.pause?.requestedAt, "string");
    const detail = await local.settle(taskId, "paused");
    assert.equal(
      detail.task.status,
      "paused",
      `events: ${detail.events.map((event) => event.type).join(", ")}`
    );
    assert.equal(detail.runtime.active, false);
    assert.equal(detail.task.activeRunId, started.runId, "a pause keeps the run it stopped");
    assert.equal(typeof detail.task.pause?.pausedAt, "string");
    assert.equal(local.requests.length, 1, "a paused Main must not ask the model for another step");
    assert.equal(await readFile(marker, "utf8"), "step-1\n", "the in-flight tool call finishes once");
    assert.equal(
      await readFile(join(localWorkspace, "agents", "main", "work", "candidates", "plan.md"), "utf8"),
      "候选方案\n",
      "the candidate is preserved"
    );
    assert.ok(
      detail.events.some((event) => event.runId === started.runId && event.type === "main.run_paused"),
      "the pause is recorded on the run"
    );

    const resumed = await local.api(`/api/tasks/${taskId}/run`, { resume: true });
    assert.equal(resumed.runId, started.runId, "continue resumes the paused run");
    const completed = await local.settle(taskId, "completed");
    assert.equal(completed.task.status, "completed");
    assert.equal(completed.task.pause, undefined, "continuing clears the pause state");
    assert.equal(local.requests.length, 2, "the model is asked exactly once more");
    const replay = local.requests.at(-1);
    assert.ok(
      replay.messages.some((message) => message.role === "tool" && message.tool_call_id === "pause-step-one"),
      "continuing keeps the completed step's tool result"
    );
    assert.equal(
      replay.messages.filter(
        (message) => message.role === "user" && JSON.stringify(message.content).includes(prompt)
      ).length,
      1,
      "continuing does not repeat the user request"
    );
    assert.equal(await readFile(marker, "utf8"), "step-1\n", "the completed step is not repeated");
  }
);

test(
  "cancelling a paused Main keeps its completed work and leaves the session resumable",
  { timeout: 90_000 },
  async (t) => {
    let localWorkspace;
    let marker;
    const local = await fixture(t, ({ response, requests }) => {
      if (requests.length === 1) {
        toolCall(response, {
          id: "cancel-after-pause",
          command: `mkdir -p ${shellQuote(join(localWorkspace, "agents", "main", "work"))}; printf 'kept\\n' >> ${shellQuote(marker)}; sleep 1`
        });
        return;
      }
      complete(response, "不重复已完成步骤。");
    });
    const taskId = "cancel-a-pause";
    localWorkspace = join(local.workspaceRoot, taskId);
    marker = join(localWorkspace, "agents", "main", "work", "kept.txt");
    await local.api("/api/tasks", { taskId, goal: "暂停后取消" });
    await local.api(`/api/tasks/${taskId}/run`, { prompt: "暂停后取消。" });
    await local.waitFor(
      () => local.status(taskId).then((task) => Boolean(task.activeRunId)),
      "the run never started"
    );
    await local.api(`/api/tasks/${taskId}/action`, { action: "pause" });
    const paused = await local.settle(taskId, "paused");
    assert.equal(
      paused.task.status,
      "paused",
      `events: ${paused.events.map((event) => event.type).join(", ")}`
    );
    assert.equal(
      paused.events.filter((event) => event.type === "main.run_failed").length,
      0,
      JSON.stringify(paused.task)
    );

    await local.api(`/api/tasks/${taskId}/action`, { action: "cancel" });
    const cancelled = await local.settle(taskId, "cancelled");
    assert.equal(cancelled.task.status, "cancelled");
    assert.equal(cancelled.runtime.active, false);
    assert.equal(await readFile(marker, "utf8"), "kept\n", "cancel does not roll back completed work");

    await local.api(`/api/tasks/${taskId}/run`, { resume: true });
    const completed = await local.settle(taskId, "completed");
    assert.equal(completed.task.status, "completed");
    assert.equal(local.requests.length, 2);
    assert.equal(await readFile(marker, "utf8"), "kept\n", "resuming never repeats the kept side effect");
  }
);

test("pausing a task with no running Main is refused", { timeout: 30_000 }, async (t) => {
  const local = await fixture(t, ({ response }) => complete(response, "unused"));
  await local.api("/api/tasks", { taskId: "idle-pause", goal: "没有运行时不能暂停" });
  const response = await fetch(`${local.base}/api/tasks/idle-pause/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "pause" })
  });
  assert.equal(response.status, 409);
  assert.equal((await local.status("idle-pause")).status, "created");
});
