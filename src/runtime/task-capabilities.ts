import type { TaskCapabilities } from "../domain/types.js";
import { DEFAULT_MAX_ATTEMPTS } from "./runtime-settings.js";

/**
 * What Agents on a Task may actually do.
 *
 * Two sources, in this order: the grant recorded on the Task, and an operator
 * preset in the environment. The Task grant is the normal path — it is made
 * after the work is understood, and it is durable, so an Agent's permissions
 * are answerable later. The environment exists for a run that is configured
 * ahead of time, such as a benchmark harness or an unattended job.
 *
 * The default is the sandbox: an Agent writes only its own directory, runs
 * commands without a shell, and retries a failed delegation. Nothing here
 * grants anything on its own; something has to say so.
 */
export interface ResolvedCapabilities {
  projectWrite: boolean;
  shell: boolean;
  evalPaths: string[];
  longRunning: boolean;
  maxAttempts: number;
  /** Where the grant came from, for diagnostics and the audit trail. */
  source: "task" | "environment" | "default";
}

export function resolveCapabilities(
  capabilities: TaskCapabilities | undefined,
  env: NodeJS.ProcessEnv = process.env
): ResolvedCapabilities {
  const preset = environmentPreset(env);
  if (capabilities) {
    return {
      projectWrite: capabilities.projectWrite === true,
      shell: capabilities.shell === true,
      // Both sources contribute read-only paths. A grant widens what an Agent
      // may write, so it must not narrow what is protected.
      evalPaths: [...new Set([...(capabilities.evalPaths ?? []), ...preset.evalPaths])],
      longRunning: capabilities.longRunning === true,
      maxAttempts: capabilities.maxAttempts ?? preset.maxAttempts,
      source: "task"
    };
  }
  return preset;
}

function environmentPreset(env: NodeJS.ProcessEnv): ResolvedCapabilities {
  const evalPaths = (env.COWORK_EVAL_PATHS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const projectWrite = flag(env.COWORK_PROJECT_WRITE);
  const configured =
    projectWrite !== undefined || env.COWORK_MAX_ATTEMPTS !== undefined || evalPaths.length > 0;
  const maxAttempts = positive(env.COWORK_MAX_ATTEMPTS) ?? DEFAULT_MAX_ATTEMPTS;
  return {
    projectWrite: projectWrite === true,
    // A shell is what makes project edits usable — pipes, redirection,
    // backgrounding — so it follows the same grant rather than a separate one.
    shell: projectWrite === true,
    evalPaths,
    longRunning: projectWrite === true,
    maxAttempts,
    source: configured ? "environment" : "default"
  };
}

function flag(value: string | undefined): boolean | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  return trimmed !== "0" && trimmed !== "false";
}

function positive(value: string | undefined): number | undefined {
  const numeric = Number(value);
  return value !== undefined && Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}
