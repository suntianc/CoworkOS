import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpTransport } from "../runtime/http-transport.js";
import { sanitizeRecording } from "../storage/model-request-recorder.js";
import type { SearchProvider, WebSource } from "./search-provider.js";

export const EXA_MCP_ENDPOINT = "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa";
export interface ExaOptions {
  exaEndpoint?: string;
  exaApiKey?: string;
  timeoutMs: number;
  maxContentBytes: number;
  maxContentChars: number;
}
class ExaFailure extends Error {}

/** SDK owns JSON/SSE, initialization, session/protocol headers and cancellation. One call owns one connection. */
export function createExaSearchProvider(options: ExaOptions): SearchProvider {
  const endpoint = new URL(options.exaEndpoint ?? EXA_MCP_ENDPOINT);
  if (
    !["https:", "http:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  )
    throw new Error("Exa endpoint must be an HTTP(S) URL without credentials or fragment");
  endpoint.search = "?tools=web_search_exa,web_fetch_exa";
  if (
    options.exaApiKey !== undefined &&
    (typeof options.exaApiKey !== "string" || /[\r\n\0]/.test(options.exaApiKey))
  )
    throw new Error("Exa API key must be a single-line string");
  const secrets = options.exaApiKey ? [options.exaApiKey] : [];
  const call = async (name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
    signal.throwIfAborted();
    const http = createHttpTransport();
    const client = new Client({ name: "atria-web-search", version: "0.1" });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: options.exaApiKey ? { "x-api-key": options.exaApiKey } : {} },
      fetch: async (url, init) => {
        // No redirected credentials; SDK handles negotiation without auth-provider or extra capabilities.
        const housekeeping =
          init?.method === "DELETE" ||
          (typeof init?.body === "string" && init.body.includes('"notifications/cancelled"'));
        let response: Response;
        try {
          response = await http.fetch(url, {
            ...init,
            redirect: "error",
            signal: housekeeping
              ? AbortSignal.timeout(1000)
              : AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])])
          });
        } catch {
          signal.throwIfAborted();
          throw new ExaFailure("Exa 网络连接失败；检查网络和代理后重试。未获得搜索结果。");
        }
        if (
          !response.ok &&
          !(init?.method === "GET" && response.status === 405) &&
          !(init?.method === "DELETE" && response.status === 405)
        ) {
          await response.body?.cancel();
          throw new ExaFailure(httpFailure(response.status));
        }
        if (!response.body) return response;
        let bytes = 0;
        const bounded = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              bytes += chunk.byteLength;
              if (bytes > options.maxContentBytes) {
                controller.error(new ExaFailure("Exa 响应超出大小限制；缩小搜索范围后重试。"));
                return;
              }
              controller.enqueue(chunk);
            }
          })
        );
        return new Response(bounded, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      }
    });
    try {
      await client.connect(transport, { signal, timeout: options.timeoutMs });
      const result = await client.callTool({ name, arguments: args }, undefined, {
        signal,
        timeout: options.timeoutMs
      });
      signal.throwIfAborted();
      if (result.isError) {
        const message = JSON.stringify(result.content);
        if (/429|rate.?limit|too many requests/i.test(message)) throw new ExaFailure(httpFailure(429));
        if (/quota|credit|402|payment/i.test(message)) throw new ExaFailure(httpFailure(402));
        if (/401|403|unauthori|invalid.*key/i.test(message)) throw new ExaFailure(httpFailure(401));
        throw new ExaFailure("Exa 工具执行失败；稍后重试或在联网搜索设置中检查认证。未获得搜索结果。");
      }
      return sanitizeRecording(result, secrets);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ExaFailure) throw error;
      // Transport/protocol errors can echo response bodies, URLs or credentials.
      throw new ExaFailure("Exa 服务或协议响应失败；稍后重试。未获得搜索结果。");
    } finally {
      // eslint-disable-next-line no-restricted-syntax -- 连接已进入关闭流程，会话终止或客户端关闭失败不会改变本次结果的成败，也不该覆盖已抛出的错误
      if (transport.sessionId) await transport.terminateSession().catch(() => {});
      // eslint-disable-next-line no-restricted-syntax -- 传输可能已被远端断开，close 失败时无需上报，http.close 仍会释放本地资源
      await client.close().catch(() => {});
      await http.close();
    }
  };
  return {
    async search(query, numResults, signal) {
      const result = await call(
        "web_search_exa",
        {
          query,
          objective: `Find relevant sources for: ${query}. Include source links and available publication dates.`,
          numResults
        },
        signal
      );
      return normalizeExaSources(result, options.maxContentChars);
    },
    async fetch(url, signal) {
      const result = await call(
        "web_fetch_exa",
        { urls: [url], maxCharacters: options.maxContentChars },
        signal
      );
      const normalized = normalizeExaSources(result, options.maxContentChars, url);
      const source = fetchedSource(normalized.sources, url);
      const content = source?.text ?? "";
      if (!content.trim()) throw new ExaFailure("Exa 未返回可读取的网页正文；请检查来源 URL 或稍后重试。");
      return {
        url: source?.url ?? url,
        title: source?.title,
        content,
        status: 200,
        contentType: "text/markdown",
        truncated: content.length >= options.maxContentChars,
        bytes: Buffer.byteLength(content)
      };
    }
  };
}
function httpFailure(status: number): string {
  const next =
    status === 429
      ? "请求受到限流；稍后重试，或在高级设置中填写自有 Exa API Key。匿名使用有额度限制。"
      : status === 402
        ? "搜索额度不足；检查自有账户额度，或稍后重试匿名服务。"
        : [401, 403].includes(status)
          ? "认证失败；检查高级设置中的 Exa API Key，或清除密钥使用匿名模式。"
          : "服务暂不可用；稍后重试并检查网络和代理。";
  return `Exa HTTP ${status}：${next} 未获得搜索结果。`;
}

/** Official hosted MCP currently returns labelled text; structured results are accepted too. */
export function normalizeExaSources(
  value: unknown,
  maxChars: number,
  fallbackUrl?: string
): { sources: WebSource[]; content: string } {
  const result = record(value);
  let text = Array.isArray(result.content)
    ? result.content
        .map((block) => {
          const item = record(block);
          return item.type === "text" && typeof item.text === "string" ? item.text : "";
        })
        .filter(Boolean)
        .join("\n\n")
    : "";
  let parsed: unknown;
  let isJson = false;
  try {
    parsed = JSON.parse(text);
    isJson = true;
    // eslint-disable-next-line no-restricted-syntax -- 官方托管 MCP 默认返回带标签的 markdown，文本不是 JSON 时按原文解析，属于预期分支
  } catch {
    /* Labelled markdown is the hosted default. */
  }
  // Structured envelopes are authoritative. Never turn their JSON or display prose into a fetched page.
  const isStructured = result.structuredContent !== undefined || isJson;
  const entries =
    result.structuredContent !== undefined
      ? sourceEntries(result.structuredContent)
      : isJson
        ? sourceEntries(parsed)
        : undefined;
  if (isStructured && !Array.isArray(entries)) throw sourceFormatFailure();
  let sources: WebSource[] = [];
  if (Array.isArray(entries)) {
    sources = entries
      .map((entry) => {
        const item = record(entry);
        const content = string(item.text) ?? string(item.content);
        return {
          url: sourceUrl(string(item.url) ?? string(item.link)) ?? "",
          title: string(item.title),
          date: availableDate(string(item.publishedDate) ?? string(item.date)),
          snippet:
            string(item.snippet) ??
            (Array.isArray(item.highlights)
              ? item.highlights.filter((x): x is string => typeof x === "string").join("\n")
              : content),
          text: content?.slice(0, maxChars)
        };
      })
      .filter((entry) => Boolean(entry.url));
  } else if (text.trim()) {
    const blocks = text.split(/\n---\s*\n/);
    for (const block of blocks) {
      const url = sourceUrl(/^URL:\s*(\S+)\s*$/m.exec(block)?.[1]);
      if (!url) continue;
      const title = /^Title:\s*(.*)$/m.exec(block)?.[1] ?? /^#\s+(.+)$/m.exec(block)?.[1];
      const date = /^Published:\s*(.*)$/m.exec(block)?.[1];
      let body = block
        .replace(/^(?:Title|URL|Published|Author):.*\n?/gm, "")
        .replace(/^Highlights:\s*\n?/m, "")
        .trim()
        .slice(0, maxChars);
      // A title and provenance metadata alone are not page evidence.
      if (title && body.split("\n")[0] === `# ${title}`)
        body = body.slice(body.indexOf("\n") < 0 ? body.length : body.indexOf("\n") + 1).trim();
      sources.push({
        url,
        title: title === "N/A" ? undefined : title,
        date: availableDate(date),
        snippet: body.slice(0, 1500),
        text: body
      });
    }
  }
  if (Array.isArray(entries) && entries.length > 0 && !sources.length) throw sourceFormatFailure();
  const noResults = /^No (?:search )?results(?: found)?[.!]?$/i.test(text.trim());
  if (fallbackUrl) {
    // Only genuine, unlabelled raw page text may borrow the requested URL.
    if (
      !sources.length &&
      !isStructured &&
      text.trim() &&
      !noResults &&
      !/^URL:/m.test(text) &&
      !/^\s*[\[{]/.test(text)
    ) {
      const url = sourceUrl(fallbackUrl);
      if (url) sources = [{ url, text: text.slice(0, maxChars) }];
    }
    if (!fetchedSource(sources, fallbackUrl))
      throw new ExaFailure("Exa 未返回请求来源的可读取正文；请检查来源 URL 或稍后重试。");
  } else if (!sources.length && !Array.isArray(entries) && !noResults) throw sourceFormatFailure();
  text = text.slice(0, maxChars);
  return { sources, content: text };
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function availableDate(value: string | undefined): string | undefined {
  return value && !/^(?:N\/A|unknown)$/i.test(value.trim()) ? value : undefined;
}

/** Supported source envelopes may nest results under data/result/structuredContent. Unknown wrappers fail closed. */
function sourceEntries(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value;
  const object = record(value);
  if (Object.hasOwn(object, "results")) return object.results;
  if (depth >= 3) return undefined;
  for (const field of ["data", "result", "structuredContent"])
    if (Object.hasOwn(object, field)) return sourceEntries(object[field], depth + 1);
  return undefined;
}
function sourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
    // eslint-disable-next-line no-restricted-syntax -- 来源 URL 来自服务端响应，非法 URL 由 undefined 表达，调用方按缺少来源处理
  } catch {
    return undefined;
  }
}
/** A single-URL MCP fetch can return one redirected source; retain its actual provenance. */
function fetchedSource(sources: WebSource[], requested: string): WebSource | undefined {
  return (
    sources.find((source) => sameSourceUrl(source.url, requested) && source.text?.trim()) ??
    (sources.length === 1 && sources[0]?.text?.trim() ? sources[0] : undefined)
  );
}
function sameSourceUrl(source: string, requested: string): boolean {
  const sourceAddress = new URL(source),
    requestedAddress = new URL(requested);
  sourceAddress.hash = "";
  requestedAddress.hash = "";
  return sourceAddress.href === requestedAddress.href;
}
function sourceFormatFailure(): ExaFailure {
  return new ExaFailure("Exa 返回的来源格式无法识别；稍后重试。未获得可核验结果。");
}
