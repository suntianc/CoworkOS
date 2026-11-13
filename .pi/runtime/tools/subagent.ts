import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { agentDisplayName } from "../../../dist/src/runtime/agent-identity.js";
import {
  configuredSubagentMaxQuestions,
  configuredSubagentQuestionTimeout,
  runtimeSettingsEnv
} from "../../../dist/src/runtime/runtime-settings.js";
import { askMain } from "../../../dist/src/runtime/subagent-questions.js";
import { DurableScheduler } from "../../../dist/src/runtime/scheduler.js";
import { parseReviewConclusion, type ReviewConclusion } from "../../../dist/src/runtime/subagent-review.js";
import { sendPeerMessage, type PeerMessageResult } from "../../../dist/src/runtime/subagent-peer-message.js";
import {
  ASK_MAIN_TOOL_DESCRIPTION,
  SEND_PEER_MESSAGE_TOOL_DESCRIPTION
} from "../../../dist/src/runtime/subagent-guidance.js";
import { browseWorkspace } from "../../../dist/src/tools/builtin.js";
import { loadConfig } from "../helpers.ts";
import type { RuntimeToolResult } from "../helpers.ts";
import type { SubagentRole } from "../../../dist/src/runtime/subagent-roles.js";

/**
 * The tools a delegated Pi process registers for its role.
 *
 * Main's orchestration tools are absent by construction: this module registers
 * channels and the Reviewer's conclusion, and the role policy decides which of
 * Pi's own file and shell tools are active. A Subagent never reaches the
 * extension entry that registers call_subagent, finish_task or askhuman.
 */
export interface SubagentToolContext {
  role: SubagentRole;
  workspaceRoot: string;
  taskId: string;
  runId: string;
  callId: string;
  agentId: string;
  taskWorkspace: string;
  /** Record a well-formed conclusion; the result record writes it on exit. */
  submitReview(review: ReviewConclusion): void;
}

export function registerSubagentTools(pi: ExtensionAPI, context: SubagentToolContext): void {
  const runtimeEnv = runtimeSettingsEnv(loadConfig());
  // Bounds a Subagent that would rather ask than decide; per attempt, like the
  // in-process dispatcher, so a rework turn starts with a fresh budget.
  let asked = 0;

  pi.registerTool({
    name: "ask_main",
    label: "Ask Main",
    description: ASK_MAIN_TOOL_DESCRIPTION,
    promptSnippet: "Ask Main a blocking question with a declared fallback",
    parameters: Type.Object(
      {
        question: Type.String({
          description:
            "One concrete decision for Main, with enough context to answer it without reading your transcript."
        }),
        assumption: Type.String({
          description:
            "What you will do if nobody answers. Required, and it must be a course you can actually take."
        })
      },
      { additionalProperties: false }
    ),
    async execute(_toolCallId, params, signal): Promise<RuntimeToolResult> {
      const outcome = await askMain({
        workspaceRoot: context.workspaceRoot,
        taskId: context.taskId,
        runId: context.runId,
        callId: context.callId,
        agentId: context.agentId,
        agentName: agentDisplayName(context.agentId),
        question: params.question,
        assumption: params.assumption,
        timeoutMs: configuredSubagentQuestionTimeout(runtimeEnv),
        maxQuestions: configuredSubagentMaxQuestions(runtimeEnv),
        asked,
        isCancelled: async () => signal?.aborted === true || (await callCancelled(context)),
        cancellationWatchPaths: [
          join(context.workspaceRoot, context.taskId, "runs", context.runId, "queue.json")
        ]
      });
      if (outcome.status === "refused") {
        const payload = {
          status: "refused",
          reason: outcome.reason,
          instruction: outcome.instruction
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          details: payload,
          isError: true
        };
      }
      asked += 1;
      if (outcome.status === "answered") {
        const payload = {
          status: "answered",
          questionId: outcome.question.questionId,
          question: outcome.question.question,
          answer: outcome.question.answer
        };
        return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
      }
      if (outcome.status === "cancelled") throw new Error("Subagent was cancelled while waiting for Main");
      const payload = {
        status: "timeout",
        questionId: outcome.question.questionId,
        question: outcome.question.question,
        assumption: outcome.question.assumption,
        instruction:
          "Main did not answer in time. Continue under the assumption you declared and say so in your final summary."
      };
      return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
    }
  });

  pi.registerTool({
    name: "send_peer_message",
    label: "Send Peer Message",
    description: SEND_PEER_MESSAGE_TOOL_DESCRIPTION,
    promptSnippet: "Send a non-blocking message to another Subagent",
    parameters: Type.Object(
      {
        targetCallId: Type.String({ description: "The peer callId supplied by Main." }),
        message: Type.String({
          description: "A short question, correction or finding. Include a file or artifact path when useful."
        }),
        priority: Type.Optional(
          Type.Number({
            description: "Optional delivery priority; use a higher value only for time-sensitive guidance."
          })
        )
      },
      { additionalProperties: false }
    ),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      const targetCallId = params.targetCallId.trim();
      const message = params.message.trim();
      if (!targetCallId) throw new Error("send_peer_message requires targetCallId");
      if (!message) throw new Error("send_peer_message requires message");
      const result: PeerMessageResult = await sendPeerMessage({
        taskId: context.taskId,
        runId: context.runId,
        workspaceRoot: context.workspaceRoot,
        senderCallId: context.callId,
        targetCallId,
        message,
        priority: typeof params.priority === "number" ? params.priority : undefined
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    }
  });

  pi.registerTool({
    name: "browse_workspace",
    label: "Browse Workspace",
    description:
      "Read-only browser for the entire current Task workspace, not just your working directory. It can show the workspace structure and inspect other Agents' progress, working files, artifacts, sessions, run events, queue and manifests. It never modifies files or runs commands.",
    promptSnippet: "Inspect the shared Task workspace (read-only)",
    promptGuidelines: [
      "Use browse_workspace with mode=tree to understand the Task layout and other Agents' progress.",
      "Use browse_workspace with mode=read for a known artifact, session, event or Agent file, and mode=search to locate evidence across the workspace."
    ],
    parameters: Type.Object({
      mode: Type.Optional(Type.Union([Type.Literal("tree"), Type.Literal("read"), Type.Literal("search")])),
      path: Type.Optional(
        Type.String({
          description: "Relative path inside the Task workspace; default is the workspace root."
        })
      ),
      query: Type.Optional(Type.String({ description: "Text to search for when mode=search." })),
      offset: Type.Optional(
        Type.Number({
          description: "Byte offset for mode=read; use nextOffset from a truncated result to continue."
        })
      ),
      depth: Type.Optional(Type.Number({ description: "Tree depth, default 2." })),
      maxEntries: Type.Optional(Type.Number({ description: "Maximum entries or matches, default 200." }))
    }),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      const result = await browseWorkspace({ workspaceDirectory: context.taskWorkspace }, params);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    }
  });

  if (context.role !== "reviewer") return;
  pi.registerTool({
    name: "submit_review",
    label: "Submit Review",
    description:
      "Submit the review conclusion Main acts on. Call it once the examination is complete: verdict is pass or changes_requested, and every finding states where it is, what supports it and whether it blocks acceptance. A work item that ends without a submitted conclusion is recorded as a failure. A malformed submission is reported as an error and can be retried.",
    promptSnippet: "Submit the review verdict and findings",
    promptGuidelines: [
      "Call submit_review once the examination is complete: it is how Main receives your verdict.",
      "Use verdict=changes_requested only with at least one finding, and set blocking=true for findings that must be fixed before acceptance.",
      "A pass may still carry non-blocking findings; it must not carry a blocking one.",
      "Location is a file path or path:line, evidence names what you actually observed (command output, code, test result), and findings must be checkable by the Executor."
    ],
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal("pass"), Type.Literal("changes_requested")]),
      findings: Type.Array(
        Type.Object(
          {
            location: Type.String({ description: "File path, path:line, or the named area examined." }),
            evidence: Type.String({
              description:
                "What you observed and what supports the finding: code, command output or test result."
            }),
            blocking: Type.Boolean({
              description: "Whether this finding must be resolved before the result is accepted."
            })
          },
          { additionalProperties: false }
        ),
        { maxItems: 100 }
      )
    }),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      const parsed = parseReviewConclusion(params);
      if (!parsed.ok) {
        const payload = { submitted: false, errors: parsed.errors };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          details: payload,
          isError: true
        };
      }
      context.submitReview(parsed.review);
      const payload = {
        submitted: true,
        verdict: parsed.review.verdict,
        findings: parsed.review.findings.length,
        blocking: parsed.review.findings.filter((finding) => finding.blocking).length
      };
      return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
    }
  });
}

/** Whether the backend cancelled this call while the question was waiting. */
async function callCancelled(context: SubagentToolContext): Promise<boolean> {
  const items = await new DurableScheduler(
    join(context.workspaceRoot, context.taskId, "runs", context.runId, "queue.json")
  ).list();
  return items.find((item) => item.stepId === context.callId)?.status === "cancelled";
}
