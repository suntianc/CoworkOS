/** One deadline owns the whole provider call, including its connection and body. */
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
