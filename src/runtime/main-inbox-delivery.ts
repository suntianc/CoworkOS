import { readQueuedUserTurn } from "./queued-user-turn.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { InboxStore } from "./scheduler.js";
import { mainContextPaths, updateMainContextRuntime } from "./main-context.js";
import { JsonlEventStore } from "../storage/event-store.js";
import { withFileLock } from "../storage/file-lock.js";
import { experimentDigest } from "./experiment-digest.js";
import { clearSleep } from "./main-sleep.js";
import type { InboxMessage } from "../domain/types.js";
import { WatchProgramStore } from "./watch-program-store.js";
import { routeGoalMessage, discardGoalMessage } from "./goal-routing.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { monitoringPrograms } from "./monitoring-control.js";

interface DeliveredMessage {
  customType: string;
  content: string;
  display: boolean;
  details: Record<string, unknown>;
}

interface InboxIdentity {
  taskId?: string;
  runId?: string;
  messageId?: string;
}

interface ContextMessage {
  role?: string;
  content?: unknown;
  type?: string;
  toolName?: string;
  isError?: boolean;
  message?: ContextMessage;
  details?: { _coworkInbox?: InboxIdentity; _coworkInboxMessages?: InboxIdentity[] };
}

/** Pi's sendMessage is fire-and-forget. Queuing is not acknowledgement:
 * keep Inbox leases until the message appears in Main's saved context. */
export class MainInboxDelivery {
  private readonly inbox: InboxStore;
  private readonly events: JsonlEventStore;
  private readonly receiptLock: string;
  private readonly queued = new Set<string>();
  private readonly recorded = new Set<string>();
  private readonly consumerId = `main-${randomUUID()}`;
  private delivery = Promise.resolve();
  private humanAnswerWaits = 0;

  constructor(
    private readonly workspaceRoot: string,
    private readonly taskId: string,
    private readonly runId: string
  ) {
    const runPath = join(workspaceRoot, taskId, "runs", runId);
    this.inbox = new InboxStore(join(runPath, "agents", "main", "inbox-store.json"));
    this.events = new JsonlEventStore(join(runPath, "run_events.jsonl"));
    this.receiptLock = join(runPath, "agents", "main", ".inbox-consumed");
  }

  get queuedCount(): number {
    return this.queued.size;
  }

  /** A Pi message can remain queued beyond its Inbox lease. While this
   * process still owns that pending delivery, wait must not take its body. */
  isQueued(messageId: string): boolean {
    return this.queued.has(messageId);
  }

  /** askhuman reads its answer as a tool result. While it waits, recovery
   * copies must stay durable without also being injected into Main's turn. */
  holdHumanAnswers(): () => void {
    this.humanAnswerWaits += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.humanAnswerWaits -= 1;
    };
  }

  deliver(
    send: (
      message: DeliveredMessage,
      options: { triggerTurn: true; deliverAs: "steer" | "followUp" }
    ) => void | Promise<void>,
    { includeFollowUps = true } = {}
  ): Promise<void> {
    const delivery = this.delivery.then(async () => {
      await this.inbox.recoverAbandonedWaitCallbacks();
      const candidates = (await this.inbox.list("main"))
        .filter(
          (message) =>
            !this.queued.has(message.messageId) &&
            (message.state === "ready" ||
              (message.state === "leased" && Date.parse(message.lease?.expiresAt ?? "") <= Date.now()))
        )
        .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
      const programs = await monitoringPrograms(this.workspaceRoot, this.taskId);
      const background =
        (await new LocalWorkspaceStore(this.workspaceRoot).readTask(this.taskId)).monitoring?.scope ===
        "background";
      for (const candidate of candidates) {
        const route = routeGoalMessage(programs, background, candidate);
        if (route === "hold") continue;
        if (route === "discard") {
          await discardGoalMessage(this.inbox, candidate);
          continue;
        }
        const watch = candidate.payload as
          { type?: string; programId?: string; monitorId?: string } | undefined;
        if (watch?.type?.startsWith("watch.") && watch.programId) {
          const store = new WatchProgramStore(this.workspaceRoot);
          const program = programs.find((entry) => entry.programId === watch.programId);
          if (program?.status === "paused") continue;
          if (program?.status === "completed" && watch.type.startsWith("watch.goal_")) {
            await discardGoalMessage(this.inbox, candidate);
            continue;
          }
          if (
            program &&
            watch.monitorId &&
            (await store.readVirtualAgent(this.taskId, watch.programId, watch.monitorId)).status === "paused"
          )
            continue;
        }
        const candidatePayload = candidate.payload as { type?: string; delivery?: string } | undefined;
        if (
          !includeFollowUps &&
          candidate.kind === "human_command" &&
          candidatePayload?.type === "human.message" &&
          candidatePayload.delivery === "followUp"
        )
          continue;
        if (this.humanAnswerWaits && isHumanAnswerMessage(candidate)) continue;
        const message = await this.inbox.leaseMessage("main", candidate.messageId, 60_000, this.consumerId);
        if (message?.state !== "leased" || message.lease?.consumerId !== this.consumerId) continue;
        // A tool can start waiting while the asynchronous lease is acquired.
        if (this.humanAnswerWaits && isHumanAnswerMessage(message)) {
          await this.inbox.release(message.messageId);
          continue;
        }
        this.queued.add(message.messageId);
        try {
          const payload =
            message.payload && typeof message.payload === "object"
              ? (message.payload as Record<string, unknown>)
              : { payload: message.payload };
          // A finished job rides the external_event channel, since it is the
          // same shape of news: something outside this turn changed. It is
          // labelled separately so Main is not told its own training run was a
          // watch event.
          const isJobFinished = message.kind === "external_event" && payload.type === "job.finished";
          const isWatchEvent = message.kind === "external_event" && !isJobFinished;
          const isHumanAnswer = message.kind === "human_command" && payload.type === "human.answer";
          const isUserMessage = message.kind === "human_command" && payload.type === "human.message";
          const followUp = isUserMessage && payload.delivery === "followUp";
          const isSubagentQuestion = message.kind === "subagent_question";
          // Pi owns Main's execution lifecycle. Only agent_start may reopen
          // the Task: queue acceptance is not a started turn, and a disposed
          // sender must not leave a stopped Task permanently running.
          // Any delivered message means Main is awake, so the standing wake
          // condition it parked on has been met. One clear covers callbacks,
          // human answers, watch events and scheduled wakes alike. A park left
          // behind by a failed clear only delays automatic completion, which
          // finish_task overrides, so it must not fail the delivery itself.
          await clearSleep(this.workspaceRoot, this.taskId).catch(async (error) => {
            await this.events
              .append({
                eventId: `event_${randomUUID()}`,
                type: "main.park_clear_failed",
                taskId: this.taskId,
                runId: this.runId,
                agentId: "main",
                occurredAt: new Date().toISOString(),
                payload: {
                  messageId: message.messageId,
                  error: error instanceof Error ? error.message : String(error)
                }
              })
              // eslint-disable-next-line no-restricted-syntax -- 这条事件本身就是清理失败的记录，写不进事件流时投递仍必须继续
              .catch(() => {});
          });
          // A callback that settled a measured round is the moment Main decides
          // what to try next, so the recorded series travels with it. Main is
          // not asked to look it up, and nothing here reads the trend for it.
          const digest = payload.experimentRunId
            ? await experimentDigest(this.workspaceRoot, this.taskId)
                // eslint-disable-next-line no-restricted-syntax -- 实验趋势是附加信息，读不到时消息照常投递，只是不带趋势段落
                .catch(() => undefined)
            : undefined;
          await send(
            {
              customType: isUserMessage
                ? "cowork-user-message"
                : isJobFinished
                  ? "cowork-job-finished"
                  : isWatchEvent
                    ? "cowork-watch-event"
                    : isHumanAnswer
                      ? "cowork-human-answer"
                      : isSubagentQuestion
                        ? "cowork-subagent-question"
                        : "cowork-callback",
              // A user message is delivered as what it is — the person speaking —
              // rather than wrapped in the Inbox envelope the machinery uses. The
              // envelope reads as a system notice, and Main treated it as one.
              content: isUserMessage
                ? followUp
                  ? `用户排队的下一条请求（当前工作结束后处理）：\n${String(payload.message ?? "")}`
                  : `用户在你工作期间补充了一句话：\n${String(payload.message ?? "")}\n\n如果它改变了当前该做的事，就据此调整；如果只是补充信息，记下来继续。不要重新开始已经完成的部分。`
                : `Cowork ${isJobFinished ? "job finished" : isWatchEvent ? "watch event" : isHumanAnswer ? "human answer" : isSubagentQuestion ? "subagent question" : "callback"} received from Inbox:\n${JSON.stringify(message.payload)}${digest ? `\n\n${digest}` : ""}`,
              display: true,
              details: {
                ...payload,
                _coworkInbox: { taskId: this.taskId, runId: this.runId, messageId: message.messageId }
              }
            },
            { triggerTurn: true, deliverAs: followUp ? "followUp" : "steer" }
          );
        } catch (error) {
          this.queued.delete(message.messageId);
          await this.inbox.release(message.messageId);
          throw error;
        }
      }
    });
    // eslint-disable-next-line no-restricted-syntax -- 上次投递的拒绝已经由返回的 delivery 交给调用方，串行链只需保持可继续排队
    this.delivery = delivery.catch(() => {});
    return delivery;
  }

  async acknowledge(context: unknown[]): Promise<void> {
    const ids = new Set<string>();
    const waitIds = new Set<string>();
    for (const value of context) {
      if (!value || typeof value !== "object") continue;
      const entry = value as ContextMessage;
      const message = entry.type === "message" ? entry.message : entry;
      if (!message) continue;
      const user = message;
      if (user.role === "toolResult" && user.toolName === "wait_for_subagents" && !user.isError) {
        const receipts = user.details?._coworkInboxMessages;
        for (const receipt of Array.isArray(receipts) ? receipts : []) {
          if (
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 回执数组来自 Pi 会话上下文，历史 transcript 里可能混入 null 条目
            receipt?.taskId !== this.taskId ||
            typeof receipt.messageId !== "string" ||
            typeof receipt.runId !== "string"
          )
            continue;
          if (receipt.runId === this.runId) {
            ids.add(receipt.messageId);
            waitIds.add(receipt.messageId);
          } else {
            await new MainInboxDelivery(this.workspaceRoot, this.taskId, receipt.runId).acknowledge([
              {
                ...user,
                details: { _coworkInboxMessages: [receipt] }
              }
            ]);
          }
        }
      }
      const initial = user.role === "user" ? readQueuedUserTurn(user.content) : undefined;
      if (initial?.taskId === this.taskId) {
        if (initial.runId === this.runId) ids.add(initial.messageId);
        else
          await new MainInboxDelivery(this.workspaceRoot, this.taskId, initial.runId).acknowledge([message]);
      }
      if (message.role !== "custom" && message.type !== "custom_message") continue;
      const identity = message.details?._coworkInbox;
      if (identity?.taskId === this.taskId && identity.runId === this.runId && identity.messageId)
        ids.add(identity.messageId);
    }
    if (!ids.size) return;
    for (const message of await this.inbox.list("main")) {
      if (!ids.has(message.messageId)) continue;
      if (message.state !== "consumed") {
        // A restored Pi session may already contain a message whose old
        // process exited between persistence and Inbox acknowledgement.
        if (message.state === "ready")
          await this.inbox.leaseMessage("main", message.messageId, 60_000, this.consumerId);
        await this.inbox.consume(message.messageId);
      }
      try {
        // Consumption and its UI receipt are separate durable writes. Recover
        // an exit or write failure between them without resending the input.
        await this.recordConsumed(message, waitIds.has(message.messageId) ? "wait" : undefined);
      } finally {
        this.queued.delete(message.messageId);
      }
    }
  }

  /** After settlement, successful results are durable; cancelled/failed waits may be delivered again. */
  async settle(context: unknown[]): Promise<void> {
    await this.acknowledge(context);
    await this.inbox.releaseCurrentWaitCallbacks();
  }

  private async recordConsumed(message: InboxMessage, delivery?: "wait"): Promise<void> {
    if (this.recorded.has(message.messageId)) return;
    const type = message.kind === "callback" ? "callback.consumed" : "inbox.consumed";
    // Use a separate lock because EventStore.list/append acquire their own
    // event-file lock. This makes receipt repair idempotent across processes,
    // including old receipts whose event ids were randomly generated.
    const appended = await withFileLock(
      this.receiptLock,
      async () => {
        const events = await this.events.list(this.runId);
        if (
          events.some(
            (event) =>
              event.type === type &&
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 事件从 run_events.jsonl 读出，payload 声明为 unknown，旧记录可能没有 payload
              (event.payload as { messageId?: string })?.messageId === message.messageId
          )
        )
          return false;
        await this.events.append({
          eventId: `event_inbox_consumed_${message.messageId}`,
          type,
          taskId: this.taskId,
          runId: this.runId,
          agentId: "main",
          callId: message.callId,
          occurredAt: new Date().toISOString(),
          payload: {
            messageId: message.messageId,
            kind: message.kind,
            delivery: delivery ?? (message.payload as { delivery?: string } | undefined)?.delivery
          }
        });
        return true;
      },
      { recoverDeadOwner: true }
    );
    this.recorded.add(message.messageId);
    if (!appended) return;
    const payload = message.payload as { type?: string } | undefined;
    const isHumanAnswer = message.kind === "human_command" && payload?.type === "human.answer";
    const isJobFinished = message.kind === "external_event" && payload?.type === "job.finished";
    await updateMainContextRuntime(mainContextPaths(this.workspaceRoot, this.taskId), {
      runtimeLastEvent: {
        type: isHumanAnswer
          ? "human_answer_received"
          : isJobFinished
            ? "job_finished"
            : message.kind === "external_event"
              ? "watch_event_received"
              : message.kind === "subagent_question"
                ? "subagent_question_received"
                : "subagent_callback_received",
        summary: JSON.stringify(message.payload).slice(0, 240)
      }
    });
  }
}

function isHumanAnswerMessage(message: InboxMessage): boolean {
  const payload = message.payload as { type?: unknown } | undefined;
  return message.kind === "human_command" && payload?.type === "human.answer";
}
