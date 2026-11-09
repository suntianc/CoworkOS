import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { signalProcessGroup } from "./process-group.js";
import { ForegroundCommandOutput, type ForegroundOutputReceipt } from "./foreground-command-output.js";

export interface ForegroundCommandOptions {
  cwd: string;
  shell: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Independent per-stream head/tail preview budget; omission keeps legacy prefix capture. */
  previewBytes?: number;
  /** Full raw stdout/stderr logs, each bounded by maxOutputBytes. */
  outputLogDirectory?: string;
  /** Per-invocation environment overrides; never serialized into command arguments. */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export type ForegroundCommandResult = ForegroundOutputReceipt;

/** Bounded foreground execution; start_job has a separate persistent lifetime. */
export async function executeForegroundCommand(
  command: string,
  args: string[],
  options: ForegroundCommandOptions
): Promise<ForegroundCommandResult> {
  options.signal?.throwIfAborted();
  const output = await ForegroundCommandOutput.create(options);
  const grouped = process.platform !== "win32";
  let child: ChildProcess;
  try {
    // Log setup is asynchronous; cancellation during it must not start a command.
    options.signal?.throwIfAborted();
    child = grouped
      ? spawn(
          process.execPath,
          [
            fileURLToPath(new URL("./foreground-command-host.js", import.meta.url)),
            JSON.stringify({ command, args, cwd: options.cwd, shell: options.shell })
          ],
          {
            cwd: options.cwd,
            env: { ...process.env, ...options.env },
            detached: true,
            stdio: ["pipe", "pipe", "pipe", "pipe"]
          }
        )
      : spawn(command, args, {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          shell: options.shell,
          // No input provider here either: /dev/null gives a reader EOF instead
          // of an open pipe that waits for cancellation.
          stdio: ["ignore", "pipe", "pipe"]
        });
  } catch (error) {
    await output.close();
    throw Object.assign(error as Error, output.receipt());
  }
  const groupPid = child.pid;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let timedOut = false;
  let failure: Error | undefined;
  let forceKill: Promise<void> | undefined;
  let commandExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const signalChild = async (signal: NodeJS.Signals): Promise<void> => {
    try {
      if (grouped && groupPid !== undefined) await signalProcessGroup(groupPid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        failure ??= new Error(`Foreground command cleanup failed: ${String(error)}`, { cause: error });
      }
    }
  };
  const kill = (): Promise<void> => {
    // Result, deadline and close callbacks can race. One KILL operation owns
    // cleanup, including any asynchronous EPERM fallback.
    forceKill ??= signalChild("SIGKILL");
    return forceKill;
  };
  const stop = (): void => {
    if (stopped || commandExit) return;
    stopped = true;
    clearTimeout(deadline);
    void signalChild("SIGTERM");
    forceStop = setTimeout(() => void kill(), 1000);
  };
  const aborted = (): void => stop();
  const outputFailure = (error: Error): void => {
    failure ??= error;
    stop();
  };
  const readers = [
    output.consume("stdout", child.stdout, outputFailure),
    output.consume("stderr", child.stderr, outputFailure)
  ];
  if (grouped) {
    let status = "";
    (child.stdio[3] as Readable | null)?.on("data", (chunk: Buffer) => {
      status += chunk.toString("utf8");
      if (status.length > 1024) {
        failure ??= new Error("Invalid foreground command result");
        stop();
        return;
      }
      if (!status.endsWith("\n") || commandExit) return;
      try {
        const value = JSON.parse(status) as { code: unknown; signal: unknown };
        if (
          (value.code !== null && typeof value.code !== "number") ||
          (value.signal !== null && typeof value.signal !== "string")
        )
          throw new Error("Invalid foreground command result");
        commandExit = value as { code: number | null; signal: NodeJS.Signals | null };
        clearTimeout(deadline);
        // Completion of a foreground command also ends unregistered ordinary
        // descendants. Persistent commands must use start_job instead.
        void kill();
      } catch (error) {
        failure ??= error as Error;
        stop();
      }
    });
  }
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, signal) => {
      // The group identity survives a wrapper exit. Always clean its residual
      // descendants after cancellation, even if the wrapper exits before KILL.
      if (grouped || stopped) void kill().then(() => done({ code, signal }));
      else done({ code, signal });
    });
  });
  options.signal?.addEventListener("abort", aborted, { once: true });
  if (options.signal?.aborted) stop();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stopped 由 stop() 在 abort、超时和输出失败回调里写入，TS 在读取处看不到这些闭包赋值
  if (options.timeoutMs > 0 && !stopped) {
    deadline = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
  }
  try {
    const hostExit = await closed;
    await Promise.all(readers);
    try {
      await output.close();
    } catch (error) {
      failure ??= error as Error;
    }
    const result = commandExit ?? hostExit;
    const receipt = output.receipt();
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stopped 由 stop() 在 abort、超时和输出失败回调里写入，TS 在读取处看不到这些闭包赋值
    if (failure || stopped || result.code !== 0) {
      throw Object.assign(
        failure ?? new Error(`Command failed${result.signal ? ` with ${result.signal}` : ""}: ${command}`),
        receipt,
        {
          code: result.code !== null ? result.code : undefined,
          signal: result.signal ?? undefined,
          timedOut
        }
      );
    }
    return receipt;
  } finally {
    clearTimeout(deadline);
    clearTimeout(forceStop);
    options.signal?.removeEventListener("abort", aborted);
    child.stdin?.destroy();
    await output.close();
  }
}
