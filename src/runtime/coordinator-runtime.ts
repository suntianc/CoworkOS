import { join } from "node:path";
import { id, now, type Event } from "../domain/types.js";
import { JsonlEventStore } from "../storage/event-store.js";
import { DurableScheduler, InboxStore } from "./scheduler.js";
import {
  sendPeerMessage as queuePeerMessage,
  type PeerMessageInput,
  type PeerMessageResult
} from "./subagent-peer-message.js";
import { agentDisplayName } from "./agent-identity.js";
import { clearSleep } from "./main-sleep.js";
import { subagentCallStatuses, type SubagentCallStatus } from "./subagent-call-status.js";

/**
 * Items this Run still has to hear about.
 *
 * A terminal row whose callback has not been queued yet is not settled for
 * Main: the outcome exists, but the record Main reads it from does not.
 */
function unsettled<T extends { status: string; callbackPending?: boolean }>(items: readonly T[]): T[] {
  return items.filter(
    (item) => !["completed", "failed", "cancelled"].includes(item.status) || item.callbackPending === true
  );
}

/**
 * Main's view of delegated work.
 *
 * Delegated execution belongs to the backend: it registers a work item in the
 * Run's durable queue, launches the process and settles it. This class only
 * reads those durable records for Main's status/wait tools and appends the
 * messages Main sends. It starts and observes no process of its own.
 */
export interface SubagentDiagnostics {
  tracePath: string;
  resultPath: string;
}

export interface SubagentMessageInput {
  taskId: string;
  runId: string;
  callId: string;
  message: string;
  workspaceRoot: string;
  priority?: number;
}

export interface SubagentMessageResult {
  messageId: string;
  callId: string;
  agentId: string;
  status: "queued";
}

export type { PeerMessageInput, PeerMessageResult } from "./subagent-peer-message.js";

export interface WaitForSubagentsInput {
  taskId: string;
  runId: string;
  workspaceRoot: string;
  callIds?: string[];
  timeoutMs?: number;
  /** Tools must return before Main can consume callbacks queued for its next turn. */
  waitForCallbackConsumption?: boolean;
  /** Claim callback bodies for a wait tool result; acknowledge only after that result is saved. */
  consumeCompletedCallbacks?: boolean;
  /** Include call briefs and result bodies by default; false selects a compact status query. */
  includeCallDetails?: boolean;
  /** Explicitly reread only these stored callback results when details are omitted. */
  resultCallIds?: string[];
  /** A live Main delivery may already have queued this callback in Pi. */
  isCallbackQueued?: (messageId: string) => boolean;
}

export interface WaitForSubagentsResult {
  taskId: string;
  runId: string;
  waitedMs: number;
  timedOut: boolean;
  pending: string[];
  callbackPending: string[];
  /** Machine receipts for the owning wait tool result, excluded from model-visible text. */
  claimedCallbacks?: Array<{ taskId: string; runId: string; messageId: string }>;
  calls: Array<{
    callId: string;
    agentId: string;
    name: string;
    status: string;
    callbackState?: SubagentCallStatus["callbackState"];
    resultAvailable?: boolean;
    resultDelivered?: boolean;
    task?: string;
    response?: string;
    outputFiles?: string[];
    diagnostics?: SubagentDiagnostics;
    error?: string;
  }>;
}

export class CoordinatorRuntime {
  /** Return durable call state, optionally restricted to a set of call ids. */
  async waitForSubagents(input: WaitForSubagentsInput): Promise<WaitForSubagentsResult> {
    if (input.includeCallDetails === false && input.consumeCompletedCallbacks) {
      throw new Error("Compact status queries cannot claim callbacks; use a full wait result for delivery.");
    }
    const started = Date.now();
    const timeoutMs = Math.max(0, input.timeoutMs ?? 30_000);
    const requested = input.callIds && input.callIds.length > 0 ? new Set(input.callIds) : undefined;
    const queuePath = join(input.workspaceRoot, input.taskId, "runs", input.runId, "queue.json");
    const inboxPath = join(
      input.workspaceRoot,
      input.taskId,
      "runs",
      input.runId,
      "agents",
      "main",
      "inbox-store.json"
    );
    const inbox = new InboxStore(inboxPath);
    let items: Awaited<ReturnType<DurableScheduler["list"]>> = [];
    let inboxMessages: Awaited<ReturnType<InboxStore["list"]>> = [];
    const waitingCallbacks = () =>
      inboxMessages.filter(
        (message) =>
          message.kind === "callback" &&
          (!requested || (message.callId && requested.has(message.callId))) &&
          (message.state === "ready" || message.state === "leased")
      );
    for (;;) {
      const scheduler = new DurableScheduler(queuePath);
      items = (await scheduler.list()).filter((item) => !requested || requested.has(item.stepId));
      inboxMessages = await inbox.list("main");
      const pending = unsettled(items);
      const callbackPending = waitingCallbacks();
      if (
        pending.length === 0 &&
        (input.waitForCallbackConsumption === false || callbackPending.length === 0)
      )
        break;
      if (Date.now() - started >= timeoutMs) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250, Math.max(25, timeoutMs - (Date.now() - started))))
      );
    }
    const claimedCallbacks = new Set<string>();
    if (input.consumeCompletedCallbacks) {
      const consumerId = `wait-${process.pid}-${id("callback")}`;
      try {
        for (const item of items) {
          if (!["completed", "failed", "cancelled"].includes(item.status)) continue;
          if (
            inboxMessages.some(
              (message) =>
                message.kind === "callback" &&
                message.callId === item.stepId &&
                input.isCallbackQueued?.(message.messageId)
            )
          )
            continue;
          const message = await inbox.claimReadyCallbackForWait(item.stepId, consumerId);
          if (!message) continue;
          claimedCallbacks.add(message.messageId);
        }
        // Wait is a delivery channel too. Clear the old wake condition now,
        // before Main can create a new one after receiving this evidence.
        // eslint-disable-next-line no-restricted-syntax -- 清除停车标记失败只会让旧唤醒条件多留一轮，本次 wait 仍必须返回已认领的回调证据，标记会在下次唤醒时重新评估
        if (claimedCallbacks.size) await clearSleep(input.workspaceRoot, input.taskId).catch(() => {});
        inboxMessages = await inbox.list("main");
      } catch (error) {
        // eslint-disable-next-line no-restricted-syntax -- 释放已认领回调失败不能顶替正在上抛的原始错误；未释放的租约会被 InboxStore 的过期回收路径重新置为 ready
        await inbox.releaseCurrentWaitCallbacks(consumerId).catch(() => {});
        throw error;
      }
    }
    const pending = unsettled(items);
    const callbackPending = waitingCallbacks().filter((message) => !claimedCallbacks.has(message.messageId));
    const responseByCall = new Map<
      string,
      {
        response?: string;
        outputFiles?: string[];
        diagnostics?: SubagentDiagnostics;
        error?: string;
      }
    >();
    const compact = input.includeCallDetails === false;
    const resultCallIds = new Set(input.resultCallIds ?? []);
    for (const message of inboxMessages) {
      if (!message.callId || !message.payload || typeof message.payload !== "object") continue;
      if (compact && (message.kind !== "callback" || !resultCallIds.has(message.callId))) continue;
      if (input.consumeCompletedCallbacks && !claimedCallbacks.has(message.messageId)) continue;
      const payload = message.payload as {
        response?: unknown;
        outputFiles?: unknown;
        diagnostics?: SubagentDiagnostics;
        error?: unknown;
      };
      responseByCall.set(message.callId, {
        response: typeof payload.response === "string" ? payload.response : undefined,
        outputFiles: Array.isArray(payload.outputFiles)
          ? payload.outputFiles.filter((path): path is string => typeof path === "string")
          : undefined,
        diagnostics: payload.diagnostics,
        error: typeof payload.error === "string" ? payload.error : undefined
      });
    }
    const callStatuses = compact ? await subagentCallStatuses(input, items, inboxMessages) : undefined;
    return {
      taskId: input.taskId,
      runId: input.runId,
      waitedMs: Date.now() - started,
      timedOut:
        pending.length > 0 || (input.waitForCallbackConsumption !== false && callbackPending.length > 0),
      pending: pending.map((item) => item.stepId),
      callbackPending: [...new Set(callbackPending.map((message) => message.callId ?? message.messageId))],
      ...(input.consumeCompletedCallbacks
        ? {
            claimedCallbacks: [...claimedCallbacks].map((messageId) => ({
              taskId: input.taskId,
              runId: input.runId,
              messageId
            }))
          }
        : {}),
      calls: items.map((item, index) =>
        callStatuses
          ? {
              ...callStatuses[index],
              ...(responseByCall.has(item.stepId)
                ? {
                    response: responseByCall.get(item.stepId)?.response,
                    outputFiles: responseByCall.get(item.stepId)?.outputFiles,
                    error: responseByCall.get(item.stepId)?.error
                  }
                : {})
            }
          : {
              callId: item.stepId,
              agentId: item.agentId,
              name: agentDisplayName(item.agentId),
              status: item.status,
              task:
                typeof (item.payload as { task?: unknown } | undefined)?.task === "string"
                  ? (item.payload as { task: string }).task
                  : undefined,
              ...responseByCall.get(item.stepId)
            }
      )
    };
  }

  /** Queue a durable Main -> Subagent message for delivery at a turn boundary. */
  async sendMessage(input: SubagentMessageInput): Promise<SubagentMessageResult> {
    const scheduler = new DurableScheduler(
      join(input.workspaceRoot, input.taskId, "runs", input.runId, "queue.json")
    );
    const item = (await scheduler.list()).find((candidate) => candidate.stepId === input.callId);
    if (!item) throw new Error(`unknown subagent call: ${input.callId}`);
    if (["completed", "failed", "cancelled"].includes(item.status))
      throw new Error(`subagent call ${input.callId} is already ${item.status}`);
    const message = input.message.trim();
    if (!message) throw new Error("message must not be empty");
    const messageId = id("subagent-message");
    const inbox = new InboxStore(
      join(
        input.workspaceRoot,
        input.taskId,
        "runs",
        input.runId,
        "agents",
        "subagents",
        item.agentId,
        "inbox-store.json"
      )
    );
    await inbox.enqueue({
      messageId,
      recipientAgentId: item.agentId,
      kind: "human_command",
      eventId: id("event"),
      callId: input.callId,
      priority: input.priority ?? 1,
      state: "ready",
      payload: { message, from: "main", priority: input.priority ?? 1 },
      createdAt: now()
    });
    const events = new JsonlEventStore(
      join(input.workspaceRoot, input.taskId, "runs", input.runId, "run_events.jsonl")
    );
    await events.append(
      event({ taskId: input.taskId, runId: input.runId }, input.callId, "message.queued", "main", {
        messageId,
        agentId: item.agentId,
        priority: input.priority ?? 1
      })
    );
    return { messageId, callId: input.callId, agentId: item.agentId, status: "queued" };
  }

  /** Queue a durable, non-blocking message from one running Subagent to another. */
  async sendPeerMessage(input: PeerMessageInput): Promise<PeerMessageResult> {
    return queuePeerMessage(input);
  }
}

function event(
  input: { taskId: string; runId: string },
  callId: string,
  type: string,
  agentId: string,
  payload: unknown
): Event {
  return {
    eventId: id("event"),
    type,
    taskId: input.taskId,
    runId: input.runId,
    agentId,
    callId,
    occurredAt: now(),
    payload
  };
}
