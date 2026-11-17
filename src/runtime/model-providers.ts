import { randomUUID } from "node:crypto";
import type { CoworkConfig } from "./config.js";
import {
  connectionProfile,
  NEW_CONNECTION_PROFILE,
  parseConnectionProfile,
  type ConnectionProfile
} from "./model-profile.js";
import {
  normalizeContextWindow,
  normalizeModelApi,
  normalizeThinkingFormat,
  type CoworkModelApi,
  type CoworkThinkingFormat
} from "./runtime-settings.js";

/**
 * Model providers on the execution host.
 *
 * A provider is one service account: an address, a wire format and a key. It
 * offers any number of models, and each model keeps its own limits and
 * reasoning settings. Everything that runs a request still works with one
 * flattened connection (provider + model); its id is `<providerId>#<modelId>`,
 * which role bindings and one-off launches name.
 */

/** Settings that belong to one model rather than to the account. */
type ModelSettings = Omit<ConnectionProfile, "api" | "thinkingFormat" | "supportsPromptCacheKey">;

export interface ProviderModel extends ModelSettings {
  /** The id sent to the service. */
  id: string;
  /** Display name, when the provider's listing gives one. */
  name?: string;
  supportsImages: boolean;
}

export interface ModelProvider {
  id: string;
  name: string;
  /** Preset this provider was created from; only chooses the logo and defaults. */
  preset?: string;
  baseUrl: string;
  api: CoworkModelApi;
  thinkingFormat?: CoworkThinkingFormat;
  supportsPromptCacheKey: boolean;
  enabled: boolean;
  /** Present in memory only; persisted in the host credential store. */
  apiKey?: string;
  models: ProviderModel[];
}

export interface ModelProviders {
  version: 1;
  providers: ModelProvider[];
}

/** One provider model, as the request path uses it. */
export interface ModelConnection extends ConnectionProfile {
  id: string;
  name: string;
  /** The account context; models of one provider share it. */
  contextId: string;
  providerId: string;
  baseUrl: string;
  model: string;
  supportsImages: boolean;
  apiKey?: string;
}

export interface ModelConnections {
  version: 1;
  /** The connection Main uses without an explicit choice. */
  activeId?: string;
  profiles: ModelConnection[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/;
const unreadable = () => new Error("模型供应商配置无法读取");

export const connectionIdOf = (providerId: string, modelId: string) => `${providerId}#${modelId}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new Error(`${label}须为 1–${max} 个字符`);
  return value.trim();
}

function parseBaseUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(typeof value === "string" ? value.trim() : "");
  } catch {
    throw new Error("请填写有效的 HTTP(S) API 地址");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("API 地址需使用 HTTP 或 HTTPS，不能包含凭据");
  return url.href.replace(/\/+$/, "");
}

function parseModelId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!MODEL_ID.test(id)) throw new Error(`模型 ID 不合法：${String(value)}`);
  return id;
}

/** The account-level part of a connection profile, merged with one model's settings. */
function modelProfile(provider: ModelProvider, model: ModelSettings): ConnectionProfile {
  return parseConnectionProfile(
    {
      ...model,
      api: provider.api,
      thinkingFormat: provider.thinkingFormat,
      supportsPromptCacheKey: provider.supportsPromptCacheKey
    },
    connectionProfile({ ...NEW_CONNECTION_PROFILE, api: provider.api })
  );
}

/** Model settings from form input, over the model's previous values or new-model defaults. */
function parseModelSettings(
  provider: ModelProvider,
  input: Record<string, unknown>,
  previous?: ProviderModel
): ModelSettings {
  const base = previous ?? NEW_CONNECTION_PROFILE;
  const profile = parseConnectionProfile(
    {
      ...input,
      api: provider.api,
      thinkingFormat: provider.thinkingFormat,
      supportsPromptCacheKey: provider.supportsPromptCacheKey
    },
    {
      ...base,
      api: provider.api,
      supportsPromptCacheKey: provider.supportsPromptCacheKey
    }
  );
  const { api: _api, thinkingFormat: _format, supportsPromptCacheKey: _cache, ...settings } = profile;
  return settings;
}

function readModel(provider: ModelProvider, value: unknown): ProviderModel {
  if (!isRecord(value)) throw unreadable();
  const id = parseModelId(value.id);
  if (value.name !== undefined && typeof value.name !== "string") throw unreadable();
  if (typeof value.supportsImages !== "boolean") throw unreadable();
  const settings = parseModelSettings(provider, value);
  normalizeContextWindow(settings.contextWindow);
  return {
    ...settings,
    id,
    ...(typeof value.name === "string" && value.name.trim() ? { name: value.name.trim() } : {}),
    supportsImages: value.supportsImages
  };
}

/** The validated provider list; empty when this host has none. */
export function modelProviders(config: CoworkConfig): ModelProviders {
  const value: unknown = config.modelProviders;
  if (value === undefined) return { version: 1, providers: [] };
  if (!isRecord(value)) throw unreadable();
  if (value.version !== 1) throw new Error("模型供应商配置版本不兼容，请升级应用");
  if (!Array.isArray(value.providers)) throw unreadable();
  const providers = value.providers.map((entry: unknown): ModelProvider => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !ID.test(entry.id)) throw unreadable();
    if (typeof entry.enabled !== "boolean" || typeof entry.supportsPromptCacheKey !== "boolean")
      throw unreadable();
    if (entry.preset !== undefined && (typeof entry.preset !== "string" || !ID.test(entry.preset)))
      throw unreadable();
    if (entry.apiKey !== undefined && typeof entry.apiKey !== "string") throw unreadable();
    if (!Array.isArray(entry.models)) throw unreadable();
    const provider: ModelProvider = {
      id: entry.id,
      name: text(entry.name, "供应商名称", 80),
      ...(typeof entry.preset === "string" ? { preset: entry.preset } : {}),
      baseUrl: parseBaseUrl(entry.baseUrl),
      api: normalizeModelApi(entry.api),
      thinkingFormat: normalizeThinkingFormat(entry.thinkingFormat),
      supportsPromptCacheKey: entry.supportsPromptCacheKey,
      enabled: entry.enabled,
      ...(typeof entry.apiKey === "string" && entry.apiKey ? { apiKey: entry.apiKey } : {}),
      models: []
    };
    provider.models = entry.models.map((model: unknown) => readModel(provider, model));
    if (new Set(provider.models.map((model) => model.id)).size !== provider.models.length) throw unreadable();
    return provider;
  });
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length) throw unreadable();
  return { version: 1, providers };
}

/** Every model of every enabled provider, as runnable connections. */
export function providerConnections(config: CoworkConfig): ModelConnection[] {
  return modelProviders(config).providers.flatMap((provider) =>
    provider.enabled
      ? provider.models.map((model) => ({
          ...modelProfile(provider, model),
          id: connectionIdOf(provider.id, model.id),
          name: `${provider.name} / ${model.name || model.id}`,
          contextId: provider.id,
          providerId: provider.id,
          baseUrl: provider.baseUrl,
          model: model.id,
          supportsImages: model.supportsImages,
          ...(provider.apiKey ? { apiKey: provider.apiKey } : {})
        }))
      : []
  );
}

/** Main's host binding when it names a runnable model, otherwise the first model offered. */
export function modelConnections(config: CoworkConfig): ModelConnections {
  const profiles = providerConnections(config);
  const bound = config.roleModels?.host?.main?.profileId;
  const activeId = profiles.find((profile) => profile.id === bound)?.id ?? profiles[0]?.id;
  return { version: 1, ...(activeId ? { activeId } : {}), profiles };
}

export function selectedConnection(config: CoworkConfig, input: Record<string, unknown>) {
  const registry = modelConnections(config);
  const id = input.profileId === undefined ? registry.activeId : input.profileId;
  if (id === "" || id === undefined) return undefined;
  if (typeof id !== "string") throw new Error("模型 ID 不合法");
  const profile = registry.profiles.find((p) => p.id === id);
  if (!profile) throw new Error("模型不存在，请重新打开设置");
  return profile;
}

/**
 * Keep the single-connection fields in step with the connection Main uses by
 * default. CLI launches, the composer's model list and the runtime display read
 * these; a host without providers keeps whatever it was started with.
 */
export function withActiveConnection(config: CoworkConfig): CoworkConfig {
  if (!config.modelProviders) return config;
  const registry = modelConnections(config);
  const active = registry.profiles.find((profile) => profile.id === registry.activeId);
  const {
    reasoningLevels: _levels,
    autoLimits: _limits,
    baseUrl: _baseUrl,
    apiBase: _apiBase,
    model: _model,
    apiKey: _apiKey,
    ...rest
  } = config;
  if (!active) return rest;
  const { id: _id, name: _name, contextId: _context, providerId: _provider, ...connection } = active;
  return { ...rest, ...connection };
}

/** Role bindings that name a connection; deleting or disabling what they use is refused. */
function usedBy(config: CoworkConfig, match: (profileId: string) => boolean): string[] {
  const uses: string[] = [];
  const roles = config.roleModels;
  for (const [role, binding] of Object.entries(roles?.host ?? {}))
    if (match(binding.profileId)) uses.push(role);
  return uses;
}

function assertUnused(config: CoworkConfig, match: (profileId: string) => boolean, what: string) {
  const uses = usedBy(config, match);
  if (uses.length) throw new Error(`${what}正被角色使用：${uses.join("、")}。请先在角色分配中改选其他模型`);
}

function withProviders(config: CoworkConfig, providers: ModelProvider[]): CoworkConfig {
  return withActiveConnection({ ...config, modelProviders: { version: 1, providers } });
}

function findProvider(registry: ModelProviders, id: unknown): ModelProvider {
  const provider = registry.providers.find((entry) => entry.id === id);
  if (!provider) throw new Error("模型供应商不存在，请刷新设置后重试");
  return provider;
}

/**
 * Create or update one provider's account fields. An empty key keeps the saved
 * one; a new provider needs a key. Models are edited separately.
 */
export function saveProvider(config: CoworkConfig, input: Record<string, unknown>): CoworkConfig {
  const registry = modelProviders(config);
  const previous = input.id === undefined ? undefined : findProvider(registry, input.id);
  if (input.preset !== undefined && (typeof input.preset !== "string" || !ID.test(input.preset)))
    throw new Error("预置供应商不合法");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    throw new Error("启用状态须为布尔值");
  if (input.supportsPromptCacheKey !== undefined && typeof input.supportsPromptCacheKey !== "boolean")
    throw new Error("缓存键支持须为布尔值");
  const apiKey =
    typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : previous?.apiKey;
  if (!apiKey || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) throw new Error("请填写有效的 API Key");
  const api = normalizeModelApi(input.api ?? previous?.api ?? "openai-completions");
  const enabled = input.enabled ?? previous?.enabled ?? true;
  if (previous && previous.enabled && !enabled)
    assertUnused(config, (id) => id.startsWith(`${previous.id}#`), `供应商「${previous.name}」的模型`);
  const provider: ModelProvider = {
    id: previous?.id ?? randomUUID().replace(/-/g, "").slice(0, 16),
    name: text(input.name ?? previous?.name, "供应商名称", 80),
    ...((input.preset ?? previous?.preset) ? { preset: input.preset ?? previous?.preset } : {}),
    baseUrl: parseBaseUrl(input.baseUrl ?? previous?.baseUrl),
    api,
    thinkingFormat: normalizeThinkingFormat(input.thinkingFormat ?? previous?.thinkingFormat),
    supportsPromptCacheKey:
      api === "anthropic-messages"
        ? false
        : (input.supportsPromptCacheKey ?? previous?.supportsPromptCacheKey ?? false),
    enabled,
    apiKey,
    models: previous?.models ?? []
  };
  // Every model is re-read under the provider's (possibly new) wire format.
  provider.models = provider.models.map((model) => ({
    ...model,
    ...parseModelSettings(provider, {}, model)
  }));
  return withProviders(config, [...registry.providers.filter((entry) => entry.id !== provider.id), provider]);
}

export function deleteProvider(config: CoworkConfig, input: Record<string, unknown>): CoworkConfig {
  const registry = modelProviders(config);
  const provider = findProvider(registry, input.id);
  assertUnused(config, (id) => id.startsWith(`${provider.id}#`), `供应商「${provider.name}」的模型`);
  return withProviders(
    config,
    registry.providers.filter((entry) => entry.id !== provider.id)
  );
}

/**
 * Add, update or remove a provider's models. Each added entry may carry the
 * listing's name and limits; an existing model keeps its settings unless the
 * entry changes them.
 */
export function saveProviderModels(config: CoworkConfig, input: Record<string, unknown>): CoworkConfig {
  const registry = modelProviders(config);
  const provider = findProvider(registry, input.providerId);
  const upsert = input.models === undefined ? [] : input.models;
  const remove = input.remove === undefined ? [] : input.remove;
  if (!Array.isArray(upsert) || !Array.isArray(remove)) throw new Error("模型列表格式不合法");
  const removed = new Set(remove.map(parseModelId));
  assertUnused(
    config,
    (id) => removed.has(id.slice(provider.id.length + 1)) && id.startsWith(`${provider.id}#`),
    "要移除的模型"
  );
  const models = provider.models.filter((model) => !removed.has(model.id));
  for (const entry of upsert) {
    if (!isRecord(entry)) throw new Error("模型列表格式不合法");
    const id = parseModelId(entry.id);
    if (entry.name !== undefined && entry.name !== null && typeof entry.name !== "string")
      throw new Error("模型名称须为文本");
    if (entry.supportsImages !== undefined && typeof entry.supportsImages !== "boolean")
      throw new Error("图像能力设置必须为布尔值");
    const index = models.findIndex((model) => model.id === id);
    const previous = index >= 0 ? models[index] : undefined;
    const name =
      entry.name === undefined ? previous?.name : typeof entry.name === "string" ? entry.name.trim() : "";
    const next: ProviderModel = {
      ...parseModelSettings(provider, entry, previous),
      id,
      ...(name ? { name: name.slice(0, 120) } : {}),
      supportsImages: entry.supportsImages ?? previous?.supportsImages ?? false
    };
    if (index >= 0) models[index] = next;
    else models.push(next);
  }
  if (models.length > 500) throw new Error("单个供应商最多保存 500 个模型");
  const next = { ...provider, models };
  return withProviders(
    config,
    registry.providers.map((entry) => (entry.id === provider.id ? next : entry))
  );
}

/** Redacted view for the settings API; never includes a key. */
export function publicProviders(config: CoworkConfig) {
  const registry = modelProviders(config);
  const active = modelConnections(config).activeId;
  return {
    activeProfileId: active ?? "",
    providers: registry.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      ...(provider.preset ? { preset: provider.preset } : {}),
      baseUrl: provider.baseUrl,
      api: provider.api,
      thinkingFormat: provider.thinkingFormat ?? "auto",
      supportsPromptCacheKey: provider.supportsPromptCacheKey,
      enabled: provider.enabled,
      configured: Boolean(provider.apiKey),
      models: provider.models.map((model) => ({
        ...model,
        profileId: connectionIdOf(provider.id, model.id)
      }))
    }))
  };
}

/** The provider's account fields a probe or listing needs, from form input over the saved provider. */
export function providerDraft(config: CoworkConfig, input: Record<string, unknown>) {
  const registry = modelProviders(config);
  const saved = input.id === undefined ? undefined : findProvider(registry, input.id);
  const supplied = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const api = normalizeModelApi(input.api ?? saved?.api ?? "openai-completions");
  return {
    saved,
    baseUrl: parseBaseUrl(input.baseUrl ?? saved?.baseUrl),
    api,
    thinkingFormat: normalizeThinkingFormat(input.thinkingFormat ?? saved?.thinkingFormat),
    apiKey: supplied || saved?.apiKey || ""
  };
}
