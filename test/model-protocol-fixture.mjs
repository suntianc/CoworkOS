import { createServer } from "node:http";
import { once } from "node:events";

/** Strict local provider: wrong paths/formats fail instead of concealing fallback bugs. */
export async function modelProtocolFixture(api, handle) {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ data: [{ id: "protocol-fixture" }] }));
    }
    let raw = "";
    for await (const chunk of req.setEncoding("utf8")) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ path: req.url, body });
    const responses = api === "openai-responses";
    if (
      req.url !== (responses ? "/v1/responses" : "/v1/chat/completions") ||
      !Array.isArray(responses ? body.input : body.messages) ||
      body.stream !== true
    ) {
      res.writeHead(400);
      return res.end('{"error":{"message":"incorrect protocol"}}');
    }
    const tools = body.tools?.map((tool) => (responses ? tool.name : tool.function.name)) ?? [];
    const reply = tools.includes("atria_connection_check")
      ? { name: "atria_connection_check", arguments: { status: "connected", color: "none", code: "none" } }
      : ((await handle?.(body, requests)) ?? { text: "协议会话验证成功" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(protocolStream(api, reply));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  };
}

export function protocolStream(api, reply) {
  if (api === "openai-completions") {
    const chunk = (delta, finish_reason = null) =>
      `data: ${JSON.stringify({
        id: "protocol",
        object: "chat.completion.chunk",
        created: 1,
        model: "protocol-fixture",
        choices: [{ index: 0, delta, finish_reason }]
      })}\n\n`;
    const delta = reply.name
      ? {
          tool_calls: [
            {
              index: 0,
              id: "call_protocol",
              type: "function",
              function: { name: reply.name, arguments: JSON.stringify(reply.arguments) }
            }
          ]
        }
      : { content: reply.text };
    return (
      chunk({ role: "assistant" }) +
      chunk(delta) +
      chunk({}, reply.finishReason ?? (reply.name ? "tool_calls" : "stop")) +
      "data: [DONE]\n\n"
    );
  }
  const event = (type, rest) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;
  const item = reply.name
    ? {
        type: "function_call",
        id: "fc_protocol",
        call_id: "call_protocol",
        name: reply.name,
        arguments: JSON.stringify(reply.arguments),
        status: "completed"
      }
    : {
        type: "message",
        id: "msg_protocol",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: reply.text, annotations: [] }]
      };
  return (
    event("response.created", { response: { id: "resp_protocol", status: "in_progress", output: [] } }) +
    event("response.output_item.added", {
      output_index: 0,
      item: reply.name ? { ...item, arguments: "" } : { ...item, content: [] }
    }) +
    (reply.name
      ? event("response.function_call_arguments.delta", { output_index: 0, delta: item.arguments })
      : event("response.output_text.delta", { output_index: 0, content_index: 0, delta: reply.text })) +
    event("response.output_item.done", { output_index: 0, item }) +
    event(reply.finishReason === "length" ? "response.incomplete" : "response.completed", {
      response: {
        id: "resp_protocol",
        status: reply.finishReason === "length" ? "incomplete" : "completed",
        ...(reply.finishReason === "length" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
        output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 }
      }
    })
  );
}
