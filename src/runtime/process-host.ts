import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/** Owns subprocess groups and bounded shutdown. Run state is owned by the caller. */
export class ProcessHost {
  readonly processes = new Map<string, ChildProcess>();
  private stopping = false;

  start(key: string, command: string, args: string[], options: SpawnOptions): ChildProcess {
    if (this.stopping) throw new Error("Runtime is shutting down");
    if (this.processes.has(key)) throw new Error(`Process already active: ${key}`);
    const env = { ...(options.env ?? process.env) };
    delete env.ATRIA_COMPONENTS_GITHUB_TOKEN;
    const child = spawn(command, args, { ...options, env, detached: process.platform !== "win32" });
    this.processes.set(key, child);
    return child;
  }

  private readonly stops = new Map<string, Promise<void>>();

  /** Stop one task without disabling unrelated or future runs. */
  stopKey(key: string, graceMs = 2_000): Promise<void> {
    const pending = this.stops.get(key);
    if (pending) return pending;
    const child = this.processes.get(key);
    if (!child) return Promise.resolve();
    const operation = (async () => {
      const signal = (value: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, value);
          else child.kill(value);
          // eslint-disable-next-line no-restricted-syntax -- 进程组可能已经退出（ESRCH），信号发不出去属预期，shutdown 仍按 close 与超时继续
        } catch {
          /* the process group has exited */
        }
      };
      if (child.exitCode !== null || child.signalCode !== null) {
        signal("SIGKILL");
        return;
      }
      const closed = new Promise<void>((done) => child.once("close", () => done()));
      let timer: ReturnType<typeof setTimeout> | undefined;
      signal("SIGTERM");
      try {
        await Promise.race([
          closed,
          new Promise<void>((done) => {
            timer = setTimeout(done, graceMs);
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
      // The wrapper may exit first; descendants still belong to this group.
      signal("SIGKILL");
      await closed;
    })().finally(() => this.stops.delete(key));
    this.stops.set(key, operation);
    return operation;
  }

  async stop(graceMs = 2_000): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.processes.keys()].map((key) => this.stopKey(key, graceMs)));
  }
}
