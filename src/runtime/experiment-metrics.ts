import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Metrics are read from a file the run wrote, not from a Subagent's prose.
 * A natural-language summary is candidate evidence; a ledger that decides the
 * next iteration needs the number itself, unrelayed and traceable to its file.
 */
export const METRICS_FILENAME = "metrics.json";

export interface ReadMetricsInput {
  /** The agent's own working directory, where it was told to write metrics.json. */
  workingDirectory: string;
  /** Task workspace root, so the recorded source path stays relative to it. */
  taskDirectory: string;
  /** Candidate outputs already collected for this run, relative to taskDirectory. */
  outputFiles?: string[];
}

export interface MetricsReadResult {
  metrics?: Record<string, unknown>;
  /** Path the metrics came from, relative to the task directory. */
  source?: string;
  /** Optional label the run gave this variant, taken from a reserved key. */
  ref?: string;
  /** Present when a metrics file existed but could not be used. */
  problem?: string;
}

/**
 * Keys a run may use to label what it measured. They are read out of the
 * metrics object rather than asked of Main, and are not treated as metrics.
 */
const REF_KEYS = ["variant", "ref", "version", "_variant", "_ref"];

/**
 * Look for the run's metrics file and parse it. A missing file is normal — most
 * delegations are not measurements — and reports nothing. A malformed or
 * unusable file is reported as a problem rather than silently ignored, because
 * a failed read must never look like a run that had no metrics.
 */
export async function readRunMetrics(input: ReadMetricsInput): Promise<MetricsReadResult> {
  const candidates = [
    join(input.workingDirectory, METRICS_FILENAME),
    join(input.workingDirectory, "deliverables", METRICS_FILENAME)
  ];
  for (const outputFile of input.outputFiles ?? []) {
    if (outputFile.endsWith(METRICS_FILENAME)) candidates.push(resolve(input.taskDirectory, outputFile));
  }

  for (const path of candidates) {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return {
        problem: `could not read ${displayPath(input.taskDirectory, path)}: ${(error as Error).message}`
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        problem: `${displayPath(input.taskDirectory, path)} is not valid JSON: ${(error as Error).message}`
      };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        problem: `${displayPath(input.taskDirectory, path)} must contain a JSON object of metric names to values`
      };
    }
    const record = parsed as Record<string, unknown>;
    const refKey = REF_KEYS.find((key) => typeof record[key] === "string" && record[key]);
    const metrics = Object.fromEntries(Object.entries(record).filter(([key]) => !REF_KEYS.includes(key)));
    return {
      metrics,
      source: displayPath(input.taskDirectory, path),
      ref: refKey ? String(record[refKey]) : undefined
    };
  }
  return {};
}

function displayPath(taskDirectory: string, path: string): string {
  const rel = relative(taskDirectory, path);
  return !rel || rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}
