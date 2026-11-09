import { createHash } from "node:crypto";
import { lazyStream, type AssistantMessageEvent, type ProviderStreams } from "@earendil-works/pi-ai";

/** Additive metadata: SDK token counts retain their existing meaning. */
export interface CacheUsageReport {
  tokenUsageReported: boolean;
  cacheReadReported: boolean;
  cacheWriteReported: boolean;
  rawCacheUsage: Record<string, number | Record<string, number>>;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Persist only documented numeric cache counters, never arbitrary upstream usage fields. */
export function cacheUsageReport(raw: unknown, api: string): CacheUsageReport {
  const usage = object(raw) ?? {};
  const detailKey = api === "openai-responses" ? "input_tokens_details" : "prompt_tokens_details";
  const details = object(usage[detailKey]) ?? {};
  const rawCacheUsage: CacheUsageReport["rawCacheUsage"] = {};
  const counters = Object.fromEntries(
    ["cached_tokens", "cache_write_tokens"]
      .filter((key) => count(details[key]))
      .map((key) => [key, details[key] as number])
  );
  if (Object.keys(counters).length) rawCacheUsage[detailKey] = counters;
  if (api === "openai-completions") {
    for (const key of ["prompt_cache_hit_tokens", "cached_tokens"])
      if (count(usage[key])) rawCacheUsage[key] = usage[key];
  }
  const read =
    api === "openai-responses"
      ? details.cached_tokens
      : (details.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens);
  return {
    tokenUsageReported:
      api === "openai-responses"
        ? count(usage.input_tokens) && count(usage.output_tokens)
        : count(usage.prompt_tokens) && count(usage.completion_tokens),
    cacheReadReported: count(read),
    cacheWriteReported: count(details.cache_write_tokens),
    rawCacheUsage
  };
}

/** OpenAI bounds cache keys to 64 characters; long IDs remain stable without disclosing their contents. */
export function promptCacheKey(sessionId: string): string {
  return sessionId.length <= 64 ? sessionId : createHash("sha256").update(sessionId).digest("hex");
}

type ParsedUsage = {
  input: number;
  output: unknown;
  cacheRead: unknown;
  cacheWrite: unknown;
  responseId?: string;
  rawStopReason?: string;
};

/** Match the pinned providers' normalization, without persisting raw input/output fields. */
function parsedUsage(raw: Record<string, unknown>, api: string): ParsedUsage {
  const responses = api === "openai-responses";
  const details = object(raw[responses ? "input_tokens_details" : "prompt_tokens_details"]);
  const cacheRead = responses
    ? details?.cached_tokens || 0
    : (details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? raw.cached_tokens ?? 0);
  const cacheWrite = details?.cache_write_tokens || 0;
  return {
    input: Math.max(
      0,
      Number(raw[responses ? "input_tokens" : "prompt_tokens"] || 0) - Number(cacheRead) - Number(cacheWrite)
    ),
    output: raw[responses ? "output_tokens" : "completion_tokens"] || 0,
    cacheRead,
    cacheWrite
  };
}

/** Observe SSE usage while forwarding every original byte, with bounded diagnostic memory. */
function observeUsage(
  response: Response,
  api: string,
  consume: (report: CacheUsageReport, parsed?: ParsedUsage) => void
): Response {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!response.ok || !response.body || mediaType !== "text/event-stream") return response;
  const decoder = new TextDecoder();
  const limit = 1024 * 1024;
  let pending = "";
  let data = "";
  let hasData = false;
  let eventName = "";
  let stopped = false;
  let droppingLine = false;
  let droppingEvent = false;
  let skipLF = false;
  const line = (value: string) => {
    if (stopped) return;
    if (!value) {
      if ((hasData || eventName) && !droppingEvent) {
        if (data.startsWith("[DONE]")) {
          stopped = true;
          return;
        }
        try {
          const event = object(JSON.parse(data));
          // The SDK wraps thread.* events instead of exposing their JSON as provider chunks.
          if (!eventName.startsWith("thread.")) {
            if (
              event?.error ||
              (api === "openai-responses" && (event?.type === "error" || event?.type === "response.failed"))
            ) {
              stopped = true;
              return;
            }
            const raw =
              api === "openai-responses"
                ? event?.type === "response.completed" || event?.type === "response.incomplete"
                  ? object(event.response)?.usage
                  : undefined
                : (event?.usage ??
                  object(Array.isArray(event?.choices) ? event.choices[0] : undefined)?.usage);
            const usage = object(raw);
            if (usage) {
              const parsed = parsedUsage(usage, api);
              if (api === "openai-responses") {
                const terminal = object(event?.response);
                const reason = object(terminal?.incomplete_details)?.reason;
                if (typeof terminal?.id === "string" && terminal.id) parsed.responseId = terminal.id;
                if (typeof terminal?.status === "string")
                  parsed.rawStopReason =
                    typeof reason === "string" && reason ? `${terminal.status}.${reason}` : terminal.status;
              }
              consume(cacheUsageReport(usage, api), parsed);
            }
          }
          // eslint-disable-next-line no-restricted-syntax -- 解析不了的事件只是让统计停止，原始字节仍原样转发给 SDK
        } catch {
          // JSON parse errors stop the SDK before it can consume any subsequent usage.
          stopped = true;
        }
      }
      data = "";
      hasData = false;
      eventName = "";
      droppingEvent = false;
    } else if ((value === "event" || value.startsWith("event:")) && !droppingEvent) {
      eventName = value.slice(6).replace(/^ /, "");
    } else if ((value === "data" || value.startsWith("data:")) && !droppingEvent) {
      data += `${hasData ? "\n" : ""}${value.slice(5).replace(/^ /, "")}`;
      hasData = true;
      if (data.length > limit) {
        data = "";
        droppingEvent = true;
        consume(cacheUsageReport(undefined, api));
      }
    }
  };
  const append = (part: string) => {
    if (droppingLine) return;
    if (pending.length + part.length > limit) {
      pending = "";
      droppingLine = true;
      droppingEvent = true;
      consume(cacheUsageReport(undefined, api));
    } else pending += part;
  };
  const inspect = (text: string) => {
    if (stopped) return;
    // SSE permits LF, CRLF and CR, including a CRLF split across chunks.
    let start = skipLF && text.startsWith("\n") ? 1 : 0;
    if (!text.length) return;
    skipLF = false;
    for (let index = start; index < text.length; index++) {
      if (text[index] !== "\n" && text[index] !== "\r") continue;
      append(text.slice(start, index));
      if (!droppingLine) line(pending);
      pending = "";
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stopped 由 line 闭包在处理上一个事件时置位，TS 在读取处看不到那次写入
      if (stopped) return;
      droppingLine = false;
      if (text[index] === "\r") {
        if (text[index + 1] === "\n") index++;
        else if (index === text.length - 1) skipLF = true;
      }
      start = index + 1;
    }
    append(text.slice(start));
  };
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        inspect(decoder.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      },
      flush() {
        inspect(decoder.decode());
        // The SDK dispatches only blank-line-terminated events, never an EOF remainder.
      }
    })
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

/** Compose inside request recording so wire archives and final usage share the same cache policy. */
export function withModelCache(
  streams: ProviderStreams,
  capability: { supportsPromptCacheKey: boolean; sessionId?: string }
): ProviderStreams {
  const wrap =
    (method: "stream" | "streamSimple"): ProviderStreams["streamSimple"] =>
    (model, context, options) =>
      lazyStream(model, async () => {
        let report = cacheUsageReport(undefined, model.api);
        let parsed: ParsedUsage | undefined;
        const source = streams[method](model, context, {
          ...options,
          onPayload: async (payload, requestModel) => {
            const replacement = await options?.onPayload?.(payload, requestModel);
            const prepared = object(replacement === undefined ? payload : replacement);
            if (!prepared) return replacement;
            const body = { ...prepared };
            const sessionId = options?.sessionId ?? capability.sessionId;
            if (capability.supportsPromptCacheKey && options?.cacheRetention !== "none" && sessionId)
              body.prompt_cache_key = promptCacheKey(sessionId);
            else {
              // Preserve official SDK defaults; third-party services require explicit capability.
              let official = false;
              try {
                official = new URL(model.baseUrl).hostname === "api.openai.com";
                // eslint-disable-next-line no-restricted-syntax -- baseUrl 是用户配置，解析失败时按非官方地址保留 SDK 默认行为，错误由 provider 请求本身报出
              } catch {
                /* invalid URL is rejected by the provider */
              }
              if (!official || options?.cacheRetention === "none") delete body.prompt_cache_key;
            }
            return body;
          },
          fetch: async (input, init) => {
            report = cacheUsageReport(undefined, model.api);
            parsed = undefined;
            return observeUsage(
              await (options?.fetch ?? globalThis.fetch)(input, init),
              model.api,
              (value, counts) => {
                report = value;
                parsed = counts;
              }
            );
          }
        });
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
            for await (const event of source) {
              if (event.type === "done" || event.type === "error") {
                const message = event.type === "done" ? event.message : event.error;
                const usage = message.usage;
                // Observation can run ahead of provider parsing within one HTTP chunk.
                // Failed zero counters may still be untouched SDK initialization.
                // Confirm flags only when the final SDK counters match the observed report.
                // A consumed Responses terminal can legitimately finish as an error with zero
                // usage (for example, content filtering). Its final identity and stop reason
                // distinguish consumed zeros from initial counters before a parsing failure.
                const consumedTerminal =
                  model.api === "openai-responses" &&
                  !!parsed?.responseId &&
                  !!parsed.rawStopReason &&
                  message.responseId === parsed.responseId &&
                  message.rawStopReason === parsed.rawStopReason;
                const confirmed =
                  parsed?.input === usage.input &&
                  parsed.output === usage.output &&
                  parsed.cacheRead === usage.cacheRead &&
                  parsed.cacheWrite === usage.cacheWrite &&
                  (event.type === "done" ||
                    consumedTerminal ||
                    [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some(
                      (value) => value > 0
                    ));
                Object.assign(usage, {
                  ...report,
                  tokenUsageReported: report.tokenUsageReported && confirmed,
                  cacheReadReported: report.cacheReadReported && confirmed,
                  cacheWriteReported: report.cacheWriteReported && confirmed
                });
              }
              yield event;
            }
          }
        };
      });
  return { ...streams, stream: wrap("stream"), streamSimple: wrap("streamSimple") };
}
