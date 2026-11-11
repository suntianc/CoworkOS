import { proxyEnvironment, type HttpProxyConfig } from "./http-transport.js";
import { atriaDataPaths } from "../../scripts/data-home.cjs";

/**
 * Centralized runtime knobs.  Main and Subagent deadlines are intentionally
 * separate: a long-running delegated job must not accidentally inherit the
 * interactive Main deadline (or vice versa).
 */

export const DEFAULT_MAX_TURNS = 200;
/**
 * Main runs the outer loop, so it spends turns across many rounds rather than
 * one task: reading results, revising a pipeline, launching work, polling it.
 * A limit sized for a single request would end an optimization mid-run.
 */
export const DEFAULT_MAIN_MAX_TURNS = 2_000;
export const DEFAULT_MAX_TOKENS = 65_536;
export const DEFAULT_CONTEXT_WINDOW = 256_000;
/**
 * Deadline for one tool-invoked command when nothing supervises it.
 *
 * A Task granted `longRunning` gets a supervised command instead: the model
 * watches for output and decides whether a quiet job is working or wedged,
 * which a fixed number cannot tell apart. This value is the fallback for
 * everything else. Thirty minutes covers a test suite, a dependency install or
 * a build without a hung command holding a turn open forever; a genuinely long
 * job belongs in start_job.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60_000;
/** Attempts per delegated call. A Task expecting expensive jobs lowers it to one. */
export const DEFAULT_MAX_ATTEMPTS = 3;
/**
 * How long a Subagent waits for Main to answer a question before continuing
 * under its own stated assumption.
 *
 * The wait is bounded because Main may be busy, restarting or gone, and a
 * Subagent blocked forever is worse than one that proceeds on a declared guess.
 * Three minutes is long enough for Main to finish a turn and read the question,
 * short enough that a dead Main costs one wait rather than a whole run.
 */
export const DEFAULT_SUBAGENT_QUESTION_TIMEOUT_MS = 3 * 60_000;
/**
 * How long `askhuman` waits for the person before deciding for itself.
 *
 * Short on purpose. Blocking is what makes the answer an ordinary tool result
 * rather than a fabricated user turn, but a person may take days and a Main
 * process cannot be held open for that — so the timeout hands the decision back
 * to the model, which proceeds on the recommended option and says so.
 */
export const DEFAULT_HUMAN_ANSWER_TIMEOUT_MS = 60_000;
/** Questions one delegated call may raise. Blocking already rate-limits this. */
export const DEFAULT_SUBAGENT_MAX_QUESTIONS = 3;
export const DEFAULT_REASONING_EFFORT = "high";
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const REASONING_LEVELS: readonly PiThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];

export type CoworkModelApi = "openai-completions" | "openai-responses";
export type CoworkThinkingFormat = "auto" | "openai" | "zai";

/** Preserve SDK detection unless a connection explicitly selects a wire format. */
export function normalizeThinkingFormat(value: unknown): CoworkThinkingFormat {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "openai" || value === "zai") return value;
  throw new Error("thinkingFormat must be auto, openai, or zai");
}

export function configuredThinkingFormat(env: NodeJS.ProcessEnv = process.env): CoworkThinkingFormat {
  return normalizeThinkingFormat(env.COWORK_THINKING_FORMAT);
}

/** Missing legacy runtime settings keep their original protocol; new connections use NEW_CONNECTION_PROFILE. */
export function normalizeModelApi(value: unknown): CoworkModelApi {
  if (value === undefined) return "openai-completions";
  if (value === "openai-completions" || value === "openai-responses") return value;
  throw new Error("消息格式须为 Chat Completions 或 Responses");
}

export function configuredModelApi(env: NodeJS.ProcessEnv = process.env): CoworkModelApi {
  return normalizeModelApi(env.COWORK_MODEL_API);
}

export interface RuntimeSettingsConfig extends HttpProxyConfig {
  api?: CoworkModelApi;
  thinkingFormat?: CoworkThinkingFormat;
  reasoningEffort?: PiThinkingLevel;
  /** Levels chosen for a connection whose models the provider and Pi do not describe (#27). */
  reasoningLevels?: PiThinkingLevel[];
  supportsReasoningEffort?: boolean;
  supportsImages?: boolean;
  supportsPromptCacheKey?: boolean;
  workspaceRoot?: string;
  mainTimeoutMs?: number;
  subagentTimeoutMs?: number;
  mainMaxTurns?: number;
  subagentMaxTurns?: number;
  mainMaxTokens?: number;
  subagentMaxTokens?: number;
  contextWindow?: number;
  commandTimeoutMs?: number;
  maxAttempts?: number;
  subagentQuestionTimeoutMs?: number;
  humanAnswerTimeoutMs?: number;
  subagentMaxQuestions?: number;
}

/** Resolve the task workspace once, with environment taking precedence over config. */
export function configuredWorkspaceRoot(
  config: Pick<RuntimeSettingsConfig, "workspaceRoot"> = {},
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): string {
  return atriaDataPaths(env, config, cwd).workspaceRoot;
}

/** Process environment with optional local config values as lower precedence. */
export function runtimeSettingsEnv(config: RuntimeSettingsConfig = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const values: Array<[keyof RuntimeSettingsConfig, string]> = [
    ["api", "COWORK_MODEL_API"],
    ["thinkingFormat", "COWORK_THINKING_FORMAT"],
    ["reasoningEffort", "COWORK_REASONING_EFFORT"],
    ["supportsReasoningEffort", "COWORK_SUPPORTS_REASONING_EFFORT"],
    ["supportsImages", "COWORK_SUPPORTS_IMAGES"],
    ["supportsPromptCacheKey", "COWORK_SUPPORTS_PROMPT_CACHE_KEY"],
    ["mainTimeoutMs", "COWORK_MAIN_TIMEOUT_MS"],
    ["subagentTimeoutMs", "COWORK_SUBAGENT_TIMEOUT_MS"],
    ["mainMaxTurns", "COWORK_MAIN_MAX_TURNS"],
    ["subagentMaxTurns", "COWORK_MAX_TURNS"],
    ["mainMaxTokens", "COWORK_MAIN_MAX_TOKENS"],
    ["subagentMaxTokens", "COWORK_MAX_TOKENS"],
    ["contextWindow", "COWORK_CONTEXT_WINDOW"],
    ["commandTimeoutMs", "COWORK_COMMAND_TIMEOUT_MS"],
    ["maxAttempts", "COWORK_MAX_ATTEMPTS"],
    ["subagentQuestionTimeoutMs", "COWORK_SUBAGENT_QUESTION_TIMEOUT_MS"],
    ["humanAnswerTimeoutMs", "COWORK_HUMAN_ANSWER_TIMEOUT_MS"],
    ["subagentMaxQuestions", "COWORK_SUBAGENT_MAX_QUESTIONS"]
  ];
  for (const [configKey, envKey] of values) {
    if (env[envKey] === undefined && config[configKey] !== undefined) env[envKey] = String(config[configKey]);
  }
  return proxyEnvironment(config, env);
}

/** Reject misspellings before Pi can silently clamp an unknown level to off. */
export function normalizeReasoningEffort(value: unknown, source = "reasoningEffort"): PiThinkingLevel {
  if (value === undefined) return DEFAULT_REASONING_EFFORT;
  if (typeof value === "string" && REASONING_LEVELS.includes(value.trim() as PiThinkingLevel)) {
    return value.trim() as PiThinkingLevel;
  }
  throw new Error(`${source} must be one of: ${REASONING_LEVELS.join(", ")}`);
}

export function configuredReasoningEffort(env: NodeJS.ProcessEnv = process.env): PiThinkingLevel {
  return normalizeReasoningEffort(env.COWORK_REASONING_EFFORT, "COWORK_REASONING_EFFORT / reasoningEffort");
}

/** Opt out only for gateways that reject the reasoning_effort request field. */
export function configuredSupportsReasoningEffort(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.COWORK_SUPPORTS_REASONING_EFFORT?.trim();
  if (value === undefined || value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error("COWORK_SUPPORTS_REASONING_EFFORT / supportsReasoningEffort must be true, false, 1 or 0");
}

/** Vision is explicit: a custom endpoint must not receive images it cannot accept. */
export function configuredSupportsImages(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.COWORK_SUPPORTS_IMAGES?.trim();
  if (value === undefined || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error("COWORK_SUPPORTS_IMAGES / supportsImages must be true, false, 1 or 0");
}

/** Unknown fields stay opt-in on third-party OpenAI-compatible services. */
export function configuredSupportsPromptCacheKey(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.COWORK_SUPPORTS_PROMPT_CACHE_KEY?.trim();
  if (value === undefined || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error("COWORK_SUPPORTS_PROMPT_CACHE_KEY / supportsPromptCacheKey must be true, false, 1 or 0");
}

function nonNegativeEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function positiveCappedEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, cap: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.min(cap, Math.floor(value)) : fallback;
}

/** Main Agent wall-clock deadline.  Zero means unlimited. */
export function configuredMainTimeout(env: NodeJS.ProcessEnv = process.env): number {
  return nonNegativeEnv(env, "COWORK_MAIN_TIMEOUT_MS", 0);
}

/**
 * Subagent wall-clock deadline.  `COWORK_TIMEOUT_MS` remains a compatibility
 * alias and deliberately applies only to Subagents, matching its historical
 * extension behavior.
 */
export function configuredSubagentTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = env.COWORK_SUBAGENT_TIMEOUT_MS;
  if (explicit !== undefined && explicit.trim() !== "")
    return nonNegativeEnv(env, "COWORK_SUBAGENT_TIMEOUT_MS", 0);
  return nonNegativeEnv(env, "COWORK_TIMEOUT_MS", 0);
}

/**
 * Deadline for a single tool-invoked local command.  Zero means unlimited, so
 * long jobs such as a training or evaluation run are not killed at an
 * interactive deadline.  This is independent of the model wall-clock timeouts
 * above: a command may outlive the Agent turn that started it.
 */
export function configuredCommandTimeout(env: NodeJS.ProcessEnv = process.env): number {
  return nonNegativeEnv(env, "COWORK_COMMAND_TIMEOUT_MS", DEFAULT_COMMAND_TIMEOUT_MS);
}

/**
 * Attempts per delegated call, including the first.  One disables the retry:
 * an expensive or side-effecting job — a training run, say — should surface a
 * failure for judgment rather than silently repeat it.
 */
export function configuredMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  return positiveCappedEnv(env, "COWORK_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS, 20);
}

/**
 * How many delegations one Task records in its ledger.  Zero means unlimited.
 * This is an operator-side bound on bookkeeping growth, not a limit on what
 * Main may attempt: past it, recording stops and the work still runs.
 */
export function configuredExperimentMaxRuns(env: NodeJS.ProcessEnv = process.env): number {
  return nonNegativeEnv(env, "COWORK_EXPERIMENT_MAX_RUNS", 0);
}

export function configuredMainMaxTurns(env: NodeJS.ProcessEnv = process.env): number {
  return positiveCappedEnv(env, "COWORK_MAIN_MAX_TURNS", DEFAULT_MAIN_MAX_TURNS, 10_000);
}

export function configuredSubagentMaxTurns(env: NodeJS.ProcessEnv = process.env): number {
  return positiveCappedEnv(env, "COWORK_MAX_TURNS", DEFAULT_MAX_TURNS, 10_000);
}

export function configuredMainMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  return positiveCappedEnv(env, "COWORK_MAIN_MAX_TOKENS", DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS);
}

export function configuredSubagentMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  return positiveCappedEnv(env, "COWORK_MAX_TOKENS", DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS);
}

/** Local capacity for context budgeting; never an inference request parameter. */
export function normalizeContextWindow(value: unknown): number {
  if (value === undefined) return DEFAULT_CONTEXT_WINDOW;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("上下文窗口（contextWindow）须为 1–9007199254740991 的整数（token）");
  return value;
}

export function configuredContextWindow(env: NodeJS.ProcessEnv = process.env): number {
  return normalizeContextWindow(
    env.COWORK_CONTEXT_WINDOW === undefined ? undefined : Number(env.COWORK_CONTEXT_WINDOW)
  );
}

/**
 * How long a Subagent blocks waiting for Main to answer its question.
 *
 * Zero disables upward questions entirely: the tool is not offered, and a
 * Subagent behaves as it did before — declaring an assumption and continuing.
 * Capped at an hour so a misconfiguration cannot park a delegation indefinitely.
 */
export function configuredSubagentQuestionTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const value = nonNegativeEnv(
    env,
    "COWORK_SUBAGENT_QUESTION_TIMEOUT_MS",
    DEFAULT_SUBAGENT_QUESTION_TIMEOUT_MS
  );
  return Math.min(value, 60 * 60_000);
}

/**
 * Questions one delegated call may raise.  Blocking is itself the main limit;
 * this bounds a Subagent that would rather ask than decide.
 */
export function configuredHumanAnswerTimeout(env: NodeJS.ProcessEnv = process.env): number {
  // Capped at ten minutes: past that the durable path is the right answer, not
  // a process sitting on an open question.
  const value = nonNegativeEnv(env, "COWORK_HUMAN_ANSWER_TIMEOUT_MS", DEFAULT_HUMAN_ANSWER_TIMEOUT_MS);
  return Math.min(value, 10 * 60_000);
}

export function configuredSubagentMaxQuestions(env: NodeJS.ProcessEnv = process.env): number {
  return positiveCappedEnv(env, "COWORK_SUBAGENT_MAX_QUESTIONS", DEFAULT_SUBAGENT_MAX_QUESTIONS, 20);
}
