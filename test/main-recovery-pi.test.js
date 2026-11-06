import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
const { mainInputPath, saveMainInput } = await import("../dist/src/runtime/main-continuation.js");
const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");

const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

function stream(response, delta, finishReason = null) {
  response.write(
    `data: ${JSON.stringify({
      id: "main-recovery-fixture",
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

async function fixture(t, handle, { retryBaseDelayMs } = {}) {
  const requests = [],
    rawRequests = [];
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
      rawRequests.push(raw);
      await handle({ body, response, dashboard, requests });
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
  if (retryBaseDelayMs !== undefined) {
    await mkdir(join(dashboard.root, "pi"), { recursive: true });
    await writeFile(
      join(dashboard.root, "pi", "settings.json"),
      JSON.stringify({ retry: { baseDelayMs: retryBaseDelayMs } })
    );
  }
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
  const settle = async (taskId, status) => {
    const until = Date.now() + 30_000;
    let detail;
    while (Date.now() < until) {
      detail = await api(`/api/tasks/${taskId}`);
      if (!detail.runtime.active) {
        assert.equal(detail.task.status, status, JSON.stringify(detail.task));
        return detail;
      }
      await delay(40);
    }
    assert.fail(`Main did not settle: ${JSON.stringify(detail?.task)}`);
  };
  return { ...dashboard, api, settle, requests, rawRequests };
}

async function receipt(root, name, value) {
  const evidence = join(root, "evidence");
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

for (const recover of [true, false])
  test(
    `real Main uses exactly five automatic retries and ${recover ? "recovers on the last" : "stops when exhausted"}`,
    { timeout: 60_000 },
    async (t) => {
      const local = await fixture(
        t,
        ({ response, requests }) => {
          if (recover && requests.length === 6) return complete(response, "Fifth retry recovered.");
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Synthetic service temporarily unavailable" } }));
        },
        { retryBaseDelayMs: 1 }
      );
      const taskId = `five-retries-${recover}`;
      await local.api("/api/tasks", { taskId, goal: "Exercise the fifth retry." });
      await local.api(`/api/tasks/${taskId}/run`, { prompt: "Exercise the fifth retry." });
      const detail = await local.settle(taskId, recover ? "completed" : "failed");
      assert.equal(local.requests.length, 6);
      for (const request of local.requests) assert.deepEqual(request.messages, local.requests[0].messages);
      const starts = detail.runtimeEvents
        .filter((event) => event.payload.type === "auto_retry_start")
        .map((event) => event.payload);
      assert.deepEqual(
        starts.map((event) => [event.attempt, event.maxAttempts]),
        [
          [1, 5],
          [2, 5],
          [3, 5],
          [4, 5],
          [5, 5]
        ]
      );
      const end = detail.runtimeEvents.findLast((event) => event.payload.type === "auto_retry_end").payload;
      assert.equal(end.success, recover);
      assert.equal(end.attempt, 5);
    }
  );

test("real Main does not retry a structured model-not-found 404", { timeout: 60_000 }, async (t) => {
  const local = await fixture(
    t,
    ({ response }) => {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ message: "No configured account supports this model", type: "model_not_found" })
      );
    },
    { retryBaseDelayMs: 1 }
  );
  const taskId = "nonretryable-model";
  await local.api("/api/tasks", { taskId, goal: "Exercise a model-not-found error." });
  await local.api(`/api/tasks/${taskId}/run`, { prompt: "Exercise a model-not-found error." });
  const detail = await local.settle(taskId, "failed");
  assert.equal(local.requests.length, 1);
  assert.equal(detail.runtimeEvents.filter((event) => event.payload.type === "auto_retry_start").length, 0);
});

test(
  "real Main cancellation during retry backoff prevents another request",
  { timeout: 60_000 },
  async (t) => {
    const local = await fixture(
      t,
      ({ response }) => {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Synthetic service temporarily unavailable" } }));
      },
      { retryBaseDelayMs: 10_000 }
    );
    const taskId = "cancel-retry-wait";
    await local.api("/api/tasks", { taskId, goal: "Cancel while retrying." });
    await local.api(`/api/tasks/${taskId}/run`, { prompt: "Cancel while retrying." });
    let retrying = false;
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      const detail = await local.api(`/api/tasks/${taskId}`);
      if (detail.runtimeEvents.some((event) => event.payload.type === "auto_retry_start")) {
        retrying = true;
        break;
      }
      await delay(40);
    }
    assert.equal(retrying, true);
    await local.api(`/api/tasks/${taskId}/action`, { action: "cancel" });
    await local.settle(taskId, "cancelled");
    assert.equal(local.requests.length, 1);
  }
);

test(
  "real Main resumes a failed SSE turn with completed tool evidence and no repeated side effect",
  { timeout: 60_000 },
  async (t) => {
    let recovering = false;
    let marker;
    const local = await fixture(t, ({ body, response }) => {
      if (recovering) return complete(response, "Recovered from the preserved tool evidence.");
      response.writeHead(200, { "content-type": "text/event-stream" });
      stream(response, { role: "assistant" });
      if (!body.messages.some((message) => message.role === "tool")) {
        stream(response, {
          tool_calls: [
            {
              index: 0,
              id: "fixture-append-once",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({ command: `printf 'done\\n' >> ${shellQuote(marker)}` })
              }
            }
          ]
        });
        stream(response, {}, "tool_calls");
        response.end("data: [DONE]\n\n");
        return;
      }
      stream(response, { content: "The tool completed; this response is partial." });
      response.end(`data: ${JSON.stringify({ error: { message: "fixture-fixture-denied" } })}\n\n`);
    });
    const taskId = "effect-before-error";
    const prompt = "Record the isolated fixture result exactly once, then explain the result.";
    await local.api("/api/tasks", { taskId, goal: prompt });
    marker = join(local.workspaceRoot, taskId, "agents", "main", "work", "effect.txt");
    await mkdir(join(local.workspaceRoot, taskId, "agents", "main", "work"), { recursive: true });
    const first = await local.api(`/api/tasks/${taskId}/run`, { prompt });
    const failed = await local.settle(taskId, "failed");
    assert.match(failed.task.lastError, /fixture-fixture-denied/);
    assert.equal(await readFile(marker, "utf8"), "done\n");
    const firstRequests = local.requests.length;
    assert.equal(firstRequests, 2, "a deterministic SSE error must not trigger an unbounded retry");
    recovering = true;
    const next = await local.api(`/api/tasks/${taskId}/run`, { resume: true });
    const completed = await local.settle(taskId, "completed");
    assert.notEqual(next.runId, first.runId);
    assert.equal(local.requests.length, firstRequests + 1);
    const resumed = local.requests.at(-1);
    assert.equal(local.rawRequests.at(-1), local.rawRequests[firstRequests - 1]);
    assert.equal(resumed.messages.filter((message) => message.role === "user").length, 1);
    assert.equal(completed.messages.filter((message) => message.role === "user").length, 1);
    assert.deepEqual(
      resumed,
      local.requests[firstRequests - 1],
      "manual retry must replay the complete failed body, including system and tool definitions"
    );
    assert.ok(
      resumed.messages.some(
        (message) => message.role === "tool" && message.tool_call_id === "fixture-append-once"
      )
    );
    assert.equal(
      resumed.messages.filter(
        (message) => message.role === "user" && JSON.stringify(message.content).includes(prompt)
      ).length,
      1
    );
    assert.equal(
      await readFile(marker, "utf8"),
      "done\n",
      "a successful side effect must remain single after recovery"
    );
    const toolRuns = completed.runtimeEvents.filter((event) => event.payload.type === "tool_execution_end");
    assert.equal(toolRuns.length, 1);
    assert.equal(completed.messages.at(-1).stopReason, "stop");
    assert.equal(
      completed.events.filter((event) => event.type === "main.run_failed").length,
      0,
      "the new run must not inherit the prior terminal error"
    );
    await receipt(local.root, "sse-after-effect", {
      failed: failed.task.status,
      recovered: completed.task.status,
      requests: local.requests.length,
      sideEffectLines: 1,
      completedToolExecutions: toolRuns.length,
      priorUserPromptCopies: 1
    });
  }
);

test(
  "real Main restores an accepted input after startup failed before saving any transcript",
  { timeout: 60_000 },
  async (t) => {
    const local = await fixture(t, ({ response }) => complete(response, "Recovered the original input."));
    const taskId = "startup-before-transcript";
    const prompt = `Original request with attachment:\n${"fixture attachment body\n".repeat(300)}`;
    await local.api("/api/tasks", { taskId, goal: "Original startup request" });
    const store = new LocalWorkspaceStore(local.workspaceRoot);
    await store.createRun(taskId, "failed-startup");
    await store.transitionTask(taskId, "running", { runId: "failed-startup" });
    await store.transitionTask(taskId, "failed", { runId: "failed-startup", reason: "fixture_startup_exit" });
    await saveMainInput(mainInputPath(local.workspaceRoot, taskId, "failed-startup"), {
      version: 1,
      prompt,
      submittedAt: Date.now()
    });
    await local.restart();
    await local.api(`/api/tasks/${taskId}/run`, { resume: true });
    const completed = await local.settle(taskId, "completed");
    const users = local.requests.at(-1).messages.filter((message) => message.role === "user");
    assert.equal(users.length, 1);
    assert.equal(users[0].content, prompt);
    assert.equal(completed.messages.filter((message) => message.role === "user").length, 1);
  }
);

test(
  "repeated manual continuation keeps one user turn and retains bounded retries",
  { timeout: 60_000 },
  async (t) => {
    let rejecting = true;
    const local = await fixture(
      t,
      ({ response }) => {
        if (!rejecting) return complete(response, "Manual continuation succeeded.");
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Synthetic transient service error" } }));
      },
      { retryBaseDelayMs: 1 }
    );
    const taskId = "repeated-continuation";
    await local.api("/api/tasks", { taskId, goal: "Keep this original request exactly once." });
    await local.api(`/api/tasks/${taskId}/run`, { prompt: "Keep this original request exactly once." });
    await local.settle(taskId, "failed");
    await local.api(`/api/tasks/${taskId}/run`, { resume: true });
    await local.settle(taskId, "failed");
    assert.equal(local.requests.length, 12, "each invocation retains five bounded automatic retries");
    rejecting = false;
    await local.api(`/api/tasks/${taskId}/run`, { resume: true });
    const completed = await local.settle(taskId, "completed");
    assert.equal(completed.messages.filter((message) => message.role === "user").length, 1);
    for (const request of local.requests)
      assert.deepEqual(
        request.messages.filter((message) => message.role !== "system"),
        local.requests[0].messages.filter((message) => message.role !== "system")
      );
    await local.api(`/api/tasks/${taskId}/run`, { prompt: "A separate follow-up." });
    const followUp = await local.settle(taskId, "completed");
    assert.equal(followUp.messages.filter((message) => message.role === "user").length, 2);
    assert.equal(local.requests.at(-1).messages.filter((message) => message.role === "user").length, 2);
  }
);

test(
  "real Main exposes a zero-output HTTP rejection and continues without inheriting that error",
  { timeout: 60_000 },
  async (t) => {
    let rejecting = true;
    const local = await fixture(t, ({ response }) => {
      if (!rejecting) return complete(response, "HTTP rejection recovered.");
      response.writeHead(400, { "content-type": "application/json", "x-request-id": "fixture-http-request" });
      response.end(
        JSON.stringify({ error: { message: "fixture-invalid-parameter", type: "invalid_request_error" } })
      );
    });
    const taskId = "http-rejection";
    await local.api("/api/tasks", { taskId, goal: "Exercise isolated provider rejection." });
    await local.api(`/api/tasks/${taskId}/run`, { prompt: "Exercise isolated provider rejection." });
    const failed = await local.settle(taskId, "failed");
    assert.match(failed.task.lastError, /400|fixture-invalid-parameter/);
    assert.equal(local.requests.length, 1);
    rejecting = false;
    await local.api(`/api/tasks/${taskId}/run`, { resume: true });
    const completed = await local.settle(taskId, "completed");
    assert.equal(local.requests.length, 2);
    assert.deepEqual(local.requests[1], local.requests[0]);
    assert.equal(local.rawRequests[1], local.rawRequests[0]);
    assert.equal(completed.messages.at(-1).content.at(-1).text, "HTTP rejection recovered.");
    await receipt(local.root, "http-zero-output", {
      failed: failed.task.status,
      failedMessage: failed.task.lastError,
      recovered: completed.task.status,
      requests: local.requests.length
    });
  }
);

test(
  "real Main cancellation of a partial stream stays cancelled and can explicitly continue",
  { timeout: 60_000 },
  async (t) => {
    let held = false;
    let recovering = false;
    const local = await fixture(t, ({ response }) => {
      if (recovering) return complete(response, "Explicitly continued after cancellation.");
      response.writeHead(200, { "content-type": "text/event-stream" });
      stream(response, { role: "assistant", content: "Partial before cancellation." });
      held = true;
    });
    const taskId = "cancelled-stream";
    await local.api("/api/tasks", { taskId, goal: "Exercise isolated cancellation." });
    await local.api(`/api/tasks/${taskId}/run`, { prompt: "Exercise isolated cancellation." });
    const until = Date.now() + 20_000;
    while (!held && Date.now() < until) await delay(20);
    assert.equal(held, true);
    await local.api(`/api/tasks/${taskId}/action`, { action: "cancel" });
    const cancelled = await local.settle(taskId, "cancelled");
    assert.equal(cancelled.events.filter((event) => event.type === "main.run_failed").length, 0);
    recovering = true;
    await local.api(`/api/tasks/${taskId}/run`, { resume: true });
    const completed = await local.settle(taskId, "completed");
    assert.equal(local.requests.length, 2);
    assert.equal(completed.messages.at(-1).content.at(-1).text, "Explicitly continued after cancellation.");
    await receipt(local.root, "cancel-and-continue", {
      cancelled: cancelled.task.status,
      recovered: completed.task.status,
      requests: local.requests.length,
      falseFailureEvents: 0
    });
  }
);

test(
  "real Main completes after a transient HTTP service failure without persisting a false terminal failure",
  { timeout: 60_000 },
  async (t) => {
    const local = await fixture(t, ({ response, requests }) => {
      if (requests.length > 1) return complete(response, "Transient service failure recovered.");
      response.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
      response.end(JSON.stringify({ error: { message: "fixture-service-temporarily-unavailable" } }));
    });
    const taskId = "transient-service";
    await local.api("/api/tasks", { taskId, goal: "Exercise existing bounded provider retry." });
    await local.api(`/api/tasks/${taskId}/run`, { prompt: "Exercise existing bounded provider retry." });
    const completed = await local.settle(taskId, "completed");
    assert.equal(local.requests.length, 2);
    assert.equal(completed.messages.at(-1).content.at(-1).text, "Transient service failure recovered.");
    assert.equal(completed.events.filter((event) => event.type === "main.run_failed").length, 0);
    assert.ok(completed.runtimeEvents.some((event) => event.payload.type === "auto_retry_start"));
    await receipt(local.root, "transient-service", {
      status: completed.task.status,
      requests: local.requests.length,
      falseFailureEvents: 0,
      existingProviderRetryObserved: true
    });
  }
);

for (const finalFails of [true, false]) {
  test(
    `real Main finish_task followed by ${finalFails ? "SSE failure remains recoverable" : "a final answer retains explicit completion"}`,
    { timeout: 60_000 },
    async (t) => {
      let recovering = false;
      const local = await fixture(t, ({ body, response }) => {
        const finishResult = body.messages.some(
          (message) => message.role === "tool" && message.tool_call_id === "fixture-finish"
        );
        if (recovering || (finishResult && !finalFails))
          return complete(response, "Explicit finish result delivered.");
        response.writeHead(200, { "content-type": "text/event-stream" });
        stream(response, { role: "assistant" });
        if (!finishResult) {
          stream(response, {
            tool_calls: [
              {
                index: 0,
                id: "fixture-finish",
                type: "function",
                function: {
                  name: "finish_task",
                  arguments: JSON.stringify({ summary: "Isolated fixture work verified." })
                }
              }
            ]
          });
          stream(response, {}, "tool_calls");
          response.end("data: [DONE]\n\n");
        } else
          response.end(
            `data: ${JSON.stringify({ error: { message: "fixture-final-delivery-denied" } })}\n\n`
          );
      });
      const taskId = finalFails ? "finish-before-error" : "finish-before-stop";
      await local.api("/api/tasks", {
        taskId,
        goal: "Verify explicit finish and final delivery consistency."
      });
      await local.api(`/api/tasks/${taskId}/run`, {
        prompt: "Verify explicit finish and final delivery consistency."
      });
      const terminal = await local.settle(taskId, finalFails ? "failed" : "completed");
      const finishCall = terminal.runtimeEvents.find(
        (event) =>
          event.payload.type === "tool_execution_end" && event.payload.toolCallId === "fixture-finish"
      );
      assert.ok(finishCall, "the real finish_task tool must execute");
      assert.equal(finishCall.payload.isError, false);
      assert.equal(finishCall.payload.result.details.completed, true);
      if (finalFails) {
        assert.match(terminal.task.lastError, /fixture-final-delivery-denied/);
        assert.equal(terminal.events.filter((event) => event.type === "main.run_failed").length, 1);
        recovering = true;
        await local.api(`/api/tasks/${taskId}/run`, { resume: true });
        const recovered = await local.settle(taskId, "completed");
        assert.equal(
          recovered.runtimeEvents.filter(
            (event) =>
              event.payload.type === "tool_execution_end" && event.payload.toolCallId === "fixture-finish"
          ).length,
          1,
          "manual recovery must retain rather than rerun finish_task"
        );
      } else assert.equal(terminal.task.completion.signal, "finish_task");
      await receipt(local.root, taskId, {
        terminalStatus: terminal.task.status,
        finalDeliveryFailed: finalFails,
        finishToolSucceeded: true,
        requests: local.requests.length,
        explicitCompletionRetained: !finalFails
      });
    }
  );
}

for (const action of ["cancel", "shutdown"]) {
  test(
    `real Main ${action} after finish_task settles its still-active final response truthfully`,
    { timeout: 60_000 },
    async (t) => {
      let finalResponseStarted = false;
      const local = await fixture(t, ({ body, response }) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        stream(response, { role: "assistant" });
        if (
          body.messages.some(
            (message) => message.role === "tool" && message.tool_call_id === "fixture-finish-held"
          )
        ) {
          finalResponseStarted = true;
          stream(response, { content: "Final response awaiting delivery." });
          return;
        }
        stream(response, {
          tool_calls: [
            {
              index: 0,
              id: "fixture-finish-held",
              type: "function",
              function: {
                name: "finish_task",
                arguments: JSON.stringify({
                  summary: "Isolated fixture work verified before final delivery."
                })
              }
            }
          ]
        });
        stream(response, {}, "tool_calls");
        response.end("data: [DONE]\n\n");
      });
      const taskId = `finish-before-${action}`;
      await local.api("/api/tasks", { taskId, goal: "Exercise stop while final delivery is pending." });
      const run = await local.api(`/api/tasks/${taskId}/run`, {
        prompt: "Exercise stop while final delivery is pending."
      });
      const until = Date.now() + 20_000;
      while (!finalResponseStarted && Date.now() < until) await delay(20);
      assert.equal(finalResponseStarted, true);
      const before = await local.api(`/api/tasks/${taskId}`);
      assert.equal(before.runtime.active, true);
      assert.equal(before.task.completion.signal, "finish_task");
      let status;
      if (action === "cancel") {
        await local.api(`/api/tasks/${taskId}/action`, { action: "cancel" });
        status = (await local.settle(taskId, "cancelled")).task.status;
      } else {
        const exited = once(local.child, "exit");
        local.child.kill("SIGTERM");
        await exited;
        const stored = JSON.parse(await readFile(join(local.workspaceRoot, taskId, "task.json"), "utf8"));
        assert.equal(stored.status, "waiting");
        assert.equal(stored.activeRunId, run.runId);
        status = stored.status;
      }
      await receipt(local.root, taskId, {
        action,
        status,
        stillActiveBeforeStop: true,
        finishTaskHadCompleted: true
      });
    }
  );
}
