import type { CoworkConfig } from "./config.js";
import { resolveModelRole, type ResolvedModelRole } from "./role-models.js";
import type { PiThinkingLevel } from "./runtime-settings.js";

/**
 * Marker the Dashboard sets on a Main launch whose connection it resolved from
 * this host's saved configuration.
 *
 * A connection pinned by the launch environment itself must stay pinned for the
 * process's life, so only a marked launch re-reads a connection at a turn
 * boundary. Both cases look identical in the child process otherwise: the
 * Dashboard copies the resolved values into `COWORK_API_*` either way.
 */
export const MAIN_MODEL_FROM_CONFIG = "COWORK_MAIN_MODEL_FROM_CONFIG";

/**
 * Model values a launch already fixed.
 *
 * A resident Main re-reads the host file for the next turn, so every value the
 * Dashboard copied into the environment at launch would otherwise outrank that
 * file: role resolution reads `COWORK_API_BASE`, `COWORK_MODEL` and the profile
 * keys straight from the environment.
 */
const LAUNCH_MODEL_ENV = [
  "COWORK_API_BASE",
  "COWORK_API_KEY",
  "COWORK_MODEL",
  "COWORK_CONNECTION_ID",
  "COWORK_MODEL_API",
  "COWORK_THINKING_FORMAT",
  "COWORK_REASONING_EFFORT",
  "COWORK_SUPPORTS_REASONING_EFFORT",
  "COWORK_SUPPORTS_PROMPT_CACHE_KEY",
  "COWORK_SUPPORTS_IMAGES",
  "COWORK_CONTEXT_WINDOW",
  "COWORK_MAIN_MAX_TOKENS",
  "COWORK_MAX_TOKENS"
] as const;

/**
 * The connection one resident turn should use, from the host file saved now.
 *
 * Returns `undefined` when this launch's connection is pinned rather than read
 * from the host file (environment, a one-off profile or an archived retry),
 * and when the saved configuration names no usable connection: the process
 * keeps the connection it was started with rather than failing a turn over a
 * file it cannot use. The explicit level is the one the message that opens the
 * turn chose; the connection's own level is the default for every other turn.
 */
export function resolveMainTurnModel(
  config: CoworkConfig,
  input: { projectId?: string | null; thinkingLevel?: PiThinkingLevel } = {},
  env: NodeJS.ProcessEnv = process.env
): ResolvedModelRole | undefined {
  if (env[MAIN_MODEL_FROM_CONFIG] !== "1") return undefined;
  const launchFree: NodeJS.ProcessEnv = { ...env };
  for (const name of LAUNCH_MODEL_ENV) delete launchFree[name];
  const selection = resolveModelRole(
    config,
    {
      role: "main",
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {})
    },
    launchFree
  );
  return selection.baseUrl && selection.apiKey ? selection : undefined;
}
