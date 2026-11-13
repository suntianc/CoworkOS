import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProviderStreams } from "@earendil-works/pi-ai";
import { createCoworkModel } from "../../dist/src/runtime/model-profile.js";
import { createModelStreams } from "../../dist/src/runtime/model-provider.js";
import { guardCompactionSummaries } from "../../dist/src/runtime/compaction-summary-guard.js";

/**
 * Register the CoworkOS model provider for whichever agent process loaded this
 * extension.
 *
 * Main and a delegated process use one connection, one protocol and one stream
 * stack. Only the per-agent facts (model limits, session id and the request
 * recorder Main owns) differ, so they are inputs instead of a second copy of
 * the provider wiring.
 */
export function registerCoworkProvider(
  pi: ExtensionAPI,
  input: {
    model: ReturnType<typeof createCoworkModel>;
    apiKey: string;
    sessionId: string;
    supportsPromptCacheKey: boolean;
    /** Main layers request recording and retry; delegated agents do not. */
    wrap?: (streams: ProviderStreams) => ProviderStreams;
  }
): void {
  const streams = createModelStreams(input.model.api, {
    supportsPromptCacheKey: input.supportsPromptCacheKey,
    sessionId: input.sessionId
  });
  const wrapped = input.wrap ? input.wrap(streams) : streams;
  pi.registerProvider(input.model.provider, {
    baseUrl: input.model.baseUrl,
    apiKey: input.apiKey,
    api: input.model.api,
    streamSimple: guardCompactionSummaries(wrapped).streamSimple,
    models: [input.model]
  });
}
