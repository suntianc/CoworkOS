import { createExaSearchProvider } from "./exa-search-provider.js";
import type { SearchProvider } from "./search-provider.js";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { decodeHTML } from "entities";
import type { RuntimeTool } from "../runtime/tool.js";
import { sanitizeRecording } from "../storage/model-request-recorder.js";
import { WebKeyPool } from "./web-key-pool.js";
import { requestWebText, withWebDeadline, type WebRequestResult } from "./web-request.js";

export type VisitExtractor = (input: {
  url: string;
  goal: string;
  content: string;
  contentType: string;
  truncated: boolean;
  signal: AbortSignal;
}) => Promise<string | undefined>;

export interface WebToolOptions {
  provider?: "exa" | "serper";
  exaApiKey?: string;
  exaEndpoint?: string;
  /** Credentials never enter tool results or traces. Explicit pools override the single key. */
  serperApiKey?: string;
  serperApiKeys?: readonly string[];
  serperEndpoint?: string;
  /** Explicit opt-in to Jina Reader; absent keys keep direct page fetching. */
  jinaApiKeys?: readonly string[];
  jinaEndpoint?: string;
  jinaTimeoutSeconds?: number;
  timeoutMs?: number;
  maxResults?: number;
  maxContentBytes?: number;
  maxContentChars?: number;
  userAgent?: string;
  allowPrivateNetwork?: boolean;
  rawSearchResults?: boolean;
  /** Receives untrusted source text; the callback must respect its abort signal. */
  extract?: VisitExtractor;
}

interface WebConfig {
  provider?: SearchProvider;
  serperPool: WebKeyPool;
  readerPool?: WebKeyPool;
  secrets: readonly string[];
  serperEndpoint: string;
  jinaEndpoint: string;
  jinaTimeoutSeconds: number;
  timeoutMs: number;
  maxResults: number;
  maxContentBytes: number;
  maxContentChars: number;
  userAgent: string;
  allowPrivateNetwork: boolean;
  rawSearchResults: boolean;
  extract?: VisitExtractor;
}

/** Tools share credential state; every execution owns and closes its HTTP transport. */
export function createWebTools(options: WebToolOptions = {}): ReadonlyMap<string, RuntimeTool> {
  for (const field of ["allowPrivateNetwork", "rawSearchResults"] as const)
    if (options[field] !== undefined && typeof options[field] !== "boolean")
      throw new Error(`${field} must be a boolean`);
  if (options.extract !== undefined && typeof options.extract !== "function")
    throw new Error("extract must be a callback");
  if (
    options.userAgent !== undefined &&
    (typeof options.userAgent !== "string" || /[\r\n\0]/.test(options.userAgent))
  )
    throw new Error("userAgent must be a single-line string");
  if (options.provider !== undefined && !["exa", "serper"].includes(options.provider))
    throw new Error("Unknown web search provider");
  const keys =
    options.serperApiKeys ??
    [options.serperApiKey ?? process.env.COWORK_SERPER_API_KEY ?? process.env.SERPER_API_KEY].filter(
      (key): key is string => Boolean(key)
    );
  const readerKeys = options.jinaApiKeys ?? [];
  const timeoutMs = limit(options.timeoutMs, 30_000, 3_600_000, "timeoutMs");
  const config: WebConfig = {
    provider:
      options.provider === "exa"
        ? createExaSearchProvider({
            ...options,
            timeoutMs,
            maxContentBytes: limit(options.maxContentBytes, 1_000_000, 16_000_000, "maxContentBytes"),
            maxContentChars: limit(options.maxContentChars, 150_000, 16_000_000, "maxContentChars")
          })
        : undefined,
    serperPool: new WebKeyPool(keys, "Serper"),
    readerPool: readerKeys.length ? new WebKeyPool(readerKeys, "Jina Reader") : undefined,
    secrets: [...keys, ...readerKeys, ...(options.exaApiKey ? [options.exaApiKey] : [])].map((key) =>
      key.trim()
    ),
    serperEndpoint: serviceUrl(options.serperEndpoint ?? "https://google.serper.dev/search"),
    jinaEndpoint: serviceUrl(options.jinaEndpoint ?? "https://r.jina.ai/").replace(/\/?$/, "/"),
    jinaTimeoutSeconds: limit(
      options.jinaTimeoutSeconds,
      Math.max(1, Math.min(120, Math.floor(timeoutMs / 1000) - 5)),
      180,
      "jinaTimeoutSeconds"
    ),
    timeoutMs,
    maxResults: limit(options.maxResults, 10, 20, "maxResults"),
    maxContentBytes: limit(options.maxContentBytes, 1_000_000, 16_000_000, "maxContentBytes"),
    maxContentChars: limit(options.maxContentChars, 150_000, 16_000_000, "maxContentChars"),
    userAgent: options.userAgent ?? "CoworkOS/0.1 (+https://github.com/ignorejjj/Atria-Cowork)",
    allowPrivateNetwork: options.allowPrivateNetwork ?? false,
    rawSearchResults: options.rawSearchResults ?? false,
    extract: options.extract
  };
  return new Map([
    [
      "search",
      {
        executionMode: "parallel",
        description: `Search the public web with ${options.provider === "exa" ? "Exa" : "Serper"}. Return source titles, URLs, excerpts and available dates. Read a source with visit and cite its URL. Tool failure means evidence is unavailable, never zero results or verified facts.`,
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "A focused web search query." },
            numResults: { type: "integer", minimum: 1, maximum: 20 }
          },
          required: ["query"],
          additionalProperties: false
        },
        execute: (input, signal) =>
          withWebDeadline(config.timeoutMs, signal, (active) => searchWeb(config, input, active))
      } satisfies RuntimeTool
    ],
    [
      "visit",
      {
        executionMode: "parallel",
        description: config.extract
          ? "Read a public webpage and extract evidence for your goal. On extraction failure, source text remains available."
          : "Read a public HTTP(S) URL and return source text with status, size and truncation metadata.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The public HTTP(S) URL to read." },
            goal: {
              type: "string",
              description: "Information to extract, required when goal extraction is enabled."
            }
          },
          required: config.extract ? ["url", "goal"] : ["url"],
          additionalProperties: false
        },
        execute: (input, signal) =>
          withWebDeadline(config.timeoutMs, signal, (active) => visitUrl(config, input, active))
      } satisfies RuntimeTool
    ]
  ]);
}

async function searchWeb(options: WebConfig, rawInput: unknown, signal: AbortSignal): Promise<unknown> {
  const input = asRecord(rawInput);
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) throw new Error("search requires a non-empty query");
  const num = limit(input.numResults, options.maxResults, 20, "numResults");
  if (options.provider) {
    const result = await options.provider.search(query, num, signal);
    return sanitizeRecording(
      {
        query,
        provider: "exa",
        ...result,
        organic: result.sources.map((source, index) => ({ ...source, link: source.url, position: index + 1 }))
      },
      options.secrets
    );
  }
  const response = await credentialRequest(options, options.serperPool, "Serper", 3, signal, (key) => ({
    url: options.serperEndpoint,
    init: {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", "X-API-KEY": key, "user-agent": options.userAgent },
      body: JSON.stringify(
        options.rawSearchResults && input.numResults === undefined ? { q: query } : { q: query, num }
      )
    }
  }));
  if (response.truncated) throw new Error("Serper response exceeded maxContentBytes");
  const payload = sanitizeRecording(
    parseJson(response.text, "Serper returned invalid JSON"),
    options.secrets
  );
  return options.rawSearchResults
    ? payload
    : sanitizeRecording(normalizeSearchResult(query, payload), options.secrets);
}

async function credentialRequest(
  options: WebConfig,
  pool: WebKeyPool,
  service: string,
  attempts: number,
  signal: AbortSignal,
  request: (key: string) => { url: string; init: RequestInit }
): Promise<WebRequestResult> {
  let lastError = `${service} request failed`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const key = await pool.acquire(signal);
    const { url, init } = request(key);
    let response: WebRequestResult;
    try {
      response = await requestWebText(url, init, { ...options, signal });
    } catch {
      signal.throwIfAborted();
      if (attempt === attempts - 1) throw new Error(lastError);
      await delay(250 * 2 ** Math.min(attempt, 4), undefined, { signal });
      continue;
    }
    if (response.status >= 200 && response.status < 300) return response;
    // Never include provider error bodies: they may echo an entire credential.
    lastError = `${service} HTTP ${response.status}`;
    if ([401, 402, 403].includes(response.status)) {
      pool.reject(key);
      if (attempt === attempts - 1) throw new Error(lastError);
      continue;
    }
    if (response.status === 429) {
      pool.cooldown(key, retryDelay(response.headers.get("retry-after"), attempt));
      if (attempt === attempts - 1) throw new Error(lastError);
      continue;
    }
    const retryable = [408, 425, 500, 502, 503, 504, 520, 522, 523, 524].includes(response.status);
    if (!retryable || attempt === attempts - 1) throw new Error(lastError);
    await delay(250 * 2 ** Math.min(attempt, 4), undefined, { signal });
  }
  throw new Error(lastError);
}

async function visitUrl(options: WebConfig, rawInput: unknown, signal: AbortSignal): Promise<unknown> {
  const input = asRecord(rawInput);
  const rawUrl = typeof input.url === "string" ? input.url.trim() : "";
  const goal = typeof input.goal === "string" ? input.goal.trim() : "";
  if (!rawUrl) throw new Error("visit requires a non-empty url");
  if (options.extract && !goal) throw new Error("visit requires a non-empty goal for extraction");
  const url = validatePublicUrl(
    options.readerPool ? readerTarget(rawUrl) : rawUrl,
    options.allowPrivateNetwork
  );
  const page = options.provider
    ? await options.provider.fetch(url, signal)
    : options.readerPool
      ? await readThroughJina(options, url, signal)
      : await fetchPageText(options, url, signal);
  const limited = page.content.slice(0, options.maxContentChars);
  const result = {
    ...page,
    content: limited,
    truncated: page.truncated || limited.length < page.content.length
  };
  if (options.extract && page.status >= 200 && page.status < 300 && limited.trim()) {
    try {
      const notes = await options.extract({
        url: page.url,
        goal,
        content: limited,
        contentType: page.contentType,
        truncated: result.truncated,
        signal
      });
      signal.throwIfAborted();
      if (notes?.trim())
        return sanitizeRecording(
          {
            ...result,
            content: notes.slice(0, options.maxContentChars),
            truncated: result.truncated || notes.length > options.maxContentChars,
            extracted: true
          },
          options.secrets
        );
      // eslint-disable-next-line no-restricted-syntax -- goal extraction is best-effort: the result below reports extracted: false and returns the source text, while aborts still propagate
    } catch {
      signal.throwIfAborted();
    }
    return sanitizeRecording(
      { ...result, extracted: false, extractionError: "Goal extraction failed; source text retained." },
      options.secrets
    );
  }
  return sanitizeRecording(result, options.secrets);
}

async function readThroughJina(options: WebConfig, url: string, signal: AbortSignal) {
  const response = await credentialRequest(options, options.readerPool!, "Jina Reader", 8, signal, (key) => ({
    url: `${options.jinaEndpoint}${url}`,
    init: {
      redirect: "manual",
      headers: {
        authorization: `Bearer ${key}`,
        accept: "text/plain",
        "X-Respond-With": "text",
        "X-Timeout": String(options.jinaTimeoutSeconds)
      }
    }
  }));
  const marker = response.text.indexOf("Markdown Content:");
  const content =
    marker >= 0 ? response.text.slice(marker + "Markdown Content:".length).trim() : response.text.trim();
  if (!content) throw new Error("Jina Reader returned no usable page content");
  return {
    url,
    status: response.status,
    contentType: "text/plain",
    content,
    truncated: response.truncated,
    bytes: response.bytes
  };
}

async function fetchPageText(options: WebConfig, url: string, signal: AbortSignal) {
  let currentUrl = url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await requestWebText(
      currentUrl,
      {
        headers: { "user-agent": options.userAgent, accept: "text/html, text/plain, application/json" },
        redirect: "manual"
      },
      { ...options, signal }
    );
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      if (redirects === 5) throw new Error("visit exceeded 5 redirects");
      currentUrl = validatePublicUrl(
        new URL(response.headers.get("location")!, currentUrl).toString(),
        options.allowPrivateNetwork
      );
      continue;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (/application\/pdf/i.test(contentType))
      throw new Error("Direct visit does not extract PDF text; configure Jina Reader for documents");
    return {
      url: currentUrl,
      status: response.status,
      contentType,
      title: extractTitle(response.text),
      content: isHtml(contentType, response.text) ? htmlToText(response.text) : response.text,
      truncated: response.truncated,
      bytes: response.bytes,
      ...(response.status >= 400 ? { isError: true } : {})
    };
  }
  throw new Error("visit did not receive a response");
}

function readerTarget(raw: string): string {
  let target = raw;
  for (let step = 0; step < 8; step++) {
    const prefix = /^(?:https?:\/\/)?r\.jina\.ai\//i.exec(target);
    if (prefix) target = target.slice(prefix[0].length);
    else if (/^https?%3a%2f%2f/i.test(target)) {
      try {
        target = decodeURIComponent(target);
      } catch {
        throw new Error("visit url contains invalid percent encoding");
      }
    } else return target;
  }
  throw new Error("visit url contains too many Reader prefixes");
}

function serviceUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Web service endpoint must be an HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Web service endpoint must be HTTP(S) without credentials, query or fragment");
  return url.toString();
}

function limit(value: unknown, fallback: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  return value;
}

function retryDelay(value: string | null, attempt: number): number {
  if (value) {
    const seconds = Number(value);
    const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    if (Number.isFinite(milliseconds)) return Math.min(60_000, Math.max(0, milliseconds));
  }
  return 1000 * 2 ** Math.min(attempt, 5);
}

function normalizeSearchResult(query: string, value: unknown): unknown {
  const payload = asRecord(value);
  const organic = Array.isArray(payload.organic)
    ? payload.organic.map((value: unknown) => {
        const item = asRecord(value);
        return {
          position: item.position,
          title: item.title,
          link: item.link,
          snippet: item.snippet,
          date: item.date
        };
      })
    : [];
  return {
    query,
    sources: organic
      .filter((item) => typeof item.link === "string")
      .map((item) => ({
        title: item.title,
        url: item.link,
        snippet: item.snippet,
        text: item.snippet,
        date: item.date
      })),
    organic,
    answerBox: payload.answerBox ?? undefined,
    knowledgeGraph: payload.knowledgeGraph ?? undefined,
    relatedSearches: payload.relatedSearches ?? undefined
  };
}

function validatePublicUrl(rawUrl: string, allowPrivateNetwork: boolean): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("visit url must be a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("visit only supports http and https URLs");
  if (url.username || url.password) throw new Error("visit does not allow URL credentials");
  if (!allowPrivateNetwork && isPrivateHost(url.hostname))
    throw new Error("visit refuses localhost/private-network URLs");
  return url.toString();
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/[\[\]]/g, "")
    .replace(/\.$/, "");
  if (
    ["localhost", "localhost.localdomain", "0.0.0.0", "::", "::1"].includes(host) ||
    host.endsWith(".localhost")
  )
    return true;
  const parts = host.split(".").map(Number);
  if (isIP(host) === 4) {
    const [a, b] = parts;
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIP(host) !== 6) return false;
  if (host.startsWith("::ffff:")) {
    const groups = host
      .slice(7)
      .split(":")
      .map((part) => Number.parseInt(part, 16));
    if (groups.length === 2)
      return isPrivateHost(`${groups[0] >> 8}.${groups[0] & 255}.${groups[1] >> 8}.${groups[1] & 255}`);
  }
  const first = Number.parseInt(host.split(":")[0], 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
      .replace(/<\/?(?:p|div|section|article|main|header|footer|h[1-6]|li|tr|br)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t\r\f\v]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function decodeEntities(text: string): string {
  return decodeHTML(text);
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1].replace(/<[^>]+>/g, "").trim()) : undefined;
}

function isHtml(contentType: string, content: string): boolean {
  return (
    /text\/html|application\/xhtml\+xml/i.test(contentType) || /<html\b|<body\b/i.test(content.slice(0, 4096))
  );
}

function parseJson(text: string, message: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(message);
  }
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}
