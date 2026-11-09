import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../storage/file-lock.js";
import { now } from "../domain/types.js";
import {
  newExperimentProgram,
  newExperimentRun,
  type ExperimentBudget,
  type ExperimentProgram,
  type ExperimentRun,
  type ExperimentRunKind,
  type ExperimentRunStatus,
  type ExperimentStatus,
  type ExperimentVariant,
  type MetricSpec,
  type MetricsOrigin
} from "../domain/experiment.js";
import { configuredExperimentMaxRuns } from "./runtime-settings.js";

/**
 * One ledger per Task, under a fixed id.  Runtime owns it, so there is nothing
 * for Main to name, open or close, and a recovered process finds the same
 * ledger without having to look one up.
 */
const LEDGER_ID = "ledger";

/**
 * Small durable ledger for iterative work. It records the experiment and each
 * delegated run, but it deliberately does not decide the next experiment:
 * Main remains responsible for interpretation and replanning.
 */
export class ExperimentProgramStore {
  constructor(private readonly workspaceRoot: string) {}

  async createProgram(input: {
    taskId: string;
    objective: string;
    successCriteria?: string;
    primaryMetric?: MetricSpec;
    budget?: ExperimentBudget;
    experimentId?: string;
  }): Promise<ExperimentProgram> {
    const program = newExperimentProgram(input);
    const root = this.programDirectory(input.taskId, program.experimentId);
    await this.ensureLayout(root);
    // Create is idempotent like the other program stores: a racing writer that
    // already claimed this id keeps its record rather than being clobbered.
    try {
      await writeFile(join(root, "program.json"), json(program), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return this.readProgram(input.taskId, program.experimentId);
    }
    await this.appendEvent(root, "experiment.created", { objective: program.objective });
    return program;
  }

  async readProgram(taskId: string, experimentId: string): Promise<ExperimentProgram> {
    const value = await this.readJson<Partial<ExperimentProgram>>(
      join(this.programDirectory(taskId, experimentId), "program.json")
    );
    // Older ledgers predate the explicit ownership marker; their semantics are
    // unchanged and are normalized to the invariant used by the new runtime.
    return { ...value, decisionOwner: "main" } as ExperimentProgram;
  }

  async listPrograms(taskId: string): Promise<ExperimentProgram[]> {
    const directory = join(this.workspaceRoot, safe(taskId), "experiments");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const programs: ExperimentProgram[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9._-]+$/.test(entry.name)) continue;
      try {
        programs.push(await this.readProgram(taskId, entry.name));
        // eslint-disable-next-line no-restricted-syntax -- program.json 可能被并发创建尚未写完或被删除，单条实验记录不完整时跳过，其余实验仍要列出
      } catch {
        /* ignore incomplete records */
      }
    }
    return programs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * The Task's ledger, created on first use.
   *
   * There is one per Task and Runtime owns it, so nothing asks Main to open,
   * name or close an experiment. The objective is the Task's own goal, which
   * the Runtime already records.
   */
  async ensureLedger(taskId: string, objective: string): Promise<ExperimentProgram> {
    const existing = (await this.listPrograms(taskId)).find((program) => program.experimentId === LEDGER_ID);
    if (existing) return existing;
    return this.createProgram({ taskId, objective, experimentId: LEDGER_ID });
  }

  /**
   * Record a delegation as the next row of the Task's ledger.
   *
   * Lineage is inferred rather than declared. The parent is the most recent
   * row that has *finished*, not the most recent row opened: a round builds on
   * a result it could see, and a row still in flight has no result yet. This
   * is also what keeps parallel delegations honest — three Subagents started in
   * the same turn are siblings from one ancestor, not a chain in which each
   * happens to descend from whichever was opened a millisecond earlier.
   * `COWORK_EXPERIMENT_MAX_RUNS` bounds how many rows one Task records; past
   * it, bookkeeping stops and work continues.
   */
  async openRun(input: {
    taskId: string;
    callId: string;
    agentId: string;
    objective: string;
    maxRuns?: number;
  }): Promise<{ experimentId: string; experimentRunId: string } | undefined> {
    const program = await this.ensureLedger(input.taskId, input.objective);
    const previous = await this.listRuns(input.taskId, program.experimentId);
    const cap = input.maxRuns ?? configuredExperimentMaxRuns();
    if (cap > 0 && previous.length >= cap) return undefined;
    const settled = [...previous].reverse().find((run) => run.finishedAt !== undefined);
    const run = await this.startRun({
      taskId: input.taskId,
      experimentId: program.experimentId,
      callId: input.callId,
      agentId: input.agentId,
      objective: input.objective,
      variant: settled ? { subject: "other", ref: "", parentRunId: settled.runId } : undefined
    });
    return { experimentId: program.experimentId, experimentRunId: run.runId };
  }

  async updateProgram(
    taskId: string,
    experimentId: string,
    patch: Partial<
      Pick<
        ExperimentProgram,
        "status" | "nextAction" | "lastSummary" | "successCriteria" | "primaryMetric" | "budget"
      >
    >
  ): Promise<ExperimentProgram> {
    const path = join(this.programDirectory(taskId, experimentId), "program.json");
    return withFileLock(path, async () => {
      const current = await this.readProgram(taskId, experimentId);
      const next: ExperimentProgram = {
        ...current,
        ...patch,
        budget: patch.budget ? { ...current.budget, ...patch.budget } : current.budget,
        revision: current.revision + 1,
        updatedAt: now()
      };
      await atomicWrite(path, json(next));
      await this.appendEvent(this.programDirectory(taskId, experimentId), "experiment.updated", {
        fields: Object.keys(patch),
        status: next.status
      });
      return next;
    });
  }

  async startRun(input: {
    taskId: string;
    experimentId: string;
    callId: string;
    agentId: string;
    objective: string;
    kind?: ExperimentRunKind;
    variant?: ExperimentVariant;
  }): Promise<ExperimentRun> {
    const root = this.programDirectory(input.taskId, input.experimentId);
    const run = newExperimentRun(input);
    await this.ensureLayout(root);
    const programPath = join(root, "program.json");
    await withFileLock(programPath, async () => {
      const program = await this.readProgram(input.taskId, input.experimentId);
      if (program.budget.maxRuns !== undefined && program.runCount >= program.budget.maxRuns)
        throw new Error(`experiment budget exhausted: ${input.experimentId}`);
      const nextProgram: ExperimentProgram = {
        ...program,
        status: "running",
        currentRunId: run.runId,
        runCount: program.runCount + 1,
        revision: program.revision + 1,
        updatedAt: now()
      };
      await atomicWrite(programPath, json(nextProgram));
      await atomicWrite(
        join(root, "runs", `${run.runId}.json`),
        json({ ...run, status: "running", startedAt: now(), updatedAt: now() })
      );
      await this.appendEvent(root, "experiment.run_started", { runId: run.runId, callId: run.callId });
    });
    return this.readRun(input.taskId, input.experimentId, run.runId);
  }

  async readRun(taskId: string, experimentId: string, runId: string): Promise<ExperimentRun> {
    return this.readJson(join(this.programDirectory(taskId, experimentId), "runs", `${safe(runId)}.json`));
  }

  /**
   * Remove a row for a delegation that turned out not to be an iteration.
   *
   * Every delegation opens a row, because whether one produced a measurement
   * is only known once it finishes. A row with no metrics and no output was
   * ordinary work — reading a file, summarizing a log — and leaving it would
   * bury the rounds that matter. The Run event log still records that the
   * delegation happened, so nothing is lost that was evidence.
   */
  async discardRun(taskId: string, experimentId: string, runId: string): Promise<void> {
    const root = this.programDirectory(taskId, experimentId);
    const runPath = join(root, "runs", `${safe(runId)}.json`);
    await withFileLock(runPath, async () => {
      // eslint-disable-next-line no-restricted-syntax -- Run 行可能已被其它进程丢弃或从未写出，缺失时视为无可删除内容并继续 lineage 检查
      const current = await this.readJson<ExperimentRun>(runPath).catch(() => undefined);
      // A row later rows already point at must stay, or the lineage breaks.
      if (!current) return;
      const referenced = (await this.listRuns(taskId, experimentId)).some(
        (run) => run.variant?.parentRunId === runId
      );
      if (referenced) return;
      await rm(runPath, { force: true });
      await this.appendEvent(root, "experiment.run_discarded", {
        runId,
        reason: "no metrics and no outputs"
      });
    });
    // runCount stays as it is: it counts delegations against the budget, and
    // a discarded row still consumed one.
  }

  async completeRun(input: {
    taskId: string;
    experimentId: string;
    runId: string;
    status: ExperimentRunStatus;
    summary?: string;
    artifacts?: string[];
    metrics?: Record<string, unknown>;
    metricsSource?: string;
    metricsOrigin?: MetricsOrigin;
    variantRef?: string;
    error?: string;
  }): Promise<ExperimentRun> {
    const root = this.programDirectory(input.taskId, input.experimentId);
    const runPath = join(root, "runs", `${safe(input.runId)}.json`);
    const run = await withFileLock(runPath, async () => {
      const current = await this.readJson<ExperimentRun>(runPath);
      if (["succeeded", "partial", "failed", "timed_out", "cancelled"].includes(current.status))
        return current;
      // A label the run reported names the variant the parent lineage already links.
      const variant = input.variantRef
        ? {
            subject: current.variant?.subject ?? ("other" as const),
            ref: input.variantRef,
            parentRunId: current.variant?.parentRunId,
            changes: current.variant?.changes
          }
        : current.variant;
      const next: ExperimentRun = {
        ...current,
        status: input.status,
        summary: input.summary ?? current.summary,
        artifacts: input.artifacts ?? current.artifacts,
        metrics: input.metrics ?? current.metrics,
        metricsSource: input.metricsSource ?? current.metricsSource,
        metricsOrigin: input.metricsOrigin ?? current.metricsOrigin,
        variant,
        error: input.error ?? current.error,
        finishedAt: now(),
        updatedAt: now()
      };
      await atomicWrite(runPath, json(next));
      await this.appendEvent(root, "experiment.run_finished", {
        runId: next.runId,
        status: next.status,
        artifacts: next.artifacts
      });
      return next;
    });
    // The ledger records; it does not advise. `waiting` means no run of this
    // ledger is in flight — not that Main owes it an action.
    await this.updateProgram(input.taskId, input.experimentId, {
      status: run.status === "succeeded" || run.status === "partial" ? "waiting" : "failed",
      lastSummary: run.summary ?? run.error
    });
    return run;
  }

  /**
   * Correct a row after it settled. `completeRun` is deliberately write-once so
   * a retry or a duplicate callback cannot rewrite history; amending is the
   * separate, explicit act of fixing a record, and it keeps `metricsOrigin` so
   * a reported value stays distinguishable from a measured one.
   */
  async amendRun(input: {
    taskId: string;
    experimentId: string;
    runId: string;
    status?: ExperimentRunStatus;
    summary?: string;
    metrics?: Record<string, unknown>;
    metricsSource?: string;
    metricsOrigin?: MetricsOrigin;
  }): Promise<ExperimentRun> {
    const root = this.programDirectory(input.taskId, input.experimentId);
    const runPath = join(root, "runs", `${safe(input.runId)}.json`);
    return withFileLock(runPath, async () => {
      const current = await this.readJson<ExperimentRun>(runPath);
      const next: ExperimentRun = {
        ...current,
        status: input.status ?? current.status,
        summary: input.summary ?? current.summary,
        metrics: input.metrics ?? current.metrics,
        metricsSource: input.metricsSource ?? current.metricsSource,
        metricsOrigin: input.metricsOrigin ?? current.metricsOrigin,
        updatedAt: now()
      };
      await atomicWrite(runPath, json(next));
      await this.appendEvent(root, "experiment.run_amended", {
        runId: next.runId,
        status: next.status,
        metricsOrigin: next.metricsOrigin
      });
      return next;
    });
  }

  /** Every run of a program, oldest first, so a caller can read a metric series. */
  async listRuns(taskId: string, experimentId: string): Promise<ExperimentRun[]> {
    const directory = join(this.programDirectory(taskId, experimentId), "runs");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const runs: ExperimentRun[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        runs.push(await this.readJson<ExperimentRun>(join(directory, entry.name)));
        // eslint-disable-next-line no-restricted-syntax -- run 文件可能是并发写入中的临时内容或被截断，跳过该行才能返回其余轮次给 metric 序列
      } catch {
        /* ignore incomplete records */
      }
    }
    return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /** The program a delegated call belongs to, if any. Used to attribute a callback. */
  async findRunByCallId(
    taskId: string,
    callId: string
  ): Promise<{ program: ExperimentProgram; run: ExperimentRun } | undefined> {
    for (const program of await this.listPrograms(taskId)) {
      const run = (await this.listRuns(taskId, program.experimentId)).find(
        (candidate) => candidate.callId === callId
      );
      if (run) return { program, run };
    }
    return undefined;
  }

  private async ensureLayout(root: string): Promise<void> {
    await mkdir(join(root, "runs"), { recursive: true });
    try {
      await writeFile(join(root, "events.jsonl"), "", { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  private async appendEvent(root: string, type: string, payload: unknown): Promise<void> {
    await appendFile(
      join(root, "events.jsonl"),
      `${JSON.stringify({ type, payload, occurredAt: now() })}\n`,
      "utf8"
    );
  }

  private async readJson<T>(path: string): Promise<T> {
    return JSON.parse(await readFile(path, "utf8")) as T;
  }
  private programDirectory(taskId: string, experimentId: string): string {
    return join(this.workspaceRoot, safe(taskId), "experiments", safe(experimentId));
  }
}

function safe(value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`unsafe experiment segment: ${value}`);
  return value;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}
