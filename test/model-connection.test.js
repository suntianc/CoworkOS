import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { testModelConnection } from "../dist/src/runtime/model-connection.js";

const input = { baseUrl: "https://gateway.example/", model: "fixture", apiKey: "private-test-key" };
const chunk = (delta, finish_reason = null) =>
  `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const reply = (color = "none", code = "none") =>
  new Response(
    chunk({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call_connection_check",
          type: "function",
          function: {
            name: "atria_connection_check",
            arguments: JSON.stringify({ status: "connected", color, code })
          }
        }
      ]
    }) +
      chunk({}, "tool_calls") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }
  );

test("connection test verifies actual tool calling and image transport without returning credentials", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) });
    return calls.length === 1 ? reply() : reply("blue", "2");
  });
  const text = await testModelConnection(input);
  assert.equal(text.ok, true);
  assert.equal(text.supportsImages, false);
  assert.equal(calls[0].url, "https://gateway.example/v1/chat/completions");
  assert.equal(calls[0].body.stream, true);
  assert.equal(calls[0].body.max_completion_tokens, 65536);
  assert.equal(calls[0].body.reasoning_effort, "high");
  assert.ok(calls[0].body.messages.some((message) => message.role === "system"));
  const vision = await testModelConnection(
    {
      ...input,
      baseUrl: "https://gateway.example/v1/",
      supportsImages: true
    },
    { imageFixture: () => ({ imageUrl: "data:image/png;base64,fixture", code: "2" }) }
  );
  assert.equal(vision.supportsImages, true);
  assert.equal(calls[1].url, calls[0].url);
  assert.match(
    calls[1].body.messages.find((message) => message.role === "user").content[1].image_url.url,
    /^data:image\/png;base64,/
  );
  assert.equal(calls[1].options.redirect, "error");
  assert.ok(!JSON.stringify([text, vision]).includes(input.apiKey));
  assert.ok(
    !calls[1].body.messages.find((message) => message.role === "user").content[0].text.includes("2"),
    "visual answer must not appear in request text"
  );
});

test("connection test rejects plain text, unsupported vision and malformed provider replies", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ choices: [{ message: { content: "Hello" } }] }))
  );
  await assert.rejects(testModelConnection(input), /工具调用/);
  globalThis.fetch.mock.mockImplementation(async () => reply("red"));
  await assert.rejects(testModelConnection({ ...input, supportsImages: true }), /测试图片/);
  globalThis.fetch.mock.mockImplementation(async () => new Response(`invalid ${input.apiKey}`));
  await assert.rejects(
    testModelConnection(input),
    (error) => /JSON/.test(error.message) && !error.message.includes(input.apiKey)
  );
});

test("connection errors never relay credential-bearing provider diagnostics or network errors", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(input.apiKey, { status: 401 }));
  await assert.rejects(
    testModelConnection(input),
    (error) => /认证/.test(error.message) && !error.message.includes(input.apiKey)
  );
  globalThis.fetch.mock.mockImplementation(async () => {
    throw new Error(input.apiKey);
  });
  await assert.rejects(
    testModelConnection(input),
    (error) => /连接/.test(error.message) && !error.message.includes(input.apiKey)
  );
  for (const baseUrl of [
    "file:///private",
    "https://user:secret@example.com",
    "https://example.com?token=secret",
    "https://example.com#fragment"
  ])
    await assert.rejects(testModelConnection({ ...input, baseUrl }), /HTTP/);
  await assert.rejects(testModelConnection({ ...input, apiKey: "key\nheader" }), /Key/);
});

test("a previously working connection reports provider model availability without blaming request parameters", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(String(url));
    return urls.length === 1
      ? reply()
      : new Response(
          JSON.stringify({
            message: `Model is not supported by any configured account in this group ${input.apiKey}`,
            type: "model_not_found"
          }),
          { status: 404, headers: { "content-type": "application/json" } }
        );
  });
  assert.equal((await testModelConnection(input)).ok, true);
  await assert.rejects(testModelConnection(input), (error) => {
    assert.match(error.message, /HTTP 404.*账号或分组.*模型/);
    assert.doesNotMatch(error.message, /输出上限|推理参数|工具调用|图像输入|private-test-key/);
    return true;
  });
  assert.equal(urls[0], urls[1]);
  globalThis.fetch.mock.mockImplementation(async () => new Response(input.apiKey, { status: 404 }));
  await assert.rejects(testModelConnection(input), (error) => {
    assert.match(error.message, /HTTP 404.*API 地址.*模型 ID/);
    assert.doesNotMatch(error.message, /输出上限|推理参数|private-test-key/);
    return true;
  });
});

test("malformed successful provider responses cannot pass or leak parser diagnostics", async (t) => {
  const bodies = [
    null,
    { choices: [{ message: { tool_calls: {} } }] },
    { choices: [{ message: { tool_calls: [null] } }] },
    {
      choices: [
        { message: { tool_calls: [{ function: { name: "atria_connection_check", arguments: "{}" } }] } }
      ]
    },
    {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call",
                type: "function",
                function: {
                  name: "atria_connection_check",
                  arguments: JSON.stringify({ status: "connected", color: ["none"], code: "none" })
                }
              }
            ]
          }
        }
      ]
    }
  ];
  let body;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(body)));
  for (body of bodies) await assert.rejects(testModelConnection(input), /工具调用/);
});

test("guessing the blue background cannot pass the visual code challenge", async (t) => {
  t.mock.method(globalThis, "fetch", async () => reply("blue", "4"));
  await assert.rejects(
    testModelConnection(
      { ...input, supportsImages: true },
      {
        imageFixture: () => ({ imageUrl: "data:image/png;base64,fixture", code: "2" })
      }
    ),
    /测试图片/
  );
});

test("connection probe sends selected runtime parameters and rejects invalid limits before requesting", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return reply();
  });
  await testModelConnection({
    ...input,
    reasoningEffort: "low",
    supportsReasoningEffort: true,
    mainMaxTokens: 4096
  });
  assert.equal(requests[0].stream, true);
  assert.equal(requests[0].reasoning_effort, "low");
  assert.equal(requests[0].max_completion_tokens, 4096);
  await testModelConnection({
    ...input,
    reasoningEffort: "off",
    supportsReasoningEffort: false,
    mainMaxTokens: 8192
  });
  assert.equal(requests[1].reasoning_effort, undefined);
  assert.equal(requests[1].max_completion_tokens, 8192);
  await assert.rejects(testModelConnection({ ...input, mainMaxTokens: 0 }), /输出上限/);
  await assert.rejects(testModelConnection({ ...input, subagentMaxTokens: 65537 }), /输出上限/);
  assert.equal(requests.length, 2);
});

test("upstream service failures are distinguished from invalid connection settings", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(input.apiKey, { status: 503 }));
  for (const api of ["openai-completions", "openai-responses"])
    await assert.rejects(
      testModelConnection({ ...input, api }),
      (error) =>
        /服务暂时不可用.*HTTP 503/.test(error.message) &&
        !error.message.includes(input.apiKey) &&
        !error.message.includes("请检查消息格式")
    );
});

test("default vision probe shows one large readable digit and checks the actual pixels", async (t) => {
  let digit;
  let wrong = false;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    const content = body.messages.find((message) => message.role === "user").content;
    assert.match(content[0].text, /single large digit/);
    const png = Buffer.from(content[1].image_url.url.split(",")[1], "base64");
    assert.equal(png.readUInt32BE(16), 192);
    assert.equal(png.readUInt32BE(20), 192);
    const chunks = [];
    for (let offset = 8; offset < png.length;) {
      const size = png.readUInt32BE(offset);
      if (png.toString("ascii", offset + 4, offset + 8) === "IDAT")
        chunks.push(png.subarray(offset + 8, offset + 8 + size));
      offset += size + 12;
    }
    const pixels = inflateSync(Buffer.concat(chunks));
    const at = (x, y) => [...pixels.subarray(y * 577 + x * 3 + 1, y * 577 + x * 3 + 4)];
    assert.deepEqual(at(0, 0), [37, 99, 235]);
    assert.deepEqual(at(112, 48), [255, 255, 255]);
    digit = at(80, 48)[0] === 255 ? "2" : "4";
    return reply("blue", wrong ? (digit === "2" ? "4" : "2") : digit);
  });
  assert.equal((await testModelConnection({ ...input, supportsImages: true })).ok, true);
  wrong = true;
  await assert.rejects(testModelConnection({ ...input, supportsImages: true }), /测试图片/);
});
