import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { metricSeries } from "../../../dist/src/domain/experiment.js";
import { clearSleep, readSleep, writeSleep } from "../../../dist/src/runtime/main-sleep.js";
import { readSubagentProgress } from "../../../dist/src/runtime/progress.js";
import { configuredHumanAnswerTimeout } from "../../../dist/src/runtime/runtime-settings.js";
import { assessTaskCompletion } from "../../../dist/src/runtime/task-completion.js";
import { LocalWorkspaceStore } from "../../../dist/src/workspace/workspace-store.js";
import { formatSubagentSummary } from "../../../dist/src/runtime/subagent-callback.js";
import { createSubagentClient } from "../../../dist/src/runtime/subagent-client.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CoworkToolContext } from "../extension.ts";
import type { RuntimeToolResult } from "../helpers.ts";

import { delegationRenderers } from "../cli-ui.ts";

/** coordination tools depend only on explicit runtime ports. */
export function registerCoordinationTools(pi: ExtensionAPI, context: CoworkToolContext) {
  pi.registerTool({
    name: "askhuman",
    label: "Ask Human",
    description:
      "Ask the user a question and wait for their answer, which comes back as this tool's result. The wait is bounded: if they do not answer in time you are told so and must proceed on your recommended option. The request is durable, so a UI or CLI can still answer it after a restart.",
    promptSnippet: "Ask the user for a decision or missing information",
    promptGuidelines: [
      "Use askhuman only when the answer changes the task or a safe autonomous choice is not possible.",
      "Include the smallest useful question, enough context to decide, and a short list of options when appropriate.",
      "Mark one option as recommended. The wait is bounded, and on a timeout that is the option you proceed on — so it has to be a choice you are willing to act on unattended.",
      "On a timeout, act on the recommended option and say in your reply that you did so without an answer, so the user can correct it."
    ],
    parameters: Type.Object({
      question: Type.String({ description: "A concrete question the user can answer." }),
      context: Type.Optional(
        Type.String({ description: "Short context explaining why the decision is needed." })
      ),
      options: Type.Optional(Type.Array(Type.String({ description: "Optional answer choices." }))),
      recommended: Type.Optional(
        Type.Number({
          description:
            "Zero-based index into options: the choice you would make yourself, and the one you proceed on if nobody answers in time."
        })
      )
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<RuntimeToolResult> {
      const releaseAnswers = context.inboxDelivery.holdHumanAnswers();
      try {
        const options = Array.isArray(params.options)
          ? params.options.filter((option): option is string => typeof option === "string")
          : undefined;
        const recommended =
          typeof params.recommended === "number" &&
          options &&
          params.recommended >= 0 &&
          params.recommended < options.length
            ? params.recommended
            : undefined;
        const request = await context.humanStore.create({
          taskId: context.taskId,
          runId: context.mainRunId,
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- askhuman 的 question 由模型以 JSON 参数传入，运行期可能缺失；空串回退让 humanStore.create 始终收到字符串
          question: String(params.question ?? ""),
          context: typeof params.context === "string" ? params.context : undefined,
          options,
          recommended
        });
        await new LocalWorkspaceStore(context.workspaceRoot).transitionTask(context.taskId, "waiting", {
          runId: context.mainRunId,
          reason: `waiting_for_human:${request.requestId}`
        });
        context.updateRuntime({
          runtimePhase: "waiting",
          runtimeLastEvent: { type: "human_question_created", summary: request.question.slice(0, 240) }
        });
        ctx.ui.notify(`Waiting for human answer · ${request.requestId}`, "info");

        // Wait here, so the answer is this tool's result. Returning immediately
        // meant the answer had to re-enter as a fabricated user turn, which showed
        // up in the transcript as something the person had typed, and dragged the
        // supervisor's own wake-up prompt in with it.
        const settled = await context.humanStore.waitForAnswer(context.taskId, request.requestId, {
          timeoutMs: configuredHumanAnswerTimeout(context.runtimeEnv),
          isCancelled: async () => signal?.aborted === true
        });

        if (settled.status === "answered") {
          // The question is closed, so the durable answer must not also arrive
          // through the Inbox and be read as a second, unprompted instruction.
          // eslint-disable-next-line no-restricted-syntax -- 答案已经由 waitForAnswer 作为工具结果返回，这里只是把 Inbox 重复副本标记为已消费；去重写失败不能让已回答的调用失败，残留消息仍带同一 requestId
          await context.humanStore.consumeAnswerMessage(context.taskId, request.requestId).catch(() => {
            /* nothing was queued */
          });
          await new LocalWorkspaceStore(context.workspaceRoot)
            .transitionTask(context.taskId, "running", { runId: context.mainRunId, reason: "human_answered" })
            // eslint-disable-next-line no-restricted-syntax -- 同步持久状态是回答后的尽力更新；runtime 事件已发出，写盘失败时下一次生命周期钩子按实际状态重算，不能因此丢掉答案结果
            .catch(() => {});
          context.updateRuntime({
            runtimePhase: "active",
            runtimeLastEvent: {
              type: "human_answer_received",
              summary: (settled.request.answer ?? "").slice(0, 240)
            }
          });
          const payload = {
            status: "answered",
            requestId: request.requestId,
            question: request.question,
            answer: settled.request.answer
          };
          return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
        }

        if (settled.status === "cancelled") {
          const payload = { status: "cancelled", requestId: request.requestId, question: request.question };
          return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
        }

        // Nobody answered in time. The question stays open — a late answer still
        // reaches Main through the durable path — but this turn continues rather
        // than ending, so the person is not left with a stalled conversation.
        // Nobody answered in time. The question is marked unanswered rather than
        // left pending: pending means someone is blocked on it, and the completion
        // gate treats that as outstanding work — so the turn could never finish.
        // A late answer still reaches Main through the durable path.
        // eslint-disable-next-line no-restricted-syntax -- 超时分支必须把超时结果返回给模型；标记 unanswered 失败时请求仍是 pending，门禁和下一次等待会重新读到它，写盘异常不能中断这次返回
        await context.humanStore.markUnanswered(context.taskId, request.requestId).catch(() => {});
        await new LocalWorkspaceStore(context.workspaceRoot)
          .transitionTask(context.taskId, "running", {
            runId: context.mainRunId,
            reason: "human_answer_timeout"
          })
          // eslint-disable-next-line no-restricted-syntax -- 超时后回到 running 的持久迁移同样是尽力更新；runtime 事件已更新，写盘失败由后续生命周期钩子重算，不能阻断超时结果返回
          .catch(() => {});
        context.updateRuntime({
          runtimePhase: "active",
          runtimeLastEvent: { type: "human_answer_timeout", summary: request.question.slice(0, 240) }
        });
        const fallback =
          request.recommended !== undefined ? request.options?.[request.recommended] : undefined;
        const payload = {
          status: "timeout",
          requestId: request.requestId,
          question: request.question,
          ...(fallback ? { recommendedOption: fallback } : {}),
          instruction: fallback
            ? `用户没有及时回答。按你推荐的选项「${fallback}」继续，并在最终回复里说明这是在没有确认的情况下做的选择。`
            : "用户没有及时回答。选择最合理的做法继续，并在最终回复里说明这是在没有确认的情况下做的选择。"
        };
        return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
      } finally {
        releaseAnswers();
      }
    }
  });

  pi.registerTool({
    name: "sleep_until",
    label: "Park Until Wake",
    description:
      "Record that this Task's work is done for now and that you expect to be woken later, after a stated interval. The Task stays open across process restarts and the wake arrives through the normal Inbox. Ending a turn is not sleeping: without this record a Task with no outstanding work is treated as finished.",
    promptSnippet: "Park this Task until a stated interval wakes it",
    promptGuidelines: [
      "Use this when the objective is ongoing but nothing can advance it right now: this round's result is written, and the next useful action waits on time passing or on external news that will arrive through the Inbox.",
      "Update agents/main/context/memory.md before parking. After a wake the model context may be new; what is not in memory is not carried over.",
      "Set wakeInSeconds when the next action is periodic, such as refreshing a report or checking a long-running job again.",
      "A park with no wakeInSeconds is refused: nothing could wake it."
    ],
    parameters: Type.Object({
      reason: Type.String({
        description: "Why this Task is parked and what you will do next, in your own terms."
      }),
      wakeInSeconds: Type.Optional(Type.Number({ description: "Wake after this many seconds. Minimum 60." }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<RuntimeToolResult> {
      // The 60s floor leaves time for this turn to settle before the wake is
      // due, so a very small value still means "later", not "again now".
      const wakeInSeconds =
        typeof params.wakeInSeconds === "number" && Number.isFinite(params.wakeInSeconds)
          ? Math.max(60, Math.floor(params.wakeInSeconds))
          : undefined;
      // Whether a wake condition exists is countable, so refusing is mechanical.
      if (!wakeInSeconds) {
        const refusal = {
          parked: false,
          reason: "no_wake_condition",
          note: "Nothing could wake this Task: no interval was given. Pass wakeInSeconds or finish the Task instead."
        };
        return {
          content: [{ type: "text", text: JSON.stringify(refusal) }],
          details: refusal,
          isError: true
        };
      }
      const sleep = {
        runId: context.mainRunId,
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- sleep_until 的 reason 由模型以 JSON 参数传入，运行期可能缺失；空串回退让 MainSleep.reason 始终是字符串
        reason: String(params.reason ?? "").trim(),
        wakeAt: new Date(Date.now() + wakeInSeconds * 1_000).toISOString(),
        parkedAt: new Date().toISOString()
      };
      await writeSleep(context.workspaceRoot, context.taskId, sleep);
      // The lifecycle stays with the completion gate two hooks later: one
      // mechanism decides whether the Task is running, waiting or finished.
      context.updateRuntime({
        runtimePhase: "waiting",
        runtimeLastEvent: { type: "main_parked", summary: sleep.reason.slice(0, 240) }
      });
      ctx.ui.notify(`Parked until ${sleep.wakeAt}`, "info");
      const payload = { parked: true, ...sleep };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: payload,
        terminate: true
      };
    }
  });

  pi.registerTool({
    name: "call_subagent",
    label: "Call Subagent",
    description:
      "Delegate one concrete work item to a Subagent. sync waits for the result; async returns a callId and delivers the result by callback. Both modes execute the task once. role names the job (executor implements, reviewer examines an independent session); dependsOn holds the item until earlier callIds finish; developmentId runs it in that requirement's isolated checkout; continueCallId reworks a finding as the next turn of a finished Executor's own session and checkout. Task wording never registers a persistent program.",
    promptSnippet: "Delegate a concrete task",
    promptGuidelines: [
      "Use call_subagent when an independent analysis, implementation or validation task is likely to improve the result.",
      "Give each delegate an independently testable objective, relevant inputs, constraints and acceptance evidence. Independent end-to-end attempts are valid when they help compare approaches; avoid a fixed research/production/review pipeline for every task.",
      "Set mode=sync to wait for the result; set mode=async to continue independent work and receive a callback. Wait for any result needed for acceptance before completing the parent task.",
      "The task must state a concrete objective and expected evidence; ask for a deliverables/ file only when the result is a substantial reusable artifact. Main may issue multiple independent calls in one turn.",
      "A request to research a topic or run an experiment is still an ordinary task. This tool does not register or activate persistent programs.",
      "The Subagent returns a concise summary with evidence, candidate outputFiles, diagnostic paths and validation results. Candidate files remain in the Subagent's directory until Main accepts and copies selected files into the Task artifacts directory.",
      "Use role=reviewer for an independent check of a result; it starts its own session, so it must be given the candidate and evidence to examine rather than asked to trust the Executor's summary.",
      "Pass dependsOn only for work that genuinely needs an earlier item's result: a dependent item does not start until those calls finish, and does not run at all when one of them failed or was cancelled. Independent work should be dispatched without dependsOn so it can proceed at once.",
      "Pass developmentId when the work belongs to a requirement with an isolated checkout. ensure_workspace first; the checkout — not the user's working tree — is then the delegate's project directory.",
      "To rework a review finding in the original context, pass continueCallId with the finished Executor callId (and reviewId). It appends one turn to that agent's own session and checkout; do not dispatch a fresh Agent and paste a summary of the first attempt."
    ],
    parameters: Type.Object(
      {
        task: Type.String({
          description:
            "A concrete objective for one Subagent with relevant context, scope, constraints and acceptance evidence. A substantial independent end-to-end attempt is valid. The summary returns conclusions, candidate output paths and validation evidence."
        }),
        attachments: Type.Optional(
          Type.Array(Type.String(), {
            maxItems: 10,
            uniqueItems: true,
            description: "Explicit upload IDs this delegate may inspect with read_attachment."
          })
        ),
        mode: Type.Union([Type.Literal("sync"), Type.Literal("async")], {
          description:
            "sync waits for the Subagent result; async returns immediately and delivers a later callback. Both execute once; async does not mean persistent."
        }),
        role: Type.Optional(
          Type.Union([Type.Literal("executor"), Type.Literal("reviewer")], {
            description:
              "Which role this work item runs as. executor implements and verifies; reviewer runs an independent session over the result. Omit for executor. The role's connection is read on this host when the item starts."
          })
        ),
        dependsOn: Type.Optional(
          Type.Array(Type.String(), {
            maxItems: 16,
            uniqueItems: true,
            description:
              "callIds from this Run that must finish first. A work item with unfinished prerequisites does not start until they are terminal, and does not run at all when one of them failed or was cancelled."
          })
        ),
        developmentId: Type.Optional(
          Type.String({
            description:
              "Run this work item in its own checkout forked from the recorded requirement checkout. Its directory, not the user's working tree, becomes the delegate's project directory; ensure_workspace must have made it ready."
          })
        ),
        continueCallId: Type.Optional(
          Type.String({
            description:
              "Rework by continuing this Run's finished Executor call: same agent identity, checkpoint history and checkout, with this task appended as the next turn. The finished call stays finished; this creates one new call instead of repeating it."
          })
        ),
        reviewId: Type.Optional(
          Type.String({
            description:
              "With continueCallId: the review whose finding this rework answers, recorded on the new call."
          })
        ),
        profileId: Type.Optional(
          Type.String({
            description:
              "One-off model connection for this work item only; not saved as a role binding. A missing id is an error, never a fallback."
          })
        ),
        model: Type.Optional(
          Type.String({
            description: "One-off model on the connection the role resolves to, for this work item only."
          })
        )
      },
      { additionalProperties: false }
    ),
    executionMode: "parallel",
    ...delegationRenderers(() => context.cliDebugEnabled()),
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<RuntimeToolResult> {
      if (!context.baseUrl || !context.apiKey)
        throw new Error("Cowork requires COWORK_API_BASE/COWORK_API_KEY or .cowork/config.json");
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- task 由模型以 JSON 参数传入，运行期可能缺失；空串回退后由下面的 !goal 拒绝，否则 String(undefined) 会变成 "undefined" 通过校验
      const goal = String(params.task ?? "").trim();
      if (!goal) throw new Error("call_subagent requires task");
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mode 来自模型传入的工具参数 JSON，schema 只在声明层约束；显式拒绝未知值，避免把拼错的 mode 当成 sync 执行
      if (params.mode !== "sync" && params.mode !== "async")
        throw new Error("call_subagent mode must be sync or async");
      const role = params.role ?? "executor";
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- role 同样来自模型传入的工具参数，运行期可能是 schema 之外的值；这里拒绝未知 role，而不是把它当成 executor 静默执行
      if (role !== "executor" && role !== "reviewer")
        throw new Error("call_subagent role must be executor or reviewer");
      const dependsOn = Array.isArray(params.dependsOn)
        ? [
            ...new Set(
              params.dependsOn.filter(
                (stepId): stepId is string => typeof stepId === "string" && stepId.trim().length > 0
              )
            )
          ]
        : [];
      const continueCallId = typeof params.continueCallId === "string" ? params.continueCallId.trim() : "";
      const requestedReview = typeof params.reviewId === "string" ? params.reviewId.trim() : "";
      if (requestedReview && !continueCallId)
        throw new Error("reviewId 只能与 continueCallId 一起使用：发现由返修续接回答");
      // Main asks for a work item and the backend owns the process:
      // registration, dependencies, checkout, role connection and settlement
      // all happen there. There is no in-process execution to fall back to.
      const accepted = await createSubagentClient({ taskId: context.taskId }).dispatch({
        task: goal,
        mode: params.mode,
        role,
        ...(dependsOn.length > 0 ? { dependsOn } : {}),
        ...(typeof params.developmentId === "string" && params.developmentId.trim()
          ? { developmentId: params.developmentId.trim() }
          : {}),
        ...(continueCallId ? { continueCallId } : {}),
        ...(requestedReview ? { reviewId: requestedReview } : {}),
        ...(params.attachments === undefined ? {} : { attachments: params.attachments }),
        ...(typeof params.profileId === "string" && params.profileId.trim()
          ? { profileId: params.profileId.trim() }
          : {}),
        ...(typeof params.model === "string" && params.model.trim() ? { model: params.model.trim() } : {}),
        thinkingLevel: context.currentThinkingLevel()
      });
      const callId = String(accepted.callId ?? "");
      const acceptedPayload = {
        callId,
        runId: accepted.runId,
        agentId: accepted.agentId,
        name: accepted.name,
        role,
        ...(accepted.developmentId
          ? { developmentId: accepted.developmentId, workspace: accepted.workspace }
          : {}),
        ...(accepted.continuedFrom ? { continuedFrom: accepted.continuedFrom } : {}),
        ...(Array.isArray(accepted.dependsOn) ? { dependsOn: accepted.dependsOn } : {})
      };
      if (params.mode === "async") {
        context.updateRuntime({
          runtimeRouting: { strategy: "async", reason: goal.slice(0, 240) },
          runtimeLastEvent: { type: "subagent_accepted", summary: `${callId}: ${goal.slice(0, 180)}` }
        });
        const payload = { accepted: true, mode: "async", ...acceptedPayload };
        return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
      }
      const settled = await waitForDispatchedCall(context, accepted);
      context.updateRuntime({
        runtimeRouting: { strategy: "sync", reason: goal.slice(0, 240) },
        runtimeLastEvent: { type: "subagent_completed", summary: `${callId}: ${settled.status}` }
      });
      const payload = {
        ...acceptedPayload,
        status: settled.status,
        response: settled.response,
        artifacts: [],
        outputFiles: settled.outputFiles,
        diagnostics: settled.diagnostics,
        error: settled.error
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: { ...payload, _coworkInboxMessages: settled.claimedCallbacks ?? [] }
      };
    }
  });

  pi.registerTool({
    name: "send_subagent_message",
    label: "Send Subagent Message",
    description:
      "Queue a message from Main to a running Subagent, or answer a question a Subagent asked. The message is durable and delivered at a safe turn boundary; it does not interrupt an in-flight model request. Pass questionId to answer a pending question — that Subagent is blocked waiting for it.",
    promptSnippet: "Answer a Subagent's question or send it guidance",
    promptGuidelines: [
      "Use the callId returned by call_subagent.",
      "To answer a question a Subagent asked, pass both its callId and the questionId from the question, and put the decision in message. That Subagent is blocked and its wait is bounded, so answer before doing other work; a late answer still arrives as ordinary guidance, but it will already have continued on its stated assumption.",
      "Messages are queued durably and will be injected before the Subagent's next turn; a queued response is not proof that the Subagent has already acted on it.",
      "Keep the message focused: one correction, new constraint, or concrete follow-up requirement."
    ],
    parameters: Type.Object({
      callId: Type.String({ description: "The callId returned by call_subagent." }),
      message: Type.String({
        description:
          "Concrete guidance for the Subagent to apply at its next turn, or the answer to its question."
      }),
      questionId: Type.Optional(
        Type.String({
          description: "Answer this pending question from the Subagent. Omit for ordinary guidance."
        })
      ),
      priority: Type.Optional(
        Type.Number({
          description: "Optional priority; higher-priority messages are reserved for urgent guidance."
        })
      )
    }),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- callId 由模型以 JSON 参数传入，运行期可能缺失；空串回退后由下面的 !callId 检查拒绝
      const callId = String(params.callId ?? "");
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- message 同样来自模型参数，缺失时按空串处理并交给下面的 !message 检查拒绝
      const message = String(params.message ?? "").trim();
      if (!callId || !message) throw new Error("send_subagent_message requires callId and message");
      const questionId =
        typeof params.questionId === "string" && params.questionId.trim()
          ? params.questionId.trim()
          : undefined;
      if (questionId) {
        // eslint-disable-next-line no-restricted-syntax -- 问题记录不存在或读取失败对调用方是同一个结果：下一行按 unknown question 拒绝，存储异常不必再单独抛出
        const question = await context.questionStore.read(context.taskId, questionId).catch(() => undefined);
        if (!question) throw new Error(`unknown question: ${questionId}`);
        // A mismatched pair means the answer was aimed at the wrong collaborator,
        // which is worth surfacing rather than silently delivering.
        if (question.callId !== callId)
          throw new Error(`question ${questionId} belongs to call ${question.callId}, not ${callId}`);
        if (question.status === "pending") {
          const answered = await context.questionStore.answer(context.taskId, questionId, message);
          context.updateRuntime({
            runtimeLastEvent: {
              type: "subagent_question_answered",
              summary: `${questionId}: ${message.slice(0, 180)}`
            }
          });
          // `answer` leaves an already-expired record alone, so report what the
          // store actually recorded rather than assuming the wait was still open.
          const payload =
            answered.status === "answered"
              ? {
                  questionId,
                  callId,
                  agentId: question.agentId,
                  name: question.agentName,
                  status: answered.status,
                  delivered: "unblocked_waiting_subagent"
                }
              : {
                  questionId,
                  callId,
                  agentId: question.agentId,
                  name: question.agentName,
                  status: answered.status,
                  delivered: "too_late",
                  note: `${question.agentName} stopped waiting and continued under its stated assumption: ${question.assumption}`
                };
          return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
        }
        // The Subagent already gave up waiting and continued on its assumption.
        // The decision is still worth delivering, so fall through to ordinary
        // guidance — but only while that Agent is still running. Once its call
        // is terminal there is nobody to steer, and reporting that plainly is
        // more useful to Main than an exception it cannot act on.
        const stillRunning = (
          await context.coordinator.waitForSubagents({
            taskId: context.taskId,
            runId: context.mainRunId,
            workspaceRoot: context.workspaceRoot,
            callIds: [callId],
            timeoutMs: 0
          })
        ).calls.some(
          (call) => call.callId === callId && !["completed", "failed", "cancelled"].includes(call.status)
        );
        if (!stillRunning) {
          const payload = {
            questionId,
            callId,
            agentId: question.agentId,
            name: question.agentName,
            status: question.status,
            delivered: "not_delivered",
            note: `${question.agentName} already finished; it continued under its stated assumption (${question.assumption}). Judge its result against that assumption instead of answering.`
          };
          return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
        }
      }
      const result = await context.coordinator.sendMessage({
        taskId: context.taskId,
        runId: context.mainRunId,
        workspaceRoot: context.workspaceRoot,
        callId,
        message,
        priority: typeof params.priority === "number" ? params.priority : undefined
      });
      const payload = questionId
        ? {
            ...result,
            questionId,
            note: "The question had already expired; this was delivered as ordinary guidance."
          }
        : result;
      return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
    }
  });

  pi.registerTool({
    name: "cancel_subagent",
    label: "Cancel Subagent",
    description: "Cancel a queued or running Subagent.",
    promptSnippet: "Cancel a Subagent",
    parameters: Type.Object({
      callId: Type.String({ description: "The callId returned by call_subagent." }),
      reason: Type.Optional(Type.String({ description: "Short reason for cancelling the work." }))
    }),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancel_subagent 的 callId 由模型以 JSON 参数传入，运行期可能缺失；空串会落到找不到 call 的分支，不能把 undefined 传给存储查询
      const callId = String(params.callId ?? "");
      const result = await createSubagentClient({ taskId: context.taskId }).cancel({
        callId,
        ...(typeof params.reason === "string" ? { reason: params.reason } : {})
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    }
  });

  pi.registerTool({
    name: "get_subagent_status",
    label: "Get Subagent Status",
    description:
      "Return a compact structured snapshot of every Subagent in the current Task: task, mode, status, elapsed time, model turns, message count, last tool, last assistant text, pending Main messages, latest lifecycle event, last trace activity, published artifacts and pending callbacks. Use this instead of reading many workspace files when checking progress.",
    promptSnippet: "Check structured progress for all Subagents",
    promptGuidelines: [
      "Use get_subagent_status to check delegated work before deciding whether to wait, send guidance, cancel, retry or summarize.",
      "Use browse_workspace only when you need the full contents of a specific artifact, event or working file."
    ],
    parameters: Type.Object({
      agentId: Type.Optional(
        Type.String({ description: "Filter to one Subagent id; omit to show all Subagents." })
      )
    }),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      const progress = await readSubagentProgress({
        workspaceRoot: context.workspaceRoot,
        taskId: context.taskId,
        runId: context.mainRunId,
        agentId: params.agentId
      });
      const result = { ...progress };
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    }
  });

  pi.registerTool({
    name: "wait_for_subagents",
    label: "Wait for Subagents",
    description:
      "Wait for selected or all currently active Subagent calls to reach a terminal state and for their Main callbacks to be durably queued. Use this when the final answer or task completion depends on async work; it prevents Main from finishing while required Subagents are still running.",
    promptSnippet: "Wait for async Subagent work before finishing",
    promptGuidelines: [
      "Use this only when the result is needed for the current task or before calling finish_task.",
      "A timeout returns the current structured state; inspect pending and callbackPending before deciding whether to continue waiting or proceed."
    ],
    parameters: Type.Object({
      callIds: Type.Optional(Type.Array(Type.String({ description: "A callId returned by call_subagent." }))),
      timeoutMs: Type.Optional(
        Type.Number({ description: "Maximum wait in milliseconds; default 30 seconds." })
      )
    }),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      const value = params as { callIds?: unknown; timeoutMs?: unknown };
      const callIds = Array.isArray(value.callIds)
        ? value.callIds.filter((callId): callId is string => typeof callId === "string")
        : undefined;
      const timeoutMs =
        typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs)
          ? Math.max(0, value.timeoutMs)
          : 30_000;
      const { claimedCallbacks, ...result } = await context.coordinator.waitForSubagents({
        taskId: context.taskId,
        runId: context.mainRunId,
        workspaceRoot: context.workspaceRoot,
        callIds,
        timeoutMs,
        waitForCallbackConsumption: false,
        consumeCompletedCallbacks: true,
        isCallbackQueued: (messageId) => context.inboxDelivery.isQueued(messageId)
      });
      // Unrelated callbacks remain durable for a later poll. A failed send
      // must not discard the only wait result carrying our claimed evidence.
      // eslint-disable-next-line no-restricted-syntax -- 投递失败时 Inbox 消息仍是 durable 的 queued 状态，下一次轮询或下一个 Main 会重新投递；本次等待结果带着已领取的 callback 证据，不能因投递异常丢失
      await context.deliverCallbacks().catch(() => {});
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: { ...result, _coworkInboxMessages: claimedCallbacks }
      };
    }
  });

  pi.registerTool({
    name: "get_task_status",
    label: "Get Task Status",
    description:
      "Return durable Task state, compact Subagent call status and pending callbacks. Default call entries omit task briefs and result bodies. resultAvailable means a persisted callback or diagnostic exists, possibly from an earlier attempt; resultDelivered is present only when callback state establishes delivery. Pass resultCallIds only to reread specific stored async results when needed; use wait_for_subagents to receive pending results.",
    promptSnippet: "Inspect durable Task lifecycle state",
    parameters: Type.Object({
      resultCallIds: Type.Optional(
        Type.Array(
          Type.String({
            description:
              "Specific async callIds whose stored result bodies you need to reread; omit for compact status. This does not consume callbacks."
          })
        )
      )
    }),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 工具可被无参数直接调用（测试与中断恢复路径），此时 params 为 undefined，取字段会抛 TypeError
      const resultCallIds = Array.isArray(params?.resultCallIds)
        ? params.resultCallIds.filter((callId): callId is string => typeof callId === "string")
        : [];
      const taskStore = new LocalWorkspaceStore(context.workspaceRoot);
      const task = await taskStore.readTask(context.taskId);
      const coordination = await context.coordinator.waitForSubagents({
        taskId: context.taskId,
        runId: context.mainRunId,
        workspaceRoot: context.workspaceRoot,
        timeoutMs: 0,
        includeCallDetails: false,
        resultCallIds
      });
      // Recorded rounds reach Main by injection at context resets and
      // callbacks, so this stays a compact index rather than the full series.
      const experiments = await Promise.all(
        (await context.experimentStore.listPrograms(context.taskId)).map(async (program) => {
          const runs = await context.experimentStore
            .listRuns(context.taskId, program.experimentId)
            // eslint-disable-next-line no-restricted-syntax -- 运行记录读取失败时该实验按 0 次运行展示；get_task_status 是只读快照，单个实验的存储损坏不该让整份状态查询失败
            .catch(() => []);
          const series = metricSeries(runs);
          return {
            experimentId: program.experimentId,
            objective: program.objective,
            status: program.status,
            runCount: program.runCount,
            measuredRuns: series[0]?.points.length ?? 0,
            metrics: series.map((entry) => entry.name)
          };
        })
      );
      const result = { task, coordination, experiments };
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    }
  });

  pi.registerTool({
    name: "finish_task",
    label: "Finish Task",
    description:
      "Optionally record a completion summary after verifying the requested result. A normal final answer also completes the Task once outstanding work is resolved. This tool refuses completion while Subagent work, background jobs, callbacks or human answers are pending.",
    promptSnippet: "Explicitly complete the durable Task",
    promptGuidelines: [
      "Call this only after the requested work and final verification are complete.",
      "This tool is optional; do not add another work phase merely to call it.",
      "If it reports pending Subagents, use wait_for_subagents or inspect their status before trying again.",
      "If it reports a pending job, it is still running: read its log with check_job, and kill_job it if its result is no longer needed.",
      "If it reports a pending Subagent question, answer it with send_subagent_message before completing: that collaborator is blocked on you."
    ],
    parameters: Type.Object({
      summary: Type.Optional(Type.String({ description: "Short human-readable completion summary." }))
    }),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      const coordination = await context.coordinator.waitForSubagents({
        taskId: context.taskId,
        runId: context.mainRunId,
        workspaceRoot: context.workspaceRoot,
        timeoutMs: 0
      });
      // A park is deliberately not checked here. It says "wake me later", and
      // finish_task is Main stating the objective is done — exactly what
      // supersedes it. Only the automatic path is blocked while parked.
      const assessment = assessTaskCompletion({
        pendingCalls: coordination.pending.length,
        pendingJobs: await context.pollJobs(),
        pendingCallbacks: Math.max(context.inboxDelivery.queuedCount, coordination.callbackPending.length),
        pendingHumanRequests: (await context.humanStore.list(context.taskId, "pending")).length,
        pendingSubagentQuestions: (await context.questionStore.list(context.taskId, "pending")).length
      });
      if (!assessment.ready) {
        const result = { completed: false, reason: assessment.reason, coordination };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, isError: true };
      }
      // eslint-disable-next-line no-restricted-syntax -- 停车记录损坏（非 ENOENT 的读取错误）不该阻止完成任务；完成本身取代停车，读不到只是少一个 supersededPark 字段
      const parked = await readSleep(context.workspaceRoot, context.taskId).catch(() => undefined);
      // eslint-disable-next-line no-restricted-syntax -- 清理停车记录失败时残留文件不会再被安排唤醒：任务紧接着迁移为 completed
      if (parked) await clearSleep(context.workspaceRoot, context.taskId).catch(() => {});
      const taskStore = new LocalWorkspaceStore(context.workspaceRoot);
      const summary = String(
        (params as { summary?: unknown }).summary ?? "Main verified the requested result"
      );
      const task = await taskStore.transitionTask(context.taskId, "completed", {
        runId: context.mainRunId,
        reason: summary,
        completion: {
          policy: "explicit",
          signal: "finish_task",
          summary,
          verifiedAt: new Date().toISOString()
        }
      });
      context.updateRuntime({
        runtimePhase: "completed",
        runtimePendingDelegations: 0,
        runtimeLastEvent: { type: "task_completed", summary }
      });
      const result = { completed: true, task, ...(parked ? { supersededPark: parked.reason } : {}) };
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    }
  });
}

/**
 * Wait for the backend to settle one dispatched call.
 *
 * The wait reads the same durable queue, callback and result record every other
 * status tool reads, so a backend restart in the middle changes nothing about
 * this wait: the process is adopted by the next backend and settles there.
 */
async function waitForDispatchedCall(
  context: CoworkToolContext,
  accepted: Record<string, unknown>
): Promise<{
  status: "succeeded" | "failed" | "timed_out" | "cancelled";
  response: string;
  outputFiles: string[];
  diagnostics: { tracePath: string; resultPath: string };
  error?: string;
  claimedCallbacks?: Array<{ taskId: string; runId: string; messageId: string }>;
}> {
  const taskId = context.taskId;
  const runId = String(accepted.runId ?? context.mainRunId);
  const callId = String(accepted.callId ?? "");
  const agentId = String(accepted.agentId ?? "");
  const diagnostics = {
    tracePath: `sessions/${agentId}/${runId}.jsonl`,
    resultPath: `runs/${runId}/agents/subagents/${agentId}/result.json`
  };
  const terminal = (status: string | undefined) =>
    status === "completed" || status === "failed" || status === "cancelled";
  // Wait for the queue to reach a terminal state first; the callback is written
  // by the settling backend and is claimed in the read that follows.
  for (;;) {
    const state = await context.coordinator.waitForSubagents({
      taskId,
      runId,
      workspaceRoot: context.workspaceRoot,
      callIds: [callId],
      timeoutMs: 5_000,
      waitForCallbackConsumption: false,
      includeCallDetails: false
    });
    if (terminal(state.calls.find((call) => call.callId === callId)?.status)) break;
    if (state.calls.length === 0 && state.pending.length === 0) break;
  }
  const waited = await context.coordinator.waitForSubagents({
    taskId,
    runId,
    workspaceRoot: context.workspaceRoot,
    callIds: [callId],
    timeoutMs: 0,
    waitForCallbackConsumption: false,
    consumeCompletedCallbacks: true,
    isCallbackQueued: (messageId) => context.inboxDelivery.isQueued(messageId)
  });
  const call = waited.calls.find((candidate) => candidate.callId === callId);
  const status =
    call?.status === "completed"
      ? ("succeeded" as const)
      : call?.status === "cancelled"
        ? ("cancelled" as const)
        : call?.status === "timed_out"
          ? ("timed_out" as const)
          : ("failed" as const);
  const result = await readResultRecord(join(context.workspaceRoot, taskId, diagnostics.resultPath));
  const outputFiles = call?.outputFiles ?? result?.outputFiles ?? [];
  const error = call?.error ?? result?.error;
  const response =
    call?.response ??
    formatSubagentSummary({
      status,
      rawResponse: result?.response ?? "",
      outputFiles,
      diagnostics,
      ...(error ? { error } : {})
    });
  return {
    status,
    response,
    outputFiles,
    diagnostics,
    ...(error ? { error } : {}),
    ...(waited.claimedCallbacks ? { claimedCallbacks: waited.claimedCallbacks } : {})
  };
}

/** The result record a delegated process writes before it exits. */
async function readResultRecord(
  path: string
): Promise<{ response?: string; outputFiles?: string[]; error?: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as {
      response?: unknown;
      outputFiles?: unknown;
      error?: unknown;
    };
    return {
      response: typeof value.response === "string" ? value.response : undefined,
      outputFiles: Array.isArray(value.outputFiles)
        ? value.outputFiles.filter((entry): entry is string => typeof entry === "string")
        : undefined,
      error: typeof value.error === "string" ? value.error : undefined
    };
    // eslint-disable-next-line no-restricted-syntax -- 结果记录尚未写出或损坏时按没有结果处理，等待结果里的状态与错误已经是结论
  } catch {
    return undefined;
  }
}
