import { metricSeries, type ExperimentRun } from "../domain/experiment.js";
import { ExperimentProgramStore } from "./experiment-program-store.js";

/**
 * A compact, model-facing view of what earlier rounds measured.
 *
 * This is a Runtime projection in the same spirit as `state.json`: Main never
 * maintains it and never has to ask for it. It reaches the model the way
 * durable memory does — injected at the boundaries where context is rebuilt —
 * so a Main that has just been reset still knows what it already tried.
 *
 * It reports and does not judge. No metric is singled out as the one that
 * matters, no direction is assumed to be improvement, and no next step is
 * suggested; reading the trend is Main's work.
 */
export interface ExperimentDigestOptions {
  /** Most recent rounds to show in full. The first round is always kept. */
  maxRows?: number;
  /** Metric series to list. */
  maxSeries?: number;
}

export async function experimentDigest(
  workspaceRoot: string,
  taskId: string,
  options: ExperimentDigestOptions = {}
): Promise<string | undefined> {
  const store = new ExperimentProgramStore(workspaceRoot);
  let runs: ExperimentRun[];
  try {
    const programs = await store.listPrograms(taskId);
    if (!programs.length) return undefined;
    runs = (
      await Promise.all(
        programs.map((program) =>
          // eslint-disable-next-line no-restricted-syntax -- 单个实验的 runs 目录读取失败（并发删除或权限）只让该实验贡献 0 条轮次，摘要仍应展示其余实验
          store.listRuns(taskId, program.experimentId).catch(() => [])
        )
      )
    )
      .flat()
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    // eslint-disable-next-line no-restricted-syntax -- 账本不可读时摘要按“还没有实验”处理，上下文重建不能因为这份可选背景而失败
  } catch {
    return undefined;
  }

  const measured = runs.filter((run) => metricCount(run) > 0);
  // Without at least two measurements there is no series to compare, and the
  // conversation still holds everything a single round produced.
  if (measured.length < 2) return undefined;

  const series = metricSeries(measured).slice(0, options.maxSeries ?? 4);
  const maxRows = options.maxRows ?? 8;
  const shown = measured.slice(-maxRows);
  const rows =
    measured.length > shown.length && !shown.includes(measured[0]) ? [measured[0], ...shown] : shown;
  const index = new Map(measured.map((run, position) => [run.runId, position + 1]));

  const lines = [
    `Recorded rounds (${measured.length} measured of ${runs.length} delegations):`,
    ...rows.map((run) => {
      const parts = [`  #${index.get(run.runId)}`];
      if (run.variant?.ref) parts.push(run.variant.ref);
      parts.push(formatMetrics(run));
      if (run.variant?.parentRunId && index.has(run.variant.parentRunId))
        parts.push(`from #${index.get(run.variant.parentRunId)}`);
      if (run.status !== "succeeded") parts.push(`[${run.status}]`);
      return parts.join("  ");
    })
  ];
  if (measured.length > rows.length)
    lines.push(`  … ${measured.length - rows.length} earlier rounds omitted`);
  for (const entry of series) {
    if (entry.points.length < 2) continue;
    lines.push(`  ${entry.name}: ${entry.points.map((point) => point.value).join(" → ")}`);
  }
  lines.push(
    `Full records: experiments/ in the Task workspace. Values were read from each run's own metrics file.`
  );
  return lines.join("\n");
}

function metricCount(run: ExperimentRun): number {
  return Object.values(run.metrics ?? {}).filter(
    (value) => typeof value === "number" && Number.isFinite(value)
  ).length;
}

function formatMetrics(run: ExperimentRun): string {
  const entries = Object.entries(run.metrics ?? {})
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
    .map(([name, value]) => `${name}=${value}`);
  return entries.length ? entries.join(" ") : "(no metrics)";
}
