import { claimSubagentOwnership, releaseSubagentOwnership } from "../runtime/subagent-owner.js";
import { SubagentDispatchService } from "../runtime/subagent-dispatch.js";
import type { SubagentProcessResult } from "../runtime/subagent-processes.js";
import { resolve } from "node:path";

export interface SubagentWorkerOptions {
  taskId?: string;
  runId?: string;
  workspaceRoot: string;
  /** Install root the shared launcher reads. */
  harnessRoot?: string;
  /** Connection the launched agents use; read once when this host starts. */
  env: NodeJS.ProcessEnv;
  pollMs?: number;
  once?: boolean;
  leaseMs?: number;
  signal?: AbortSignal;
  onCycle?: (results: SubagentProcessResult[]) => void | Promise<void>;
}

/**
 * The CLI host's delegated-process loop.
 *
 * It is the same backend a Dashboard runs — registration, launch, lease renewal
 * and settlement live in `SubagentDispatchService`/`SubagentProcessService` —
 * with the CLI's single owner rule: while a live dashboard owns this workspace
 * root the CLI takes no work, and the processes it started are not its children
 * to end.
 */
export class SubagentWorker {
  private stopped = false;

  stop(): void {
    this.stopped = true;
  }

  /** Read through a method so a loop body does not narrow the field to false. */
  private isStopped(): boolean {
    return this.stopped;
  }

  async run(options: SubagentWorkerOptions): Promise<void> {
    const pollMs = Math.max(50, options.pollMs ?? 2_000);
    // One owner per workspace root: while the serving Dashboard dispatches and
    // settles delegated work, this host must not start or settle it again. It
    // yields the whole root rather than a single Run, so the two never split
    // one item's launch from its settlement.
    const ownership = await claimSubagentOwnership(options.workspaceRoot, "worker");
    if (!ownership.owned) {
      console.error(
        `[cowork] delegated work for ${options.workspaceRoot} is owned by the running backend (pid ${ownership.owner?.pid}); this worker takes no work`
      );
      return;
    }
    const settled: SubagentProcessResult[] = [];
    let service: SubagentDispatchService | undefined;
    try {
      // Construction is inside the try too: the owner record was taken above,
      // and every exit from here must release it.
      service = new SubagentDispatchService({
        workspaceRoot: options.workspaceRoot,
        harnessRoot: resolve(options.harnessRoot ?? process.env.COWORK_HARNESS_ROOT ?? "."),
        env: () => ({ env: options.env }),
        onSettled: (result) => {
          settled.push(result);
        },
        ...(options.pollMs === undefined ? {} : { pollMs }),
        ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs })
      });
      if (options.taskId && options.runId)
        await service.adopt({ taskId: options.taskId, runId: options.runId });
      while (!this.isStopped() && !options.signal?.aborted) {
        settled.length = 0;
        if (options.taskId && options.runId) {
          await service.maintain({ taskId: options.taskId, runId: options.runId });
        }
        if (options.once) {
          // A one-shot host still owns the processes it started: wait for the
          // exits so their callbacks are written before this process returns.
          while (
            options.taskId &&
            options.runId &&
            (await service.running({ taskId: options.taskId, runId: options.runId }))
          ) {
            if (this.isStopped() || options.signal?.aborted) break;
            await wait(pollMs, options.signal);
          }
          await options.onCycle?.([...settled]);
          return;
        }
        await options.onCycle?.([...settled]);
        await wait(pollMs, options.signal);
      }
    } finally {
      // This host is going away; the processes are not. Drop observers only.
      service?.close();
      await releaseSubagentOwnership(options.workspaceRoot);
    }
  }
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolveWait) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolveWait();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
