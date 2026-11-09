#!/usr/bin/env node
import { localApiHeaders } from "./local-api-client.js";
/**
 * The dummy counter application's MCP server.
 *
 * Its only purpose is architectural: a data model with no text, no offsets and
 * no notion of a line has to reach the Agent through exactly the same MCP
 * path as the editor. If supporting this ever needs a change in the supervisor
 * or the routes, the protocol layer has quietly specialized and a real CAD
 * server would hit the same wall.
 *
 * Registered only by tests, never in the product registry.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const base = process.env.ATRIA_DASHBOARD_URL ?? "http://127.0.0.1:3880";

function boundResource(extra: unknown): { taskId: string; resourceId: string } {
  const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta ?? {};
  const resource = meta["atria/resource"] as { resourceId?: string } | undefined;
  const task = meta["atria/task"] as { taskId?: string } | undefined;
  if (!resource?.resourceId || !task?.taskId) throw new Error("缺少绑定资源信息");
  return { taskId: task.taskId, resourceId: resource.resourceId };
}

async function readCounters(bound: { taskId: string; resourceId: string }): Promise<Record<string, number>> {
  const response = await fetch(
    `${base}/api/tasks/${encodeURIComponent(bound.taskId)}/resources/${encodeURIComponent(bound.resourceId)}`,
    { headers: localApiHeaders() }
  );
  if (!response.ok) throw new Error(`读取资源失败：HTTP ${response.status}`);
  const payload = (await response.json()) as {
    snapshot?: { content?: { counters?: Record<string, number> } };
  };
  return payload.snapshot?.content?.counters ?? {};
}

const server = new McpServer({ name: "atria-dummy-counter", version: "1" });

server.registerTool(
  "largest_counter",
  {
    description: "找出当前值最大的计数器。",
    inputSchema: {}
  },
  async (_args, extra) => {
    const counters = await readCounters(boundResource(extra));
    const entries = Object.entries(counters).sort((left, right) => right[1] - left[1]);
    const top = entries[0];
    return {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- counters 来自资源的 HTTP 响应，可能一个计数器都没有
      content: [{ type: "text", text: top ? `${top[0]} = ${top[1]}` : "没有计数器" }],
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- counters 来自资源的 HTTP 响应，可能一个计数器都没有
      structuredContent: { atria: { key: top?.[0], value: top?.[1] } }
    };
  }
);

server.registerTool(
  "bump_largest",
  {
    description: "给当前值最大的计数器加一个增量。",
    inputSchema: { amount: z.number().describe("增量") }
  },
  async ({ amount }, extra) => {
    const counters = await readCounters(boundResource(extra));
    const top = Object.entries(counters).sort((left, right) => right[1] - left[1])[0];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- counters 来自资源的 HTTP 响应，可能一个计数器都没有
    if (!top) return { content: [{ type: "text", text: "没有计数器可以递增" }], isError: true };
    return {
      content: [{ type: "text", text: `${top[0]} += ${amount}` }],
      // Returned rather than written, exactly as the editor's server does: the
      // platform applies it with baseRevision.
      structuredContent: {
        atria: { operations: [{ operationType: "counter.increment", payload: { key: top[0], amount } }] }
      }
    };
  }
);

await server.connect(new StdioServerTransport());
