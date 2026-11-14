import {
  CoordinatorRuntime,
  type CoordinatorRecoveryInput,
  type SubagentDispatchResult
} from "./coordinator-runtime.js";
import { SubagentProcessService, type SubagentProcessResult } from "./subagent-processes.js";
import { claimSubagentOwnership, releaseSubagentOwnership } from "./subagent-owner.js";
import { resolve } from "node:path";

export interface WorkerOptions extends CoordinatorRecoveryInput {
  pollMs?: number;
  once?: boolean;
  signal?: AbortSignal;
  /** Install root the shared launcher and extension are read from. */
  harnessRoot?: string;
  onCycle?: (results: SubagentDispatchResult[] | SubagentProcessResult[]) => void | Promise<void>;
}

/**
 * Independent execution loop for one Task Run.
 *
 * Delegated work runs as its own Pi process group. This loop only starts what
 * the durable queue says is runnable, keeps leases alive while those processes
 * run, and projects their exits back into the queue and Main's Inbox. While it
 * is running it adopts processes a previous backend left behind, so restarting
 * the backend neither duplicates a call nor loses its callback.
 */
export class CoordinatorWorker {
  private stopped = false;
  private readonly coordinator: CoordinatorRuntime;

  constructor(coordinator = new CoordinatorRuntime()) {
    this.coordinator = coordinator;
  }

  stop(): void {
    this.stopped = true;
  }

  /** Read through a method so a loop body does not narrow the field to false. */
  private isStopped(): boolean {
    return this.stopped;
  }

  async run(input: WorkerOptions): Promise<void> {
    const pollMs = Math.max(50, input.pollMs ?? 2_000);
    // A host without a Run has nothing to launch; the recovery loop keeps its
    // existing contract for callers that only drive the coordinator.
    // Only a caller that drives the coordinator directly omits Task/Run.
    if (!input.taskId || !input.runId || !input.workspaceRoot) return this.runRecovery(input, pollMs);
    // One owner per workspace root: while the serving Dashboard dispatches and
    // settles delegated work, this worker must not start or settle it a second
    // time. It yields the whole root rather than a single Run, so the two never
    // split one item's launch from its settlement.
    const ownership = await claimSubagentOwnership(input.workspaceRoot, "worker");
    if (!ownership.owned) {
      console.error(
        `[cowork] delegated work for ${input.workspaceRoot} is owned by the running backend (pid ${ownership.owner?.pid}); this worker takes no work`
      );
      return;
    }
    const settled: SubagentProcessResult[] = [];
    const service = new SubagentProcessService({
      workspaceRoot: input.workspaceRoot,
      harnessRoot: resolve(input.harnessRoot ?? process.env.COWORK_HARNESS_ROOT ?? "."),
      env: this.processEnv(input),
      ...(input.pollMs === undefined ? {} : { pollMs }),
      ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
      onSettled: (result) => {
        settled.push(result);
      }
    });
    try {
      await service.adopt({ taskId: input.taskId, runId: input.runId });
      while (!this.stopped && !input.signal?.aborted) {
        settled.length = 0;
        await service.maintain({ taskId: input.taskId, runId: input.runId });
        const launchFailures = await service.startQueued({ taskId: input.taskId, runId: input.runId });
        if (input.once) {
          // A one-shot worker still owns the processes it started: wait for the
          // exits so their callbacks are written before this process returns.
          while (await service.running({ taskId: input.taskId, runId: input.runId })) {
            if (this.isStopped() || input.signal?.aborted) break;
            await wait(pollMs, input.signal);
          }
          await input.onCycle?.([...settled, ...launchFailures]);
          return;
        }
        await input.onCycle?.([...settled, ...launchFailures]);
        await wait(pollMs, input.signal);
      }
    } finally {
      // This backend is going away; the processes are not. Drop observers only.
      service.close();
      await releaseSubagentOwnership(input.workspaceRoot);
    }
  }

  private async runRecovery(input: WorkerOptions, pollMs: number): Promise<void> {
    while (!this.stopped && !input.signal?.aborted) {
      const results = await this.coordinator.recoverRun(input);
      await input.onCycle?.(results);
      if (input.once) return;
      await wait(pollMs, input.signal);
    }
  }

  /** The connection this backend was configured with, handed to the process. */
  private processEnv(input: WorkerOptions): NodeJS.ProcessEnv {
    return {
      COWORK_API_BASE: input.baseUrl,
      COWORK_API_KEY: input.apiKey,
      COWORK_WORKSPACE: input.workspaceRoot,
      ...(input.model ? { COWORK_MODEL: input.model } : {}),
      ...(input.api ? { COWORK_MODEL_API: input.api } : {}),
      ...(input.thinkingLevel ? { COWORK_REASONING_EFFORT: input.thinkingLevel } : {}),
      ...(input.thinkingFormat ? { COWORK_THINKING_FORMAT: input.thinkingFormat } : {}),
      ...(input.supportsReasoningEffort === undefined
        ? {}
        : { COWORK_SUPPORTS_REASONING_EFFORT: input.supportsReasoningEffort ? "1" : "0" }),
      ...(input.supportsPromptCacheKey === undefined
        ? {}
        : { COWORK_SUPPORTS_PROMPT_CACHE_KEY: input.supportsPromptCacheKey ? "1" : "0" })
    };
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
