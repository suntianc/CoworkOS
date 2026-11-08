import { hostConfigRoot, readHostCoworkConfig, type CoworkConfig } from "./config.js";
import {
  DEFAULT_MODEL,
  modelRoleSnapshot,
  resolveDelegatedModelRole,
  type DelegatedModelRequest,
  type ModelRoleSnapshot,
  type ResolvedModelRole
} from "./role-models.js";
import type { CoworkModelApi, CoworkThinkingFormat, PiThinkingLevel } from "./runtime-settings.js";

/**
 * The role model one delegated work item actually runs with.
 *
 * Resolution happens on the execution host at the moment the work item starts:
 * the configuration is read fresh, so a binding changed while another work item
 * is in flight applies to the next start and never rewrites the running one.
 * Nothing returned here carries a key except the runtime-only values the caller
 * hands to the session; the snapshot is safe to persist and display.
 */
export interface DelegatedModelSelection {
  selection: ResolvedModelRole;
  snapshot: ModelRoleSnapshot;
}

/** What a delegated session starts with, after the role decision is made. */
export interface WorkItemModel {
  baseUrl: string;
  apiKey: string;
  model?: string;
  thinkingLevel: PiThinkingLevel;
  api: CoworkModelApi;
  thinkingFormat: CoworkThinkingFormat;
  supportsReasoningEffort: boolean;
  supportsPromptCacheKey: boolean;
  supportsImages: boolean;
  maxTokens?: number;
  contextWindow?: number;
  /** Non-sensitive record of this start; absent for a caller with no role request. */
  snapshot?: ModelRoleSnapshot;
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

/**
 * Decide the connection, model and request parameters one work item starts with.
 *
 * Called after its prerequisites are terminal and immediately before the session
 * exists: a binding edited or removed while the item waited therefore decides
 * this start, and a removed reference fails it here instead of running on a
 * connection captured when it was only queued. `caller` is the launching Main
 * Run's own connection, which an unbound item keeps.
 */
export function resolveWorkItemModel(input: {
  delegation?: DelegatedModelRequest;
  caller: WorkItemModel;
}): WorkItemModel {
  const caller = input.caller;
  if (!input.delegation) return caller;
  const delegated = delegationModelSelection(input.delegation);
  const profile = delegated?.selection.profile;
  return {
    baseUrl: delegated?.selection.baseUrl ?? caller.baseUrl,
    apiKey: delegated?.selection.apiKey ?? caller.apiKey,
    model: delegated?.selection.model ?? caller.model,
    thinkingLevel: delegated?.selection.thinkingLevel ?? caller.thinkingLevel,
    api: profile?.api ?? caller.api,
    thinkingFormat: profile?.thinkingFormat ?? caller.thinkingFormat,
    supportsReasoningEffort: profile?.supportsReasoningEffort ?? caller.supportsReasoningEffort,
    supportsPromptCacheKey: profile?.supportsPromptCacheKey ?? caller.supportsPromptCacheKey,
    supportsImages: delegated ? delegated.selection.supportsImages : caller.supportsImages,
    maxTokens: profile?.subagentMaxTokens ?? caller.maxTokens,
    contextWindow: profile?.contextWindow ?? caller.contextWindow,
    // An inherited connection has no binding to name; the record states the
    // role and what it actually used rather than inventing a connection.
    snapshot: delegated?.snapshot ?? {
      role: input.delegation.role,
      source: "active",
      connectionId: null,
      connectionName: null,
      model: caller.model || DEFAULT_MODEL,
      api: caller.api,
      thinkingLevel: caller.thinkingLevel,
      supportsImages: caller.supportsImages,
      ...(input.delegation.projectId ? { projectId: input.delegation.projectId } : {})
    }
  };
}

/** The role line a delegated Subagent sees, so its summary names the right job. */
export function delegationRoleGuidance(request: DelegatedModelRequest): string {
  if (request.role === "reviewer")
    return "You run this work item as the independent Reviewer: examine the change or candidate you were given and report findings with evidence. The Executor's own report is a claim to check, not proof that it works, and staying unconvinced is a valid outcome.";
  return "You run this work item as the Executor: make the assigned change in the workspace you were given, run the checks that prove it, and return the evidence — command output, file paths and test results — together with the conclusion.";
}
