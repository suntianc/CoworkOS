import { isIP } from "node:net";
import type { RuntimeTool } from "../runtime/tool.js";
import { sanitizeRecording } from "../storage/model-request-recorder.js";
import { createExaSearchProvider } from "./exa-search-provider.js";
import type { SearchProvider } from "./search-provider.js";
import { withWebDeadline } from "./web-request.js";

export interface WebToolOptions {
  provider: "exa";
  /** Credentials never enter tool results or traces. */
  exaApiKey?: string;
  exaEndpoint?: string;
  timeoutMs?: number;
  maxResults?: number;
  maxContentBytes?: number;
  maxContentChars?: number;
}

interface WebConfig {
  provider: SearchProvider;
  secrets: readonly string[];
  timeoutMs: number;
  maxResults: number;
  maxContentChars: number;
}

/** Every execution owns and closes its provider connection. */
export function createWebTools(options: WebToolOptions): ReadonlyMap<string, RuntimeTool> {
  const timeoutMs = limit(options.timeoutMs, 30_000, 3_600_000, "timeoutMs");
  const maxContentChars = limit(options.maxContentChars, 150_000, 16_000_000, "maxContentChars");
  const config: WebConfig = {
    provider: createExaSearchProvider({
      ...options,
      timeoutMs,
      maxContentBytes: limit(options.maxContentBytes, 1_000_000, 16_000_000, "maxContentBytes"),
      maxContentChars
    }),
    secrets: options.exaApiKey ? [options.exaApiKey.trim()] : [],
    timeoutMs,
    maxResults: limit(options.maxResults, 10, 20, "maxResults"),
    maxContentChars
  };
  return new Map([
    [
      "search",
      {
        executionMode: "parallel",
        description:
          "Search the public web with Exa. Return source titles, URLs, excerpts and available dates. Read a source with visit and cite its URL. Tool failure means evidence is unavailable, never zero results or verified facts.",
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
        description:
          "Read a public HTTP(S) URL and return source text with status, size and truncation metadata.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The public HTTP(S) URL to read." }
          },
          required: ["url"],
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
  const result = await options.provider.search(query, num, signal);
  return sanitizeRecording(
    {
      query,
      provider: "exa",
      ...result
    },
    options.secrets
  );
}

async function visitUrl(options: WebConfig, rawInput: unknown, signal: AbortSignal): Promise<unknown> {
  const input = asRecord(rawInput);
  const rawUrl = typeof input.url === "string" ? input.url.trim() : "";
  if (!rawUrl) throw new Error("visit requires a non-empty url");
  const page = await options.provider.fetch(validatePublicUrl(rawUrl), signal);
  const limited = page.content.slice(0, options.maxContentChars);
  return sanitizeRecording(
    { ...page, content: limited, truncated: page.truncated || limited.length < page.content.length },
    options.secrets
  );
}

function limit(value: unknown, fallback: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  return value;
}

function validatePublicUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("visit url must be a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("visit only supports http and https URLs");
  if (url.username || url.password) throw new Error("visit does not allow URL credentials");
  if (isPrivateHost(url.hostname)) throw new Error("visit refuses localhost/private-network URLs");
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

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}
