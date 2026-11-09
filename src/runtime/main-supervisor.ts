import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { withFileLock } from "../storage/file-lock.js";
import { InboxStore } from "./scheduler.js";
import { HumanRequestStore } from "./human.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { JsonlEventStore } from "../storage/event-store.js";
import { id, now } from "../domain/types.js";
import { WatchProgramStore } from "./watch-program-store.js";
import { routeGoalMessage, discardGoalMessage } from "./goal-routing.js";
import { mainIsAlive, readHeartbeat } from "./main-heartbeat.js";
import { monitoringPrograms } from "./monitoring-control.js";

/**
 * Restarts a Main that stopped while work was still addressed to it.
 *
 * An iterative run sleeps between rounds: the Task parks, the model stops, and
 * a callback hours later is what resumes it. That works while the process
 * lives. If it does not — a closed terminal, a crash, a reboot — the messages
 * stay on disk and nothing consumes them until someone starts Main by hand.
 * This closes that gap, and nothing more: it decides only *whether* a Main
 * should exist, never what one should do.
 *
 * Spawning a model process is expensive and hard to undo, so the bar is high.
 * A Task is resumed only when it has an unconsumed callback, no live Main, and
 * nothing it is waiting on a human for — a Task parked on a question must stay
 * parked, or the supervisor would answer for the user by restarting past them.
 */

export interface MainSupervisorOptions {
  workspaceRoot: string;
  /** Command used to start a Main for one Task. */
  launch: (input: { taskId: string; runId: string }) => Promise<void> | void;
  /** Report a decision, for logging. */
  onDecision?: (decision: MainSupervisorDecision) => void | Promise<void>;
  nowMs?: () => number;
}

export interface MainSupervisorDecision {
  taskId: string;
  action: "resumed" | "skipped";
  /** Why a Task was left alone, when it was. */
  reason?:
    | "main_alive"
    | "no_pending_work"
    | "awaiting_human"
    | "task_closed"
    | "no_run"
    | "launch_failed"
    | "monitoring_paused"
    | "backoff";
  pendingCallbacks?: number;
  /** For "backoff": how long until this Task is eligible again. */
  retryInMs?: number;
  attempts?: number;
  error?: string;
}

export interface MainSupervisorCycleResult {
  inspected: number;
  resumed: number;
  decisions: MainSupervisorDecision[];
}

/**
 * How long to wait after each consecutive relaunch, in minutes.
 *
 * A Main that dies on startup would otherwise be relaunched every cycle
 * forever, spending real money on a loop that cannot make progress. Backoff
 * grows so a persistent failure becomes cheap and visible instead, and the
 * last value repeats rather than giving up: the cause may be a provider
 * outage that resolves on its own.
 */
const BACKOFF_MINUTES = [0, 1, 5, 15, 60] as const;

/** Relaunch history for one Task, kept beside its other runtime state. */
interface RelaunchState {
  attempts: number;
  lastAttemptAt: string;
}

export class MainSupervisor {
  constructor(private readonly options: MainSupervisorOptions) {}

  async runCycle(filter: { taskId?: string } = {}): Promise<MainSupervisorCycleResult> {
    const result: MainSupervisorCycleResult = { inspected: 0, resumed: 0, decisions: [] };
    const taskIds = filter.taskId ? [filter.taskId] : await this.listTasks();
    for (const taskId of taskIds) {
      result.inspected += 1;
      const decision = await this.inspect(taskId).catch((error): MainSupervisorDecision => ({
        taskId,
        action: "skipped",
        reason: "launch_failed",
        error: error instanceof Error ? error.message : String(error)
      }));
      if (decision.action === "resumed") result.resumed += 1;
      result.decisions.push(decision);
      await this.options.onDecision?.(decision);
    }
    return result;
  }

  private async inspect(taskId: string): Promise<MainSupervisorDecision> {
    const store = new LocalWorkspaceStore(this.options.workspaceRoot);
    const task = await store.readTask(taskId);
    // A finished Task is finished. Only the user reopens one.
    if (task.status === "completed" || task.status === "cancelled" || task.status === "failed") {
      return { taskId, action: "skipped", reason: "task_closed" };
    }
    const runId = task.activeRunId;
    if (!runId) return { taskId, action: "skipped", reason: "no_run" };

    const programsForRouting = await monitoringPrograms(this.options.workspaceRoot, taskId);
    // Goal decisions block only their own events; ordinary askhuman still owns Main.
    const goalQuestionIds = new Set(
      programsForRouting.map((program) => program.goal?.decisionRequestId).filter(Boolean)
    );
    // A Task parked on a question belongs to the user until they answer it.
    // Restarting past that would let the supervisor decide the question by
    // resuming without it.
    if (
      (await new HumanRequestStore(this.options.workspaceRoot).list(taskId, "pending")).some(
        (question) => !goalQuestionIds.has(question.requestId)
      )
    ) {
      return { taskId, action: "skipped", reason: "awaiting_human" };
    }

    const inbox = new InboxStore(
      join(this.options.workspaceRoot, taskId, "runs", runId, "agents", "main", "inbox-store.json")
    );
    const pending = [];
    let held = false;
    for (const message of (await inbox.list("main")).filter((entry) => entry.state !== "consumed")) {
      const route = routeGoalMessage(programsForRouting, task.monitoring?.scope === "background", message);
      if (route === "discard") await discardGoalMessage(inbox, message);
      else if (route === "hold") held = true;
      else pending.push(message);
    }
    if (!pending.length && held) return { taskId, action: "skipped", reason: "monitoring_paused" };
    if (pending.length === 0) return { taskId, action: "skipped", reason: "no_pending_work" };
    // Holding monitoring work must not block ordinary user/delegation messages.
    if (
      pending.every((message) => {
        const payload = message.payload as { type?: unknown } | undefined;
        return (
          message.kind === "external_event" &&
          typeof payload?.type === "string" &&
          payload.type.startsWith("watch.")
        );
      })
    ) {
      const watches = new WatchProgramStore(this.options.workspaceRoot);
      const programs = await watches.listPrograms(taskId);
      if (programs.length) {
        let active = false;
        let paused = false;
        for (const program of programs) {
          if (program.status === "completed") continue;
          const monitors = await watches.listVirtualAgents(taskId, program.programId);
          if (program.status === "paused" || monitors.some((monitor) => monitor.status === "paused"))
            paused = true;
          if (program.status === "paused") continue;
          if (program.goal) active = true;
          if (
            monitors.some(
              (monitor) =>
                monitor.status === "active" &&
                (!monitor.expiresAt || Date.parse(monitor.expiresAt) > Date.now())
            )
          )
            active = true;
        }
        if (!active && paused)
          return { taskId, action: "skipped", reason: "monitoring_paused", pendingCallbacks: pending.length };
      }
    }

    if (mainIsAlive(await readHeartbeat(this.options.workspaceRoot, taskId), this.options.nowMs?.())) {
      // A Main that got far enough to refresh a heartbeat started successfully,
      // so the crash-loop count starts over from here.
      await this.clearRelaunch(taskId);
      return { taskId, action: "skipped", reason: "main_alive", pendingCallbacks: pending.length };
    }

    // Take the Task's lock for the launch itself, so two supervisors cannot
    // both observe "no Main" and both start one.
    return withFileLock(join(this.options.workspaceRoot, taskId, ".main-supervisor"), async () => {
      // The winner of the lock may have started a Main while this call waited.
      if (mainIsAlive(await readHeartbeat(this.options.workspaceRoot, taskId), this.options.nowMs?.())) {
        return { taskId, action: "skipped", reason: "main_alive", pendingCallbacks: pending.length };
      }
      // A Main that keeps dying must not be relaunched every cycle: the loop
      // would cost real money while making no progress.
      const nowMs = this.options.nowMs?.() ?? Date.now();
      const history = await this.readRelaunch(taskId);
      const waitMs = backoffMs(history.attempts);
      const sinceMs = history.lastAttemptAt
        ? nowMs - Date.parse(history.lastAttemptAt)
        : Number.POSITIVE_INFINITY;
      if (Number.isFinite(sinceMs) && sinceMs < waitMs) {
        return {
          taskId,
          action: "skipped",
          reason: "backoff",
          attempts: history.attempts,
          retryInMs: Math.max(0, waitMs - sinceMs),
          pendingCallbacks: pending.length
        };
      }
      await this.writeRelaunch(taskId, {
        attempts: history.attempts + 1,
        lastAttemptAt: new Date(nowMs).toISOString()
      });
      await this.appendEvent(taskId, runId, "main.supervisor_resume", {
        pendingCallbacks: pending.length,
        attempts: history.attempts + 1
      });
      await this.options.launch({ taskId, runId });
      return { taskId, action: "resumed", pendingCallbacks: pending.length, attempts: history.attempts + 1 };
    });
  }

  /**
   * Relaunch history, reset once a Main proves it can run.
   *
   * "Proves it can run" is a live heartbeat: a Main that reached the point of
   * refreshing one started successfully, so the next failure is a new problem
   * rather than a continuation of a crash loop.
   */
  private async readRelaunch(taskId: string): Promise<RelaunchState> {
    const path = join(this.options.workspaceRoot, taskId, "agents", "main", "relaunch.json");
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as Partial<RelaunchState>;
      return {
        attempts: Number.isFinite(value.attempts) ? Math.max(0, value.attempts as number) : 0,
        lastAttemptAt: typeof value.lastAttemptAt === "string" ? value.lastAttemptAt : ""
      };
      // eslint-disable-next-line no-restricted-syntax -- relaunch.json 尚未写入或已损坏时按首次失败放行，成功心跳会重新清零退避
    } catch {
      return { attempts: 0, lastAttemptAt: "" };
    }
  }

  private async writeRelaunch(taskId: string, state: RelaunchState): Promise<void> {
    const directory = join(this.options.workspaceRoot, taskId, "agents", "main");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "relaunch.json");
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, "utf8");
    await rename(temporary, path);
  }

  private async clearRelaunch(taskId: string): Promise<void> {
    // eslint-disable-next-line no-restricted-syntax -- 清理失败只影响退避计数，下一次失败仍按原计数重试，成功心跳会再次清零
    await this.writeRelaunch(taskId, { attempts: 0, lastAttemptAt: "" }).catch(() => {});
  }

  private async listTasks(): Promise<string[]> {
    try {
      const entries = await readdir(this.options.workspaceRoot, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async appendEvent(taskId: string, runId: string, type: string, payload: unknown): Promise<void> {
    await new JsonlEventStore(join(this.options.workspaceRoot, taskId, "runs", runId, "run_events.jsonl"))
      .append({ eventId: id("event"), type, taskId, runId, agentId: "main", occurredAt: now(), payload })
      // eslint-disable-next-line no-restricted-syntax -- 追加的是仅供诊断的监督者事件，写失败不能中断监督循环
      .catch(() => {
        /* diagnostics only */
      });
  }
}

/** A successful short run may finish between supervisor ticks; its completion is authoritative. */
export async function resetMainSupervisorBackoff(workspaceRoot: string, taskId: string): Promise<void> {
  const directory = join(workspaceRoot, taskId, "agents", "main");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "relaunch.json");
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, JSON.stringify({ attempts: 0, lastAttemptAt: "" }) + "\n");
  await rename(temporary, path);
}

/** Repeats supervisor cycles, holding one workspace-wide lease while it runs. */
export class MainSupervisorLoop {
  private stopped = false;
  stop(): void {
    this.stopped = true;
  }

  async run(
    supervisor: MainSupervisor,
    options: {
      intervalMs?: number;
      once?: boolean;
      taskId?: string;
      signal?: AbortSignal;
      workspaceRoot: string;
      onCycle?: (result: MainSupervisorCycleResult) => void | Promise<void>;
    }
  ): Promise<void> {
    const intervalMs = Math.max(5_000, options.intervalMs ?? 60_000);
    await withFileLock(
      join(options.workspaceRoot, ".main-supervisor-loop"),
      async () => {
        while (!this.stopped && !options.signal?.aborted) {
          await options.onCycle?.(await supervisor.runCycle({ taskId: options.taskId }));
          if (options.once) return;
          await wait(intervalMs, options.signal);
        }
      },
      { heartbeatMs: 10_000 }
    );
  }
}

function backoffMs(attempts: number): number {
  const index = Math.min(attempts, BACKOFF_MINUTES.length - 1);
  return BACKOFF_MINUTES[index] * 60_000;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let timer: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * The turn a supervisor wakes Main with.
 *
 * Pi needs a turn to start running, so a relaunch has to say something — but
 * this is machinery, not a person talking. It is exported because the browser
 * has to recognise it: shown as an ordinary user message it read as though the
 * person had typed "Resume this task from its durable state…" right after
 * answering a question, and it confused Main too, which went looking for who
 * had asked it to consume an Inbox.
 *
 * `web/assets/conversation.js` holds the browser's copy and must match.
 */
export const SUPERVISOR_WAKE_TURN =
  "Resume this task from its durable state: consume the pending Inbox messages and continue.";

/**
 * The default launcher: the same entry point a user would run by hand.
 *
 * Main resumes from its own durable state — Inbox, memory and the recorded
 * rounds — so the wake turn carries no instruction about what to do next: that
 * decision belongs to Main.
 */
export function spawnMainProcess(input: {
  taskId: string;
  runId: string;
  harnessRoot: string;
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const child = spawn(
    process.execPath,
    [
      join(input.harnessRoot, "scripts", "start-pi.mjs"),
      "--print",
      "--mode",
      "json",
      "--continue",
      "--session-dir",
      join(input.workspaceRoot, input.taskId, "sessions", "main", "pi"),
      SUPERVISOR_WAKE_TURN
    ],
    {
      cwd: input.harnessRoot,
      env: {
        ...process.env,
        ...input.env,
        COWORK_CLI_SESSION: "0",
        COWORK_WORKSPACE: input.workspaceRoot,
        COWORK_TASK_ID: input.taskId,
        COWORK_RUN_ID: input.runId
      },
      stdio: "ignore",
      detached: true
    }
  );
  child.unref();
}
