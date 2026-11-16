import type { WebToolOptions } from "../tools/web-tools.js";

/** Search is Exa or off; the optional key belongs to the execution host. */
export interface WebSearchConfig {
  webSearch?: { provider: "exa" | "off"; exaApiKey?: string };
}

export function validateWebSearchConfig(config: WebSearchConfig): void {
  const search = config.webSearch;
  if (search !== undefined) {
    if (
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- webSearch 来自 config.json 的自由 JSON，为 null 时 typeof 也是 object，必须先由 !search 拦成配置错误
      !search ||
      typeof search !== "object" ||
      Array.isArray(search) ||
      !["exa", "off"].includes(search.provider)
    )
      throw new Error("webSearch.provider must be exa or off");
    if (
      search.exaApiKey !== undefined &&
      (typeof search.exaApiKey !== "string" ||
        search.exaApiKey.length > 4096 ||
        /[\r\n\0]/.test(search.exaApiKey))
    )
      throw new Error("webSearch.exaApiKey must be a single-line string");
  }
}

/** An explicit choice disables search; no configuration means anonymous Exa. */
export function configuredWebTools(
  config: WebSearchConfig = {},
  env: NodeJS.ProcessEnv = process.env
): WebToolOptions | undefined {
  validateWebSearchConfig(config);
  if (env.COWORK_WEB_TOOLS !== undefined && !["0", "1"].includes(env.COWORK_WEB_TOOLS))
    throw new Error("COWORK_WEB_TOOLS must be 0 or 1");
  if (env.COWORK_WEB_TOOLS === "0" || config.webSearch?.provider === "off") return undefined;
  return {
    provider: "exa",
    exaApiKey: env.COWORK_EXA_API_KEY ?? env.EXA_API_KEY ?? config.webSearch?.exaApiKey,
    ...(env.COWORK_EXA_MCP_ENDPOINT ? { exaEndpoint: env.COWORK_EXA_MCP_ENDPOINT } : {})
  };
}

export function publicWebSearchStatus(config: WebSearchConfig, env: NodeJS.ProcessEnv = process.env) {
  const web = configuredWebTools(config, env);
  return {
    enabled: Boolean(web),
    provider: web?.provider ?? "off",
    authenticated: Boolean(web?.exaApiKey),
    managedByEnvironment: ["COWORK_WEB_TOOLS", "COWORK_EXA_API_KEY", "EXA_API_KEY"].some(
      (key) => env[key] !== undefined
    )
  };
}

export function saveWebSearchConfig(
  config: WebSearchConfig,
  input: Record<string, unknown>
): WebSearchConfig {
  if (!["exa", "off"].includes(String(input.provider))) throw new Error("搜索服务必须为 Exa 或关闭");
  if (
    input.exaApiKey !== undefined &&
    (typeof input.exaApiKey !== "string" || input.exaApiKey.length > 4096 || /[\r\n\0]/.test(input.exaApiKey))
  )
    throw new Error("Exa API Key 必须为单行字符串");
  if (input.clearExaApiKey !== undefined && typeof input.clearExaApiKey !== "boolean")
    throw new Error("clearExaApiKey 必须为布尔值");
  return {
    ...config,
    webSearch: {
      ...config.webSearch,
      provider: input.provider as "exa" | "off",
      exaApiKey: input.clearExaApiKey
        ? undefined
        : typeof input.exaApiKey === "string" && input.exaApiKey.trim()
          ? input.exaApiKey.trim()
          : config.webSearch?.exaApiKey
    }
  };
}
