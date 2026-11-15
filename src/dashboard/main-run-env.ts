import { atriaDataPaths } from "../../scripts/data-home.cjs";
import type { PiThinkingLevel } from "../runtime/runtime-settings.js";
import { roleConnectionEnv, type ResolvedModelRole } from "../runtime/role-models.js";
import { MAIN_MODEL_FROM_CONFIG } from "../runtime/main-turn-model.js";

/**
 * The environment a Main run is spawned with.
 *
 * Its own module, and a pure function, so it can be asserted without starting
 * a Dashboard: importing `dashboard.ts` binds a port, which is why every other
 * test of that file spawns it as a process instead.
 *
 * Two of these values are locations the Agent process cannot derive on its
 * own, and both were learned the hard way — see the comments below.
 */
export interface MainRunEnvInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  taskWorkspace: string;
  projectDirectory?: string;
  taskId: string;
  runId: string;
  /** Where this Dashboard answers, for the host-dependent Agent tools. */
  dashboardUrl: string;
  piAgentDir?: string;
  projectRoot?: string;
  /**
   * The connection and model this Run was admitted with. A connection chosen
   * from the local registry pins its whole profile, so a role-selected
   * connection never inherits the active one's protocol, reasoning level or
   * output limits. Environment-managed and legacy single connections keep
   * their existing path: the child reads the same configuration file.
   */
  selection?: ResolvedModelRole;
  /** Per-request override; omitted so the child inherits the connection default. */
  thinkingLevel?: PiThinkingLevel;
}

export function mainRunEnv(input: MainRunEnvInput): Record<string, string> {
  return {
    COWORK_API_BASE: input.baseUrl,
    COWORK_API_KEY: input.apiKey,
    COWORK_MODEL: input.model,
    ...(input.selection?.connectionId
      ? roleConnectionEnv(input.selection)
      : input.thinkingLevel
        ? { COWORK_REASONING_EFFORT: input.thinkingLevel }
        : {}),
    // The connection came from this host's saved configuration, so a resident
    // Main may adopt a newer one at its next turn. An environment-pinned or
    // one-off (explicit/retry) connection is fixed by definition and stays for
    // the process's life.
    ...(input.selection && ["active", "host", "project"].includes(input.selection.source)
      ? { [MAIN_MODEL_FROM_CONFIG]: "1" }
      : {}),
    COWORK_WORKSPACE: input.taskWorkspace,
    COWORK_PROJECT_DIR: input.projectDirectory ?? input.taskWorkspace,
    COWORK_TASK_ID: input.taskId,
    COWORK_RUN_ID: input.runId,
    COWORK_CLI_SESSION: "0",
    // Where the host-dependent tools reach this Dashboard and its credentials.
    COWORK_DASHBOARD_URL: input.dashboardUrl,
    COWORK_INITIAL_PROMPT: "1",
    PI_CODING_AGENT_DIR: input.piAgentDir ?? atriaDataPaths().piAgentDir
  };
}
