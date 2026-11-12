import type { ConnectionProfile } from "./model-profile.js";
import { DEFAULT_CONTEXT_WINDOW } from "./runtime-settings.js";

/** The new-connection output default (`NEW_CONNECTION_PROFILE`), kept here to avoid an import cycle. */
const DEFAULT_OUTPUT_TOKENS = 8192;

/**
 * A model's own limits from the provider's `/models` entry (#27): the context
 * window, the largest output and whether it reads images. They are the model's
 * defaults; a value filled in by hand on the connection wins.
 */
export interface EndpointLimits {
  contextWindow?: number;
  maxOutputTokens?: number;
  images?: boolean;
}

/** The connection fields that can follow the endpoint. */
export const LIMIT_FIELDS = ["contextWindow", "maxTokens", "images"] as const;
export type LimitField = (typeof LIMIT_FIELDS)[number];

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/** What one `/models` entry says about its limits, or undefined when it says nothing. */
export function endpointLimits(entry: unknown): EndpointLimits | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const value = entry as Record<string, unknown>;
  const contextWindow =
    positive(value.context_window) ?? positive(value.context_length) ?? positive(value.max_context_length);
  const maxOutputTokens =
    positive(value.max_output_tokens) ?? positive(value.max_completion_tokens) ?? positive(value.max_tokens);
  const modalities = value.modalities;
  const input =
    modalities && typeof modalities === "object" ? (modalities as Record<string, unknown>).input : undefined;
  const images = Array.isArray(input) ? input.includes("image") : undefined;
  const limits: EndpointLimits = {
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(images === undefined ? {} : { images })
  };
  return Object.keys(limits).length ? limits : undefined;
}

/** A saved choice of which fields follow the endpoint: known names, no repeats. */
export function parseAutoLimits(value: unknown): LimitField[] {
  if (
    !Array.isArray(value) ||
    !value.every((field) => (LIMIT_FIELDS as readonly unknown[]).includes(field)) ||
    new Set(value).size !== value.length
  )
    throw new Error("autoLimits 只能列出 contextWindow、maxTokens、images");
  return LIMIT_FIELDS.filter((field) => value.includes(field));
}

/**
 * The fields that follow the endpoint. A connection saved before this choice
 * existed counts a field as untouched while it still holds the new-connection
 * default, so a value someone changed by hand keeps winning.
 */
export function autoLimitFields(profile: ConnectionProfile, supportsImages: boolean): LimitField[] {
  if (profile.autoLimits) return profile.autoLimits;
  return LIMIT_FIELDS.filter((field) =>
    field === "contextWindow"
      ? profile.contextWindow === DEFAULT_CONTEXT_WINDOW
      : field === "maxTokens"
        ? profile.mainMaxTokens === DEFAULT_OUTPUT_TOKENS &&
          profile.subagentMaxTokens === DEFAULT_OUTPUT_TOKENS
        : !supportsImages
  );
}

/** The largest output Atria asks for: what the model allows, within the form's range and half the window. */
export function outputLimit(maxOutputTokens: number, contextWindow: number): number {
  return Math.max(1, Math.min(maxOutputTokens, 65536, Math.floor(contextWindow / 2)));
}

/** A connection's limits for one model, with the endpoint's values where the field follows it. */
export function applyEndpointLimits<T extends { profile: ConnectionProfile; supportsImages: boolean }>(
  selection: T,
  limits: EndpointLimits | undefined
): T {
  if (!limits) return selection;
  const auto = autoLimitFields(selection.profile, selection.supportsImages);
  const profile = { ...selection.profile };
  let supportsImages = selection.supportsImages;
  if (auto.includes("contextWindow") && limits.contextWindow) profile.contextWindow = limits.contextWindow;
  if (auto.includes("maxTokens") && limits.maxOutputTokens) {
    const tokens = outputLimit(limits.maxOutputTokens, profile.contextWindow);
    profile.mainMaxTokens = tokens;
    profile.subagentMaxTokens = tokens;
  }
  if (auto.includes("images") && limits.images !== undefined) supportsImages = limits.images;
  return { ...selection, profile, supportsImages };
}
