import { createHash } from "node:crypto";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  configuredModelApi,
  normalizeModelApi,
  type CoworkModelApi,
  configuredThinkingFormat,
  normalizeThinkingFormat,
  type CoworkThinkingFormat,
  configuredMainMaxTokens,
  configuredSubagentMaxTokens,
  configuredContextWindow,
  normalizeContextWindow,
  DEFAULT_CONTEXT_WINDOW,
  configuredReasoningEffort,
  configuredSupportsReasoningEffort,
  configuredSupportsPromptCacheKey,
  normalizeReasoningEffort,
  runtimeSettingsEnv,
  type RuntimeSettingsConfig,
  type PiThinkingLevel
} from "./runtime-settings.js";
import { orderedLevels } from "./model-levels.js";
import { parseAutoLimits, type LimitField } from "./model-limits.js";

/** Only new connections use these defaults; existing deployments retain their runtime settings. */
export const NEW_CONNECTION_PROFILE = {
  api: "openai-responses" as const,
  reasoningEffort: "off" as PiThinkingLevel,
  supportsReasoningEffort: false,
  supportsPromptCacheKey: false,
  mainMaxTokens: 8192,
  subagentMaxTokens: 8192,
  contextWindow: DEFAULT_CONTEXT_WINDOW
};

/** Optional reproducible sampling for programmatic runs; providers default otherwise. */
export interface ModelSampling {
  temperature?: number;
  topP?: number;
}

export function modelSamplingOptions(
  sampling?: ModelSampling
): Pick<SimpleStreamOptions, "temperature" | "samplingParams"> {
  const temperature = sampling?.temperature;
  const topP = sampling?.topP;
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2))
    throw new Error("sampling.temperature must be between 0 and 2");
  if (topP !== undefined && (!Number.isFinite(topP) || topP <= 0 || topP > 1))
    throw new Error("sampling.topP must be greater than 0 and at most 1");
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { samplingParams: { top_p: topP } })
  };
}

export interface ConnectionProfile {
  api: CoworkModelApi;
  thinkingFormat?: CoworkThinkingFormat;
  reasoningEffort: PiThinkingLevel;
  /** Absent means every level; narrowed only for models nothing else describes (#27). */
  reasoningLevels?: PiThinkingLevel[];
  supportsReasoningEffort: boolean;
  supportsPromptCacheKey: boolean;
  mainMaxTokens: number;
  subagentMaxTokens: number;
  contextWindow: number;
  /** Fields that take each model's `/models` value; absent means untouched defaults do (#27). */
  autoLimits?: LimitField[];
}

export function connectionProfile(
  config: RuntimeSettingsConfig & { baseUrl?: string; apiBase?: string }
): ConnectionProfile {
  const existing = Boolean(config.baseUrl || config.apiBase || process.env.COWORK_API_BASE);
  const env = runtimeSettingsEnv(existing ? config : { ...NEW_CONNECTION_PROFILE, ...config });
  return {
    api: configuredModelApi(env),
    thinkingFormat: configuredThinkingFormat(env),
    reasoningEffort: configuredReasoningEffort(env),
    supportsReasoningEffort: configuredSupportsReasoningEffort(env),
    supportsPromptCacheKey: configuredSupportsPromptCacheKey(env),
    mainMaxTokens: configuredMainMaxTokens(env),
    subagentMaxTokens: configuredSubagentMaxTokens(env),
    contextWindow: configuredContextWindow(env),
    ...(config.reasoningLevels ? { reasoningLevels: parseReasoningLevels(config.reasoningLevels) } : {}),
    ...(config.autoLimits ? { autoLimits: parseAutoLimits(config.autoLimits) } : {})
  };
}

/** A connection's chosen levels: known names, at least one, kept in Pi's order. */
export function parseReasoningLevels(value: unknown): PiThinkingLevel[] {
  const levels = Array.isArray(value) ? orderedLevels(value) : undefined;
  if (!levels || levels.length !== new Set(value as unknown[]).size)
    throw new Error("支持的推理档位须至少选择一项，且只能是已知档位");
  return levels;
}

/** Validate form input before writing a key or contacting a model service. */
export function parseConnectionProfile(
  value: Record<string, unknown>,
  fallback: ConnectionProfile
): ConnectionProfile {
  const supportsReasoningEffort = value.supportsReasoningEffort ?? fallback.supportsReasoningEffort;
  if (typeof supportsReasoningEffort !== "boolean") throw new Error("推理参数支持须为布尔值");
  const supportsPromptCacheKey =
    value.supportsPromptCacheKey === undefined
      ? fallback.supportsPromptCacheKey
      : value.supportsPromptCacheKey;
  if (typeof supportsPromptCacheKey !== "boolean") throw new Error("缓存键支持须为布尔值");
  const tokens = (name: "mainMaxTokens" | "subagentMaxTokens") => {
    const count = value[name] ?? fallback[name];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 65536)
      throw new Error("输出上限须为 1–65536 的整数，并且不超过模型服务支持的上限");
    return count;
  };
  const levelsValue = value.reasoningLevels === undefined ? fallback.reasoningLevels : value.reasoningLevels;
  const reasoningLevels =
    levelsValue === undefined || levelsValue === null ? undefined : parseReasoningLevels(levelsValue);
  const limitsValue = value.autoLimits === undefined ? fallback.autoLimits : value.autoLimits;
  const autoLimits =
    limitsValue === undefined || limitsValue === null ? undefined : parseAutoLimits(limitsValue);
  const reasoningEffort = normalizeReasoningEffort(value.reasoningEffort ?? fallback.reasoningEffort);
  if (reasoningLevels && !reasoningLevels.includes(reasoningEffort))
    throw new Error("连接默认的推理强度须是支持的档位之一");
  return {
    api: normalizeModelApi(value.api === undefined ? fallback.api : value.api),
    thinkingFormat: normalizeThinkingFormat(
      value.thinkingFormat === undefined ? fallback.thinkingFormat : value.thinkingFormat
    ),
    reasoningEffort,
    ...(reasoningLevels ? { reasoningLevels } : {}),
    supportsReasoningEffort,
    supportsPromptCacheKey,
    mainMaxTokens: tokens("mainMaxTokens"),
    subagentMaxTokens: tokens("subagentMaxTokens"),
    contextWindow: normalizeContextWindow(
      value.contextWindow === undefined ? fallback.contextWindow : value.contextWindow
    ),
    ...(autoLimits ? { autoLimits } : {})
  };
}

/** Distinguish service/account contexts even when both advertise the same model ID. */
export function coworkProviderId(baseUrl: string, connectionId = process.env.COWORK_CONNECTION_ID): string {
  if (!connectionId) return "cowork-glm"; // Existing CLI integrations retain their provider name.
  const base = baseUrl.replace(/\/+$/, "");
  const endpoint = base.endsWith("/v1") ? base : `${base}/v1`;
  return `cowork-${createHash("sha256")
    .update(JSON.stringify([endpoint, connectionId]))
    .digest("hex")
    .slice(0, 24)}`;
}

/** Main, delegated sessions and connection probes use the same provider declaration. */
export function createCoworkModel(options: {
  baseUrl: string;
  connectionId?: string;
  api?: CoworkModelApi;
  thinkingFormat?: CoworkThinkingFormat;
  model?: string;
  maxTokens?: number;
  contextWindow?: number;
  supportsImages?: boolean;
  supportsReasoningEffort: boolean;
}): Model<CoworkModelApi> {
  const base = options.baseUrl.replace(/\/+$/, "");
  const model = options.model ?? "glm-5.3";
  const api = normalizeModelApi(options.api);
  const thinkingFormat = normalizeThinkingFormat(options.thinkingFormat);
  const contextWindow = normalizeContextWindow(options.contextWindow ?? configuredContextWindow());
  return {
    id: model,
    name: model,
    api,
    provider: coworkProviderId(base, options.connectionId),
    baseUrl: /^https:\/\/open\.bigmodel\.cn\/api\/(?:coding\/)?paas\/v4$/i.test(base)
      ? base
      : base.endsWith("/v1")
        ? base
        : `${base}/v1`,
    reasoning: api === "openai-completions" || options.supportsReasoningEffort,
    // Off must remain selectable by Pi. Its wire omission is handled by model-provider.
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    input: options.supportsImages ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: options.maxTokens ?? 65536,
    compat:
      api === "openai-completions"
        ? {
            supportsDeveloperRole: false,
            supportsReasoningEffort: options.supportsReasoningEffort,
            ...(thinkingFormat === "auto" ? {} : { thinkingFormat })
          }
        : { supportsDeveloperRole: false }
  };
}
