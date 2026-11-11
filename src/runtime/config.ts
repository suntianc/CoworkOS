import { validateWebSearchConfig, type WebSearchConfig } from "./web-search-config.js";
import { proxyEnvironment } from "./http-transport.js";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { modelConnections, type ModelConnections } from "./model-connections.js";
import { parseReasoningLevels } from "./model-profile.js";
import { validateRoleModelConfig, type RoleModelConfig } from "./role-models.js";
import {
  normalizeModelApi,
  normalizeThinkingFormat,
  normalizeContextWindow,
  type RuntimeSettingsConfig
} from "./runtime-settings.js";
import { atriaDataPaths } from "../../scripts/data-home.cjs";
import {
  applyHostCredentials,
  hostCredentialsPath,
  readHostCredentials
} from "../security/host-credentials.js";
import type { ProjectDataConfig } from "../storage/project-data/config.js";
import { mainCapacitySettings, type MainCapacitySettings } from "../domain/main-capacity.js";

export interface CoworkConfig extends RuntimeSettingsConfig, WebSearchConfig {
  modelConnections?: ModelConnections;
  /** Execution-host role bindings; project overrides stay in this local file. */
  roleModels?: RoleModelConfig;
  baseUrl?: string;
  apiBase?: string;
  apiKey?: string;
  model?: string;
  workspaceRoot?: string;
  taskId?: string;
  serperApiKey?: string;
  webTools?: boolean;
  /** Default SQLite; an explicit PostgreSQL choice is never replaced by a fallback. */
  projectData?: ProjectDataConfig;
  /** External Main quotas; absent keeps the internal-only behavior of an old entry. */
  mainCapacity?: MainCapacitySettings;
}

/**
 * The configuration root a process that reads the host file itself starts from.
 *
 * The Dashboard, a Main process and a delegated launch all name the same root,
 * so a role binding written by one is the binding the next launch reads.
 */
export function hostConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.COWORK_CONFIG_ROOT ?? env.COWORK_HARNESS_ROOT ?? process.cwd();
}

/** Explicit and project paths win; all installed hosts share the user fallback. */
export function coworkConfigPath(root = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  return env.COWORK_CONFIG
    ? resolve(root, env.COWORK_CONFIG)
    : ([join(root, ".cowork", "config.json"), join(root, "config.json")].find(existsSync) ??
        atriaDataPaths(env).configPath);
}

export function readCoworkConfig(root = process.cwd(), env: NodeJS.ProcessEnv = process.env): CoworkConfig {
  const explicit = env.COWORK_CONFIG;
  const path = coworkConfigPath(root, env);
  if (!existsSync(path)) {
    if (explicit) throw new Error("COWORK_CONFIG 指定的配置文件不存在");
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // JSON parser errors can contain excerpts of the API key; never forward them.
    throw new Error("模型配置文件无法读取或不是有效 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("模型配置必须是 JSON 对象");
  const config = value as CoworkConfig;
  validateWebSearchConfig(config);
  normalizeModelApi(config.api);
  normalizeThinkingFormat(config.thinkingFormat);
  normalizeContextWindow(config.contextWindow);
  proxyEnvironment(config, {});
  if (config.modelConnections) modelConnections(config);
  // An explicit external configuration is either valid or an error: guessing
  // would silently change how many Mains this host runs.
  if (config.mainCapacity !== undefined) config.mainCapacity = mainCapacitySettings(config.mainCapacity);
  validateRoleModelConfig(config.roleModels);
  if (config.supportsImages !== undefined && typeof config.supportsImages !== "boolean")
    throw new Error("模型配置 supportsImages 必须为布尔值");
  if (config.supportsPromptCacheKey !== undefined && typeof config.supportsPromptCacheKey !== "boolean")
    throw new Error("模型配置 supportsPromptCacheKey 必须为布尔值");
  if (config.reasoningLevels !== undefined) parseReasoningLevels(config.reasoningLevels);
  for (const field of ["baseUrl", "apiBase", "apiKey", "model"] as const) {
    if (config[field] !== undefined && (typeof config[field] !== "string" || !config[field].trim())) {
      throw new Error(`模型配置 ${field} 必须为非空字符串`);
    }
  }
  return { ...config, baseUrl: config.baseUrl ?? config.apiBase };
}

/**
 * The execution host's effective configuration: the public file plus the
 * credential store the host owns. A damaged store leaves secrets unresolved so
 * ordinary runs and unrelated settings keep working; the settings services
 * report the concrete error instead of starting a process with a bad key.
 */
export function readHostCoworkConfig(
  root = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): CoworkConfig {
  const config = readCoworkConfig(root, env);
  let credentials;
  try {
    credentials = readHostCredentials(hostCredentialsPath(coworkConfigPath(root, env), env));
    // eslint-disable-next-line no-restricted-syntax -- 凭据库损坏不能让使用环境变量密钥的普通运行失败，具体错误由设置服务读取同一存储时单独上报
  } catch {
    // A damaged store is reported by the settings services; it must not stop runs
    // that use a key from the environment or a legacy plaintext configuration.
    return config;
  }
  applyHostCredentials(config, credentials);
  return config;
}
