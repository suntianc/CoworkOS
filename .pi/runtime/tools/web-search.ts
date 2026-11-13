import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWebTools, type WebToolOptions } from "../../../dist/src/tools/web-tools.js";

/** Main and delegated sessions use the same provider; registration happens before the first model request. */
export function registerWebSearchTools(pi: ExtensionAPI, options: WebToolOptions | undefined) {
  if (!options) return;
  const tools = createWebTools(options);
  for (const name of ["search", "visit"] as const) {
    const tool = tools.get(name)!;
    pi.registerTool({
      name,
      label: name === "search" ? "Web Search" : "Read Web Source",
      description: tool.description!,
      parameters:
        name === "search"
          ? Type.Object({
              query: Type.String(),
              numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 }))
            })
          : Type.Object({ url: Type.String(), goal: Type.Optional(Type.String()) }),
      async execute(_id, params, signal) {
        const result = await tool.execute(params, signal);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      }
    });
  }
}
