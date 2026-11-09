import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { InboxMessage } from "../domain/types.js";
import type { WorkItem } from "./scheduler.js";
import { agentDisplayName } from "./agent-identity.js";

export interface SubagentCallStatus {
  callId: string;
  agentId: string;
  name: string;
  status: string;
  callbackState: InboxMessage["state"] | "none";
  /** A persisted callback or diagnostic exists, possibly from an earlier attempt. */
  resultAvailable: boolean;
  /** Absent when callback delivery cannot establish receipt (e.g. a sync call). */
  resultDelivered?: boolean;
  diagnostics: { tracePath: string; resultPath: string };
}

/** Read-only metadata from the same snapshot used by the coordination query. */
export async function subagentCallStatuses(
  input: { workspaceRoot: string; taskId: string; runId: string },
  items: readonly Pick<WorkItem, "stepId" | "agentId" | "status">[],
  inboxMessages: readonly InboxMessage[]
): Promise<SubagentCallStatus[]> {
  const callbacks = new Map<string, InboxMessage>();
  for (const message of inboxMessages) {
    if (message.kind === "callback" && message.callId) callbacks.set(message.callId, message);
  }
  return Promise.all(
    items.map(async (item) => {
      const callback = callbacks.get(item.stepId);
      const diagnostics = {
        tracePath: `sessions/${item.agentId}/${input.runId}.jsonl`,
        resultPath: `runs/${input.runId}/agents/subagents/${item.agentId}/result.json`
      };
      // A synchronous call has no callback. Inspect only its canonical result
      // path; never read or serialize the transcript just to answer status.
      const resultAvailable =
        Boolean(callback) ||
        (await stat(join(input.workspaceRoot, input.taskId, diagnostics.resultPath))
          .then((result) => result.isFile())
          // eslint-disable-next-line no-restricted-syntax -- 结果文件可能还没写出（同步调用或尚未落盘），stat 失败即表示结果不可用
          .catch(() => false));
      return {
        callId: item.stepId,
        agentId: item.agentId,
        name: agentDisplayName(item.agentId),
        status: item.status,
        callbackState: callback?.state ?? "none",
        resultAvailable,
        ...(callback ? { resultDelivered: callback.state === "consumed" } : {}),
        diagnostics
      };
    })
  );
}
