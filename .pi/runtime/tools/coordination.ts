import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { metricSeries } from "../../../dist/src/domain/experiment.js";
import { reserveSubagentIdentity } from "../../../dist/src/runtime/agent-identity.js";
import { clearSleep, readSleep, writeSleep } from "../../../dist/src/runtime/main-sleep.js";
import { readSubagentProgress } from "../../../dist/src/runtime/progress.js";
import {
  configuredHumanAnswerTimeout,
  configuredMaxAttempts,
  configuredSubagentMaxQuestions,
  configuredModelApi,
  configuredThinkingFormat,
  configuredSupportsPromptCacheKey,
  configuredSubagentMaxTokens,
  configuredContextWindow,
  configuredSubagentMaxTurns,
  configuredSubagentQuestionTimeout,
  configuredSubagentTimeout
} from "../../../dist/src/runtime/runtime-settings.js";
import { assessTaskCompletion } from "../../../dist/src/runtime/task-completion.js";
import { LocalWorkspaceStore } from "../../../dist/src/workspace/workspace-store.js";
import { businessCommandEnvironment } from "../../../dist/src/runtime/command-environment.js";
import { WatchManagement } from "../../../dist/src/runtime/watch-management.js";
import type { DelegatedModelRequest } from "../../../dist/src/runtime/role-models.js";
import { createProjectDevelopmentClient } from "../../../dist/src/runtime/project-development-client.js";
import { DurableScheduler } from "../../../dist/src/runtime/scheduler.js";
import { dirname, join } from "node:path";
import { goalOwnsTaskClock } from "../../../dist/src/runtime/goal-routing.js";
import type { CoworkToolContext } from "../extension.ts";
import type { RuntimeToolResult } from "../helpers.ts";

import { errorMessage } from "../helpers.ts";
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
          await context.humanStore.consumeAnswerMessage(context.taskId, request.requestId).catch(() => {
            /* nothing was queued */
          });
          await new LocalWorkspaceStore(context.workspaceRoot)
            .transitionTask(context.taskId, "running", { runId: context.mainRunId, reason: "human_answered" })
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
        await context.humanStore.markUnanswered(context.taskId, request.requestId).catch(() => {});
        await new LocalWorkspaceStore(context.workspaceRoot)
          .transitionTask(context.taskId, "running", {
            runId: context.mainRunId,
            reason: "human_answer_timeout"
          })
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
      "Record that this Task's work is done for now and that you expect to be woken later — by a registered Virtual Agent's event, or after a stated interval. The Task stays open across process restarts and the wake arrives through the normal Inbox. Ending a turn is not sleeping: without this record a Task with no outstanding work is treated as finished.",
    promptSnippet: "Park this Task until an event or a stated interval wakes it",
    promptGuidelines: [
      "Use this when the objective is ongoing but nothing can advance it right now: the monitors are registered, this round's result is written, and the next useful action waits on the world changing or on time passing.",
      "Update agents/main/context/memory.md before parking. After a wake the model context may be new; what is not in memory is not carried over.",
      "Set wakeInSeconds when the next action is periodic, such as refreshing a report or reviewing monitor quality. Omit it when only a real external change should be worth a model run.",
      "When parking for a managed long-term goal, pass its programId. Schedule its reviews with record_goal_progress(nextReviewAt); watcher cadence never schedules a Main model poll. Omit programId for independent work in a shared session.",
      "A park with neither wakeInSeconds nor an active monitor is refused: nothing could wake it."
    ],
    parameters: Type.Object({
      reason: Type.String({
        description: "Why this Task is parked and what you will do next, in your own terms."
      }),
      programId: Type.Optional(
        Type.String({
          description:
            "Managed goal this wait belongs to. Its events or nextReviewAt wake Main; wakeInSeconds is ignored. Omit for independent Task timers."
        })
      ),
      wakeInSeconds: Type.Optional(
        Type.Number({
          description:
            "Wake after this many seconds even with no event. Minimum 60. Omit for event-only wake."
        })
      ),
      monitorIds: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Monitors you are relying on, from get_subagent_status. Omit for a timer alone; event-only waits default to active monitors on the specified goal or this Task."
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<RuntimeToolResult> {
      const active: string[] = [];
      let scheduledGoal = false;
      const programs = await context.watchStore.listPrograms(context.taskId);
      const programId = typeof params.programId === "string" ? params.programId.trim() : undefined;
      const goal = programs.find((program) => program.programId === programId && program.goal);
      if (params.programId !== undefined && !goal) {
        const result = {
          parked: false,
          reason: "invalid_goal",
          note: "programId must name a managed goal on this Task. Omit it for independent work."
        };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, isError: true };
      }
      if (goal && ["paused", "completed"].includes(goal.status)) {
        const result = {
          parked: false,
          reason: "inactive_goal",
          note: "Park only active goals. Paused goals need an explicit resume; completed goals cannot be parked."
        };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, isError: true };
      }
      for (const program of goal ? [goal] : programs) {
        if (program.status === "paused" || program.status === "completed") continue;
        if (program.goal?.nextReviewAt || program.goal?.disposition === "needs_input") scheduledGoal = true;
        for (const monitor of await context.watchStore.listVirtualAgents(context.taskId, program.programId)) {
          if (monitor.status === "active") active.push(monitor.monitorId);
        }
      }
      // The 60s floor matches the watcher cadence floor: below it the supervisor
      // would not observe the deadline any sooner anyway.
      const requestedWakeInSeconds =
        typeof params.wakeInSeconds === "number" && Number.isFinite(params.wakeInSeconds)
          ? Math.max(60, Math.floor(params.wakeInSeconds))
          : undefined;
      const requested = Array.isArray(params.monitorIds)
        ? params.monitorIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        : [];
      if (requested.some((monitorId) => !active.includes(monitorId))) {
        const result = {
          parked: false,
          reason: "inactive_monitor",
          note: goal
            ? "monitorIds must name active monitors belonging to the specified goal."
            : "monitorIds must name active monitors on this Task. Read get_subagent_status before parking."
        };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, isError: true };
      }
      const task = await new LocalWorkspaceStore(context.workspaceRoot).readTask(context.taskId);
      const taskClockIgnored =
        Boolean(requestedWakeInSeconds) &&
        goalOwnsTaskClock(programs, task.monitoring?.scope === "background", programId);
      const wakeInSeconds = taskClockIgnored ? undefined : requestedWakeInSeconds;
      // Whether a wake condition exists is countable, so refusing is mechanical.
      // What it would take to create one is Main's decision, not this tool's.
      if (!wakeInSeconds && active.length === 0 && !scheduledGoal) {
        const refusal = {
          parked: false,
          reason: "no_wake_condition",
          note: taskClockIgnored
            ? "Managed goals need an active source or an explicit record_goal_progress(nextReviewAt); watcher cadence must not wake Main."
            : "Nothing could wake this Task: no active Virtual Agent is registered and no interval was given. Register a monitor with activate_virtual_agent, pass wakeInSeconds, or finish the Task instead."
        };
        return {
          content: [{ type: "text", text: JSON.stringify(refusal) }],
          details: refusal,
          isError: true
        };
      }
      const sleep = {
        runId: context.mainRunId,
        reason: String(params.reason ?? "").trim(),
        ...(wakeInSeconds ? { wakeAt: new Date(Date.now() + wakeInSeconds * 1_000).toISOString() } : {}),
        monitorIds: requested.length > 0 ? requested : wakeInSeconds ? [] : active,
        parkedAt: new Date().toISOString()
      };
      await writeSleep(context.workspaceRoot, context.taskId, sleep);
      // The lifecycle stays with the completion gate two hooks later: one
      // mechanism decides whether the Task is running, waiting or finished.
      context.updateRuntime({
        runtimePhase: "waiting",
        runtimeLastEvent: { type: "main_parked", summary: sleep.reason.slice(0, 240) }
      });
      ctx.ui.notify(
        sleep.wakeAt ? `Parked until ${sleep.wakeAt}` : `Parked for ${sleep.monitorIds.length} monitor(s)`,
        "info"
      );
      const payload = {
        parked: true,
        ...sleep,
        activeMonitors: active.length,
        ...(taskClockIgnored
          ? {
              taskClockIgnored: true,
              note: "No Main polling clock was armed. Goal reviews use record_goal_progress(nextReviewAt); source cadence only runs deterministic probes."
            }
          : {})
      };
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
      "Delegate one concrete work item to a Subagent. sync waits for the result; async returns a callId and delivers the result by callback. Both modes execute the task once. role names the job (executor implements, reviewer examines an independent session); dependsOn holds the item until earlier callIds finish; developmentId runs it in that requirement's isolated checkout. Optional resources explicitly grant application read access or private candidate editing; no bound application is inherited automatically. Task wording never creates a persistent monitor or experiment program.",
    promptSnippet: "Delegate a concrete task",
    promptGuidelines: [
      "Use call_subagent when an independent analysis, implementation or validation task is likely to improve the result.",
      "Give each delegate an independently testable objective, relevant inputs, constraints and acceptance evidence. Independent end-to-end attempts are valid when they help compare approaches; avoid a fixed research/production/review pipeline for every task.",
      "Set mode=sync to wait for the result; set mode=async to continue independent work and receive a callback. Wait for any result needed for acceptance before completing the parent task.",
      "The task must state a concrete objective and expected evidence; ask for a deliverables/ file only when the result is a substantial reusable artifact. Main may issue multiple independent calls in one turn.",
      "A request to research monitoring, design a Virtual Agent or run an experiment is still an ordinary task. This tool does not register or activate persistent programs.",
      "The Subagent returns a concise summary with evidence, candidate outputFiles, diagnostic paths and validation results. Candidate files remain in the Subagent's directory until Main accepts and copies selected files into the Task artifacts directory.",
      "Use role=reviewer for an independent check of a result; it starts its own session, so it must be given the candidate and evidence to examine rather than asked to trust the Executor's summary.",
      "Pass dependsOn only for work that genuinely needs an earlier item's result: a dependent item does not start until those calls finish, and does not run at all when one of them failed or was cancelled. Independent work should be dispatched without dependsOn so it can proceed at once.",
      "Pass developmentId when the work belongs to a requirement with an isolated checkout. ensure_workspace first; the checkout — not the user's working tree — is then the delegate's project directory."
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
        resources: Type.Optional(
          Type.Array(
            Type.Object(
              {
                resourceId: Type.String(),
                access: Type.Union([Type.Literal("read"), Type.Literal("candidate")])
              },
              { additionalProperties: false }
            ),
            {
              maxItems: 16,
              description:
                "Only these referenced resources are shared. read exposes read-only domain tools; candidate creates private changes for Main to review and accept_resource_candidate. Omit for ordinary independent tasks."
            }
          )
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
              "Run this work item in the isolated requirement checkout recorded for this development. Its directory, not the user's working tree, becomes the delegate's project directory; ensure_workspace must have made it ready."
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
      const goal = String(params.task ?? "").trim();
      if (!goal) throw new Error("call_subagent requires task");
      if (params.mode !== "sync" && params.mode !== "async")
        throw new Error("call_subagent mode must be sync or async");
      const role = params.role ?? "executor";
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
      if (dependsOn.length > 0) {
        // Refuse an unusable dependency before this call owns a name or an
        // experiment row: a refusal here must leave no durable trace behind.
        const queue = new DurableScheduler(
          join(context.workspaceRoot, context.taskId, "runs", context.mainRunId, "queue.json")
        );
        const known = new Set((await queue.list()).map((item) => item.stepId));
        const unknown = dependsOn.filter((stepId) => !known.has(stepId));
        if (unknown.length > 0)
          throw new Error(
            `dependsOn 引用了本 Run 中不存在的工作项：${unknown.join("、")}；只能依赖已委派的 callId`
          );
      }
      const explicitProfileId = typeof params.profileId === "string" ? params.profileId.trim() : "";
      const explicitModel = typeof params.model === "string" ? params.model.trim() : "";
      // The requirement checkout is read from this backend's own record: an
      // arbitrary path from the model is never accepted as a working root.
      const requestedDevelopment =
        typeof params.developmentId === "string" ? params.developmentId.trim() : "";
      const developmentWorkspace = requestedDevelopment
        ? await developmentWorkspaceDirectory(context, requestedDevelopment)
        : undefined;
      const capabilityGrants = await context.delegationGrants(params.resources, params.attachments);
      const commandEnv = await businessCommandEnvironment(context.runtimeEnv, signal);
      const { agentId, name } = await reserveSubagentIdentity(context.taskWorkspace);
      const callId = `call-${randomUUID()}`;
      // A bound item gets its own checkout beside the integration site, forked
      // at its actual start; the item never writes the integration site itself.
      const workItemSite = developmentWorkspace
        ? {
            developmentDirectory: developmentWorkspace.directory,
            directory: join(dirname(developmentWorkspace.directory), "work-items", callId),
            branch: `coworkos/work/${callId}`
          }
        : undefined;
      // An open experiment absorbs this delegation automatically. Attribution
      // follows the program Main opened, never the wording of the task, so a
      // Task with no open program still records nothing.
      const experimentRef = await context.openExperimentRun({ callId, agentId, objective: goal });
      // A role binding is resolved on this host when the item starts, so only
      // the non-sensitive request travels with the work item.
      const projectId = await projectIdForTask(context);
      const delegation = {
        role,
        ...(projectId ? { projectId } : {}),
        ...(explicitProfileId ? { profileId: explicitProfileId } : {}),
        ...(explicitModel ? { model: explicitModel } : {})
      } satisfies DelegatedModelRequest;
      let markQueued!: () => void;
      const queued = new Promise<void>((resolve) => {
        markQueued = resolve;
      });
      const run = context.coordinator.dispatch({
        taskId: context.taskId,
        runId: context.mainRunId,
        callId,
        agentId,
        task: goal,
        mode: params.mode,
        workspaceRoot: context.workspaceRoot,
        commandEnv,
        projectDirectory: workItemSite?.directory ?? context.projectDirectory,
        delegation,
        ...(workItemSite ? { workItemSite, developmentId: requestedDevelopment } : {}),
        ...(dependsOn.length > 0 ? { dependsOn } : {}),
        baseUrl: context.baseUrl,
        apiKey: context.apiKey,
        model: context.modelId,
        thinkingLevel: context.currentThinkingLevel(),
        api: configuredModelApi(context.runtimeEnv),
        thinkingFormat: configuredThinkingFormat(context.runtimeEnv),
        supportsReasoningEffort: context.supportsReasoningEffort,
        supportsPromptCacheKey: configuredSupportsPromptCacheKey(context.runtimeEnv),
        supportsImages: context.supportsImages,
        visionModel: context.visionModel,
        context: context.recentContext,
        maxTurns: configuredSubagentMaxTurns(context.runtimeEnv),
        maxTokens: configuredSubagentMaxTokens(context.runtimeEnv),
        contextWindow: configuredContextWindow(context.runtimeEnv),
        timeoutMs: configuredSubagentTimeout(context.runtimeEnv),
        maxAttempts: configuredMaxAttempts(context.runtimeEnv),
        questionTimeoutMs: configuredSubagentQuestionTimeout(context.runtimeEnv),
        maxQuestions: configuredSubagentMaxQuestions(context.runtimeEnv),
        web: context.web,
        ...context.skillScopeNow(),
        capabilityGrants,
        capabilityProvider: context.capabilityProvider,
        onQueued: markQueued,
        experimentRef,
        callbackMetadata: experimentRef
      });
      if (params.mode === "async") {
        context.active += 1;
        ctx.ui.setStatus("cowork", `子任务运行中（${context.active}）`);
        let acceptedDurably = false;
        queued.then(() => {
          acceptedDurably = true;
        });
        void run
          .then(
            () =>
              context.deliverCallbacks().catch((error) => {
                try {
                  ctx.ui.notify(`Async callback delivery deferred: ${errorMessage(error)}`, "warning");
                } catch {
                  // Main may have stopped while the Subagent was still running.
                  // Delivery releases its Inbox lease, so the next Main can recover it.
                }
              }),
            (error) => {
              // A start refusal is reported by this call's own tool result; the
              // callback path never began, so delivery wording would misattribute it.
              if (!acceptedDurably) return;
              try {
                ctx.ui.notify(`Subagent start failed: ${errorMessage(error)}`, "warning");
              } catch {
                /* the Main that started it may already be gone */
              }
            }
          )
          .finally(() => {
            context.active -= 1;
            context.updateRuntime({
              runtimePendingDelegations: context.active + context.inboxDelivery.queuedCount
            });
            try {
              ctx.ui.setStatus("cowork", context.active ? `子任务运行中（${context.active}）` : "");
            } catch {
              // A disposed UI must not reject this detached cleanup promise.
            }
          });
        await Promise.race([queued, run]);
        context.updateRuntime({
          runtimePendingDelegations: context.active,
          runtimeRouting: { strategy: "async", reason: goal.slice(0, 240) },
          runtimeLastEvent: { type: "subagent_accepted", summary: `${callId}: ${goal.slice(0, 180)}` }
        });
        const payload = {
          accepted: true,
          mode: "async",
          callId,
          runId: context.mainRunId,
          agentId,
          name,
          role,
          ...(workItemSite ? { developmentId: requestedDevelopment, workspace: workItemSite.directory } : {}),
          ...(dependsOn.length > 0 ? { dependsOn } : {})
        };
        return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
      }
      try {
        const result = await run;
        context.updateRuntime({
          runtimeRouting: { strategy: "sync", reason: goal.slice(0, 240) },
          runtimeLastEvent: { type: "subagent_completed", summary: `${result.callId}: ${result.status}` }
        });
        const payload = {
          callId: result.callId,
          runId: result.runId,
          agentId: result.agentId,
          name,
          role,
          ...(workItemSite ? { developmentId: requestedDevelopment, workspace: workItemSite.directory } : {}),
          ...(dependsOn.length > 0 ? { dependsOn } : {}),
          status: result.status,
          response: result.response,
          artifacts: result.artifacts.map((artifact) => artifact.relativePath),
          outputFiles: result.outputFiles ?? [],
          diagnostics: result.diagnostics,
          error: result.error
        };
        return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: errorMessage(error) }) }],
          details: { ok: false, error: errorMessage(error) }
        };
      }
    }
  });

  pi.registerTool({
    name: "send_subagent_message",
    label: "Send Subagent Message",
    description:
      "Queue a message from Main to a running Subagent or durable Virtual Agent, or answer a question a Subagent asked. The message is durable and delivered at a safe turn boundary; it does not interrupt an in-flight model request. Pass questionId to answer a pending question — that Subagent is blocked waiting for it. For an existing persistent monitor, pass its monitorId from get_subagent_status.",
    promptSnippet: "Answer a Subagent's question or send it guidance",
    promptGuidelines: [
      "Use the callId returned by call_subagent; for an existing persistent monitor, use its monitorId from get_subagent_status to send rule or scope corrections.",
      "To answer a question a Subagent asked, pass both its callId and the questionId from the question, and put the decision in message. That Subagent is blocked and its wait is bounded, so answer before doing other work; a late answer still arrives as ordinary guidance, but it will already have continued on its stated assumption.",
      "Messages are queued durably and will be injected before the Subagent's next turn; a queued response is not proof that the Subagent has already acted on it.",
      "Guidance to a paused monitor is retained without resuming it. Only an explicit control-plane resume may restart monitoring; a timeout or a message is not permission to resume.",
      "Keep the message focused: one correction, new constraint, or concrete follow-up requirement."
    ],
    parameters: Type.Object({
      callId: Type.String({
        description:
          "The callId returned by call_subagent, or an existing monitorId from get_subagent_status."
      }),
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
      const callId = String(params.callId ?? "");
      const message = String(params.message ?? "").trim();
      if (!callId || !message) throw new Error("send_subagent_message requires callId and message");
      const questionId =
        typeof params.questionId === "string" && params.questionId.trim()
          ? params.questionId.trim()
          : undefined;
      if (questionId) {
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
      const persistent = await context.watchStore.findVirtualAgent(context.taskId, callId);
      const result = persistent
        ? {
            messageId: (
              await context.watchStore.enqueueControl(
                context.taskId,
                callId,
                message,
                typeof params.priority === "number" ? params.priority : undefined
              )
            ).messageId,
            callId,
            agentId: callId,
            status: (await context.watchStore.findVirtualAgent(context.taskId, callId))!.monitor.status,
            persistent: true
          }
        : await context.coordinator.sendMessage({
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
    description:
      "Cancel a queued or running Subagent, or pause a durable Virtual Agent. A persistent monitor can later be resumed by changing its status through the control plane.",
    promptSnippet: "Cancel a Subagent",
    parameters: Type.Object({
      callId: Type.String({
        description:
          "The callId returned by call_subagent, or an existing monitorId from get_subagent_status."
      }),
      reason: Type.Optional(Type.String({ description: "Short reason for cancelling the work." }))
    }),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      const callId = String(params.callId ?? "");
      const persistent = await context.watchStore.findVirtualAgent(context.taskId, callId);
      const result = persistent
        ? await new WatchManagement(context.workspaceRoot, context.harnessRoot)
            .control(context.taskId, callId, "pause")
            .then((monitor) => ({ callId, agentId: callId, status: "paused", persistent: true, monitor }))
        : await context.coordinator.cancelSubagent({
            taskId: context.taskId,
            runId: context.mainRunId,
            workspaceRoot: context.workspaceRoot,
            callId,
            reason: typeof params.reason === "string" ? params.reason : undefined
          });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    }
  });

  pi.registerTool({
    name: "get_subagent_status",
    label: "Get Subagent Status",
    description:
      "Return a compact structured snapshot of every Subagent in the current Task, including one-shot calls and dormant/running persistent Subagents: task, mode, status, elapsed time, model turns, message count, last tool, last assistant text, pending Main messages, latest lifecycle event, last trace activity, published artifacts, pending callbacks and persistent monitor state. Use this instead of reading many workspace files when checking progress.",
    promptSnippet: "Check structured progress for all one-shot and persistent Subagents",
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
      const persistent = [];
      for (const program of await context.watchStore.listPrograms(context.taskId)) {
        for (const monitor of await context.watchStore.listVirtualAgents(context.taskId, program.programId)) {
          if (params.agentId && params.agentId !== monitor.monitorId) continue;
          persistent.push({
            program,
            monitor,
            state: await context.watchStore.readVirtualAgentState(
              context.taskId,
              program.programId,
              monitor.monitorId
            ),
            pendingControls: await context.watchStore.listControls(
              context.taskId,
              program.programId,
              monitor.monitorId
            )
          });
        }
      }
      const virtualPrograms = await context.virtualAgentStore.listPrograms(context.taskId);
      const result = { ...progress, persistent, virtualPrograms };
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
      const virtualPrograms = await context.virtualAgentStore.listPrograms(context.taskId);
      const result = { task, coordination, experiments, virtualPrograms };
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
      "If it reports a pending Subagent question, answer it with send_subagent_message before completing: that collaborator is blocked on you.",
      "If the Task was parked for a later wake, completing it ends that monitoring program. Retire or pause the monitors first if they should stop polling."
    ],
    parameters: Type.Object({
      summary: Type.Optional(Type.String({ description: "Short human-readable completion summary." }))
    }),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      const goals = (await context.watchStore.listPrograms(context.taskId)).filter(
        (program) => program.goal && program.status !== "completed"
      );
      if (goals.length) {
        const value = {
          completed: false,
          reason: "active_long_term_goals",
          goals: goals.map((program) => ({ programId: program.programId, title: program.goal!.brief.title })),
          note: "Record progress and wait. Complete each goal only after verifying its criteria."
        };
        return { content: [{ type: "text", text: JSON.stringify(value) }], details: value, isError: true };
      }
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
        pendingCalls: Math.max(context.active, coordination.pending.length) + Number(context.recoveryActive),
        pendingJobs: await context.pollJobs(),
        pendingCallbacks: Math.max(context.inboxDelivery.queuedCount, coordination.callbackPending.length),
        pendingHumanRequests: (await context.humanStore.list(context.taskId, "pending")).length,
        pendingSubagentQuestions: (await context.questionStore.list(context.taskId, "pending")).length
      });
      if (!assessment.ready) {
        const result = { completed: false, reason: assessment.reason, coordination };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, isError: true };
      }
      const parked = await readSleep(context.workspaceRoot, context.taskId).catch(() => undefined);
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

/** The project this conversation belongs to, used only for a role's project override. */
async function projectIdForTask(context: CoworkToolContext): Promise<string | undefined> {
  return (await new LocalWorkspaceStore(context.workspaceRoot).readTask(context.taskId)).projectId;
}

/**
 * The isolated checkout this backend recorded for one development.
 *
 * Read back through the same Task-scoped service the development tool uses, so
 * the directory is this backend's own workspace row instead of a path the model
 * named. A workspace that is not ready is refused here rather than handed to a
 * delegate as a working tree.
 */
async function developmentWorkspaceDirectory(
  context: CoworkToolContext,
  developmentId: string
): Promise<{ directory: string }> {
  const dashboardUrl = process.env.COWORK_DASHBOARD_URL;
  if (!dashboardUrl) throw new Error("需求现场不可用：本次运行没有本地服务地址");
  const request = createProjectDevelopmentClient({ dashboardUrl, taskId: context.taskId });
  const body = await request({ action: "get", developmentId });
  const workspace = (body.development as { workspace?: { directory?: unknown; state?: unknown } } | undefined)
    ?.workspace;
  const directory = typeof workspace?.directory === "string" ? workspace.directory : "";
  if (!directory || workspace?.state !== "ready")
    throw new Error(
      `需求现场尚未就绪（${developmentId}）；先调用 project_development ensure_workspace 恢复现场后再委派`
    );
  return { directory };
}
