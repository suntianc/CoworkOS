import { join } from "node:path";
import type { ExperimentRunStatus } from "../domain/experiment.js";
import { id, now, type Event } from "../domain/types.js";
import { JsonlEventStore } from "../storage/event-store.js";
import { readRunMetrics } from "./experiment-metrics.js";
import { ExperimentProgramStore } from "./experiment-program-store.js";

/**
 * The ledger row one delegated work item opened when it was dispatched.
 *
 * Only the two identifiers travel with the work item: metrics are read from the
 * run's own output when it settles, so a recovered or process-based attempt
 * records the same numbers an in-process one did.
 */
export interface DelegatedExperimentRef {
  experimentId: string;
  experimentRunId: string;
}

export interface DelegatedExperimentSettlement {
  workspaceRoot: string;
  taskId: string;
  runId: string;
  callId: string;
  agentId: string;
  ref?: DelegatedExperimentRef;
  status: ExperimentRunStatus;
  /** The item's own site; its metrics.json is read from here. */
  workingDirectory: string;
  summary: string;
  outputFiles: string[];
  error?: string;
}

/**
 * Settle the experiment row a delegation opened.
 *
 * This runs at the same terminal boundary that writes Main's callback: a
 * retryable failure is not an outcome, so it is never recorded here. Metrics
 * come from the run's own `metrics.json`, and an empty successful delegation is
 * discarded rather than kept as an iteration. Bookkeeping must never fail an
 * otherwise finished work item, so a ledger error is reported on the run event
 * stream and the work item keeps its real outcome.
 */
export async function settleDelegatedExperiment(input: DelegatedExperimentSettlement): Promise<void> {
  const ref = input.ref;
  if (!ref) return;
  const taskDirectory = join(input.workspaceRoot, input.taskId);
  try {
    const measured =
      input.status === "succeeded" || input.status === "partial"
        ? await readRunMetrics({
            workingDirectory: input.workingDirectory,
            taskDirectory,
            outputFiles: input.outputFiles
          })
        : {};
    const store = new ExperimentProgramStore(input.workspaceRoot);
    if (
      input.status === "succeeded" &&
      !measured.metrics &&
      !measured.problem &&
      input.outputFiles.length === 0
    ) {
      await store.discardRun(input.taskId, ref.experimentId, ref.experimentRunId);
      return;
    }
    await store.completeRun({
      taskId: input.taskId,
      experimentId: ref.experimentId,
      runId: ref.experimentRunId,
      status: input.status,
      summary: input.summary,
      artifacts: input.outputFiles,
      metrics: measured.metrics,
      metricsSource: measured.source,
      metricsOrigin: measured.metrics ? "file" : undefined,
      // The run may label its own variant in the metrics file. The ledger reads
      // that label rather than asking Main to declare one.
      variantRef: measured.ref,
      // A metrics file that exists but cannot be parsed is surfaced, not dropped.
      error: [input.error, measured.problem].filter(Boolean).join("; ") || undefined
    });
  } catch (ledgerError) {
    const reason = ledgerError instanceof Error ? ledgerError.message : String(ledgerError);
    const event: Event = {
      eventId: id("event"),
      type: "experiment.settle_failed",
      taskId: input.taskId,
      runId: input.runId,
      agentId: input.agentId,
      callId: input.callId,
      occurredAt: now(),
      payload: {
        experimentId: ref.experimentId,
        experimentRunId: ref.experimentRunId,
        error: reason
      }
    };
    await new JsonlEventStore(join(taskDirectory, "runs", input.runId, "run_events.jsonl"))
      .append(event)
      // eslint-disable-next-line no-restricted-syntax -- 记录结算失败本身就是诊断路径，事件再写不进去只能放弃，否则结算错误会变成未处理拒绝
      .catch(() => {
        /* diagnostics only */
      });
  }
}
