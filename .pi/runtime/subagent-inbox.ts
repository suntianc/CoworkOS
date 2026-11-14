import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { AgentInboxDelivery, formatAgentInboxMessage } from "../../dist/src/runtime/agent-inbox-delivery.js";
import { watchFiles, type StopWatching } from "../../dist/src/runtime/file-watch.js";

export interface SubagentInboxOptions {
  workspaceRoot: string;
  taskId: string;
  runId: string;
  agentId: string;
}

/**
 * The read half of a delegated process's durable Inbox.
 *
 * A message from Main or a peer is durable in this process's own Inbox before
 * it is injected, so it survives a backend restart and reaches the process it
 * was addressed to. Pi's steering queue decides the safe boundary: the message
 * is queued while a model request is in flight and read with the next turn's
 * context, never in the middle of one. While no model request is running (for
 * example inside a blocking ask_main) a file watch is what notices a new
 * message, so nothing polls.
 *
 * The file watch is a wake-up, not the delivery guarantee: a directory event
 * can arrive after this one-shot process has settled, and the OS may coalesce
 * several writes into one event. Every turn boundary therefore re-reads the
 * whole Inbox, which is the last point the agent loop looks for queued input
 * before it decides to continue.
 *
 * Consumption is recorded only after the message appears in this session's
 * context, so a process that dies before its next request redelivers it. A
 * message that arrives before the first turn is appended as context; after this
 * one-shot process has settled, a late message is left for that agent's next
 * process rather than starting an unprompted run in a host that is exiting.
 */
export function registerSubagentInbox(pi: ExtensionAPI, options: SubagentInboxOptions): void {
  const runRoot = join(options.workspaceRoot, options.taskId, "runs", options.runId);
  const directory = join(runRoot, "agents", "subagents", options.agentId);
  const inbox = new AgentInboxDelivery({
    directory,
    taskId: options.taskId,
    runId: options.runId,
    recipientAgentId: options.agentId,
    eventsPath: join(runRoot, "run_events.jsonl")
  });
  // Before the first turn a message is context, not a reason to start a run;
  // Pi's --print host owns the initial prompt.
  let turnStarted = false;
  let stopWatching: StopWatching | undefined;

  const reportDeliveryError = (error: unknown) => {
    process.stderr.write(
      `[cowork] subagent inbox delivery failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
  };

  const deliver = async (): Promise<void> => {
    await inbox.deliver(async (message) => {
      const text = formatAgentInboxMessage(message);
      if (!text) return "discard";
      const payload =
        message.payload && typeof message.payload === "object"
          ? (message.payload as Record<string, unknown>)
          : {};
      await pi.sendMessage(
        {
          customType: "cowork-agent-message",
          content: text,
          display: true,
          details: {
            ...payload,
            _coworkInbox: {
              taskId: options.taskId,
              runId: options.runId,
              messageId: message.messageId
            }
          }
        },
        { triggerTurn: turnStarted, deliverAs: "steer" }
      );
      return "delivered";
    });
  };

  pi.on("session_start", async () => {
    stopWatching?.();
    stopWatching = await watchFiles([join(directory, "inbox-store.json")], () => {
      // A message written before the first turn is appended as context; while
      // the agent runs, Pi steers it into the next turn.
      void deliver().catch(reportDeliveryError);
    }).catch((error: unknown) => {
      reportDeliveryError(error);
      return undefined;
    });
    await deliver().catch(reportDeliveryError);
  });

  pi.on("agent_start", () => {
    turnStarted = true;
    void deliver().catch(reportDeliveryError);
  });

  pi.on("turn_end", async () => {
    // Read the Inbox at every turn boundary, not only on a directory event.
    // The loop pulls Pi's steering queue right after this hook, so a message
    // read here joins the next turn; a write the OS reports late, coalesces
    // with another entry, or never reports before this one-shot process ends
    // would otherwise be missed even though it is durable. The watch stays as
    // the wake for a process that is not between turns (a blocking ask_main).
    await deliver().catch(reportDeliveryError);
  });

  pi.on("agent_end", () => {
    turnStarted = false;
  });

  pi.on("context", async (event) => {
    await inbox.acknowledge(event.messages).catch(reportDeliveryError);
  });

  pi.on("session_shutdown", async () => {
    stopWatching?.();
    stopWatching = undefined;
    // A message handed to Pi but never read before the process ends becomes
    // readable for this agent's next process now, not after the lease expires.
    await inbox.releaseUnconfirmed().catch(reportDeliveryError);
  });
}
