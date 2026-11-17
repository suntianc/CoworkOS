import { clampThinkingLevel, type Model, type Api, type ProviderStreams } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { withModelCache } from "./model-cache.js";
import type { CoworkModelApi, PiThinkingLevel } from "./runtime-settings.js";

/** Use the same capability clamping as the Pi coding-agent Main session. */
export function modelThinkingLevel(model: Model<Api>, level: PiThinkingLevel): PiThinkingLevel {
  return clampThinkingLevel(model, level);
}

/** Shared serialization policy for probes, Main and delegated sessions. */
export function createModelStreams(
  api: CoworkModelApi,
  cache: { supportsPromptCacheKey: boolean; sessionId?: string } = { supportsPromptCacheKey: false }
): ProviderStreams {
  // Cache keys and usage counters are OpenAI wire fields; Anthropic requests go to Pi unchanged.
  const streams =
    api === "anthropic-messages"
      ? anthropicMessagesApi()
      : withModelCache(api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi(), cache);
  const wrap =
    (method: "stream" | "streamSimple"): ProviderStreams["streamSimple"] =>
    (model, context, options) =>
      streams[method](
        {
          ...model,
          // Pi uses null both to hide a selectable level and to omit its wire value.
          // Keep off selectable in the registered model; apply null only at serialization.
          thinkingLevelMap: { ...model.thinkingLevelMap, off: null }
        },
        context,
        options
      );
  return { ...streams, stream: wrap("stream"), streamSimple: wrap("streamSimple") };
}
