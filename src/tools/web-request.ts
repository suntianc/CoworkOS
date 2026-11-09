import { createHttpTransport } from "../runtime/http-transport.js";

export interface WebRequestResult {
  status: number;
  headers: Headers;
  text: string;
  /** Received bytes before cancellation, rather than the unbounded body size. */
  bytes: number;
  truncated: boolean;
}

/** Deadline and size limit cover the body as well as connection establishment. */
export async function requestWebText(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; maxContentBytes: number; signal?: AbortSignal }
): Promise<WebRequestResult> {
  options.signal?.throwIfAborted();
  const transport = createHttpTransport();
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new DOMException("Web request cancelled", "AbortError"));
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    const response = await Promise.race([
      transport.fetch(url, { ...init, signal: controller.signal }),
      aborted
    ]);
    reader = response.body?.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    let retained = 0;
    let truncated = false;
    while (reader) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      bytes += value.byteLength;
      const chunk = Buffer.from(value.subarray(0, Math.max(0, options.maxContentBytes - retained)));
      chunks.push(chunk);
      retained += chunk.byteLength;
      if (bytes > options.maxContentBytes) {
        truncated = true;
        break;
      }
    }
    return {
      status: response.status,
      headers: response.headers,
      text: Buffer.concat(chunks).toString("utf8"),
      bytes,
      truncated
    };
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- timedOut 只在 setTimeout 回调里写入，取消/超时后才进入的 catch 能看到它为 true，TS 在读取处只看到初始的 false
    if (timedOut) throw new DOMException("Web request timed out", "TimeoutError");
    if (options.signal?.aborted) throw new DOMException("Web request cancelled", "AbortError");
    // Provider/proxy errors may contain credentials or response bodies.
    throw new Error("Web request failed");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
    // eslint-disable-next-line no-restricted-syntax -- 请求已结束（含失败/取消），取消读取器只是释放连接，失败不影响已经决定的结果
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    await transport.close();
  }
}

/** One deadline owns retries, redirects, key cooldowns and optional extraction. */
export async function withWebDeadline<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new DOMException("Web operation cancelled", "AbortError"));
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    return await Promise.race([work(controller.signal), aborted]);
  } catch (error) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- timedOut 只在 setTimeout 回调里写入，超时后才进入的 catch 能看到它为 true，TS 在读取处只看到初始的 false
    if (timedOut) throw new DOMException("Web operation timed out", "TimeoutError");
    if (signal?.aborted) throw new DOMException("Web operation cancelled", "AbortError");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
  }
}
