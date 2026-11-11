import { randomUUID } from "node:crypto";
import { connectionProfile, parseConnectionProfile, type ConnectionProfile } from "./model-profile.js";
import type { CoworkConfig } from "./config.js";
import { normalizeContextWindow } from "./runtime-settings.js";

export interface ModelConnection extends ConnectionProfile {
  id: string;
  name: string;
  contextId?: string;
  baseUrl: string;
  model: string;
  supportsImages: boolean;
  apiKey?: string;
  encryptedApiKey?: string;
}
export interface ModelConnections {
  version: 1;
  activeId?: string;
  /** Existing profile used only to analyse images for text-only agents. */
  visionId?: string;
  profiles: ModelConnection[];
}

/** Existing single connections remain readable until the first explicit save. */
export function modelConnections(config: CoworkConfig): ModelConnections {
  if (config.modelConnections) {
    const value = config.modelConnections;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- modelConnections 来自持久化的 config.json，旧文件的 version 不是 1 时不能按当前结构读取
    if (value.version !== 1) throw new Error("模型配置版本不兼容，请升级应用");
    if (
      !Array.isArray(value.profiles) ||
      value.profiles.some(
        (p) =>
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- profiles 来自持久化 JSON，数组元素可能是 null 或缺少字段
          !p ||
          typeof p.id !== "string" ||
          typeof p.name !== "string" ||
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 持久化 JSON 里的 supportsPromptCacheKey 可能是字符串等非布尔值
          (p.supportsPromptCacheKey !== undefined && typeof p.supportsPromptCacheKey !== "boolean")
      ) ||
      new Set(value.profiles.map((p) => p.id)).size !== value.profiles.length ||
      (value.activeId && !value.profiles.some((p) => p.id === value.activeId)) ||
      (value.visionId !== undefined &&
        (typeof value.visionId !== "string" ||
          !value.profiles.some((p) => p.id === value.visionId && p.supportsImages === true)))
    )
      throw new Error("模型配置列表无法读取");
    const registry = structuredClone(value);
    for (const profile of registry.profiles)
      profile.contextWindow = normalizeContextWindow(profile.contextWindow);
    return registry;
  }
  if (!config.baseUrl && !config.apiBase) return { version: 1, profiles: [] };
  return {
    version: 1,
    activeId: "default",
    profiles: [
      {
        ...connectionProfile(config),
        id: "default",
        name: "默认配置",
        baseUrl: config.baseUrl || config.apiBase || "",
        model: config.model || "",
        supportsImages: config.supportsImages === true,
        apiKey: config.apiKey
      }
    ]
  };
}

export function selectedConnection(config: CoworkConfig, input: Record<string, unknown>) {
  const registry = modelConnections(config);
  const id = input.profileId === undefined ? registry.activeId : input.profileId;
  if (id === "" || id === undefined) return undefined;
  if (typeof id !== "string") throw new Error("模型配置 ID 不合法");
  const profile = registry.profiles.find((p) => p.id === id);
  if (!profile) throw new Error("模型配置不存在，请重新打开设置");
  return profile;
}

export function publicConnections(config: CoworkConfig) {
  const registry = modelConnections(config);
  return {
    activeProfileId: registry.activeId || "",
    visionProfileId: registry.visionId || "",
    profiles: registry.profiles.map((p) => ({
      ...parseConnectionProfile(p as unknown as Record<string, unknown>, connectionProfile(p)),
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      model: p.model,
      supportsImages: p.supportsImages,
      configured: Boolean(p.apiKey),
      active: p.id === registry.activeId,
      vision: p.id === registry.visionId
    }))
  };
}

/** Empty keys only reuse the selected profile's key, never another service's. */
export function saveConnection(config: CoworkConfig, input: Record<string, unknown>): CoworkConfig {
  const registry = modelConnections(config);
  const previous = selectedConnection(config, input);
  let url: URL;
  try {
    url = new URL(typeof input.baseUrl === "string" ? input.baseUrl.trim() : "");
  } catch {
    throw new Error("请填写有效的 HTTP(S) API 地址");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("API 地址需使用 HTTP 或 HTTPS，不能包含凭据");
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model)) throw new Error("请填写有效的模型 ID");
  const name = input.profileName === undefined ? previous?.name || model : input.profileName;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 80)
    throw new Error("配置名称须为 1–80 个字符");
  if (input.activate !== undefined && typeof input.activate !== "boolean")
    throw new Error("启用状态须为布尔值");
  if (input.supportsImages !== undefined && typeof input.supportsImages !== "boolean")
    throw new Error("图像能力设置必须为布尔值");
  if (input.vision !== undefined && typeof input.vision !== "boolean")
    throw new Error("图片分析用途须为布尔值");
  const apiKey =
    typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : previous?.apiKey;
  if (!apiKey || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) throw new Error("请填写有效的 API Key");
  const profile: ModelConnection = {
    ...parseConnectionProfile(input, connectionProfile(previous || {})),
    id: previous?.id || randomUUID(),
    name: name.trim(),
    contextId: previous?.apiKey === apiKey ? previous.contextId || previous.id : randomUUID(),
    baseUrl: url.href.replace(/\/+$/, ""),
    model,
    apiKey,
    supportsImages: input.supportsImages ?? previous?.supportsImages ?? false
  };
  registry.profiles = [...registry.profiles.filter((p) => p.id !== profile.id), profile];
  if (input.vision === true) {
    if (!profile.supportsImages) throw new Error("图片分析连接必须启用图像输入");
    registry.visionId = profile.id;
  } else if (input.vision === false && registry.visionId === profile.id) delete registry.visionId;
  if (registry.visionId === profile.id && !profile.supportsImages)
    throw new Error("请先取消图片分析用途，再关闭图像输入");
  if (!registry.activeId || input.activate === true || input.profileId === undefined)
    registry.activeId = profile.id;
  const active = registry.profiles.find((p) => p.id === registry.activeId)!;
  // The active connection's narrowed levels, or none: never another connection's.
  const { reasoningLevels: _previousLevels, ...rest } = config;
  return {
    ...rest,
    ...parseConnectionProfile(active as unknown as Record<string, unknown>, connectionProfile(active)),
    baseUrl: active.baseUrl,
    model: active.model,
    apiKey: active.apiKey,
    supportsImages: active.supportsImages,
    modelConnections: registry
  };
}
