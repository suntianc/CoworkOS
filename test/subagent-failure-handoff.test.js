import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { DurableScheduler, InboxStore } from "../dist/src/runtime/scheduler.js";
import { createBuiltinTools } from "../dist/src/tools/builtin.js";

async function fixture(t, respond) {
  const inherited = process.env;
  process.env = Object.fromEntries(
    Object.entries(inherited).filter(
      ([name]) => !/^(?:COWORK_|PI_|SERPER_|(?:HTTP|HTTPS|ALL|NO)_PROXY$)/i.test(name)
    )
  );
  const root = await mkdtemp(join(tmpdir(), "atria-subagent-failure-handoff-"));
  const requests = [];
  const controller = new AbortController();
  const coordinator = new CoordinatorRuntime();
  let running;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request.setEncoding("utf8")) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const reply = await respond(requests.length, body);
    if (reply.hang) return;
    if (reply.error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: reply.error } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({
          id: `handoff-${requests.length}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "handoff-fixture",
          choices: [{ index: 0, delta, finish_reason }]
        })}\n\n`
      );
    send({ role: "assistant" });
    if (reply.thinking) send({ reasoning_content: reply.thinking });
    if (reply.text) send({ content: reply.text });
    if (reply.tool)
      send({
        tool_calls: [
          {
            index: 0,
            id: `handoff-call-${requests.length}`,
            type: "function",
            function: { name: reply.tool, arguments: JSON.stringify(reply.arguments) }
          }
        ]
      });
    send({}, reply.tool ? "tool_calls" : "stop");
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    controller.abort();
    await running?.catch(() => {});
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
    process.env = inherited;
  });
  const identity = { workspaceRoot: root, taskId: "task", runId: "run", callId: "handoff-call" };
  return {
    root,
    requests,
    coordinator,
    identity,
    work: join(root, "task", "agents", "subagents", "worker"),
    inbox: new InboxStore(join(root, "task", "runs", "run", "agents", "main", "inbox-store.json")),
    dispatch(overrides = {}) {
      running = coordinator.dispatch({
        ...identity,
        agentId: "worker",
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        apiKey: "isolated-local-fixture",
        api: "openai-completions",
        model: "handoff-fixture",
        thinkingLevel: "off",
        supportsReasoningEffort: false,
        supportsImages: false,
        supportsPromptCacheKey: false,
        task: "Inspect the isolated fixture and report verified changes and remaining work.",
        mode: "sync",
        maxTurns: 4,
        maxAttempts: 1,
        maxErrorRetries: 0,
        timeoutMs: 10_000,
        questionTimeoutMs: 0,
        skillRoots: [],
        signal: controller.signal,
        toolFactory: (workingDirectory) => createBuiltinTools({ rootDirectory: workingDirectory }),
        ...overrides
      });
      return running;
    }
  };
}

test(
  "a synchronous turn limit returns file changes and the tail of failed verification without rereading diagnostics",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t, (n) => {
      if (n === 1)
        return {
          tool: "write_file",
          arguments: { path: "work/partial-fix.txt", content: "WRITE_BODY_NOT_FOR_HANDOFF" }
        };
      return {
        tool: "run_command",
        arguments: {
          command: process.execPath,
          args: [
            "-e",
            "process.stdout.write('x'.repeat(10000)+'\\n'+['VERIFICATION','FAILED'].join('_'));process.exit(3)"
          ]
        }
      };
    });
    const outcome = await f.dispatch({ maxTurns: 2 });
    assert.equal(outcome.status, "failed");
    assert.equal(f.requests.length, 2, "recovering partial progress must not make a summary request");
    assert.equal(await readFile(join(f.work, "work/partial-fix.txt"), "utf8"), "WRITE_BODY_NOT_FOR_HANDOFF");
    assert.match(outcome.response, /work\/partial-fix\.txt/);
    assert.match(outcome.response, /exitCode\D{0,5}3/);
    assert.match(outcome.response, /VERIFICATION_FAILED/, "the useful command tail must survive truncation");
    assert.doesNotMatch(outcome.response, /WRITE_BODY_NOT_FOR_HANDOFF/);
    assert.ok(
      outcome.response.length < 12_000,
      "a failed delegation must not inject its transcript or long output"
    );
    assert.deepEqual(
      await f.inbox.list("main"),
      [],
      "sync results are returned through the tool, not an extra callback"
    );
  }
);

test(
  "an async provider failure sends visible progress through Inbox and the wait delivery path",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t, (n) =>
      n === 1
        ? {
            text: "VISIBLE_FINDING: newline handling still needs validation.",
            thinking: "PRIVATE_REASONING_NOT_FOR_HANDOFF",
            tool: "write_file",
            arguments: { path: "work/provider-partial.txt", content: "WRITE_BODY_NOT_FOR_HANDOFF" }
          }
        : { error: "Synthetic fixture provider rejection" }
    );
    const outcome = await f.dispatch({ mode: "async" });
    assert.equal(outcome.status, "failed");
    assert.equal(f.requests.length, 2);
    const diagnostic = await readFile(join(f.root, "task", outcome.diagnostics.resultPath), "utf8");
    assert.match(
      diagnostic,
      /PRIVATE_REASONING_NOT_FOR_HANDOFF/,
      "the fixture must contain reasoning to test its exclusion"
    );
    assert.match(outcome.response, /VISIBLE_FINDING/);
    assert.match(outcome.response, /work\/provider-partial\.txt/);
    assert.match(outcome.response, /Synthetic fixture provider rejection/);
    assert.doesNotMatch(outcome.response, /PRIVATE_REASONING_NOT_FOR_HANDOFF|WRITE_BODY_NOT_FOR_HANDOFF/);
    const [callback] = (await f.inbox.list("main")).filter((message) => message.kind === "callback");
    assert.ok(callback, "terminal async failure must enqueue its handoff");
    assert.equal(callback.payload.response, outcome.response);
    assert.equal(callback.payload.status, "failed");
    const waited = await f.coordinator.waitForSubagents({
      ...f.identity,
      callIds: [f.identity.callId],
      timeoutMs: 0,
      waitForCallbackConsumption: false,
      consumeCompletedCallbacks: true
    });
    assert.equal(waited.calls[0].response, outcome.response);
    assert.equal(waited.claimedCallbacks[0].messageId, callback.messageId);
  }
);

test(
  "cancelling an in-flight request retains the previous completed file operation",
  { timeout: 15_000 },
  async (t) => {
    const secondRequest = Promise.withResolvers();
    const f = await fixture(t, (n) => {
      if (n === 1)
        return {
          tool: "write_file",
          arguments: { path: "work/cancelled-partial.txt", content: "kept on cancellation" }
        };
      secondRequest.resolve();
      return { hang: true };
    });
    const running = f.dispatch({ mode: "async" });
    await secondRequest.promise;
    await f.coordinator.cancelSubagent({ ...f.identity, reason: "isolated fixture cancellation" });
    const outcome = await running;
    assert.equal(outcome.status, "cancelled");
    assert.equal(await readFile(join(f.work, "work/cancelled-partial.txt"), "utf8"), "kept on cancellation");
    assert.match(outcome.response, /work\/cancelled-partial\.txt/);
    assert.equal(f.requests.length, 2);
    const [callback] = (await f.inbox.list("main")).filter((message) => message.kind === "callback");
    assert.equal(callback.payload.response, outcome.response);
    assert.equal(callback.payload.status, "cancelled");
  }
);

test(
  "timing out an in-flight request retains the previous completed file operation",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t, (n) =>
      n === 1
        ? {
            tool: "write_file",
            arguments: { path: "work/timeout-partial.txt", content: "kept on timeout" }
          }
        : { hang: true }
    );
    const outcome = await f.dispatch({ mode: "async", timeoutMs: 3000 });
    assert.equal(outcome.status, "timed_out");
    assert.equal(await readFile(join(f.work, "work/timeout-partial.txt"), "utf8"), "kept on timeout");
    assert.match(outcome.response, /work\/timeout-partial\.txt/);
    assert.equal(f.requests.length, 2, "timeout recovery must not request an additional summary");
    const [callback] = (await f.inbox.list("main")).filter((message) => message.kind === "callback");
    assert.equal(callback.payload.response, outcome.response);
    assert.equal(callback.payload.status, "timed_out");
  }
);

test(
  "a retryable async failure stays queued until the terminal attempt delivers its handoff",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t, (n) =>
      n === 1
        ? {
            tool: "write_file",
            arguments: { path: "work/retry-partial.txt", content: "kept across attempts" }
          }
        : { error: "Synthetic fixture rejection requiring a scheduler retry" }
    );
    const scheduler = new DurableScheduler(join(f.root, "task", "runs", "run", "queue.json"));
    const first = await f.dispatch({ mode: "async", maxAttempts: 2 });
    assert.equal(first.status, "failed");
    assert.match(first.response, /work\/retry-partial\.txt/);
    assert.equal(f.requests.length, 2);
    const [queued] = await scheduler.list();
    assert.equal(queued.status, "queued");
    assert.equal(queued.attempts, 1);
    assert.deepEqual(
      await f.inbox.list("main"),
      [],
      "an intermediate failure must not wake Main with a terminal callback"
    );
    const waiting = await f.coordinator.waitForSubagents({
      ...f.identity,
      timeoutMs: 0,
      waitForCallbackConsumption: false,
      consumeCompletedCallbacks: true
    });
    assert.deepEqual(waiting.pending, [f.identity.callId]);
    assert.deepEqual(waiting.claimedCallbacks, []);

    const terminal = await f.dispatch({ mode: "async", maxAttempts: 2, resume: true });
    assert.equal(terminal.status, "failed");
    assert.match(terminal.response, /work\/retry-partial\.txt/);
    assert.equal(f.requests.length, 3, "the resumed attempt must not repeat the completed file write");
    assert.equal(await readFile(join(f.work, "work/retry-partial.txt"), "utf8"), "kept across attempts");
    const [settled] = await scheduler.list();
    assert.equal(settled.status, "failed");
    assert.equal(settled.attempts, 2);
    const callbacks = (await f.inbox.list("main")).filter((message) => message.kind === "callback");
    assert.equal(callbacks.length, 1);
    assert.equal(callbacks[0].payload.response, terminal.response);
    assert.equal(callbacks[0].payload.status, "failed");
  }
);

test(
  "successful delegations keep their final summary without replaying intermediate operations",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t, (n) =>
      n === 1
        ? {
            tool: "write_file",
            arguments: { path: "work/temporary-fixture.txt", content: "temporary fixture content" }
          }
        : { text: "FINAL_VERIFIED_SUMMARY" }
    );
    const outcome = await f.dispatch();
    assert.equal(outcome.status, "succeeded");
    assert.equal(f.requests.length, 2);
    assert.match(outcome.response, /FINAL_VERIFIED_SUMMARY/);
    assert.doesNotMatch(outcome.response, /work\/temporary-fixture\.txt|temporary fixture content/);
  }
);
