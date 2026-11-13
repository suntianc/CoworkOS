import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { relative, join } from "node:path";
import { atomicWrite } from "../../dist/src/storage/atomic-file.js";
import { listAgentOutputFiles } from "../../dist/src/runtime/progress.js";
import { createCoworkModel } from "../../dist/src/runtime/model-profile.js";
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

/**
 * The delegated process half of the shared agent extension.
 *
 * A work item's conclusion is written by the process that produced it, before
 * that process exits: a backend that only watched an exit would have to guess.
 * The backend treats a missing record as a failure, so this record is the one
 * success signal for a delegated call.
 */

export type AgentRole = "executor" | "reviewer";

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

  // `agent_end` is the last hook Pi awaits before a --print host may dispose the
  // session, so the record is durable before the process can exit.
  pi.on("agent_end", async (event) => {
    const last = event.messages.findLast((message) => message.role === "assistant");
    const completed = Boolean(last && !["error", "aborted", "length"].includes(last.stopReason));
    const response = last && completed ? textFrom(last.content) : "";
    // eslint-disable-next-line no-restricted-syntax -- 候选文件扫描失败不应阻止写出本轮结论；没有列表比没有结果记录更接近事实
    const outputFiles = await listAgentOutputFiles({ workspaceRoot, taskId, agentId }).catch(() => []);
    const error = completed
      ? undefined
      : (last?.errorMessage ?? `Subagent turn ended with stop reason ${last?.stopReason ?? "missing"}`);
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
          termination: completed && response ? "completed" : "failed",
          stopReason: last?.stopReason,
          response,
          outputFiles,
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
