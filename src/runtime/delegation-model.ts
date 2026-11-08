import { hostConfigRoot, readHostCoworkConfig, type CoworkConfig } from "./config.js";
import {
  modelRoleSnapshot,
  resolveDelegatedModelRole,
  type DelegatedModelRequest,
  type ModelRoleSnapshot,
  type ResolvedModelRole
} from "./role-models.js";

/**
 * The role model one delegated work item actually runs with.
 *
 * Resolution happens on the execution host at the moment the work item starts:
 * the configuration is read fresh, so a binding changed while another work item
 * is in flight applies to the next start and never rewrites the running one.
 * Nothing returned here carries a key except the runtime-only selection the
 * caller hands to the session; the snapshot is safe to persist and display.
 */
export interface DelegatedModelSelection {
  selection: ResolvedModelRole;
  snapshot: ModelRoleSnapshot;
}

export function delegationHostConfig(env: NodeJS.ProcessEnv = process.env): CoworkConfig {
  return readHostCoworkConfig(hostConfigRoot(env), env);
}

/** `undefined` keeps the caller's own connection: no binding and no one-off choice. */
export function delegationModelSelection(
  request: DelegatedModelRequest
): DelegatedModelSelection | undefined {
  const selection = resolveDelegatedModelRole(delegationHostConfig(), request);
  return selection ? { selection, snapshot: modelRoleSnapshot(selection) } : undefined;
}

/** The role line a delegated Subagent sees, so its summary names the right job. */
export function delegationRoleGuidance(request: DelegatedModelRequest): string {
  if (request.role === "reviewer")
    return "You run this work item as the independent Reviewer: examine the change or candidate you were given and report findings with evidence. The Executor's own report is a claim to check, not proof that it works, and staying unconvinced is a valid outcome.";
  return "You run this work item as the Executor: make the assigned change in the workspace you were given, run the checks that prove it, and return the evidence — command output, file paths and test results — together with the conclusion.";
}
