// Test-only adapter fixture for resource, recovery and MCP contracts. Not shipped.
import { localApiHeaders } from "../../../src/applications/mcp/local-api-client.js";
/**
 * The text editor's MCP server — the reference implementation.
 *
 * It exists to prove an application can ship tools as a separate program, not
 * to add text features. `replace_section` knows that a section ends at the
 * next heading of equal or higher rank — exactly the kind of thing a real CAD
 * or spreadsheet server would know about its own model and the platform never
 * can. That it runs out of process, in whatever language its author likes, is
 * the point being demonstrated.
 *
 * Reading and outlining are *not* here. They live in the Adapter, in process,
 * because a window whose server fails to start is a state the supervisor
 * reports as normal — and a model that cannot read the document it is bound to
 * has nothing to fall back on. What is here is what only a domain program can
 * do, and the outline it relies on is imported from the Adapter's own module
 * so there is one definition of "heading", not two that drift.
 *
 * It reads the document through the Dashboard's HTTP API rather than touching
 * the file, and returns operations instead of writing. Every change therefore
 * still goes through revision CAS, so a tool call cannot silently overwrite
 * what someone is typing in the editor.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { findSection, outline } from "./text-outline.js";

const base = process.env.ATRIA_DASHBOARD_URL ?? "http://127.0.0.1:3880";

/** Read the bound document. The metadata names it; parameters never do. */
async function readResource(meta: {
  taskId: string;
  resourceId: string;
}): Promise<{ content: string; revision: number }> {
  const url = `${base}/api/tasks/${encodeURIComponent(meta.taskId)}/resources/${encodeURIComponent(meta.resourceId)}`;
  const response = await fetch(url, { headers: localApiHeaders() });
  if (!response.ok) throw new Error(`读取资源失败：HTTP ${response.status}`);
  const payload = (await response.json()) as { snapshot?: { content?: unknown; revision?: number } };
  const content = payload.snapshot?.content;
  if (typeof content !== "string") throw new Error("这个资源不是文本，无法处理");
  return { content, revision: payload.snapshot?.revision ?? 0 };
}

/**
 * Which document this call is about.
 *
 * It arrives as request metadata, so a model that invents a resource id cannot
 * aim the server at someone else's document, and a tool's own parameters stay
 * about its domain.
 */
function boundResource(extra: unknown): { taskId: string; resourceId: string; revision: number } {
  const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta ?? {};
  const resource = meta["atria/resource"] as { resourceId?: string; revision?: number } | undefined;
  const task = meta["atria/task"] as { taskId?: string } | undefined;
  if (!resource?.resourceId || !task?.taskId)
    throw new Error("缺少绑定资源信息，这个工具只能在绑定应用时调用");
  return { taskId: task.taskId, resourceId: resource.resourceId, revision: resource.revision ?? 0 };
}

const server = new McpServer({ name: "atria-text-editor", version: "1" });

// Read tools are registered by the in-process Adapter so reads remain available
// when MCP is unavailable. Duplicate names would be shadowed by that adapter.

server.registerTool(
  "replace_section",
  {
    description:
      "按标题名替换一整节的内容（含其下的子标题）。比自己算 offset 安全：不会算错边界，也不会把相邻章节一起改掉。",
    inputSchema: {
      heading: z.string().describe("要替换的节的标题文字，不含 # 号"),
      body: z.string().describe("这一节的新内容，不含标题行本身"),
      keepHeading: z.boolean().optional().describe("默认 true，保留原标题行")
    }
  },
  async ({ heading, body, keepHeading = true }, extra) => {
    const bound = boundResource(extra);
    const { content, revision } = await readResource(bound);
    const sections = outline(content);
    const target = findSection(sections, heading);
    if (!target) {
      const known = sections.map((section) => section.title).join("、") || "（无）";
      return {
        content: [{ type: "text", text: `找不到标题「${heading}」。文档现有的标题：${known}` }],
        isError: true
      };
    }
    const headingLine = content.slice(
      target.start,
      target.start + content.slice(target.start).indexOf("\n") + 1 || target.end
    );
    const from = keepHeading ? target.start + headingLine.length : target.start;
    const replacement = keepHeading
      ? ensureTrailingNewline(body)
      : `${"#".repeat(target.level)} ${target.title}\n${ensureTrailingNewline(body)}`;
    return {
      content: [{ type: "text", text: `将「${target.title}」一节替换为 ${body.length} 字的新内容` }],
      structuredContent: {
        atria: {
          // Returned, not written: the platform applies this with baseRevision,
          // so a conflicting edit in the open editor wins a 409 instead of
          // being silently overwritten.
          revision,
          section: target.title,
          operations: [
            { operationType: "text.replace", payload: { from, to: target.end, text: replacement } }
          ]
        }
      }
    };
  }
);

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

await server.connect(new StdioServerTransport());
