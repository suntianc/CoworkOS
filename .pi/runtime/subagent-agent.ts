import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { atomicWrite } from "../../dist/src/storage/atomic-file.js";
import { listAgentOutputFiles } from "../../dist/src/runtime/progress.js";
import { createCoworkModel } from "../../dist/src/runtime/model-profile.js";
import { atriaRoleIdentity } from "../../dist/src/domain/agent-identity.js";
import { agentDisplayName } from "../../dist/src/runtime/agent-identity.js";
import { delegationRoleGuidance } from "../../dist/src/runtime/delegation-model.js";
import { projectCompactionMessages } from "../../dist/src/runtime/compaction-input.js";
import { ASK_MAIN_GUIDANCE, SEND_PEER_MESSAGE_GUIDANCE } from "../../dist/src/runtime/subagent-guidance.js";
import type { ReviewConclusion } from "../../dist/src/runtime/subagent-review.js";
import { subagentToolNames, type SubagentRole } from "../../dist/src/runtime/subagent-roles.js";
import {
  configuredContextWindow,
  configuredModelApi,
  configuredSubagentMaxTokens,
  configuredSupportsImages,
  configuredSupportsPromptCacheKey,
  configuredSupportsReasoningEffort,
  configuredThinkingFormat,
  runtimeSettingsEnv
} from "../../dist/src/runtime/runtime-settings.js";
import { loadConfig } from "./helpers.ts";
import { registerCoworkProvider } from "./provider.ts";
import { MainCompactionRetry } from "./main-compaction-retry.ts";
import { registerSubagentInbox } from "./subagent-inbox.ts";
import { registerSubagentTools } from "./tools/subagent.ts";

/**
 * The delegated process half of the shared agent extension.
 *
 * A work item's conclusion is written by the process that produced it, before
 * that process exits: a backend that only watched an exit would have to guess.
 * The backend treats a missing record as a failure, so this record is the one
 * success signal for a delegated call. A Reviewer's record must additionally
 * carry a well-formed conclusion — the verdict is a structured fact, not prose
 * the backend would have to interpret.
 */

export type AgentRole = SubagentRole;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Agent process is missing ${name}`);
  return value;
}

function textFrom(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : ""
    )
    .join("")
    .trim();
}

export function registerSubagentAgent(pi: ExtensionAPI, role: AgentRole): void {
  const workspaceRoot = required("COWORK_WORKSPACE");
  const taskId = required("COWORK_TASK_ID");
  const runId = required("COWORK_RUN_ID");
  const callId = required("COWORK_SUBAGENT_CALL_ID");
  const agentId = required("COWORK_AGENT_ID");
  const token = required("COWORK_SUBAGENT_TOKEN");
  const resultPath = required("COWORK_SUBAGENT_RESULT");
  const taskWorkspace = join(workspaceRoot, taskId);
  const workingDirectory = resolve(process.cwd());
  const name = agentDisplayName(agentId);
  const deliverablesDirectory = join(taskWorkspace, "agents", "subagents", agentId, "deliverables");
  let submittedReview: ReviewConclusion | undefined;

  // The same provider the Main process registers, with this agent's session and
  // limits; without it Pi has no stream to the configured connection.
  const config = loadConfig();
  const runtimeEnv = runtimeSettingsEnv(config);
  const baseUrl = process.env.COWORK_API_BASE ?? config.baseUrl ?? config.apiBase ?? "";
  const apiKey = process.env.COWORK_API_KEY ?? config.apiKey;
  if (!baseUrl || !apiKey)
    throw new Error("CoworkOS model configuration is missing for the delegated agent process");
  const model = createCoworkModel({
    baseUrl,
    api: configuredModelApi(runtimeEnv),
    thinkingFormat: configuredThinkingFormat(runtimeEnv),
    model: process.env.COWORK_MODEL ?? config.model ?? "glm-5.3",
    maxTokens: configuredSubagentMaxTokens(runtimeEnv),
    contextWindow: configuredContextWindow(runtimeEnv),
    supportsImages: configuredSupportsImages(runtimeEnv),
    supportsReasoningEffort: configuredSupportsReasoningEffort(runtimeEnv)
  });
  registerCoworkProvider(pi, {
    model,
    apiKey,
    sessionId: `atria:${taskId}:${agentId}`,
    supportsPromptCacheKey: configuredSupportsPromptCacheKey(runtimeEnv)
  });

  const rolePrompt = subagentRolePrompt({
    role,
    name,
    workingDirectory,
    taskWorkspace,
    deliverablesDirectory
  });

  pi.on("session_start", async () => {
    // The role — not the extension entry — decides what this process may do.
    // Reviewer tools are read-only by construction, so an inactive write or
    // shell tool is not one a later tool discovery could switch back on.
    await mkdir(deliverablesDirectory, { recursive: true });
    pi.setActiveTools(subagentToolNames(role));
  });

  // Role text is additive: Pi's own tool list and rules stay, and the role
  // section states what this process is for. The transcript's identity line is
  // rewritten per request below, like Main does for its own sessions.
  pi.on("before_agent_start", async (event) => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 旧版 Pi 调用方可能只提供 systemPrompt，缺少结构化选项时走下面的回退分支
    if (event.systemPromptOptions) {
      event.systemPromptOptions.sections.subagent_role = rolePrompt;
      return;
    }
    return { systemPrompt: `${event.systemPrompt}\n\n<subagent_role>\n${rolePrompt}\n</subagent_role>` };
  });

  pi.on("context_with_system", (event) => ({
    messages: event.messages.map((message) =>
      message.role === "system" && message.sections
        ? {
            ...message,
            sections: {
              ...message.sections,
              preamble: atriaRoleIdentity("Subagent"),
              // The harness's own documentation pointer is Main's business; a
              // delegated work item reads the project, not the runtime.
              docs: null
            }
          }
        : message
    )
  }));

  // Delegated sessions compact the way Main does: Pi's native checkpoint, the
  // same projection of tool receipts into the summary input, and the same
  // cooldown after a failed automatic attempt.
  const compactionRetry = new MainCompactionRetry();
  pi.on("session_before_compact", (event, ctx) => {
    const skipped = compactionRetry.before(event, ctx.sessionManager.getSessionId(), ctx.model);
    if (skipped) return skipped;
    event.preparation.messagesToSummarize = projectCompactionMessages(event.preparation.messagesToSummarize);
    event.preparation.turnPrefixMessages = projectCompactionMessages(event.preparation.turnPrefixMessages);
    return undefined;
  });
  pi.on("session_compact", () => {
    compactionRetry.succeeded();
  });
  pi.on("session_compact_failed", (event) => {
    compactionRetry.failed(event);
  });

  registerSubagentTools(pi, {
    role,
    workspaceRoot,
    taskId,
    runId,
    callId,
    agentId,
    taskWorkspace,
    submitReview: (review) => {
      submittedReview = review;
    }
  });

  // Main's guidance and a peer's message reach this process through its own
  // durable Inbox; nothing about that channel is Main-specific.
  registerSubagentInbox(pi, { workspaceRoot, taskId, runId, agentId });

  // `agent_end` is the last hook Pi awaits before a --print host may dispose the
  // session, so the record is durable before the process can exit.
  pi.on("agent_end", async (event) => {
    const last = event.messages.findLast((message) => message.role === "assistant");
    const completed = Boolean(last && !["error", "aborted", "length"].includes(last.stopReason));
    const response = last && completed ? textFrom(last.content) : "";
    // eslint-disable-next-line no-restricted-syntax -- 候选文件扫描失败不应阻止写出本轮结论；没有列表比没有结果记录更接近事实
    const outputFiles = await listAgentOutputFiles({ workspaceRoot, taskId, agentId }).catch(() => []);
    const error = completed
      ? role === "reviewer" && !submittedReview
        ? "Reviewer ended without submitting a review conclusion; call submit_review with a verdict and findings."
        : undefined
      : (last?.errorMessage ?? `Subagent turn ended with stop reason ${last?.stopReason ?? "missing"}`);
    const termination = completed && !error && response ? "completed" : "failed";
    await atomicWrite(
      resultPath,
      `${JSON.stringify(
        {
          version: 1,
          taskId,
          runId,
          callId,
          agentId,
          role,
          token,
          termination,
          stopReason: last?.stopReason,
          response,
          outputFiles,
          ...(submittedReview ? { review: submittedReview } : {}),
          diagnostics: {
            tracePath: relative(taskWorkspace, join(taskWorkspace, "sessions", agentId, "pi", callId)),
            resultPath: relative(taskWorkspace, resultPath)
          },
          ...(error ? { error } : {}),
          completedAt: new Date().toISOString()
        },
        null,
        2
      )}\n`
    );
  });
}

/**
 * The role half of a delegated process's system prompt.
 *
 * The wording is the in-process dispatcher's, so the same role reads the same
 * way on either execution path; only the workspace facts and the tool set the
 * role actually holds are added here.
 */
function subagentRolePrompt(input: {
  role: SubagentRole;
  name: string;
  workingDirectory: string;
  taskWorkspace: string;
  deliverablesDirectory: string;
}): string {
  const shared = [
    delegationRoleGuidance({ role: input.role }),
    `Your team name is ${input.name}. Main and the UI use this stable name to identify your work.`,
    `Your working directory: ${input.workingDirectory}. File and command tools resolve relative paths from there.`,
    `Shared Task workspace (browse_workspace paths start here): ${input.taskWorkspace}.`,
    "Read the specific brief or source files named by Main. Use browse_workspace to inspect shared Task state, other Agents' progress and published artifacts when the task depends on them.",
    "The final response must be the complete conclusion, not progress narration. Do not claim work you did not perform. State any assumption you made and why."
  ];
  if (input.role === "reviewer")
    return [
      ...shared,
      "You are read-only: no edit or write tool and no shell tool are active. Examine the candidate, the diff and the evidence Main gave you; you cannot change the project, and you do not need to.",
      "Your conclusion reaches Main only through submit_review: verdict is pass or changes_requested, and every finding states its location, the evidence for it and whether it blocks acceptance. Call it when the examination is complete; a work item that ends without a submitted conclusion is recorded as a failure. A malformed submission is reported as an error and can be corrected.",
      ASK_MAIN_GUIDANCE,
      SEND_PEER_MESSAGE_GUIDANCE
    ].join("\n\n");
  return [
    ...shared,
    `Make the assigned change in ${input.workingDirectory}, run the checks that prove it, and return the evidence — command output, file paths and test results.`,
    `Put substantial reusable candidate outputs under ${input.deliverablesDirectory}; keep scratch files and intermediate logs in the work site. Do not write to Task artifacts/ — Main publishes accepted files.`,
    ASK_MAIN_GUIDANCE,
    SEND_PEER_MESSAGE_GUIDANCE
  ].join("\n\n");
}
