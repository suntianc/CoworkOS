import type { WatcherPoller, WatcherPollResult, WatcherRuntime } from "./watcher.js";

export interface WatcherLoopOptions {
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
  onCycle?: (result: WatcherPollResult) => void | Promise<void>;
}

/** Runs a watcher with a restart-safe polling boundary. */
export class WatcherLoop {
  private stopped = false;

  stop(): void {
    this.stopped = true;
  }

  async run(runtime: WatcherRuntime, poller: WatcherPoller, options: WatcherLoopOptions = {}): Promise<void> {
    const intervalMs = Math.max(250, options.intervalMs ?? 5_000);
    do {
      if (this.stopped || options.signal?.aborted) return;
      const result = await runtime.poll(poller);
      await options.onCycle?.(result);
      if (options.once) return;
      await wait(intervalMs, options.signal);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stop() 在 poll/onCycle 的 await 期间被外部调用，TS 控制流在读取处看不到这次赋值
    } while (!this.stopped && !options.signal?.aborted);
  }
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
