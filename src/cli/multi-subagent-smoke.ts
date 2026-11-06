import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinatorRuntime } from "../runtime/coordinator-runtime.js";
import { readHostCoworkConfig } from "../runtime/config.js";
import {
  configuredModelApi,
  configuredContextWindow,
  configuredThinkingFormat,
  configuredReasoningEffort,
  configuredSupportsReasoningEffort,
  configuredSupportsImages,
  runtimeSettingsEnv
} from "../runtime/runtime-settings.js";

const config = readHostCoworkConfig();
const runtimeEnv = runtimeSettingsEnv(config);
const apiKey = process.env.COWORK_API_KEY ?? config.apiKey;
const baseUrl = process.env.COWORK_API_BASE ?? config.baseUrl;
if (!apiKey || !baseUrl)
  throw new Error("Set COWORK_API_BASE and COWORK_API_KEY before running smoke:multi-subagent");

const taskId = `multi-subagent-smoke-${Date.now()}`;
const parent = process.env.COWORK_WORKSPACE ?? tmpdir();
await mkdir(parent, { recursive: true });
const workspaceRoot = await mkdtemp(join(parent, "cowork-multi-subagent-smoke-"));
const runId = `run-${randomUUID()}`;
const runtime = new CoordinatorRuntime();
const started = Date.now();
const common = {
  taskId,
  runId,
  workspaceRoot,
  baseUrl,
  apiKey,
  model: process.env.COWORK_MODEL ?? config.model ?? "glm-5.3",
  thinkingLevel: configuredReasoningEffort(runtimeEnv),
  api: configuredModelApi(runtimeEnv),
  thinkingFormat: configuredThinkingFormat(runtimeEnv),
  supportsReasoningEffort: configuredSupportsReasoningEffort(runtimeEnv),
  supportsImages: configuredSupportsImages(runtimeEnv),
  maxTurns: 2,
  maxTokens: 1024,
  contextWindow: configuredContextWindow(runtimeEnv),
  maxAttempts: 1,
  maxErrorRetries: 0,
  timeoutMs: 120_000,
  skillRoots: [],
  toolFactory: () => new Map()
};
let succeeded = false;
try {
  const results = await Promise.all([
    runtime.dispatch({
      ...common,
      agentId: "subagent_1",
      task: "给出两个代码变更审查要点；直接回答，禁止使用工具。",
      mode: "async"
    }),
    runtime.dispatch({
      ...common,
      agentId: "subagent_2",
      task: "给出两个测试审查要点；直接回答，禁止使用工具。",
      mode: "async"
    })
  ]);
  const coordination = await runtime.waitForSubagents({
    ...common,
    timeoutMs: 0,
    waitForCallbackConsumption: false
  });
  const ok =
    results.every((result) => result.status === "succeeded") &&
    coordination.pending.length === 0 &&
    coordination.callbackPending.length === 2;
  console.log(
    JSON.stringify({
      ok,
      model: common.model,
      elapsedMs: Date.now() - started,
      ...(!ok ? { workspaceRoot } : {}),
      agents: results.map((result) => ({
        agentId: result.agentId,
        status: result.status,
        response: result.response
      })),
      pending: coordination.pending,
      callbackPending: coordination.callbackPending
    }).replaceAll(apiKey, "[redacted]")
  );
  if (!ok) process.exitCode = 1;
  succeeded = ok;
} finally {
  if (succeeded) await rm(workspaceRoot, { recursive: true, force: true });
}
