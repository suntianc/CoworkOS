import type { RuntimeTool } from "../runtime/tool.js";

export interface RemoteToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

export interface RemoteToolOptions {
  endpoint: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Adapt a JSON-schema tool registry exposed by an external environment into
 * Cowork RuntimeTools. The environment owns state and side effects; Cowork
 * only supplies the model loop, workspace and orchestration.
 */
export function createRemoteTools(
  definitions: RemoteToolDefinition[],
  options: RemoteToolOptions
): ReadonlyMap<string, RuntimeTool> {
  const tools = new Map<string, RuntimeTool>();
  for (const definition of definitions) {
    tools.set(definition.name, {
      description: definition.description,
      parameters: definition.parameters,
      execute: async (input) => callRemoteTool(options, definition.name, input)
    });
  }
  return tools;
}

export async function callRemoteTool(
  options: RemoteToolOptions,
  toolName: string,
  argumentsValue: unknown
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
  try {
    const response = await fetch(`${options.endpoint.replace(/\/$/, "")}/call`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      body: JSON.stringify({ toolName, arguments: argumentsValue }),
      signal: controller.signal
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
      // eslint-disable-next-line no-restricted-syntax -- 远端工具响应可能是纯文本，解析失败时按原文包装，下面的 content 分支会把原文交给模型
    } catch {
      payload = { content: text };
    }
    if (!response.ok)
      throw new Error(`remote tool ${toolName} failed (${response.status}): ${JSON.stringify(payload)}`);
    if (payload && typeof payload === "object" && "error" in payload)
      throw new Error(String((payload as { error?: unknown }).error));
    // The bridge envelope carries routing metadata for the transport, but the
    // model should receive the environment's original tool content. Keeping
    // this normalization here makes `/manifest` + `/call` reusable without
    // forcing every provider to learn a Cowork-specific wrapper shape.
    if (payload && typeof payload === "object" && "content" in payload) {
      const content = (payload as { content?: unknown }).content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const text = content
          .map((part) =>
            part && typeof part === "object" && "text" in part
              ? String((part as { text?: unknown }).text ?? "")
              : String(part ?? "")
          )
          .join("");
        return text || content;
      }
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}
