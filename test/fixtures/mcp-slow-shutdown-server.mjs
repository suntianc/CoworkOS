#!/usr/bin/env node
/**
 * Test-only MCP server that is slow to shut down.
 *
 * It answers the protocol like a real application server but ignores stdin EOF
 * and SIGTERM, so shutdown has to wait for the supervisor's SIGKILL bound
 * instead of assuming a closed pipe ends the process. Its only purpose is to
 * exercise a teardown slower than the old fixed exit timer.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// A slow-starting application server: the handshake stays outstanding long
// enough that shutdown has to wait for an in-flight startup. With the hang
// flag it never completes, which is how the forced-stop path is exercised.
if (process.env.COWORK_FIXTURE_MCP_HANG === "1") {
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}
await new Promise((done) => setTimeout(done, 6_000));

process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
process.stdin.on("end", () => {});
process.stdin.on("close", () => {});
// A parent that vanished mid-handshake leaves broken pipes behind; the
// fixture must survive that instead of exiting on its own.
process.stdin.on("error", () => {});
process.stdout.on("error", () => {});
process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});

const server = new McpServer({ name: "atria-slow-shutdown", version: "1" });
server.registerTool(
  "slow_shutdown_ping",
  { description: "确认慢关闭夹具已启动", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: "pong" }] })
);
// Stay alive even if the parent disappeared during the delayed handshake: an
// orphan has to be observable, not something that quietly exits on its own.
setInterval(() => {}, 1_000);
try {
  await server.connect(new StdioServerTransport());
} catch {
  /* the parent may already be gone; the interval below keeps this process */
}
await new Promise(() => {});
