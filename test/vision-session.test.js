import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { RunService } from "../dist/src/runtime/run-service.js";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";

const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function fixture(t) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request.setEncoding("utf8")) raw += chunk;
    const input = JSON.parse(raw);
    requests.push(input);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({
          id: `vision-${requests.length}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "vision-fixture",
          choices: [{ index: 0, delta, finish_reason }]
        })}\n\n`
      );
    send({ role: "assistant" });
    if (!input.messages.some((message) => message.role === "tool")) {
      send({
        tool_calls: [
          {
            index: 0,
            id: "capture-call",
            type: "function",
            function: { name: "capture_fixture", arguments: "{}" }
          }
        ]
      });
      send({}, "tool_calls");
    } else {
      send({ content: "Vision fixture complete." });
      send({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    apiKey: "local-fixture",
    model: "vision-fixture",
    thinkingLevel: "off",
    supportsReasoningEffort: false,
    timeoutMs: 5000,
    maxTokens: 256
  };
}

function tools({ fail = false, onSignal } = {}) {
  return new Map([
    [
      "capture_fixture",
      {
        description: "Capture the isolated fixture image.",
        parameters: { type: "object", properties: {} },
        execute: async (_input, signal) => {
          onSignal?.(signal);
          return {
            content: [
              { type: "text", text: fail ? "Capture permission denied." : "Fixture accessibility text." },
              ...(!fail ? [{ type: "image", mimeType: "image/png", data: image }] : [])
            ],
            details: { fixture: true },
            isError: fail
          };
        }
      }
    ]
  ]);
}

function assertNativePicture(request) {
  const blocks = request.messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content : []
  );
  assert.ok(
    blocks.some(
      (block) => block.type === "image_url" && block.image_url.url === `data:image/png;base64,${image}`
    )
  );
  const result = request.messages.findLast((message) => message.role === "tool");
  assert.equal(result.content, "Fixture accessibility text.");
  assert.ok(!result.content.includes(image), "image data must not be serialized into model-visible text");
}

test(
  "PiSession forwards native images, structured failure status and tool cancellation signals",
  { timeout: 15_000 },
  async (t) => {
    const connection = await fixture(t);
    let signal;
    const session = new PiSession({
      ...connection,
      supportsImages: true,
      tools: tools({
        onSignal: (value) => {
          signal = value;
        }
      })
    });
    assert.equal((await session.run("Inspect the isolated fixture.")).termination, "completed");
    assert.equal(signal instanceof AbortSignal, true);
    assert.equal(connection.requests.length, 2);
    assertNativePicture(connection.requests[1]);
    assert.equal(
      session.agent.state.messages.find((message) => message.role === "toolResult").details.fixture,
      true
    );

    connection.requests.length = 0;
    const events = [];
    const failed = new PiSession({
      ...connection,
      supportsImages: true,
      tools: tools({ fail: true }),
      onEvent: (event) => events.push(event)
    });
    await failed.run("Report the capture problem.");
    assert.equal(events.find((event) => event.type === "tool_execution_end").isError, true);
    assert.equal(failed.agent.state.messages.find((message) => message.role === "toolResult").isError, true);
  }
);

test(
  "a text-only model receives accessibility feedback and an actionable image-capability reason",
  { timeout: 10_000 },
  async (t) => {
    const connection = await fixture(t);
    const session = new PiSession({ ...connection, supportsImages: false, tools: tools() });
    assert.equal((await session.run("Inspect the isolated fixture.")).termination, "completed");
    const sent = connection.requests[1];
    assert.ok(!JSON.stringify(sent).includes(image));
    assert.match(sent.messages.findLast((message) => message.role === "tool").content, /未启用图像输入/);
  }
);

test("Main and delegated runs retain explicit image-input capabilities", { timeout: 20_000 }, async (t) => {
  const connection = await fixture(t);
  const workspaceRoot = await mkdtemp(join(tmpdir(), "atria-vision-runtime-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const main = await new RunService(workspaceRoot).runPi({
    ...connection,
    supportsImages: true,
    taskId: "main",
    runId: "run-main",
    prompt: "Inspect the fixture.",
    tools: () => tools()
  });
  assert.equal(main.taskStatus, "completed");
  assertNativePicture(connection.requests[1]);
  connection.requests.length = 0;
  const delegated = await new CoordinatorRuntime().dispatch({
    ...connection,
    supportsImages: true,
    workspaceRoot,
    taskId: "delegated",
    runId: "run-delegated",
    agentId: "reviewer",
    task: "Inspect the fixture.",
    mode: "sync",
    toolFactory: () => tools(),
    skillRoots: []
  });
  assert.equal(delegated.status, "succeeded");
  assertNativePicture(connection.requests[1]);
});

test(
  "malformed image blocks and plain-data error flags remain tool failures",
  { timeout: 10_000 },
  async (t) => {
    const connection = await fixture(t);
    for (const result of [
      { content: [{ type: "image", data: image }] },
      { content: [{ type: "image", data: "", mimeType: "image/png" }] },
      { isError: true, error: "fixture capture unavailable" }
    ]) {
      connection.requests.length = 0;
      const events = [];
      const session = new PiSession({
        ...connection,
        supportsImages: true,
        tools: new Map([
          ["capture_fixture", { parameters: { type: "object", properties: {} }, execute: async () => result }]
        ]),
        onEvent: (event) => events.push(event)
      });
      await session.run("Inspect the fixture or report the actual failure.");
      assert.equal(events.find((event) => event.type === "tool_execution_end").isError, true);
      assert.equal(
        session.agent.state.messages.find((message) => message.role === "toolResult").isError,
        true
      );
      assert.ok(!JSON.stringify(connection.requests[1]).includes(image));
    }
  }
);

test(
  "queued recovery preserves the original image capability after connection defaults change",
  { timeout: 20_000 },
  async (t) => {
    const connection = await fixture(t);
    const workspaceRoot = await mkdtemp(join(tmpdir(), "atria-vision-recovery-"));
    t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
    for (const supportsImages of [true, false]) {
      connection.requests.length = 0;
      const common = {
        ...connection,
        workspaceRoot,
        taskId: `recovery-${supportsImages}`,
        runId: "run",
        agentId: "reviewer",
        toolFactory: () => tools(),
        skillRoots: []
      };
      // The interruption settles the call record; the queued item keeps the
      // original image capability for recovery.
      const interrupted = await new CoordinatorRuntime().dispatch({
        ...common,
        supportsImages,
        task: "Inspect the fixture.",
        callId: "queued",
        mode: "async",
        onQueued: () => {
          throw new Error("fixture process interruption");
        }
      });
      assert.equal(interrupted.status, "failed");
      assert.match(interrupted.error, /fixture process interruption/);
      const recovered = await new CoordinatorRuntime().recoverRun({
        ...common,
        supportsImages: !supportsImages
      });
      assert.equal(recovered[0].status, "succeeded");
      if (supportsImages) assertNativePicture(connection.requests[1]);
      else assert.ok(!JSON.stringify(connection.requests[1]).includes(image));
    }
  }
);

test(
  "cancelling a session reaches a waiting runtime tool and prevents another model turn",
  { timeout: 10_000 },
  async (t) => {
    const connection = await fixture(t);
    const controller = new AbortController();
    let started;
    const began = new Promise((resolve) => {
      started = resolve;
    });
    let aborted = false;
    const session = new PiSession({
      ...connection,
      signal: controller.signal,
      tools: new Map([
        [
          "capture_fixture",
          {
            parameters: { type: "object", properties: {} },
            execute: async (_input, signal) => {
              started();
              await new Promise((_resolve, reject) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    aborted = true;
                    reject(new Error("fixture capture cancelled"));
                  },
                  { once: true }
                );
              });
            }
          }
        ]
      ])
    });
    const running = session.run("Inspect the fixture.");
    await began;
    controller.abort();
    assert.equal((await running).termination, "cancelled");
    assert.equal(aborted, true);
    assert.equal(connection.requests.length, 1);
  }
);
