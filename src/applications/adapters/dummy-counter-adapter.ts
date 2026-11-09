import {
  ApplicationError,
  bounded,
  type ApplicationDefinition,
  type ContextRequest,
  type ContextSummary,
  type ExportResult,
  type OperationResult,
  type WorkbenchRuntimeAdapter,
  type WorkspaceResource
} from "../types.js";

/**
 * A second Adapter with a deliberately unrelated data model.
 *
 * It exists to prove the architectural acceptance condition: a resource made of
 * keyed counters, with no text, no offsets and no notion of a line, must travel
 * through exactly the same store, API, event and context code as the editor. If
 * adding this Adapter ever requires touching the registry, the resource store,
 * the context builder or the SSE layer, the abstraction has leaked and the
 * platform has quietly become a text editor.
 *
 * It is registered only by tests and by `COWORK_APPLICATION_DUMMY=1`, never in
 * the product registry.
 */

interface CounterModel {
  counters: Record<string, number>;
}

function asModel(content: unknown): CounterModel {
  if (content && typeof content === "object" && "counters" in (content as Record<string, unknown>)) {
    const counters = (content as CounterModel).counters;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- content 来自资源文件 JSON，counters 可能是字符串或数字等非对象值
    if (counters && typeof counters === "object") return { counters: { ...counters } };
  }
  return { counters: {} };
}

function requireKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new ApplicationError("invalid_operation", "counter key 必须是非空字符串", {});
  return value.trim().slice(0, 64);
}

function requireAmount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ApplicationError("invalid_operation", "amount 必须是数字", {});
  return value;
}

const definition: ApplicationDefinition = {
  appType: "dummy-counter",
  displayName: "计数器（架构回归用）",
  version: "1",
  resourceKinds: ["model/counter+json"],
  fileExtensions: { "model/counter+json": ".counter.json" },
  capabilities: ["view", "edit", "select", "history", "export", "agent-commands"],
  operationSchemas: {
    "counter.set": { description: "把某个计数器设为 amount。", required: ["key", "amount"] },
    "counter.increment": { description: "把某个计数器增加 amount。", required: ["key", "amount"] }
  },
  exportFormats: ["json"],
  // A model with no text has to reach the Agent through the same MCP path as
  // the editor, or that path has quietly specialized.
  mcpServer: {
    command: process.execPath,
    args: ["dist/src/applications/mcp/dummy-counter-server.js"]
  }
};

/**
 * This application's own tools: one read, one write.
 *
 * The read is not optional. There is no generic `get_resource` any more, so an
 * application that declares no way to read its resource leaves a bound model
 * unable to see what it is working on. That this adapter — which has no text,
 * no offsets and no lines — can say "read my counters" in its own terms is the
 * same acceptance condition the rest of the file exists for.
 *
 * The write also keeps the visibility machinery honest: without a declared
 * tool this adapter could never prove that binding a different application
 * takes the previous one's tools away.
 */
function agentTools() {
  return [
    {
      name: "list_counters",
      access: "read" as const,
      description: "读取所有计数器和它们当前的值。",
      parameters: { type: "object", properties: {} },
      async execute({ content, resource }: { content: unknown; resource: WorkspaceResource }) {
        return { result: { revision: resource.revision, counters: asModel(content).counters } };
      }
    },
    {
      name: "counter_reset_all",
      description: "把所有计数器归零。",
      parameters: { type: "object", properties: {} },
      async execute({ content }: { content: unknown }) {
        const counters = asModel(content).counters;
        return {
          result: { cleared: Object.keys(counters).length },
          // `amount`, not `value`. This said `value` from the day it was written,
          // so every operation it emitted was refused with "amount 必须是数字" —
          // the tool had never once worked. Nothing caught it because the only
          // test asserted the tool appeared in the model's tool list, never that
          // what it emitted was accepted.
          operations: Object.keys(counters).map((key) => ({
            operationType: "counter.set",
            payload: { key, amount: 0 }
          }))
        };
      }
    }
  ];
}

export const dummyCounterAdapter: WorkbenchRuntimeAdapter = {
  definition,

  // A JSON model round-trips through its own file format; the counter file is
  // readable and editable on its own, like any other workspace file.
  serialize(content) {
    return `${JSON.stringify(asModel(content), null, 2)}\n`;
  },
  parse(raw) {
    try {
      return asModel(JSON.parse(raw));
    } catch {
      throw new ApplicationError("invalid_operation", "计数器文件不是合法 JSON", {});
    }
  },

  createContent(input) {
    if (input.initialContent === undefined || input.initialContent === null) return { counters: {} };
    return asModel(input.initialContent);
  },

  applyOperation({ operationType, payload, content }): OperationResult {
    const model = asModel(content);
    const value = (payload ?? {}) as Record<string, unknown>;
    const key = requireKey(value.key);
    const amount = requireAmount(value.amount);
    const previous = model.counters[key] ?? 0;
    if (operationType === "counter.set") {
      model.counters[key] = amount;
      return {
        content: model,
        summary: `把 ${key} 设为 ${amount}`,
        inverse: { operationType: "counter.set", payload: { key, amount: previous } }
      };
    }
    if (operationType === "counter.increment") {
      model.counters[key] = previous + amount;
      return {
        content: model,
        summary: `${key} 增加 ${amount}（现在是 ${model.counters[key]}）`,
        inverse: { operationType: "counter.increment", payload: { key, amount: -amount } }
      };
    }
    throw new ApplicationError("invalid_operation", `计数器不支持操作 ${operationType}`, { operationType });
  },

  summarizeSelection({ selection, content }): string {
    const model = asModel(content);
    const key = (selection.data as { key?: unknown } | undefined)?.key;
    if (typeof key !== "string") return "未选择计数器";
    return `选中计数器 ${key}（当前 ${model.counters[key] ?? 0}）`;
  },

  summarizeContext(input: ContextRequest): ContextSummary {
    const model = asModel(input.content);
    const keys = Object.keys(model.counters);
    // Names and values, no ordinals. "第 3 个计数器" would be this model's
    // version of a line number, and the same class of mistake: an address the
    // model could try to pass somewhere. The platform bounds this line, so no
    // `bounded` call here either.
    const shown = keys.slice(0, 10).map((key) => `${key}=${model.counters[key]}`);
    return {
      shape: keys.length ? `${keys.length} 个计数器：${shown.join(", ")}` : "还没有计数器",
      selectionSummary: input.selection?.summary
    };
  },

  exportResource({ resource, content, format }): ExportResult {
    if (format !== "json")
      throw new ApplicationError("invalid_operation", `计数器不支持导出格式 ${format}`, { format });
    return {
      fileName: `${resource.title.replace(/[\\/]/g, "-").slice(0, 80) || resource.resourceId}.json`,
      mimeType: "application/json",
      body: `${JSON.stringify(asModel(content), null, 2)}\n`
    };
  },

  agentTools
};
