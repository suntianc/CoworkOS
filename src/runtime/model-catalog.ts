import { createHash } from "node:crypto";
import { createHttpTransport, proxyEnvironment, type HttpProxyConfig } from "./http-transport.js";
import { endpointLevels } from "./model-levels.js";
import { endpointLimits, type EndpointLimits } from "./model-limits.js";
import type { PiThinkingLevel } from "./runtime-settings.js";

type CatalogInput = HttpProxyConfig & {
  model: string;
  baseUrl?: string;
  apiKey?: string;
};
/** A model the connection offers, with the reasoning levels its `/models` entry names (#27). */
export interface CatalogModel {
  id: string;
  levels?: PiThinkingLevel[];
  /** Context window, largest output and image input, when the entry names them. */
  limits?: EndpointLimits;
}

/** Provider discovery is optional; a failed catalog retains the selected model. */
export async function availableModelIds(input: CatalogInput): Promise<string[]> {
  return (await availableModels(input)).map((model) => model.id);
}

export async function availableModels(input: CatalogInput): Promise<CatalogModel[]> {
  const fallback: CatalogModel[] = [{ id: input.model }];
  if (!input.baseUrl || !input.apiKey) return fallback;
  const transport = createHttpTransport(proxyEnvironment(input));
  try {
    const root = input.baseUrl.replace(/\/+$/, "");
    const response = await transport.fetch(`${root.endsWith("/v1") ? root : `${root}/v1`}/models`, {
      headers: { authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(5000),
      redirect: "error"
    });
    if (!response.ok) return fallback;
    const body = (await response.json()) as {
      data?: Array<{ id?: unknown; supported_endpoint_types?: unknown }>;
    };
    if (!Array.isArray(body.data)) return fallback;
    const entries = body.data
      .filter((entry) => {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- data 来自服务商 /v1/models 响应体，元素可能是 null 或非对象
        const endpoints = entry?.supported_endpoint_types;
        return !Array.isArray(endpoints) || endpoints.length === 0 || endpoints.includes("openai");
      })
      .map((entry): CatalogModel => {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 同上，模型条目来自服务商响应体，id 可能缺失
        const id = typeof entry?.id === "string" ? entry.id.trim() : "";
        const levels = endpointLevels(entry);
        const limits = endpointLimits(entry);
        return { id, ...(levels ? { levels } : {}), ...(limits ? { limits } : {}) };
      })
      .filter(({ id }) => id.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id));
    // The selected model keeps its place first; its own entry, when listed, supplies the levels.
    const byId = new Map<string, CatalogModel>(fallback.map((model) => [model.id, model]));
    for (const entry of entries)
      if (!byId.has(entry.id) || entry.levels || entry.limits) byId.set(entry.id, entry);
    return [...byId.values()];
    // eslint-disable-next-line no-restricted-syntax -- 目录发现只是可选的模型列表增强，失败时保留已选模型，请求仍按 input.model 发送
  } catch {
    return fallback;
  } finally {
    await transport.close();
  }
}

const cache = new Map<string, { at: number; models: Promise<CatalogModel[]> }>();
const CACHE_MS = 5 * 60_000;
/**
 * The catalog, read at most once every few minutes per address and key: the
 * composer's list and each Run's start ask the same provider question.
 */
export function cachedAvailableModels(input: CatalogInput): Promise<CatalogModel[]> {
  const key = `${input.baseUrl ?? ""}\n${createHash("sha256")
    .update(input.apiKey ?? "")
    .digest("hex")}\n${input.model}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.models;
  const models = availableModels(input);
  cache.set(key, { at: Date.now(), models });
  return models;
}
