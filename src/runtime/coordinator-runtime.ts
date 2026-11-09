import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { atriaRoleIdentity } from "../domain/agent-identity.js";
import { dirname, join } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import { id, now, transitionCall, type Call, type CallMode, type Event } from "../domain/types.js";
import { JsonlEventStore } from "../storage/event-store.js";
import { TraceRecorder } from "../storage/trace-recorder.js";
import { PiSession, type PiSessionOptions, type PiSessionResult } from "./pi-session.js";
import { createBuiltinTools } from "../tools/builtin.js";
import { projectWritesEnabled } from "../tools/protected-paths.js";
import { resolveCapabilities } from "./task-capabilities.js";
import { CheckpointStore, DurableScheduler, InboxStore } from "./scheduler.js";
import { LocalWorkspaceStore, type Artifact } from "../workspace/workspace-store.js";
import { emptyCompaction, readAgentCheckpoint } from "./agent-checkpoint.js";
import type { RuntimeTool } from "./tool.js";
import { addCapabilityTools, type CapabilityGrant, type CapabilityProvider } from "./capability-provider.js";
import type { WebToolOptions } from "../tools/web-tools.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createLoadSkillTool, discoverSkills, skillCatalogPrompt } from "./skill-registry.js";
import { listAgentOutputFiles } from "./progress.js";
import { agentDisplayName } from "./agent-identity.js";
import { clearSleep } from "./main-sleep.js";
import {
  configuredModelApi,
  configuredThinkingFormat,
  type CoworkModelApi,
  type CoworkThinkingFormat,
  configuredReasoningEffort,
  configuredSupportsReasoningEffort,
  configuredSupportsPromptCacheKey,
  configuredSupportsImages,
  configuredSubagentMaxQuestions,
  configuredSubagentQuestionTimeout,
  normalizeReasoningEffort,
  type PiThinkingLevel
} from "./runtime-settings.js";
import { ExperimentProgramStore } from "./experiment-program-store.js";
import { SubagentQuestionStore } from "./subagent-questions.js";
import { readRunMetrics } from "./experiment-metrics.js";
import type { ExperimentRunStatus } from "../domain/experiment.js";
import type { VisionModelConfig } from "../tools/vision-model.js";
import { subagentRecoverySummary } from "./subagent-recovery-summary.js";
import { subagentCallStatuses, type SubagentCallStatus } from "./subagent-call-status.js";
import { delegationRoleGuidance, resolveWorkItemModel, type WorkItemModel } from "./delegation-model.js";
import type { DelegatedModelRequest } from "./role-models.js";
import { prepareWorkItemSite, type WorkItemSite } from "../workspace/work-item-workspace.js";

type DelegatedModelSettings = Pick<
  PiSessionOptions,
  | "maxTurns"
  | "maxTokens"
  | "maxErrorRetries"
  | "timeoutMs"
  | "contextWindow"
  | "maxLengthContinuations"
  | "sampling"
  | "compaction"
  | "maxToolResponseChars"
>;

export interface SubagentDispatchInput extends DelegatedModelSettings {
  visionModel?: VisionModelConfig;
  thinkingLevel?: PiThinkingLevel;
  api?: CoworkModelApi;
  thinkingFormat?: CoworkThinkingFormat;
  supportsReasoningEffort?: boolean;
  supportsPromptCacheKey?: boolean;
  supportsImages?: boolean;
  /** Notify the caller only after the work item is durably visible to wait/status tools. */
  onQueued?: () => void;
  taskId: string;
  runId: string;
  /** False keeps a background analysis Run separate from Main's Task lifecycle. Defaults to true. */
  activateRun?: boolean;
  /** A narrow runtime role, such as event classification, can replace coding guidance. */
  systemPrompt?: string;
  /** A restricted runtime role can prohibit every model-visible tool, including communication. */
  disableTools?: boolean;
  callId?: string;
  agentId: string;
  task: string;
  mode: CallMode;
  workspaceRoot: string;
  projectDirectory?: string;
  baseUrl: string;
  apiKey: string;
  model?: string;
  context?: unknown[];
  maxAttempts?: number;
  leaseMs?: number;
  signal?: AbortSignal;
  /** Runtime-only command environment; never persisted with the work item. */
  commandEnv?: NodeJS.ProcessEnv;
  /** Optional in-process tool factory for benchmark/external environments. */
  toolFactory?: (workingDirectory: string, workspaceDirectory: string) => ReadonlyMap<string, RuntimeTool>;
  capabilityProvider?: CapabilityProvider;
  capabilityGrants?: CapabilityGrant[];
  /** Optional public web tools for the fallback built-in tool factory. */
  web?: WebToolOptions;
  /** Project skill roots. Only skill metadata is put in the prompt; content is loaded on demand. */
  skillRoots?: string[];
  /** Application skill scope captured when Main dispatches this call. */
  skillApplications?: string[];
  /** Resume a running/failed Subagent checkpoint when explicitly requested. */
  resume?: boolean;
  /**
   * Explicitly continue an earlier call's session and checkout as a new work
   * item. The earlier call stays terminal: this appends one turn to the same
   * transcript instead of re-running work it already finished.
   */
  continuation?: { fromCallId: string; reviewId?: string };
  /** Extra durable fields for Main's callback (for example experiment ids). */
  callbackMetadata?: Record<string, unknown>;
  /** Ledger row this dispatch belongs to. Runtime settles it at the terminal state; it never opens one. */
  experimentRef?: ExperimentRef;
  /** How long ask_main blocks. Zero withholds the tool. Defaults to the configured value. */
  questionTimeoutMs?: number;
  /** Questions this call may raise. Defaults to the configured value. */
  maxQuestions?: number;
  /**
   * Role this work item runs as. Its connection and model are resolved on this
   * host when the item starts, so a changed binding applies to later starts.
   * Omitted keeps the caller's connection: ordinary delegations are unchanged.
   */
  delegation?: DelegatedModelRequest;
  /** Work items in this Run that must finish before this one starts. */
  dependsOn?: string[];
  /**
   * The item's own checkout, forked from the requirement's integration site at
   * its actual start. Two parallel items never share a working tree.
   */
  workItemSite?: WorkItemSite;
  /** The requirement development this item works for, kept for attribution. */
  developmentId?: string;
}

/** Identifies the ledger row a delegated call was opened against. */
export interface ExperimentRef {
  experimentId: string;
  experimentRunId: string;
}

export interface SubagentDispatchResult {
  callId: string;
  taskId: string;
  runId: string;
  agentId: string;
  name?: string;
  status: "succeeded" | "failed" | "timed_out" | "cancelled";
  response: string;
  workingDirectory: string;
  /** Formal Task artifacts published by this dispatch; candidates are kept separate. */
  artifacts: Artifact[];
  /** Candidate outputs in the agent workspace, relative to the Task directory. */
  outputFiles?: string[];
  /** Runtime records, relative to the Task directory. */
  diagnostics?: { tracePath: string; resultPath: string };
  error?: string;
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

export interface PeerMessageInput {
  taskId: string;
  runId: string;
  workspaceRoot: string;
  senderCallId: string;
  targetCallId: string;
  message: string;
  priority?: number;
}

export interface PeerMessageResult {
  messageId: string;
  senderCallId: string;
  targetCallId: string;
  senderAgentId: string;
  targetAgentId: string;
  status: "queued";
}

export interface SubagentCancelInput {
  taskId: string;
  runId: string;
  callId: string;
  workspaceRoot: string;
  reason?: string;
}

export interface SubagentCancelResult {
  callId: string;
  agentId: string;
  status: "cancelled" | "already_terminal";
  previousStatus: string;
}

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
    diagnostics?: SubagentDispatchResult["diagnostics"];
    error?: string;
  }>;
}

export interface CoordinatorRecoveryInput extends DelegatedModelSettings {
  visionModel?: VisionModelConfig;
  thinkingLevel?: PiThinkingLevel;
  api?: CoworkModelApi;
  thinkingFormat?: CoworkThinkingFormat;
  supportsReasoningEffort?: boolean;
  supportsPromptCacheKey?: boolean;
  supportsImages?: boolean;
  taskId: string;
  runId: string;
  workspaceRoot: string;
  baseUrl: string;
  apiKey: string;
  model?: string;
  maxAttempts?: number;
  leaseMs?: number;
  toolFactory?: (workingDirectory: string, workspaceDirectory: string) => ReadonlyMap<string, RuntimeTool>;
  capabilityProvider?: CapabilityProvider;
  web?: WebToolOptions;
  skillRoots?: string[];
  skillApplications?: string[];
  questionTimeoutMs?: number;
  maxQuestions?: number;
  /** Runtime-only command environment supplied by the recovering host. */
  commandEnv?: NodeJS.ProcessEnv;
}

/**
 * Deterministic Coordinator control plane. It never makes planning decisions:
 * Main decides when/how many Subagents to call, while this class owns the
 * durable call lifecycle, isolated workspace, execution and result recording.
 */
export class CoordinatorRuntime {
  private readonly activeSubagents = new Map<string, { session: PiSession; cancelRequested: boolean }>();
  private readonly cancelRequests = new Set<string>();

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
      const pending = items.filter((item) => !["completed", "failed", "cancelled"].includes(item.status));
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
    const pending = items.filter((item) => !["completed", "failed", "cancelled"].includes(item.status));
    const callbackPending = waitingCallbacks().filter((message) => !claimedCallbacks.has(message.messageId));
    const responseByCall = new Map<
      string,
      {
        response?: string;
        outputFiles?: string[];
        diagnostics?: SubagentDispatchResult["diagnostics"];
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
        diagnostics?: SubagentDispatchResult["diagnostics"];
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
    const message = input.message.trim();
    if (!message) throw new Error("message must not be empty");
    if (message.length > 8_000) throw new Error("peer message must be at most 8000 characters");
    if (input.senderCallId === input.targetCallId)
      throw new Error("peer message target must be a different Subagent");
    const scheduler = new DurableScheduler(
      join(input.workspaceRoot, input.taskId, "runs", input.runId, "queue.json")
    );
    const items = await scheduler.list();
    const sender = items.find((candidate) => candidate.stepId === input.senderCallId);
    if (!sender) throw new Error(`unknown sender call: ${input.senderCallId}`);
    if (sender.status !== "leased") throw new Error(`sender call ${input.senderCallId} is not active`);
    const target = items.find((candidate) => candidate.stepId === input.targetCallId);
    if (!target) throw new Error(`unknown peer call: ${input.targetCallId}`);
    if (!["queued", "leased"].includes(target.status))
      throw new Error(`peer call ${input.targetCallId} is already ${target.status}`);
    const messageId = id("peer-message");
    const inbox = new InboxStore(
      join(
        input.workspaceRoot,
        input.taskId,
        "runs",
        input.runId,
        "agents",
        "subagents",
        target.agentId,
        "inbox-store.json"
      )
    );
    await inbox.enqueue({
      messageId,
      recipientAgentId: target.agentId,
      senderAgentId: sender.agentId,
      senderCallId: input.senderCallId,
      kind: "peer_message",
      callId: input.targetCallId,
      eventId: id("event"),
      priority: input.priority ?? 1,
      state: "ready",
      payload: {
        message,
        from: "subagent",
        senderAgentId: sender.agentId,
        senderCallId: input.senderCallId,
        targetAgentId: target.agentId,
        priority: input.priority ?? 1
      },
      createdAt: now()
    });
    const events = new JsonlEventStore(
      join(input.workspaceRoot, input.taskId, "runs", input.runId, "run_events.jsonl")
    );
    await events.append(
      event(
        { taskId: input.taskId, runId: input.runId },
        input.targetCallId,
        "peer_message.queued",
        sender.agentId,
        {
          messageId,
          senderCallId: input.senderCallId,
          senderAgentId: sender.agentId,
          targetCallId: input.targetCallId,
          targetAgentId: target.agentId,
          priority: input.priority ?? 1
        }
      )
    );
    return {
      messageId,
      senderCallId: input.senderCallId,
      targetCallId: input.targetCallId,
      senderAgentId: sender.agentId,
      targetAgentId: target.agentId,
      status: "queued"
    };
  }

  /** Cancel a queued or running Subagent; a live session is aborted at once. */
  async cancelSubagent(input: SubagentCancelInput): Promise<SubagentCancelResult> {
    const scheduler = new DurableScheduler(
      join(input.workspaceRoot, input.taskId, "runs", input.runId, "queue.json")
    );
    const item = (await scheduler.list()).find((candidate) => candidate.stepId === input.callId);
    if (!item) throw new Error(`unknown subagent call: ${input.callId}`);
    if (["completed", "failed", "cancelled"].includes(item.status)) {
      return {
        callId: input.callId,
        agentId: item.agentId,
        status: "already_terminal",
        previousStatus: item.status
      };
    }
    this.cancelRequests.add(input.callId);
    const active = this.activeSubagents.get(input.callId);
    if (active) {
      active.cancelRequested = true;
      active.session.agent.abort();
    }
    await scheduler.cancel(input.callId);
    const events = new JsonlEventStore(
      join(input.workspaceRoot, input.taskId, "runs", input.runId, "run_events.jsonl")
    );
    await events.append(
      event({ taskId: input.taskId, runId: input.runId }, input.callId, "run.cancel_requested", "main", {
        callId: input.callId,
        reason: input.reason ?? "Main requested cancellation"
      })
    );
    return { callId: input.callId, agentId: item.agentId, status: "cancelled", previousStatus: item.status };
  }

  /**
   * Re-drive queued or expired Subagent calls after a process restart. Calls
   * are recovered as async work so their result is delivered through Main's
   * durable Inbox even when the original decision turn was interrupted.
   */
  async recoverRun(input: CoordinatorRecoveryInput): Promise<SubagentDispatchResult[]> {
    const runPath = join(input.workspaceRoot, input.taskId, "runs", input.runId);
    const scheduler = new DurableScheduler(join(runPath, "queue.json"));
    await scheduler.reclaimExpired();
    const items = await scheduler.list();
    // Only queued work is safe to re-drive. A non-expired lease belongs to a
    // live Worker and must not be duplicated by a second recovery process.
    const pending = items.filter((item) => item.status === "queued");
    // Each item's own start is attempted concurrently, and a refusal is settled
    // on that item instead of being dropped by an all-or-nothing settle.
    const settled = await Promise.all(
      pending.map(
        async (item): Promise<{ result: SubagentDispatchResult } | { refused: SubagentDispatchResult }> => {
          const inputForItem: SubagentDispatchInput = {
            taskId: input.taskId,
            runId: input.runId,
            activateRun: (item.payload as { activateRun?: boolean } | undefined)?.activateRun,
            callId: item.stepId,
            delegation: (item.payload as { delegation?: DelegatedModelRequest } | undefined)?.delegation,
            dependsOn: (item.payload as { dependsOn?: string[] } | undefined)?.dependsOn,
            workItemSite: (item.payload as { workItemSite?: WorkItemSite } | undefined)?.workItemSite,
            developmentId: (item.payload as { developmentId?: string } | undefined)?.developmentId,
            continuation: (
              item.payload as { continuation?: { fromCallId: string; reviewId?: string } } | undefined
            )?.continuation,
            systemPrompt: (item.payload as { systemPrompt?: string } | undefined)?.systemPrompt,
            disableTools: (item.payload as { disableTools?: boolean } | undefined)?.disableTools,
            agentId: item.agentId,
            projectDirectory: (item.payload as { projectDirectory?: string } | undefined)?.projectDirectory,
            task:
              typeof (item.payload as { task?: unknown } | undefined)?.task === "string"
                ? (item.payload as { task: string }).task
                : "Resume the interrupted Subagent task from its checkpoint.",
            mode: "async",
            workspaceRoot: input.workspaceRoot,
            baseUrl: input.baseUrl,
            apiKey: input.apiKey,
            model: input.model,
            ...delegatedSettings(input, item.payload),
            visionModel: input.visionModel,
            thinkingLevel:
              (item.payload as { thinkingLevel?: PiThinkingLevel } | undefined)?.thinkingLevel ??
              input.thinkingLevel,
            api: (item.payload as { api?: CoworkModelApi } | undefined)?.api ?? input.api,
            thinkingFormat:
              (item.payload as { thinkingFormat?: CoworkThinkingFormat } | undefined)?.thinkingFormat ??
              input.thinkingFormat,
            supportsReasoningEffort:
              (item.payload as { supportsReasoningEffort?: boolean } | undefined)?.supportsReasoningEffort ??
              input.supportsReasoningEffort,
            supportsPromptCacheKey:
              (item.payload as { supportsPromptCacheKey?: boolean } | undefined)?.supportsPromptCacheKey ??
              input.supportsPromptCacheKey,
            supportsImages:
              (item.payload as { supportsImages?: boolean } | undefined)?.supportsImages ??
              input.supportsImages,
            // The queue is the only record that survives a crash, so a recovered
            // dispatch recovers its ledger row from there too. Without this the run
            // would finish untracked and its iteration would go missing.
            experimentRef: (item.payload as { experimentRef?: ExperimentRef } | undefined)?.experimentRef,
            maxAttempts: input.maxAttempts,
            leaseMs: input.leaseMs,
            questionTimeoutMs: input.questionTimeoutMs,
            maxQuestions: input.maxQuestions,
            toolFactory: input.toolFactory,
            commandEnv: input.commandEnv,
            capabilityProvider: input.capabilityProvider,
            capabilityGrants: (item.payload as { capabilityGrants?: CapabilityGrant[] } | undefined)
              ?.capabilityGrants,
            web: input.web,
            skillRoots:
              (item.payload as { skillRoots?: string[] } | undefined)?.skillRoots ?? input.skillRoots,
            skillApplications:
              (item.payload as { skillApplications?: string[] } | undefined)?.skillApplications ??
              input.skillApplications,
            resume: true
          };
          try {
            return { result: await this.dispatch(inputForItem) };
          } catch (error) {
            return { refused: await this.settleRefusedRecovery(inputForItem, error) };
          }
        }
      )
    );
    return settled.map((entry) => ("result" in entry ? entry.result : entry.refused));
  }

  /**
   * Settle a recovered item whose start was refused before any worker owned it.
   *
   * The durable queue is where a later status, wait and recovery pass look, so
   * the reason is written there first and the run event, experiment row and Main
   * callback follow it. Without this the rejection would be dropped: the item
   * would stay queued, be re-driven on every pass, and never report why.
   */
  private async settleRefusedRecovery(
    input: SubagentDispatchInput,
    error: unknown
  ): Promise<SubagentDispatchResult> {
    const message = error instanceof Error ? error.message : String(error);
    const callId = input.callId ?? id("call");
    const call = { ...makeCall(input, callId), resolvedMode: "async" as const };
    const diagnostics = {
      tracePath: `sessions/${input.agentId}/${input.runId}.jsonl`,
      resultPath: `runs/${input.runId}/agents/subagents/${input.agentId}/result.json`
    };
    const runPath = join(input.workspaceRoot, input.taskId, "runs", input.runId);
    const scheduler = new DurableScheduler(join(runPath, "queue.json"));
    await scheduler.failUnstarted(callId, message);
    const events = new JsonlEventStore(join(runPath, "run_events.jsonl"));
    const response = formatSubagentSummary({
      status: "failed",
      rawResponse: "",
      outputFiles: [],
      diagnostics,
      error: message
    });
    try {
      await this.append(
        events,
        event(input, callId, "run.failed", input.agentId, {
          callId,
          error: message,
          state: "failed",
          retryScheduled: false,
          artifacts: [],
          outputFiles: [],
          diagnostics
        })
      );
      await this.settleExperimentRun(input, "failed", input.projectDirectory ?? "", "", [], message);
      await this.writeMainCallback(input, call, response, [], diagnostics, "failed", message);
      // eslint-disable-next-line no-restricted-syntax -- 队列行已经写入失败原因，事件/账本投影失败不能再把工作项改回可启动状态，否则一个永远起不来的项会被反复重跑
    } catch {
      // The queue row already carries the reason; a projection failure must not
      // revive an item that can never start.
    }
    return {
      callId,
      taskId: input.taskId,
      runId: input.runId,
      agentId: input.agentId,
      name: agentDisplayName(input.agentId),
      status: "failed",
      response,
      workingDirectory: input.projectDirectory ?? "",
      artifacts: [],
      outputFiles: [],
      diagnostics,
      error: message
    };
  }

  async dispatch(input: SubagentDispatchInput): Promise<SubagentDispatchResult> {
    const dependsOn = [...new Set(input.dependsOn ?? [])];
    const callId = input.callId ?? id("call");
    const workspace = new LocalWorkspaceStore(input.workspaceRoot);
    const runPath =
      input.activateRun === false
        ? await workspace.ensureRunDirectory(input.taskId, input.runId)
        : await workspace.createRun(input.taskId, input.runId);
    const events = new JsonlEventStore(join(runPath, "run_events.jsonl"));
    const scheduler = new DurableScheduler(join(runPath, "queue.json"));
    if (dependsOn.length > 0) {
      const known = new Set((await scheduler.list()).map((item) => item.stepId));
      const unknown = dependsOn.filter((stepId) => !known.has(stepId));
      if (unknown.length > 0)
        throw new Error(
          `dependsOn 引用了本 Run 中不存在的工作项：${unknown.join("、")}；只能依赖已委派的 callId`
        );
    }
    const checkpointPath = join(runPath, "agents", "subagents", input.agentId, "checkpoint.json");
    const checkpointStore = new CheckpointStore(checkpointPath);
    const previous = await checkpointStore.load(input.runId);
    const restored = readAgentCheckpoint(previous?.state);
    if (restored?.status === "succeeded" && !input.continuation) {
      throw new Error(`subagent call ${callId} already completed; choose a new call id`);
    }
    // A continuation is the one deliberate way to add a turn to a finished
    // session: it needs the earlier transcript, and without one it would be a
    // fresh Agent wearing the same name, which this contract refuses.
    if (input.continuation && !restored)
      throw new Error(
        `工作项 ${input.continuation.fromCallId} 没有可续接的会话记录；不能新建 Agent 冒充原上下文`
      );
    const shouldResume = input.continuation
      ? true
      : (input.resume ?? Boolean(restored && restored.status === "running"));
    // Append the rework instruction only when the restored transcript is a
    // finished attempt. A continuation interrupted mid-run is recovered from
    // its checkpoint like any other running session, so the instruction is not
    // appended twice.
    const appendsContinuation = Boolean(input.continuation && restored?.status !== "running");
    let checkpointSequence = previous?.sequence ?? 0;
    const saveCheckpoint = async (
      state: Parameters<NonNullable<PiSessionOptions["onCheckpoint"]>>[0]
    ): Promise<void> => {
      checkpointSequence += 1;
      await checkpointStore.save({
        runId: input.runId,
        sequence: checkpointSequence,
        state: {
          version: 1,
          status: state.status,
          prompt: restored?.prompt ?? input.task,
          messages: state.messages,
          compaction: state.compaction
        },
        savedAt: now()
      });
    };
    // The launching Run's own connection. It is what an item with no role
    // binding keeps, and it is persisted so a recovered attempt can fall back to
    // it without reading anything from the process that started the call.
    const callerThinkingLevel = normalizeReasoningEffort(input.thinkingLevel ?? configuredReasoningEffort());
    const callerModel: WorkItemModel = {
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      ...(input.model ? { model: input.model } : {}),
      thinkingLevel: callerThinkingLevel,
      api: input.api ?? configuredModelApi(),
      thinkingFormat: input.thinkingFormat ?? configuredThinkingFormat(),
      supportsReasoningEffort: input.supportsReasoningEffort ?? configuredSupportsReasoningEffort(),
      supportsPromptCacheKey: input.supportsPromptCacheKey ?? configuredSupportsPromptCacheKey(),
      supportsImages: input.supportsImages ?? configuredSupportsImages(),
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow })
    };
    const call = makeCall(input, callId);
    let leaseToken: string | undefined;
    let workingDirectory = "";
    let session: PiSession | undefined;
    const artifacts: Artifact[] = [];
    let outputFiles: string[] = [];
    const diagnostics = {
      tracePath: `sessions/${input.agentId}/${input.runId}.jsonl`,
      resultPath: `runs/${input.runId}/agents/subagents/${input.agentId}/result.json`
    };
    let sessionResult: PiSessionResult | undefined;
    let messagePoller: ReturnType<typeof setInterval> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      await this.transition(events, input, call, "accepted");
      await this.append(
        events,
        event(input, callId, "step.queued", "coordinator", { callId, agentId: input.agentId })
      );
      const work = await scheduler.enqueue({
        stepId: callId,
        taskId: input.taskId,
        runId: input.runId,
        agentId: input.agentId,
        importance: call.importance,
        payload: {
          task: input.task,
          activateRun: input.activateRun,
          projectDirectory: input.projectDirectory,
          systemPrompt: input.systemPrompt,
          disableTools: input.disableTools,
          thinkingLevel: callerThinkingLevel,
          api: callerModel.api,
          thinkingFormat: callerModel.thinkingFormat,
          supportsReasoningEffort: callerModel.supportsReasoningEffort,
          supportsPromptCacheKey: callerModel.supportsPromptCacheKey,
          supportsImages: callerModel.supportsImages,
          ...delegatedSettings(input),
          // Non-sensitive launch facts: a recovered item re-reads this host's
          // configuration and re-prepares its own site instead of carrying a
          // connection, key, endpoint or path fact that is no longer true.
          delegation: input.delegation,
          workItemSite: input.workItemSite,
          developmentId: input.developmentId,
          continuation: input.continuation,
          dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
          experimentRef: input.experimentRef,
          capabilityGrants: input.capabilityGrants ?? [],
          skillRoots: input.skillRoots,
          skillApplications: input.skillApplications
        },
        // A Task expecting expensive jobs grants one attempt, so a diverged
        // training run surfaces as evidence instead of being repeated silently.
        maxAttempts:
          input.maxAttempts ??
          // eslint-disable-next-line no-restricted-syntax -- Task 记录被并发删除或损坏时按无 capability 处理，resolveCapabilities 会给出最小默认值，排队不能因此中止
          resolveCapabilities((await workspace.readTask(input.taskId).catch(() => undefined))?.capabilities)
            .maxAttempts
      });
      input.onQueued?.();
      const leaseMs = input.leaseMs ?? 60_000;
      const leased =
        work.status !== "completed" && work.status !== "failed"
          ? await scheduler.claim(`coordinator-${process.pid}`, leaseMs, callId)
          : undefined;
      if (!leased?.lease) throw new Error(`unable to lease subagent call ${callId}`);
      leaseToken = leased.lease.token;
      await this.append(
        events,
        event(input, callId, "step.leased", "coordinator", { callId, lease: leased.lease })
      );
      await this.transition(events, input, call, "running");
      heartbeat = setInterval(
        () => {
          // eslint-disable-next-line no-restricted-syntax -- 续租失败说明租约已被其它 Worker 收回，终态写入会用 token 不匹配失败暴露，未捕获的 rejection 会打断正在运行的 session
          void scheduler.renew(callId, leaseToken!, leaseMs).catch(() => {
            // If the lease was reclaimed by another Worker, the terminal write
            // below will fail with a token mismatch instead of corrupting state.
          });
        },
        Math.max(1_000, Math.floor(leaseMs / 3))
      );
      // A work item whose prerequisites are not finished does not start: it
      // holds its lease, emits no model request and writes no checkpoint.
      if (dependsOn.length > 0) await this.awaitDependencies({ input, callId, dependsOn, scheduler, events });
      // ---- the actual start boundary ----
      // The role binding and the item's own checkout are decided here, after the
      // prerequisites, immediately before the session exists. A binding changed
      // or removed while the item waited decides this start; an attempt that has
      // already started never re-reads it.
      const execution = resolveWorkItemModel({ delegation: input.delegation, caller: callerModel });
      if (execution.snapshot)
        await this.append(
          events,
          event(input, callId, "call.model_selected", input.agentId, {
            callId,
            modelSelection: execution.snapshot
          })
        );
      if (input.continuation)
        await this.append(
          events,
          event(input, callId, "call.continued", input.agentId, {
            callId,
            fromCallId: input.continuation.fromCallId,
            ...(input.continuation.reviewId ? { reviewId: input.continuation.reviewId } : {}),
            agentId: input.agentId
          })
        );
      const projectDirectory = input.workItemSite
        ? await this.prepareSite(input.workItemSite, input.projectDirectory)
        : input.projectDirectory;
      workingDirectory = await workspace.prepareAgentWorkDir(input.taskId, input.runId, input.agentId);
      const tracePath = workspace.sessionPath(input.taskId, input.runId, input.agentId);
      if (!shouldResume) {
        await saveCheckpoint({ messages: [], compaction: emptyCompaction(), status: "running" });
      }
      const grants = input.capabilityGrants ?? [];
      if (grants.length && !input.capabilityProvider)
        throw new Error("Delegated capabilities require a provider; refusing to drop the recorded grant");
      const provided = grants.length
        ? await input.capabilityProvider!(grants, {
            taskId: input.taskId,
            runId: input.runId,
            callId,
            agentId: input.agentId,
            workspaceRoot: input.workspaceRoot,
            workingDirectory,
            supportsImages: execution.supportsImages
          })
        : undefined;
      const skills = await discoverSkills(
        [...(provided?.skillRoots ?? []), ...(input.skillRoots ?? [join(process.cwd(), ".pi", "skills")])],
        { applications: [...(input.skillApplications ?? []), ...(provided?.skillApplications ?? [])] }
      );
      // Capabilities are granted on the Task, so a Subagent inherits exactly
      // what this Task was granted rather than whatever the process was told.
      const capabilities = resolveCapabilities(
        // eslint-disable-next-line no-restricted-syntax -- Task 记录被并发删除或损坏时按无 capability 处理，工具装配继续用最小默认值，不能让读取失败挡住本次 dispatch
        (await workspace.readTask(input.taskId).catch(() => undefined))?.capabilities
      );
      const baseTools = input.toolFactory
        ? input.toolFactory(workingDirectory, join(input.workspaceRoot, input.taskId))
        : createBuiltinTools({
            rootDirectory: workingDirectory,
            workspaceDirectory: join(input.workspaceRoot, input.taskId),
            projectDirectory,
            capabilities,
            commandEnv: { COWORK_API_TOKEN: undefined, ...input.commandEnv },
            supportsImages: execution.supportsImages,
            visionModel: input.visionModel,
            web: input.web
          });
      const tools = new Map(baseTools);
      if (skills.length > 0) tools.set("load_skill", createLoadSkillTool(skills));
      tools.set(
        "send_peer_message",
        this.createPeerMessageTool({
          taskId: input.taskId,
          runId: input.runId,
          workspaceRoot: input.workspaceRoot,
          senderCallId: callId
        })
      );
      // Only an async delegation can be answered: a sync call holds Main's turn
      // inside call_subagent, so a question raised there could never reach it.
      const questionTimeoutMs = input.questionTimeoutMs ?? configuredSubagentQuestionTimeout();
      const canAskMain = call.resolvedMode === "async" && questionTimeoutMs > 0;
      if (canAskMain) {
        tools.set(
          "ask_main",
          this.createAskMainTool({
            input,
            callId,
            events,
            scheduler,
            timeoutMs: questionTimeoutMs,
            maxQuestions: input.maxQuestions ?? configuredSubagentMaxQuestions()
          })
        );
      }
      if (provided) addCapabilityTools(tools, provided.tools);
      // A classifier's restriction is authoritative over factories, skills,
      // delegated capabilities and runtime-added peer/question tools. Persisted
      // disableTools also keeps recovered async analyses restricted.
      if (input.disableTools) tools.clear();
      const projectWrites = projectDirectory !== undefined && capabilities.projectWrite;
      session = new PiSession({
        baseUrl: execution.baseUrl,
        apiKey: execution.apiKey,
        model: execution.model,
        thinkingLevel: normalizeReasoningEffort(execution.thinkingLevel),
        api: execution.api,
        thinkingFormat: execution.thinkingFormat,
        supportsReasoningEffort: execution.supportsReasoningEffort,
        supportsPromptCacheKey: execution.supportsPromptCacheKey,
        supportsImages: execution.supportsImages,
        systemPrompt:
          input.systemPrompt ??
          [
            atriaRoleIdentity("Subagent"),
            ...(input.delegation ? [delegationRoleGuidance(input.delegation)] : []),
            `Your team name is ${agentDisplayName(input.agentId)}. Main and the UI use this stable name to identify your work.`,
            `Your working directory (read_file/write_file/run_command): ${workingDirectory}. Drafts and scripts: ${join(workingDirectory, "work")}. Candidate outputs: ${join(workingDirectory, "deliverables")}.`,
            `Shared Task workspace (browse_workspace paths start here): ${join(input.workspaceRoot, input.taskId)}.${projectDirectory ? ` The project directory you may edit is ${projectDirectory}.` : ""}`,
            projectWrites
              ? `You may edit the user's project directly: relative paths resolve there as well as in your own directory, and run_command runs in the project through a shell, supporting pipes and redirection. Foreground command completion also stops ordinary descendants on Unix; use start_job for persistent background work. Some paths are read-only and a write to one fails with the pattern that protects it — evaluation code, test fixtures, this harness and .git are kept outside the loop so results stay trustworthy. Never work around that by writing those paths from a spawned process; if a task seems to require it, say so instead and explain why.`
              : "Execute only the task assigned by Main. Your own working directory is the only place where you may modify files; use browse_workspace (read-only) to inspect shared Task state, prior Agent progress and published artifacts before starting when the task depends on them.",
            ...(projectWrites
              ? [
                  "Start long jobs such as training with start_job, then poll their log and state with check_job — a foreground command holds this Agent open for its whole duration."
                ]
              : []),
            canAskMain
              ? "You can reach Main with ask_main when an ambiguity would change your approach and you cannot settle it from the workspace or the project — which evaluation script is authoritative, which of two incompatible readings of the task is meant, a constraint that turns out to be wrong. It blocks until Main answers or the wait runs out, so ask only when the answer changes what you do, not whenever you are unsure; investigate first, and never ask for something a file or command would tell you. State the assumption you will follow if nobody answers, because an unanswered question continues under it rather than failing. Ask on its own turn, not alongside other tool calls, and put one decision in one question."
              : call.resolvedMode === "async"
                ? "There is no way to reach Main during this task. When you hit an ambiguity you cannot resolve from the workspace or the project, choose the most reasonable reading, say plainly in your summary which assumption you made and why, and continue."
                : "This is a synchronous delegation: Main is waiting inside its own tool call and cannot be reached, so there is no way to ask it anything. When you hit an ambiguity you cannot resolve from the workspace or the project, choose the most reasonable reading, say plainly in your summary which assumption you made and why, and continue.",
            "You may use send_peer_message to send a short, non-blocking question, correction or finding to another Subagent in this Task when Main has given you its target callId. The message is queued for the peer's next safe turn and does not wait for a reply; include a file or artifact path when that is clearer than copying large content.",
            "Read the specific brief or source files named by Main with browse_workspace. Put substantial reusable candidate outputs under your own deliverables/. Runtime reports those Task-relative paths to Main without moving them; Main reviews the files and uses existing file/command tools to copy accepted final deliverables into Task artifacts/.",
            "Return a concise natural-language or simple Markdown summary of the completed work, including the conclusion and useful evidence such as file paths, line numbers, commands or test results.",
            "Only write a file under deliverables/ when the task produces a substantial report, script or other reusable output; do not create files just to repeat a short message. Keep temporary files and intermediate logs in work/ or logs/ in your own directory. Do not write to Task artifacts/.",
            "The final response must be the complete conclusion, not progress narration. Do not claim work you did not perform.",
            provided?.prompt ?? "",
            skillCatalogPrompt(skills)
          ].join("\n\n"),
        tools,
        maxTurns: input.maxTurns ?? 200,
        maxTokens: execution.maxTokens,
        contextWindow: execution.contextWindow,
        maxLengthContinuations: input.maxLengthContinuations,
        sampling: input.sampling,
        compaction: input.compaction,
        maxToolResponseChars: input.maxToolResponseChars,
        maxErrorRetries: input.maxErrorRetries,
        // A delegated model run has no artificial wall-clock deadline by
        // default. Long artifact tasks (for example PPT generation with
        // rendering and several review passes) must be allowed to finish.
        // Callers can still opt into a deadline with timeoutMs; `0` explicitly
        // means unlimited. Environment-specific defaults are resolved by the
        // CLI/Pi extension before dispatching this runtime.
        timeoutMs: input.timeoutMs ?? 0,
        signal: input.signal,
        initialMessages: restored?.messages,
        initialCompaction: restored?.compaction,
        onCheckpoint: saveCheckpoint,
        trace: {
          recorder: new TraceRecorder(tracePath),
          taskId: input.taskId,
          runId: input.runId,
          agentId: input.agentId
        }
      });
      this.activeSubagents.set(callId, { session, cancelRequested: this.cancelRequests.has(callId) });
      if (this.cancelRequests.has(callId)) session.agent.abort();
      const deliverMessages = async (): Promise<void> => {
        const current = this.activeSubagents.get(callId);
        if (!current) return;
        const queueItem = (await scheduler.list()).find((candidate) => candidate.stepId === callId);
        if (queueItem?.status === "cancelled") {
          current.cancelRequested = true;
          this.cancelRequests.add(callId);
          current.session.agent.abort();
          return;
        }
        if (!current.session.agent.state.isStreaming) return;
        const inbox = new InboxStore(
          join(
            input.workspaceRoot,
            input.taskId,
            "runs",
            input.runId,
            "agents",
            "subagents",
            input.agentId,
            "inbox-store.json"
          )
        );
        for (;;) {
          const message = await inbox.lease(input.agentId, 60_000, `subagent-${process.pid}`);
          if (!message) return;
          try {
            const payload = message.payload as {
              message?: unknown;
              from?: unknown;
              senderAgentId?: unknown;
              senderCallId?: unknown;
            };
            const text = typeof payload.message === "string" ? payload.message.trim() : "";
            if (!text) {
              await inbox.consume(message.messageId);
              continue;
            }
            const peerMessage = message.kind === "peer_message";
            const senderName =
              peerMessage && typeof payload.senderAgentId === "string"
                ? agentDisplayName(payload.senderAgentId)
                : "Main";
            const senderLabel =
              peerMessage && typeof payload.senderCallId === "string"
                ? [senderName, payload.senderCallId].join(" (") + ")"
                : senderName;
            const injected: AgentMessage = {
              role: "user",
              content: `[Message from ${senderLabel}]\n${text}\n\nContinue the assigned task with this guidance. Acknowledge or incorporate it in your next response when relevant.`,
              timestamp: Date.now()
            };
            current.session.agent.steer(injected);
            await inbox.consume(message.messageId);
            await this.append(
              events,
              event(
                input,
                callId,
                peerMessage ? "peer_message.delivered" : "message.delivered",
                input.agentId,
                {
                  messageId: message.messageId,
                  ...(peerMessage
                    ? {
                        senderAgentId: payload.senderAgentId,
                        senderCallId: payload.senderCallId
                      }
                    : {})
                }
              )
            );
            // eslint-disable-next-line no-restricted-syntax -- 单条投递失败时消息仍处于 leased，InboxStore 读取时会回收过期租约重新投递，这里中断会连带丢掉本轮的 session 结果
          } catch {
            // Leave a leased message for InboxStore's expiry/reclaim path.
            return;
          }
        }
      };
      messagePoller = setInterval(() => {
        // eslint-disable-next-line no-restricted-syntax -- 轮询每秒重跑一次，本轮扫描失败由下一次 tick 和 Inbox 过期回收承接，未捕获的 rejection 会以 unhandled rejection 打断正在运行的 session
        void deliverMessages().catch(() => {});
      }, 1_000);
      // eslint-disable-next-line no-restricted-syntax -- 首次投递与轮询同一路径，失败由 1 秒后的 tick 和 Inbox 过期回收重试，不能让消息投递影响 session.run 的启动
      void deliverMessages().catch(() => {});
      const result = (sessionResult = await session.run(
        [
          `Main 分配的任务：${input.task}`,
          `Main 的相关上下文（仅作背景，不要当作已验证事实）：${JSON.stringify(contextSummary(input.context))}`,
          "完成后请返回完整结论；如果创建了 deliverables/ 文件，请列出路径。证据直接写在总结中；不要返回‘正在处理’之类的过程叙述，也不要声称没有执行过的操作。"
        ].join("\n"),
        { resume: shouldResume, continueConversation: appendsContinuation }
      ));
      const rawResponse = result.assistant ? contentText(result.assistant.content).trim() : "";
      await saveSessionResult(join(input.workspaceRoot, input.taskId, diagnostics.resultPath), result);
      outputFiles = await listAgentOutputFiles(input);
      if (this.cancelRequests.has(callId) || this.activeSubagents.get(callId)?.cancelRequested) {
        throw new SubagentTerminationError("cancelled", "Subagent was cancelled by Main");
      }
      if (result.termination !== "completed") {
        throw new SubagentTerminationError(
          result.termination,
          result.error
            ? `Model request failed: ${result.error}`
            : `Subagent ${result.termination} before returning a complete summary`
        );
      }
      if (!rawResponse) {
        throw new SubagentTerminationError("aborted", "Subagent completed without a textual summary");
      }
      const response = formatSubagentSummary({ status: "succeeded", rawResponse, outputFiles, diagnostics });
      await saveCheckpoint({ messages: result.messages, compaction: result.compaction, status: "succeeded" });
      await this.transition(events, input, call, "succeeded");
      // A question this Agent never got an answer to can never be answered now,
      // and a pending one counts as outstanding work — so closing it here is
      // what keeps a completed call from parking the Task forever.
      await this.expireOpenQuestions(input, callId);
      // Settle the ledger before the callback so Main wakes to a current row.
      await this.settleExperimentRun(input, "succeeded", workingDirectory, rawResponse, outputFiles);
      if (call.resolvedMode === "async") {
        await this.writeMainCallback(input, call, response, outputFiles, diagnostics, "succeeded");
      }
      await scheduler.complete(callId, leaseToken);
      clearInterval(messagePoller);
      this.activeSubagents.delete(callId);
      this.cancelRequests.delete(callId);
      await this.append(
        events,
        event(input, callId, "run.completed", input.agentId, {
          callId,
          artifacts: [],
          outputFiles,
          diagnostics
        })
      );
      clearInterval(heartbeat);
      return {
        callId,
        taskId: input.taskId,
        runId: input.runId,
        agentId: input.agentId,
        name: agentDisplayName(input.agentId),
        status: "succeeded",
        response,
        workingDirectory,
        artifacts,
        outputFiles,
        diagnostics
      };
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      clearInterval(messagePoller);
      const message = error instanceof Error ? error.message : String(error);
      const termination = error instanceof SubagentTerminationError ? error.termination : undefined;
      const cancelled =
        input.signal?.aborted ||
        termination === "cancelled" ||
        this.cancelRequests.has(callId) ||
        this.activeSubagents.get(callId)?.cancelRequested;
      const state = cancelled ? "cancelled" : termination === "timed_out" ? "timed_out" : "failed";
      // An interrupted provider/tool run can still have useful candidate files.
      // Keep them discoverable even when no final assistant message was returned.
      // eslint-disable-next-line no-restricted-syntax -- 输出文件扫描失败时保留此前已发现的列表，诊断收集失败不能顶替取消/超时这个真实终态
      outputFiles = await listAgentOutputFiles(input).catch(() => outputFiles);
      await saveSessionResult(join(input.workspaceRoot, input.taskId, diagnostics.resultPath), {
        messages: sessionResult?.messages ?? session?.agent.state.messages ?? [],
        assistant: sessionResult?.assistant,
        termination: sessionResult?.termination ?? state,
        lastStopReason: sessionResult?.lastStopReason,
        continuations: sessionResult?.continuations,
        error: message
        // eslint-disable-next-line no-restricted-syntax -- 诊断结果文件写失败时仍要抛出原始的执行失败原因，否则 Main 只会看到写盘错误
      }).catch(() => {
        /* Preserve the original execution failure if diagnostics cannot be written. */
      });
      const response = formatSubagentSummary({
        status: state,
        rawResponse: subagentRecoverySummary(sessionResult?.messages ?? session?.agent.state.messages ?? []),
        outputFiles,
        diagnostics,
        error: message
      });
      let retryScheduled = false;
      if (session)
        await saveCheckpoint({
          messages: session.agent.state.messages,
          compaction: session.compactionState,
          status: "failed"
        });
      try {
        await this.transition(events, input, call, state);
        // eslint-disable-next-line no-restricted-syntax -- 状态事件写入失败时仍要抛出原始执行错误，租约到期后队列会重新驱动该工作项
      } catch {
        /* preserve original failure */
      }
      if (leaseToken) {
        try {
          if (state === "cancelled") await scheduler.cancel(callId);
          else retryScheduled = (await scheduler.fail(callId, leaseToken, message)).status === "queued";
          // eslint-disable-next-line no-restricted-syntax -- settle 抛错时仍要上抛原始执行错误，未写入终态的租约到期后会被 reclaimExpired 重新排队
        } catch {
          /* preserve original failure */
        }
      }
      // The session that raised a question is gone either way, so close it on
      // both exits. A retried attempt resumes from a transcript whose tool call
      // was never answered and will ask again if it still needs to; leaving the
      // old one open would let Main "answer" an Agent that no longer exists.
      await this.expireOpenQuestions(input, callId);
      if (retryScheduled) {
        await this.append(
          events,
          event(input, callId, "run.retry_scheduled", input.agentId, { callId, error: message })
        );
      } else {
        // Only a terminal failure is an outcome. A retryable one is still in flight,
        // so the ledger row stays open until the Runtime stops retrying it.
        await this.settleExperimentRun(
          input,
          state === "cancelled" ? "cancelled" : state === "timed_out" ? "timed_out" : "failed",
          workingDirectory,
          "",
          outputFiles,
          message
        );
        if (call.resolvedMode === "async") {
          await this.writeMainCallback(input, call, response, outputFiles, diagnostics, state, message);
        }
      }
      await this.append(
        events,
        event(input, callId, "run.failed", input.agentId, {
          callId,
          error: message,
          state,
          retryScheduled,
          artifacts: [],
          outputFiles,
          diagnostics
        })
      );
      this.activeSubagents.delete(callId);
      this.cancelRequests.delete(callId);
      return {
        callId,
        taskId: input.taskId,
        runId: input.runId,
        agentId: input.agentId,
        name: agentDisplayName(input.agentId),
        status: state,
        response,
        workingDirectory,
        artifacts,
        outputFiles,
        diagnostics,
        error: message
      };
    }
  }

  /**
   * Create the one-way Subagent -> Subagent message tool.
   *
   * This deliberately has no wait-for-reply mode. A peer can answer by sending
   * its own message, while the sender remains free to continue and Main retains
   * the task-level completion decision.
   */
  private createPeerMessageTool(context: {
    taskId: string;
    runId: string;
    workspaceRoot: string;
    senderCallId: string;
  }): RuntimeTool {
    return {
      description:
        "Send a short, non-blocking message to another Subagent in this Task. The target must be a callId supplied by Main. The message is queued for the peer's next safe turn; this tool never waits for a reply.",
      parameters: {
        type: "object",
        properties: {
          targetCallId: {
            type: "string",
            description: "The peer callId supplied by Main."
          },
          message: {
            type: "string",
            description:
              "A short question, correction or finding. Include a file or artifact path when useful."
          },
          priority: {
            type: "number",
            description: "Optional delivery priority; use a higher value only for time-sensitive guidance."
          }
        },
        required: ["targetCallId", "message"],
        additionalProperties: false
      },
      execute: async (raw) => {
        const value = (raw && typeof raw === "object" ? raw : {}) as {
          targetCallId?: unknown;
          message?: unknown;
          priority?: unknown;
        };
        const targetCallId = typeof value.targetCallId === "string" ? value.targetCallId.trim() : "";
        const message = typeof value.message === "string" ? value.message.trim() : "";
        if (!targetCallId) throw new Error("send_peer_message requires targetCallId");
        if (!message) throw new Error("send_peer_message requires message");
        return await this.sendPeerMessage({
          ...context,
          targetCallId,
          message,
          priority: typeof value.priority === "number" ? value.priority : undefined
        });
      }
    };
  }

  /**
   * The Subagent's upward question channel.
   *
   * A running Subagent can ask Main one question with a bounded wait and a
   * declared fallback, without waiting for a terminal state.
   *
   * Two mechanics shape the implementation. The reply is polled from a file
   * rather than delivered through the existing Main -> Subagent path, because
   * `agent.steer()` is only drained after the current turn's tool calls return —
   * a tool waiting on a steered reply would wait for itself. Cancellation is
   * polled for the same reason a reply is: the tool adapter does not pass the
   * agent's AbortSignal through, so nothing else would notice an abort until
   * this call returns.
   */
  private createAskMainTool(context: {
    input: SubagentDispatchInput;
    callId: string;
    events: JsonlEventStore;
    scheduler: DurableScheduler;
    timeoutMs: number;
    maxQuestions: number;
  }): RuntimeTool {
    const { input, callId, events, scheduler, timeoutMs, maxQuestions } = context;
    const store = new SubagentQuestionStore(input.workspaceRoot);
    const agentName = agentDisplayName(input.agentId);
    let asked = 0;
    return {
      description:
        "Ask Main one question that must be answered before you can continue correctly, and wait for the reply. Use it only when the answer would change your approach and the workspace, project and your own tools cannot settle it — not for anything you could read, run or reasonably decide yourself. You must state the assumption you will follow if no answer arrives: the wait is bounded, and an unanswered question continues under that assumption instead of failing. Call it on its own turn rather than beside other tool calls.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "One concrete decision for Main, with enough context to answer it without reading your transcript."
          },
          assumption: {
            type: "string",
            description:
              "What you will do if nobody answers. Required, and it must be a course you can actually take."
          }
        },
        required: ["question", "assumption"],
        additionalProperties: false
      },
      execute: async (raw) => {
        const value = (raw && typeof raw === "object" ? raw : {}) as {
          question?: unknown;
          assumption?: unknown;
        };
        const question = typeof value.question === "string" ? value.question.trim() : "";
        const assumption = typeof value.assumption === "string" ? value.assumption.trim() : "";
        if (!question) throw new Error("ask_main requires question");
        if (!assumption)
          throw new Error("ask_main requires the assumption you will follow if the question goes unanswered");
        if (asked >= maxQuestions) {
          return {
            status: "refused",
            reason: `this attempt has already used its ${maxQuestions} question(s)`,
            instruction:
              "Decide for yourself, state the assumption you made in your final summary, and continue."
          };
        }
        asked += 1;
        // Unique per question rather than derived from the attempt: a retried
        // dispatch must be able to ask again, and a stale question from an
        // interrupted attempt is closed by expireOpenQuestions, not by id reuse.
        const questionId = id("question");
        const record = await store.create({
          questionId,
          taskId: input.taskId,
          runId: input.runId,
          callId,
          agentId: input.agentId,
          agentName,
          question,
          assumption
        });
        const inbox = new InboxStore(
          join(input.workspaceRoot, input.taskId, "runs", input.runId, "agents", "main", "inbox-store.json")
        );
        await inbox.enqueue({
          messageId: `subagent-question-${questionId}`,
          recipientAgentId: "main",
          kind: "subagent_question",
          callId,
          eventId: id("event"),
          // A blocked collaborator outranks an ordinary result: Main reading this
          // late costs the Subagent its whole remaining wait.
          priority: 50,
          state: "ready",
          payload: {
            type: "subagent.question",
            questionId,
            callId,
            agentId: input.agentId,
            name: agentName,
            question,
            assumption,
            timeoutMs,
            instruction: `Answer with send_subagent_message({ callId: "${callId}", questionId: "${questionId}", message: "<your answer>" }). ${agentName} is blocked until you answer or the wait expires.`
          },
          createdAt: now()
        });
        await this.append(
          events,
          event(input, callId, "question.raised", input.agentId, {
            questionId,
            question,
            assumption,
            timeoutMs
          })
        );
        const settled = await store.waitForAnswer(input.taskId, questionId, {
          timeoutMs,
          isCancelled: async () => {
            if (this.cancelRequests.has(callId) || this.activeSubagents.get(callId)?.cancelRequested)
              return true;
            // eslint-disable-next-line no-restricted-syntax -- 取消探测读队列失败时按未取消继续等待，真正的取消请求和本次等待的 timeout 仍会结束阻塞
            const item = (await scheduler.list().catch(() => [])).find(
              (candidate) => candidate.stepId === callId
            );
            return item?.status === "cancelled";
          }
        });
        await this.append(
          events,
          event(input, callId, `question.${settled.status}`, input.agentId, {
            questionId,
            answer: settled.question.answer
          })
          // eslint-disable-next-line no-restricted-syntax -- 这条提问结算事件只是诊断记录，写失败不能阻止把作答结果返回给仍在阻塞等待的 Subagent
        ).catch(() => {
          /* diagnostics only */
        });
        if (settled.status === "answered") {
          return { status: "answered", questionId, answer: settled.question.answer };
        }
        if (settled.status === "cancelled") {
          throw new SubagentTerminationError(
            "cancelled",
            "Subagent was cancelled while waiting for Main's answer"
          );
        }
        return {
          status: "unanswered",
          questionId,
          waitedMs: timeoutMs,
          instruction: `Main did not answer in time. Continue under the assumption you stated (${record.assumption}) and say in your final summary that you proceeded on it unanswered.`
        };
      }
    };
  }

  /**
   * Close any question this call left open.
   *
   * A pending question is outstanding work, and one whose Subagent has reached a
   * terminal state can never be answered — leaving it would keep the Task from
   * completing at all. Like the ledger, this bookkeeping must never fail a
   * dispatch that otherwise finished, so failures here are swallowed.
   */
  private async expireOpenQuestions(input: SubagentDispatchInput, callId: string): Promise<void> {
    try {
      const expired = await new SubagentQuestionStore(input.workspaceRoot).expireForCall(
        input.taskId,
        callId
      );
      if (expired.length === 0) return;
      await this.append(
        new JsonlEventStore(join(input.workspaceRoot, input.taskId, "runs", input.runId, "run_events.jsonl")),
        event(input, callId, "question.expired_on_terminal", input.agentId, {
          questionIds: expired.map((question) => question.questionId)
        })
      );
      // eslint-disable-next-line no-restricted-syntax -- 关闭遗留提问是收尾簿记，失败不能把已结束的 dispatch 再判成失败；遗留提问会随 Task 的过期处理关闭
    } catch {
      /* bookkeeping only */
    }
  }

  /**
   * Settle the ledger row for a dispatch that reached a terminal state.
   *
   * This runs at the same boundary that writes Main's callback, and for the
   * same reason: a retryable failure is not an outcome, so recording one there
   * would put a run in the ledger that the Runtime is still retrying. Metrics
   * are read from the run's own metrics.json rather than from its summary, so
   * the recorded number is the one the run produced.
   *
   * Ledger bookkeeping must never fail a dispatch that otherwise succeeded, so
   * every error here is captured and reported as a problem on the row.
   */
  private async settleExperimentRun(
    input: SubagentDispatchInput,
    status: ExperimentRunStatus,
    workingDirectory: string,
    summary: string,
    outputFiles: string[],
    error?: string
  ): Promise<void> {
    const ref = input.experimentRef;
    if (!ref) return;
    const taskDirectory = join(input.workspaceRoot, input.taskId);
    try {
      const measured =
        status === "succeeded" || status === "partial"
          ? await readRunMetrics({ workingDirectory, taskDirectory, outputFiles })
          : {};
      const store = new ExperimentProgramStore(input.workspaceRoot);
      // A delegation that succeeded with nothing measurable and nothing to show
      // was ordinary work, not an iteration. Keeping its row would bury the
      // rounds that matter under reading and summarizing, so drop it — the Run
      // event log still records that the delegation happened.
      if (status === "succeeded" && !measured.metrics && !measured.problem && outputFiles.length === 0) {
        await store.discardRun(input.taskId, ref.experimentId, ref.experimentRunId);
        return;
      }
      await store.completeRun({
        taskId: input.taskId,
        experimentId: ref.experimentId,
        runId: ref.experimentRunId,
        status,
        summary,
        artifacts: outputFiles,
        metrics: measured.metrics,
        metricsSource: measured.source,
        metricsOrigin: measured.metrics ? "file" : undefined,
        // The run may label its own variant in the metrics file. Runtime reads
        // that label rather than asking Main to declare one.
        variantRef: measured.ref,
        // A metrics file that exists but cannot be parsed is surfaced, not dropped:
        // the run must not read back as one that simply reported no measurement.
        error: [error, measured.problem].filter(Boolean).join("; ") || undefined
      });
    } catch (ledgerError) {
      const reason = ledgerError instanceof Error ? ledgerError.message : String(ledgerError);
      await this.append(
        new JsonlEventStore(join(taskDirectory, "runs", input.runId, "run_events.jsonl")),
        event(input, input.callId ?? "", "experiment.settle_failed", input.agentId, {
          experimentId: ref.experimentId,
          experimentRunId: ref.experimentRunId,
          error: reason
        })
        // eslint-disable-next-line no-restricted-syntax -- 记录结算失败本身就是诊断路径，事件再写不进去只能放弃，否则已捕获的账本错误会变成未处理拒绝
      ).catch(() => {
        /* diagnostics only */
      });
    }
  }

  private async writeMainCallback(
    input: SubagentDispatchInput,
    call: Call,
    response: string,
    outputFiles: string[],
    diagnostics: NonNullable<SubagentDispatchResult["diagnostics"]>,
    status: SubagentDispatchResult["status"],
    error?: string
  ): Promise<void> {
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
    const messageId = `callback-${call.callId}-${status}`;
    const alreadyQueued = (await inbox.list("main")).some((message) => message.messageId === messageId);
    await inbox.enqueue({
      // A callback is a projection of a terminal call state. Keeping its id
      // deterministic makes retries and process recovery idempotent.
      messageId,
      recipientAgentId: "main",
      kind: "callback",
      callId: call.callId,
      eventId: id("event"),
      priority: 1,
      state: "ready",
      payload: {
        ...input.callbackMetadata,
        callId: call.callId,
        agentId: input.agentId,
        name: agentDisplayName(input.agentId),
        status,
        response,
        artifacts: [],
        outputFiles,
        diagnostics,
        error
      },
      createdAt: now()
    });
    if (!alreadyQueued) {
      const events = new JsonlEventStore(
        join(input.workspaceRoot, input.taskId, "runs", input.runId, "run_events.jsonl")
      );
      await events.append(
        event(input, call.callId, "callback.queued", "coordinator", {
          messageId,
          recipientAgentId: "main",
          status
        })
      );
    }
  }

  /**
   * Prepare the item's own checkout and confirm it is the directory it will run in.
   *
   * Prepared at the start boundary for the same reason as the role binding: a
   * parallel item must fork the integration site as it is *now*, and a resumed
   * attempt must keep the checkout — and the work in it — it already owns.
   */
  private async prepareSite(site: WorkItemSite, projectDirectory?: string): Promise<string> {
    if (projectDirectory !== site.directory)
      throw new Error(`工作项现场与项目目录不一致（${site.directory} ≠ ${projectDirectory ?? "未设置"}）`);
    await prepareWorkItemSite(site);
    return site.directory;
  }

  /**
   * Hold a work item until the calls it depends on are terminal.
   *
   * The same durable queue is the only scheduler: a blocked item keeps its
   * lease (renewed by the dispatch heartbeat) and stays visible as pending, so
   * Main still waits for it. A cancellation of this call, or a prerequisite
   * that failed, ends it here — before any model request or session exists.
   */
  private async awaitDependencies(context: {
    input: SubagentDispatchInput;
    callId: string;
    dependsOn: string[];
    scheduler: DurableScheduler;
    events: JsonlEventStore;
  }): Promise<void> {
    const { input, callId, dependsOn, scheduler, events } = context;
    const terminal = (status: string) =>
      status === "completed" || status === "failed" || status === "cancelled";
    await this.append(events, event(input, callId, "call.blocked", input.agentId, { callId, dependsOn }));
    for (;;) {
      const items = await scheduler.list();
      const own = items.find((item) => item.stepId === callId);
      if (
        !own ||
        own.status === "cancelled" ||
        this.cancelRequests.has(callId) ||
        input.signal?.aborted === true
      )
        throw new SubagentTerminationError("cancelled", "工作项在等待前置工作时被取消，未开始执行");
      const statusOf = (stepId: string) => items.find((item) => item.stepId === stepId)?.status;
      const unfinished = dependsOn.filter((stepId) => {
        const status = statusOf(stepId);
        return status === undefined || !terminal(status);
      });
      if (unfinished.length === 0) {
        const failed = dependsOn.filter((stepId) => statusOf(stepId) !== "completed");
        if (failed.length > 0) {
          await this.append(
            events,
            event(input, callId, "call.dependency_failed", input.agentId, { callId, dependsOn, failed })
          );
          throw new SubagentTerminationError(
            "cancelled",
            `前置工作 ${failed.join("、")} 未成功完成，本工作项未执行`
          );
        }
        await this.append(
          events,
          event(input, callId, "call.dependencies_met", input.agentId, { callId, dependsOn })
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async transition(
    events: JsonlEventStore,
    input: SubagentDispatchInput,
    call: Call,
    state: Call["state"]
  ): Promise<void> {
    Object.assign(call, transitionCall(call, state));
    await this.append(events, event(input, call.callId, `call.${state}`, call.callerAgentId, { call }));
  }

  private async append(store: JsonlEventStore, value: Event): Promise<void> {
    await store.append(value);
  }
}

class SubagentTerminationError extends Error {
  constructor(
    readonly termination: "timed_out" | "cancelled" | "aborted",
    message: string
  ) {
    super(message);
    this.name = "SubagentTerminationError";
  }
}

function makeCall(input: SubagentDispatchInput, callId: string): Call {
  return {
    callId,
    callerAgentId: "main",
    calleeAgentId: input.agentId,
    mode: input.mode,
    resolvedMode: input.mode === "auto" ? "async" : input.mode,
    importance: "normal",
    dependency: input.mode === "sync" ? "required" : "independent",
    callbackPolicy: "on_complete",
    interruptOnCallback: false,
    state: "created",
    createdAt: now(),
    updatedAt: now()
  };
}

function event(
  input: Pick<SubagentDispatchInput, "taskId" | "runId">,
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

async function saveSessionResult(
  path: string,
  result: {
    messages: unknown[];
    assistant?: { stopReason?: unknown };
    termination?: string;
    error?: string;
    lastStopReason?: PiSessionResult["lastStopReason"];
    continuations?: PiSessionResult["continuations"];
  }
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${id("tmp")}`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ termination: result.termination, stopReason: result.lastStopReason ?? result.assistant?.stopReason, continuations: result.continuations, error: result.error, messages: result.messages }, null, 2)}\n`,
      "utf8"
    );
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function contextSummary(context: unknown[] | undefined): Array<{ role: string; content: string }> {
  if (!Array.isArray(context)) return [];
  return context.slice(-8).map((message) => {
    const item = (message && typeof message === "object" ? message : {}) as {
      role?: unknown;
      content?: unknown;
    };
    const content =
      typeof item.content === "string"
        ? item.content
        : Array.isArray(item.content)
          ? item.content
              .map((part) =>
                part && typeof part === "object" && "text" in part
                  ? String((part as { text?: unknown }).text ?? "")
                  : ""
              )
              .join(" ")
          : String(item.content ?? "");
    return { role: String(item.role ?? "unknown"), content: content.slice(0, 3000) };
  });
}

/** Persist model budgets with queued work; caller defaults only fill old/missing values. */
function delegatedSettings(input: DelegatedModelSettings, payload?: unknown): DelegatedModelSettings {
  const saved = payload && typeof payload === "object" ? (payload as Partial<DelegatedModelSettings>) : {};
  const fields = [
    "maxTurns",
    "maxTokens",
    "maxErrorRetries",
    "timeoutMs",
    "contextWindow",
    "maxLengthContinuations",
    "sampling",
    "compaction",
    "maxToolResponseChars"
  ] as const;
  return Object.fromEntries(
    fields.map((field) => [field, saved[field] ?? input[field]]).filter((entry) => entry[1] !== undefined)
  );
}

function formatSubagentSummary(input: {
  status: SubagentDispatchResult["status"];
  rawResponse: string;
  outputFiles: string[];
  diagnostics: NonNullable<SubagentDispatchResult["diagnostics"]>;
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
