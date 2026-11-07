import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProjectLedgerTool } from "../../../dist/src/runtime/project-ledger-tool.js";
import type { CoworkToolContext } from "../extension.ts";
import type { RuntimeToolResult } from "../helpers.ts";

/** The ledger tool acts on this conversation's project only; no project id is an argument. */
export function registerProjectLedgerTool(pi: ExtensionAPI, context: CoworkToolContext) {
  const dashboardUrl = process.env.COWORK_DASHBOARD_URL;
  if (!dashboardUrl) return;
  const tool = createProjectLedgerTool({ dashboardUrl, taskId: context.taskId });
  pi.registerTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: Type.Unsafe(tool.parameters as Parameters<typeof Type.Unsafe>[0]),
    async execute(_callId, params): Promise<RuntimeToolResult> {
      const result = await tool.execute(params as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    }
  });
}
