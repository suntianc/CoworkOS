import { randomUUID } from "node:crypto";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  lazyStream,
  type AssistantMessageEvent,
  type ProviderStreams
} from "@earendil-works/pi-ai";
import { ModelRequestRecorder, recordingHash } from "../storage/model-request-recorder.js";
import type { MainRequestModel } from "../storage/main-request-store.js";
import type { MainRequestRetry } from "./main-request-retry.js";

/** Capture at the provider boundary, including compaction calls and provider payload hooks. */
export function recordModelRequests(
  streams: ProviderStreams,
  recorder: ModelRequestRecorder,
  retry?: MainRequestRetry
): ProviderStreams {
  const wrap =
    (method: "stream" | "streamSimple"): ProviderStreams["streamSimple"] =>
    (model, context, options) =>
      lazyStream(model, async () => {
        const prepared = await retry?.prepare(model, context);
        model = prepared?.model ?? model;
        context = prepared?.context ?? context;
        const replay = prepared?.replay;
        const replayBody = prepared?.replayBody;
        if (replay) options = { ...options, sessionId: replay.sessionId };
        let requestId = randomUUID();
        let httpAttempt = 0;
        let settled = false;
        let captured = false;
        let preparedPayload: unknown;
        const requestContext = JSON.parse(JSON.stringify(context));
        const systemPrompt = getCurrentSystemPrompt(context.messages);
        const tools = getCurrentTools(context.messages);
        const modelInfo = {
          id: model.id,
          provider: model.provider,
          api: model.api,
          baseUrl: model.baseUrl,
          reasoning: model.reasoning,
          input: model.input,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens
        };
        const source = streams[method](model, context, {
          ...options,
          onPayload: async (payload, requestModel) => {
            const replacement = replay
              ? JSON.parse(replayBody!)
              : await options?.onPayload?.(payload, requestModel);
            preparedPayload = replacement === undefined ? payload : replacement;
            return replacement;
          },
          fetch: async (input, init) => {
            if (httpAttempt++) requestId = randomUUID();
            captured = false;
            if (replay) {
              // Preserve archived bytes and parameters, with only an explicit
              // personal-memory refresh prepared by the retry owner.
              input = replay.endpoint!;
              init = { ...init, body: replayBody };
            }
            // Archive the SDK-serialized body for every HTTP attempt, including retries.
            const request = typeof init?.body === "string" ? JSON.parse(init.body) : preparedPayload;
            if (prepared?.main) {
              if (typeof init?.body !== "string")
                throw new Error("模型请求没有可恢复的序列化正文，未发送请求。");
              await retry!.capture({
                requestId,
                model: model as MainRequestModel,
                context: requestContext,
                sessionId: options?.sessionId,
                body: init.body,
                endpoint: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
                ...(replay ? { retryOf: replay.retryOf ?? replay.requestId } : {})
              });
              captured = true;
            }
            await recorder.record("model_request", requestId, {
              model: modelInfo,
              sessionId: options?.sessionId,
              httpAttempt,
              systemPrompt,
              tools,
              systemPromptSha256: recordingHash(systemPrompt),
              toolsSha256: recordingHash(tools),
              context: requestContext,
              request,
              ...(replay ? { retryOf: replay.retryOf ?? replay.requestId } : {})
            });
            const response = await (options?.fetch ?? globalThis.fetch)(input, init);
            // Deliberately exclude headers (cookies, auth and provider credentials).
            try {
              await recorder.record("model_response_http", requestId, {
                status: response.status,
                httpAttempt
              });
            } catch (error) {
              // The SDK cannot close a response that this fetch wrapper never returns.
              // eslint-disable-next-line no-restricted-syntax -- 这里正在抛出记录失败，取消响应体失败不能替换原始错误
              await response.body?.cancel().catch(() => {});
              throw error;
            }
            return response;
          },
          onResponse: async (response, requestModel) => {
            await options?.onResponse?.(response, requestModel);
          }
        });
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
            try {
              for await (const event of source) {
                if (event.type === "done" || event.type === "error") {
                  await recorder.record("model_response", requestId, {
                    model: modelInfo,
                    message: event.type === "done" ? event.message : event.error
                  });
                  if (captured) await retry!.settle(requestId, event.type === "done");
                  settled = true;
                }
                yield event;
              }
            } finally {
              if (captured && !settled) await retry!.settle(requestId, false);
            }
          }
        };
      });
  return { ...streams, stream: wrap("stream"), streamSimple: wrap("streamSimple") };
}
