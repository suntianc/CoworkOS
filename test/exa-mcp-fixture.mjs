import { createServer } from "node:http";
import { once } from "node:events";

/** Public synthetic source through the actual MCP protocol, for Web/native conversation acceptance. */
export async function exaMcpFixture() {
  const calls = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req.setEncoding("utf8")) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.method === "GET") {
      res.writeHead(405);
      return res.end();
    }
    if (req.method === "DELETE" || body.method?.startsWith("notifications/")) {
      res.writeHead(202);
      return res.end();
    }
    let result;
    if (body.method === "initialize")
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "source-fixture", version: "1" }
      };
    else if (body.method === "tools/list") result = { tools: [] };
    else {
      calls.push(body.params);
      result = {
        content: [
          {
            type: "text",
            text:
              body.params.name === "web_search_exa"
                ? "Title: Public paper\nURL: https://example.org/paper\nPublished: 2026-10-01\nHighlights:\nSearch evidence."
                : "# Public paper\nURL: https://example.org/paper\n\nFetched source evidence."
          }
        ]
      };
    }
    res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "source-fixture" });
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/mcp`,
    calls,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  };
}
export function sourceConversationFixture() {
  let step = 0;
  return (body) => {
    const names = body.tools.map((tool) => tool.function.name);
    if (!names.includes("search") || !names.includes("visit")) return { text: "Search tools unavailable" };
    if (step++ === 0) return { name: "search", arguments: { query: "public source paper" } };
    if (step === 2) return { name: "visit", arguments: { url: "https://example.org/paper" } };
    const content = body.messages.findLast((message) => message.role === "tool")?.content || "";
    return {
      text: content.includes("Fetched source evidence")
        ? "来源读取成功：[Public paper](https://example.org/paper)。"
        : "Source read failed"
    };
  };
}
