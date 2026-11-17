import type { PiThinkingLevel } from "./runtime-settings.js";

/**
 * The reasoning levels a model accepts (#27). Models differ: one offers off,
 * high and max, another only low to high. The levels come from, in order:
 *
 * 1. the provider's own `/models` entry, when it says (`reasoning_levels`,
 *    `supported_reasoning_levels`, `reasoning: false`);
 * 2. Pi's built-in model table, when the connection's address is the host of
 *    a provider Pi knows and that provider lists the model;
 * 3. the levels chosen on the connection, all of them unless narrowed.
 *
 * Only levels Pi can send are kept; anything else a provider names is ignored.
 */
export const ALL_LEVELS: readonly PiThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];
/** The levels offered when nothing narrows them; `minimal` is kept only for old settings. */
export const DEFAULT_LEVELS: readonly PiThinkingLevel[] = ["off", "low", "medium", "high", "xhigh", "max"];

export type LevelSource = "endpoint" | "official" | "manual";
export interface ModelLevels {
  levels: PiThinkingLevel[];
  source: LevelSource;
}

const known = (value: unknown): value is PiThinkingLevel =>
  typeof value === "string" && (ALL_LEVELS as readonly string[]).includes(value);

/** Pi's order, without duplicates or unknown names; undefined when none remain. */
export function orderedLevels(values: readonly unknown[]): PiThinkingLevel[] | undefined {
  const levels = ALL_LEVELS.filter((level) => values.includes(level));
  return levels.length ? levels : undefined;
}

/** What one `/models` entry says about reasoning, or undefined when it says nothing. */
export function endpointLevels(entry: unknown): PiThinkingLevel[] | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const value = entry as Record<string, unknown>;
  const lists = [value.reasoning_levels, value.supported_reasoning_levels].filter(Array.isArray);
  for (const list of lists) {
    const names = (list as unknown[]).map((item) =>
      item && typeof item === "object" ? (item as Record<string, unknown>).effort : item
    );
    const levels = orderedLevels(names.filter(known));
    if (levels) return levels;
  }
  return value.reasoning === false ? ["off"] : undefined;
}

/** What Pi's built-in catalog says about one model. */
export interface OfficialModel {
  levels?: PiThinkingLevel[];
  name: string;
  contextWindow: number;
  maxTokens: number;
  images: boolean;
  reasoning: boolean;
}

let officialTable: Promise<Map<string, Map<string, OfficialModel>>> | undefined;
/** Host to model ID to catalog entry, built once from Pi's built-in providers. */
function official() {
  officialTable ??= import("@earendil-works/pi-ai/providers/all").then(
    async ({ getBuiltinProviders, getBuiltinModels }) => {
      const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
      const table = new Map<string, Map<string, OfficialModel>>();
      for (const provider of getBuiltinProviders())
        for (const model of getBuiltinModels(provider)) {
          let host: string;
          try {
            host = new URL(model.baseUrl).host;
          } catch (error) {
            // A provider whose address is a template (a region or account slot) has no fixed host.
            if (error instanceof TypeError) continue;
            throw error;
          }
          const models = table.get(host) ?? new Map<string, OfficialModel>();
          table.set(host, models);
          // Several providers can share a host; the first that lists the model answers.
          if (models.has(model.id)) continue;
          const levels = orderedLevels(getSupportedThinkingLevels(model));
          models.set(model.id, {
            ...(levels ? { levels } : {}),
            name: model.name,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            images: model.input.includes("image"),
            reasoning: model.reasoning
          });
        }
      return table;
    }
  );
  return officialTable;
}

/** Pi's catalog entry for a model at a provider address it knows. */
export async function officialModel(baseUrl: string, model: string): Promise<OfficialModel | undefined> {
  const host = hostOf(baseUrl);
  return host ? (await official()).get(host)?.get(model) : undefined;
}

/** Whether `baseUrl` is the address of a provider Pi knows. */
export async function isOfficialAddress(baseUrl: string): Promise<boolean> {
  const host = hostOf(baseUrl);
  return Boolean(host && (await official()).has(host));
}

const hostOf = (baseUrl: string) => {
  try {
    return new URL(baseUrl).host;
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
};

/** The levels for one model on one connection. */
export async function modelLevels(input: {
  baseUrl: string;
  model: string;
  /** What the connection's `/models` entry for this model said, if anything. */
  endpoint?: PiThinkingLevel[];
  /** The levels chosen on the connection. */
  manual?: readonly PiThinkingLevel[];
}): Promise<ModelLevels> {
  if (input.endpoint?.length) return { levels: [...input.endpoint], source: "endpoint" };
  const listed = (await officialModel(input.baseUrl, input.model))?.levels;
  if (listed) return { levels: [...listed], source: "official" };
  return { levels: [...(input.manual?.length ? input.manual : DEFAULT_LEVELS)], source: "manual" };
}
