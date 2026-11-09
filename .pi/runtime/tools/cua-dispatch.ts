import { validateToolArguments, type Static, type TSchema, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { errorMessage, type RuntimeToolResult } from "../helpers.ts";

const CUA_TOOLS = new Set([
  "computer_status",
  "computer_discover",
  "computer_select",
  "computer_release",
  "computer_observe",
  "computer_wait",
  "computer_act",
  "browser_open",
  "browser_observe",
  "browser_act",
  "browser_wait",
  "browser_close",
  "read_image"
]);
type CapturedTool = {
  name: string;
  description: string;
  parameters: TSchema;
  invoke: (
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext
  ) => Promise<RuntimeToolResult>;
};

const failed = (errorCode: string, error: string, acting = false): RuntimeToolResult => {
  const details = {
    errorCode,
    error,
    dispatchStatus: acting ? "unknown" : "not_sent",
    ...(acting ? { requiresObservation: true } : {})
  };
  return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: true };
};

/** Capture only CUA definitions, while registering the original tools with Pi normally. */
export function createCuaDispatcher(pi: ExtensionAPI) {
  const tools = new Map<string, CapturedTool>();
  // Pi 0.87 treats a normal execute return as success. Track the trusted
  // definition's result by call ID and adapt it through the supported hook.
  // Script RPC invokes the raw definition below, so internal IDs never leak here.
  const failures = new Set<string>();
  pi.on("tool_result", (event) => {
    if (failures.delete(event.toolCallId)) return { isError: true };
  });
  pi.on("session_shutdown", () => failures.clear());
  const capturePi = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return <TParams extends TSchema, TDetails, TState>(
          tool: ToolDefinition<TParams, TDetails, TState>
        ) => {
          if (CUA_TOOLS.has(tool.name))
            tools.set(tool.name, {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              invoke: (id, params, signal, ctx) =>
                tool.execute(id, params as Static<TParams>, signal, undefined, ctx)
            });
          target.registerTool({
            ...tool,
            async execute(id, params, signal, update, ctx) {
              const result = await tool.execute(id, params, signal, update, ctx);
              if ((result as RuntimeToolResult).isError === true) failures.add(id);
              return result;
            }
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  async function dispatch(
    name: string,
    params: unknown,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext
  ): Promise<RuntimeToolResult> {
    if (signal?.aborted) return failed("cancelled", "CUA 操作已取消");
    if (!CUA_TOOLS.has(name)) return failed("tool_not_allowed", `脚本不能调用 ${name}`);
    const tool = tools.get(name);
    if (!tool || !pi.getActiveTools().includes(name))
      return failed("tool_unavailable", `${name} 当前未启用；脚本不能启用工具或扩大授权`);
    // Scripts may emit archived pixels, but have no file-reading bridge.
    if (
      name === "read_image" &&
      (!params ||
        typeof params !== "object" ||
        Array.isArray(params) ||
        Object.keys(params).length !== 1 ||
        !("imageRef" in params) ||
        typeof params.imageRef !== "string" ||
        !/^img_[0-9a-f-]{36}$/.test(params.imageRef))
    )
      return failed("invalid_argument", "脚本只可通过 imageRef 读取 Task 历史图片");
    let validated: unknown;
    const id = `cua-rpc-${randomUUID()}`;
    try {
      validated = validateToolArguments(tool, {
        type: "toolCall",
        id,
        name,
        arguments: params as ToolCall["arguments"]
      });
      // eslint-disable-next-line no-restricted-syntax -- 校验失败已转成 invalid_argument 工具结果；脚本侧要的是 failed() 的错误码，重抛会绕过这一结构化失败
    } catch {
      return failed("invalid_argument", `${name} 参数不符合工具接口`);
    }
    if (signal?.aborted) return failed("cancelled", "CUA 操作已取消");
    try {
      // The original tool keeps Task path boundaries, browser ownership and human desktop policy.
      return await tool.invoke(id, validated, signal, ctx);
    } catch (error) {
      return failed("tool_failed", errorMessage(error), name === "computer_act" || name === "browser_act");
    }
  }
  return { capturePi, dispatch };
}
