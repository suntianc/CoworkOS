import type { CoworkConfig } from "./config.js";
import { modelConnections, type ModelConnection } from "./model-connections.js";
import { connectionProfile, parseConnectionProfile, type ConnectionProfile } from "./model-profile.js";
import { configuredSupportsImages, runtimeSettingsEnv, type PiThinkingLevel } from "./runtime-settings.js";

/**
 * Model roles on the execution host.
 *
 * A connection and its key belong to the host that runs the request. A role
 * only names one of that host's connections: the host default is local to the
 * machine, and a project override is indexed by the shared project id without
 * copying any identity or secret into shared data. `main` and the delegated
 * Executor/Reviewer roles read their binding at launch; `router` is a later
 * path's key and stays configuration only.
 */
export const MODEL_ROLE_KEYS = ["main", "executor", "reviewer", "router"] as const;
export type ModelRoleKey = (typeof MODEL_ROLE_KEYS)[number];
/** Roles an actual execution path reads today. Others are configuration only. */
export const WIRED_MODEL_ROLES: readonly ModelRoleKey[] = ["main", "executor", "reviewer"];
/** Roles a delegated work item can run as. */
export const DELEGATED_MODEL_ROLES = ["executor", "reviewer"] as const;
export type DelegatedModelRole = (typeof DELEGATED_MODEL_ROLES)[number];
export const DEFAULT_MODEL = "glm-5.3";

const ROLE_LABELS: Record<ModelRoleKey, string> = {
  main: "Main",
  executor: "Executor",
  reviewer: "Reviewer",
  router: "Router"
};

export interface RoleModelBinding {
  profileId: string;
}

export interface RoleModelConfig {
  version: 1;
  /** Defaults for every project on this execution host. */
  host?: Partial<Record<ModelRoleKey, RoleModelBinding>>;
  /** This host's overrides, keyed by the shared project's stable id. */
  projects?: Record<string, Partial<Record<ModelRoleKey, RoleModelBinding>>>;
}

export type RoleModelSource = "explicit" | "project" | "host" | "active" | "environment" | "retry";

/** A launch request may pin a connection and/or a model for one Run. */
export interface ModelRoleRequest {
  role?: ModelRoleKey;
  projectId?: string | null;
  /** Explicit one-off connection; a missing id is an error, never a fallback. */
  profileId?: string;
  /** Explicit one-off model on the resolved connection. */
  model?: string;
  /** The model a saved failed request already used; retries never re-pick an account. */
  retryModel?: string;
  /** The Task's last model, kept for legacy single-connection deployments. */
  taskModel?: string;
  thinkingLevel?: PiThinkingLevel;
}

/**
 * What one delegated work item asks for beyond its role.
 *
 * Only these non-sensitive values are persisted with the work item, so a
 * recovered call re-reads the host's configuration instead of copying a key
 * into shared data.
 */
export interface DelegatedModelRequest {
  role: DelegatedModelRole;
  projectId?: string | null;
  /** One-off connection for this work item; never saved as a role binding. */
  profileId?: string;
  /** One-off model on the connection the role resolves to. */
  model?: string;
}

export interface ResolvedModelRole {
  role: ModelRoleKey;
  source: RoleModelSource;
  connectionId?: string;
  connectionName?: string;
  projectId?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  profile: ConnectionProfile;
  thinkingLevel: PiThinkingLevel;
  supportsImages: boolean;
}

/** Non-sensitive description recorded on each Run and returned to settings clients. */
export interface ModelRoleSnapshot {
  role: ModelRoleKey;
  source: RoleModelSource;
  connectionId: string | null;
  connectionName: string | null;
  model: string;
  api: ConnectionProfile["api"];
  thinkingLevel: PiThinkingLevel;
  supportsImages: boolean;
  projectId?: string;
}

function isRoleKey(value: unknown): value is ModelRoleKey {
  return typeof value === "string" && (MODEL_ROLE_KEYS as readonly string[]).includes(value);
}

function parseBinding(value: unknown, scope: string): RoleModelBinding {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${scope} 的模型角色配置无法读取`);
  const profileId = (value as Record<string, unknown>).profileId;
  if (typeof profileId !== "string" || !profileId.trim() || profileId.length > 200)
    throw new Error(`${scope} 的模型角色配置无法读取`);
  return { profileId };
}

function parseProjectId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error("项目 ID 不合法");
  return value.trim();
}

/** Structural validation while reading the local configuration. */
export function validateRoleModelConfig(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型角色配置无法读取");
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error("模型角色配置版本不兼容，请升级应用");
  for (const key of Object.keys(record))
    if (!["version", "host", "projects"].includes(key)) throw new Error(`模型角色配置包含未知字段：${key}`);
  if (record.host !== undefined) {
    if (!record.host || typeof record.host !== "object" || Array.isArray(record.host))
      throw new Error("模型角色配置的主机默认无法读取");
    for (const [role, binding] of Object.entries(record.host)) {
      if (!isRoleKey(role)) throw new Error(`模型角色配置包含未知角色：${role}`);
      parseBinding(binding, ROLE_LABELS[role]);
    }
  }
  if (record.projects !== undefined) {
    if (!record.projects || typeof record.projects !== "object" || Array.isArray(record.projects))
      throw new Error("模型角色配置的项目覆盖无法读取");
    for (const [projectId, bindings] of Object.entries(record.projects)) {
      parseProjectId(projectId);
      if (!bindings || typeof bindings !== "object" || Array.isArray(bindings))
        throw new Error("模型角色配置的项目覆盖无法读取");
      for (const [role, binding] of Object.entries(bindings)) {
        if (!isRoleKey(role)) throw new Error(`模型角色配置包含未知角色：${role}`);
        parseBinding(binding, ROLE_LABELS[role]);
      }
    }
  }
}

function normalizedProfile(connection: ModelConnection): ConnectionProfile {
  return parseConnectionProfile(
    connection as unknown as Record<string, unknown>,
    connectionProfile(connection)
  );
}

function roleLabel(role: ModelRoleKey): string {
  return ROLE_LABELS[role];
}

function connectionFor(
  registry: { profiles: ModelConnection[] },
  profileId: string,
  scope: string
): ModelConnection {
  const connection = registry.profiles.find((profile) => profile.id === profileId);
  if (!connection) throw new Error(`${scope}不存在（${profileId}），请重新选择；不会改用其他连接`);
  return connection;
}

/**
 * Resolve which connection and model a Run starts with.
 *
 * Priority is explicit one-off selection, the current host's project override,
 * the host role default, then the existing active connection. A named but
 * missing connection raises instead of silently using another account. The
 * result is fixed when the launch is admitted; later settings changes only
 * affect the next Run.
 *
 * `env` is the environment the launch belongs to. A delegated work item passes
 * its own empty environment: the Main Run's pinned connection is the parent's
 * choice, not the child's, so reading it here would silently pin every
 * delegation to Main's account.
 */
export function resolveModelRole(
  config: CoworkConfig,
  request: ModelRoleRequest = {},
  env: NodeJS.ProcessEnv = process.env
): ResolvedModelRole {
  const role = request.role ?? "main";
  if (!isRoleKey(role)) throw new Error(`未知的模型角色：${String(request.role)}`);
  const registry = modelConnections(config);
  const realRegistry = config.modelConnections;
  const projectId = request.projectId?.trim() || undefined;
  const explicitProfileId = request.profileId?.trim() || undefined;
  // A model forced by the launch environment is an explicit choice, as it was
  // before roles existed; it still uses the connection resolved for this Run.
  const explicitModel = request.model?.trim() || env.COWORK_MODEL?.trim() || undefined;
  const retryModel = request.retryModel?.trim() || undefined;
  const sourceModel = (fallback: string) => retryModel ?? explicitModel ?? fallback;
  const sourceName = (base: RoleModelSource): RoleModelSource => (retryModel ? "retry" : base);

  const fromConnection = (
    source: RoleModelSource,
    connection: ModelConnection,
    scopeProject?: string
  ): ResolvedModelRole => {
    const profile = normalizedProfile(connection);
    const active = connection.id === realRegistry?.activeId;
    // An environment key belongs to the forced endpoint, so only the active
    // connection may fall back to it; a role connection must keep its own key.
    const apiKey = active
      ? env.COWORK_API_KEY || connection.apiKey || config.apiKey || ""
      : connection.apiKey || "";
    if (!apiKey)
      throw new Error(
        `${ROLE_LABELS[role]} 角色引用的模型连接「${connection.name}」缺少可用的 API Key，请在执行主机重新填写`
      );
    return {
      role,
      source: sourceName(source),
      ...(realRegistry ? { connectionId: connection.contextId || connection.id } : {}),
      connectionName: connection.name,
      ...(projectId ? { projectId: scopeProject ?? projectId } : {}),
      baseUrl: connection.baseUrl,
      apiKey,
      model: sourceModel(connection.model),
      profile,
      thinkingLevel: request.thinkingLevel ?? profile.reasoningEffort,
      supportsImages: connection.supportsImages === true
    };
  };

  if (explicitProfileId) {
    return fromConnection("explicit", connectionFor(registry, explicitProfileId, "指定的模型连接"));
  }

  const forcedBase = env.COWORK_API_BASE;
  if (forcedBase) {
    const profile = connectionProfile(config);
    return {
      role,
      source: sourceName("environment"),
      baseUrl: forcedBase,
      apiKey: env.COWORK_API_KEY || config.apiKey || "",
      model: sourceModel(
        env.COWORK_MODEL ||
          (realRegistry?.activeId ? config.model : request.taskModel) ||
          config.model ||
          DEFAULT_MODEL
      ),
      profile,
      thinkingLevel: request.thinkingLevel ?? profile.reasoningEffort,
      supportsImages: configuredSupportsImages(runtimeSettingsEnv(config))
    };
  }

  const projectBinding = projectId ? config.roleModels?.projects?.[projectId]?.[role] : undefined;
  if (projectBinding) {
    const scope = `项目 ${projectId} 的 ${roleLabel(role)} 角色引用的模型连接`;
    return fromConnection("project", connectionFor(registry, projectBinding.profileId, scope), projectId);
  }

  const hostBinding = config.roleModels?.host?.[role];
  if (hostBinding) {
    const scope = `主机的 ${roleLabel(role)} 角色引用的模型连接`;
    return fromConnection("host", connectionFor(registry, hostBinding.profileId, scope));
  }

  const active = realRegistry?.activeId
    ? registry.profiles.find((profile) => profile.id === realRegistry.activeId)
    : undefined;
  if (active) return fromConnection("active", active);

  const profile = connectionProfile(config);
  return {
    role,
    source: sourceName("active"),
    baseUrl: config.baseUrl || config.apiBase || "",
    apiKey: env.COWORK_API_KEY || config.apiKey || "",
    model: sourceModel(request.taskModel || env.COWORK_MODEL || config.model || DEFAULT_MODEL),
    profile,
    thinkingLevel: request.thinkingLevel ?? profile.reasoningEffort,
    supportsImages: configuredSupportsImages(runtimeSettingsEnv(config))
  };
}

/** The environment a launched process receives for the resolved connection. */
export function roleConnectionEnv(selection: ResolvedModelRole): Record<string, string> {
  return {
    COWORK_API_BASE: selection.baseUrl,
    COWORK_API_KEY: selection.apiKey,
    COWORK_MODEL: selection.model,
    ...(selection.connectionId ? { COWORK_CONNECTION_ID: selection.connectionId } : {}),
    COWORK_MODEL_API: selection.profile.api,
    COWORK_THINKING_FORMAT: selection.profile.thinkingFormat ?? "auto",
    COWORK_REASONING_EFFORT: selection.thinkingLevel,
    COWORK_SUPPORTS_REASONING_EFFORT: selection.profile.supportsReasoningEffort ? "1" : "0",
    COWORK_SUPPORTS_PROMPT_CACHE_KEY: selection.profile.supportsPromptCacheKey ? "1" : "0",
    COWORK_SUPPORTS_IMAGES: selection.supportsImages ? "1" : "0",
    COWORK_CONTEXT_WINDOW: String(selection.profile.contextWindow),
    COWORK_MAIN_MAX_TOKENS: String(selection.profile.mainMaxTokens),
    COWORK_MAX_TOKENS: String(selection.profile.subagentMaxTokens)
  };
}

export function isDelegatedModelRole(value: unknown): value is DelegatedModelRole {
  return typeof value === "string" && (DELEGATED_MODEL_ROLES as readonly string[]).includes(value);
}

/** The binding a delegated role would read, project override first. */
export function delegatedRoleBinding(
  config: CoworkConfig,
  role: DelegatedModelRole,
  projectId?: string | null
): RoleModelBinding | undefined {
  const project = projectId?.trim();
  return (
    (project ? config.roleModels?.projects?.[project]?.[role] : undefined) ?? config.roleModels?.host?.[role]
  );
}

/**
 * Resolve the connection and model one delegated work item runs with.
 *
 * Returns `undefined` when this host has no binding for the role and the caller
 * named no one-off selection: an ordinary delegation then keeps inheriting the
 * Main Run's own connection, exactly as it did before roles reached this path.
 * A binding is read from the execution host's saved configuration with an empty
 * environment, so the Main Run's pinned connection never masquerades as the
 * child's environment choice and every secret stays on this host.
 */
export function resolveDelegatedModelRole(
  config: CoworkConfig,
  request: DelegatedModelRequest,
  env: NodeJS.ProcessEnv = {}
): ResolvedModelRole | undefined {
  if (!isDelegatedModelRole(request.role)) throw new Error(`未知的委派角色：${String(request.role)}`);
  const explicitProfileId = request.profileId?.trim() || undefined;
  const explicitModel = request.model?.trim() || undefined;
  if (!explicitProfileId && !explicitModel && !delegatedRoleBinding(config, request.role, request.projectId))
    return undefined;
  return resolveModelRole(config, { ...request, projectId: request.projectId ?? undefined }, env);
}

/** Nothing here identifies an account or carries a secret. */
export function modelRoleSnapshot(selection: ResolvedModelRole): ModelRoleSnapshot {
  return {
    role: selection.role,
    source: selection.source,
    connectionId: selection.connectionId ?? null,
    connectionName: selection.connectionName ?? null,
    model: selection.model,
    api: selection.profile.api,
    thinkingLevel: selection.thinkingLevel,
    supportsImages: selection.supportsImages,
    ...(selection.projectId ? { projectId: selection.projectId } : {})
  };
}

export interface PublicModelRole {
  role: ModelRoleKey;
  wired: boolean;
  host: RoleModelBinding | null;
  project: RoleModelBinding | null;
  effective: ModelRoleSnapshot | null;
  error?: string;
}

export interface PublicModelRoles {
  projectId: string | null;
  roles: PublicModelRole[];
}

/** Redacted role view for the settings API; never includes a key or endpoint. */
export function publicModelRoles(config: CoworkConfig, projectId?: string): PublicModelRoles {
  const selectedProject = projectId?.trim() || undefined;
  const roles = MODEL_ROLE_KEYS.map((role): PublicModelRole => {
    const host = config.roleModels?.host?.[role] ?? null;
    const project = selectedProject ? (config.roleModels?.projects?.[selectedProject]?.[role] ?? null) : null;
    const wired = WIRED_MODEL_ROLES.includes(role);
    if (!wired) return { role, wired, host, project, effective: null };
    try {
      // A delegated role is resolved the same way its launch resolves it: with
      // the host's saved configuration only. With no binding it has no fixed
      // effective connection — delegations inherit the launching Run's.
      const selection = isDelegatedModelRole(role)
        ? resolveDelegatedModelRole(config, { role, projectId: selectedProject })
        : resolveModelRole(config, { role, projectId: selectedProject });
      if (!selection) return { role, wired, host, project, effective: null };
      return {
        role,
        wired,
        host,
        project,
        // Nothing runnable is configured yet; a pending API key is not an effective connection.
        effective: selection.baseUrl && selection.apiKey ? modelRoleSnapshot(selection) : null
      };
    } catch (error) {
      return {
        role,
        wired,
        host,
        project,
        effective: null,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
  return { projectId: selectedProject ?? null, roles };
}

/**
 * Write one role binding (or clear it with an empty `profileId`).
 *
 * A project override is scoped by an explicit project id; omitting it edits the
 * host default. Unknown references are refused here so the UI cannot create a
 * broken configuration.
 */
export function saveRoleModelBinding(config: CoworkConfig, input: Record<string, unknown>): CoworkConfig {
  if (!isRoleKey(input.role)) throw new Error("请选择有效的模型角色");
  const role = input.role;
  if (input.profileId !== undefined && typeof input.profileId !== "string")
    throw new Error("模型连接 ID 不合法");
  const profileId = typeof input.profileId === "string" ? input.profileId.trim() : "";
  if (profileId) {
    const registry = modelConnections(config);
    if (!registry.profiles.some((profile) => profile.id === profileId))
      throw new Error("模型连接不存在，请刷新设置后重试");
  }
  const projectId = input.projectId === undefined ? undefined : parseProjectId(input.projectId);
  const next: CoworkConfig = {
    ...config,
    roleModels: {
      version: 1,
      ...(config.roleModels?.host ? { host: { ...config.roleModels.host } } : {}),
      ...(config.roleModels?.projects ? { projects: { ...config.roleModels.projects } } : {})
    }
  };
  const roleModels = next.roleModels!;
  if (projectId === undefined) {
    const host = roleModels.host ?? {};
    if (profileId) host[role] = { profileId };
    else delete host[role];
    if (Object.keys(host).length) roleModels.host = host;
    else delete roleModels.host;
  } else {
    const projects = roleModels.projects ?? {};
    const bindings = { ...projects[projectId] };
    if (profileId) bindings[role] = { profileId };
    else delete bindings[role];
    if (Object.keys(bindings).length) projects[projectId] = bindings;
    else delete projects[projectId];
    if (Object.keys(projects).length) roleModels.projects = projects;
    else delete roleModels.projects;
  }
  if (!roleModels.host && !roleModels.projects) delete next.roleModels;
  return next;
}
