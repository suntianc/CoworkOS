import { createHttpTransport, proxyEnvironment, type HttpProxyConfig } from "./http-transport.js";

/** Provider discovery is optional; a failed catalog retains the selected model. */
export async function availableModelIds(
  input: HttpProxyConfig & {
    model: string;
    baseUrl?: string;
    apiKey?: string;
  }
): Promise<string[]> {
  const fallback = [input.model];
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
    const ids = body.data
      .filter((entry) => {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- data 来自服务商 /v1/models 响应体，元素可能是 null 或非对象
        const endpoints = entry?.supported_endpoint_types;
        return !Array.isArray(endpoints) || endpoints.length === 0 || endpoints.includes("openai");
      })
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 同上，模型条目来自服务商响应体，id 可能缺失
      .map((entry) => (typeof entry?.id === "string" ? entry.id.trim() : ""))
      .filter((id) => id.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id));
    return [...new Set([...fallback, ...ids])];
    // eslint-disable-next-line no-restricted-syntax -- 目录发现只是可选的模型列表增强，失败时保留已选模型，请求仍按 input.model 发送
  } catch {
    return fallback;
  } finally {
    await transport.close();
  }
}
