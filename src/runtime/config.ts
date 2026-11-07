import { validateWebSearchConfig, type WebSearchConfig } from "./web-search-config.js";
import { proxyEnvironment } from "./http-transport.js";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { modelConnections, type ModelConnections } from "./model-connections.js";
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

export interface CoworkConfig extends RuntimeSettingsConfig, WebSearchConfig {
  modelConnections?: ModelConnections;
  baseUrl?: string;
  apiBase?: string;
  apiKey?: string;
  model?: string;
  workspaceRoot?: string;
  taskId?: string;
  serperApiKey?: string;
  webTools?: boolean;
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
  if (config.supportsImages !== undefined && typeof config.supportsImages !== "boolean")
    throw new Error("模型配置 supportsImages 必须为布尔值");
  if (config.supportsPromptCacheKey !== undefined && typeof config.supportsPromptCacheKey !== "boolean")
    throw new Error("模型配置 supportsPromptCacheKey 必须为布尔值");
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
  } catch {
    // A damaged store is reported by the settings services; it must not stop runs
    // that use a key from the environment or a legacy plaintext configuration.
    return config;
  }
  applyHostCredentials(config, credentials);
  return config;
}
