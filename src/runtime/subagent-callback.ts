import { join } from "node:path";
import { id, now } from "../domain/types.js";
import { JsonlEventStore } from "../storage/event-store.js";
import { InboxStore } from "./scheduler.js";
import { agentDisplayName } from "./agent-identity.js";

/** Machine-readable locations for a delegated result, relative to the Task directory. */
export interface SubagentDiagnostics {
  tracePath: string;
  resultPath: string;
}

/** The one response shape Main receives for a finished or failed call. */
export function formatSubagentSummary(input: {
  status: "succeeded" | "failed" | "timed_out" | "cancelled" | "partial";
  rawResponse: string;
  outputFiles: string[];
  diagnostics: SubagentDiagnostics;
  error?: string;
}): string {
  const body =
    input.rawResponse ||
    input.error ||
    "Subagent did not return a textual summary; inspect its diagnostic records and any candidate outputs.";
  const metadata = [`[Coordinator] status=${input.status}`];
  if (input.outputFiles.length > 0) {
    metadata.push(
      `Candidate outputs (Task-relative paths for browse_workspace; review before copying accepted final files into Task artifacts/):\n${input.outputFiles.map((path) => `- ${path}`).join("\n")}`
    );
  }
  metadata.push(
    `Diagnostics (Task-relative): trace=${input.diagnostics.tracePath}; result=${input.diagnostics.resultPath}`
  );
  if (input.error) metadata.push(`error=${input.error}`);
  return `${body}\n\n${metadata.join("\n")}`;
}

/**
 * Queue the callback Main reads when a delegated call reaches a terminal state.
 *
 * The delegated process writes this record into Main's Inbox. Keeping the id
 * deterministic makes retries, adoption after a restart and a late duplicate
 * process settle idempotent.
 */
export async function enqueueMainCallback(input: {
  workspaceRoot: string;
  taskId: string;
  runId: string;
  callId: string;
  agentId: string;
  status: "succeeded" | "failed" | "timed_out" | "cancelled";
  response: string;
  outputFiles: string[];
  diagnostics: SubagentDiagnostics;
  error?: string;
  callbackMetadata?: Record<string, unknown>;
}): Promise<{ messageId: string; queued: boolean }> {
  const runRoot = join(input.workspaceRoot, input.taskId, "runs", input.runId);
  const inbox = new InboxStore(join(runRoot, "agents", "main", "inbox-store.json"));
  const messageId = `callback-${input.callId}-${input.status}`;
  const alreadyQueued = (await inbox.list("main")).some((message) => message.messageId === messageId);
  await inbox.enqueue({
    messageId,
    recipientAgentId: "main",
    kind: "callback",
    callId: input.callId,
    eventId: id("event"),
    priority: 1,
    state: "ready",
    payload: {
      ...input.callbackMetadata,
      callId: input.callId,
      agentId: input.agentId,
      name: agentDisplayName(input.agentId),
      status: input.status,
      response: input.response,
      artifacts: [],
      outputFiles: input.outputFiles,
      diagnostics: input.diagnostics,
      error: input.error
    },
    createdAt: now()
  });
  if (!alreadyQueued) {
    await new JsonlEventStore(join(runRoot, "run_events.jsonl")).append({
      eventId: id("event"),
      type: "callback.queued",
      taskId: input.taskId,
      runId: input.runId,
      agentId: "coordinator",
      callId: input.callId,
      occurredAt: now(),
      payload: { messageId, recipientAgentId: "main", status: input.status }
    });
  }
  return { messageId, queued: !alreadyQueued };
}
