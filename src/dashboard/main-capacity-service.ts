import { hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  MAIN_CAPACITY_LIMIT,
  mainCapacityCount,
  type MainCapacityDecision,
  type MainCapacityExternalTask,
  type MainCapacityQueueEntry,
  type MainCapacityRequest,
  type MainCapacitySettings
} from "../domain/main-capacity.js";
import {
  ProjectDataAuthError,
  ProjectDataConflictError,
  ProjectDataInvalidError,
  ProjectDataUnavailableError
} from "../domain/project-ledger.js";
import { createMainCapacityLedger } from "../runtime/main-capacity.js";
import type { MainSessionRecord } from "../workspace/project-data-service.js";
import type { MainCapacityStore } from "../storage/main-capacity-store.js";
import { withFileLock } from "../storage/file-lock.js";

export interface MainCapacityProject {
  projectId: string;
  projectName: string;
}

export interface MainCapacityServicePorts {
  store: MainCapacityStore;
  backendId: string;
  settings(): MainCapacitySettings | undefined;
  /** Write the public configuration, preserving every other setting. */
  persistSettings(next: MainCapacitySettings): Promise<void>;
  projects(): Promise<MainCapacityProject[]>;
  sessions(projectId: string): Promise<MainSessionRecord[]>;
  /** The Main heartbeat of one local Task, when one is running. */
  heartbeat(taskId: string): Promise<{ pid: number; host: string; runId: string } | undefined>;
  /** The local Task snapshot, for reconciling a dispatch interrupted by a restart. */
  taskState(taskId: string): Promise<{ status: string; activeRunId?: string } | undefined>;
  host?: string;
  tickMs?: number;
  /** Base backoff for a recoverable dispatch failure (tests use a small one). */
  retryBaseMs?: number;
  now?: () => string;
}

export interface MainCapacityProjectUsage extends MainCapacityProject {
  regular: number;
  continuation: number;
}

export interface MainCapacityView {
  configured: boolean;
  settings: MainCapacitySettings | null;
  running: Array<{
    requestId: string;
    projectId: string;
    projectName?: string;
    sessionId: string;
    taskId: string;
    runId: string;
    kind: "regular" | "continuation";
    requirementId?: string;
    pid?: number;
    startedAt: string;
  }>;
  queued: Array<{
    requestId: string;
    projectId: string;
    projectName?: string;
    sessionId: string;
    taskId: string;
    kind: "regular" | "continuation";
    requirementId?: string;
    position: number;
    origin: MainCapacityQueueEntry["origin"];
    enqueuedAt: string;
    /** `failed` means bounded retries are spent; the input stays here to retry. */
    state: "queued" | "starting" | "failed";
    attempts: number;
    lastError?: string;
  }>;
  projects: MainCapacityProjectUsage[];
  /**
   * False when a shared session read failed: `projects` is then partial and
   * the saved-session counts are unknown, not zero.
   */
  projectsComplete: boolean;
  projectsError?: string;
}

/** A reservation whose launch has not produced a process yet still owns its slot. */
const DISPATCH_GRACE_MS = 120_000;

/** A failure the same accepted demand can survive by waiting for the service again. */
function transientDispatchFailure(error: unknown): boolean {
  return (
    error instanceof ProjectDataUnavailableError ||
    error instanceof ProjectDataAuthError ||
    (error instanceof Error &&
      ["storage_unavailable", "shared_auth_failed"].includes((error as Error & { code?: string }).code ?? ""))
  );
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * External Main capacity for this backend: settings, admission, the durable
 * queue and the program that releases a slot and starts the next demand.
 *
 * A slot is held while this backend has a process for the Run. It is released
 * when the process exits (completion, failure, cancellation or shutdown) and
 * by startup reconciliation when a recorded process is no longer alive, so a
 * crash never leaves the service short of capacity and never starts the same
 * demand twice.
 */
export function createMainCapacityService(ports: MainCapacityServicePorts) {
  const host = ports.host ?? hostname();
  const now = ports.now ?? (() => new Date().toISOString());
  const ledger = createMainCapacityLedger({
    store: ports.store,
    host,
    settings: ports.settings,
    now,
    ...(ports.retryBaseMs ? { retryBaseMs: ports.retryBaseMs } : {})
  });
  let starter: ((entry: MainCapacityQueueEntry) => Promise<void>) | undefined;
  let stopping = false;
  let started = false;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let dispatching: Promise<void> | undefined;
  let repeat = false;

  function log(error: unknown) {
    console.error(
      `[cowork] 外部 Main 容量处理失败：${error instanceof Error ? error.message : String(error)}`
    );
  }

  /** The external sessions this backend owns, per project, from the shared rows. */
  async function externalSessions(): Promise<{
    tasks: MainCapacityExternalTask[];
    usage: MainCapacityProjectUsage[];
    failures: Array<{ projectId: string; message: string }>;
  }> {
    const tasks: MainCapacityExternalTask[] = [];
    const usage: MainCapacityProjectUsage[] = [];
    const failures: Array<{ projectId: string; message: string }> = [];
    for (const project of await ports.projects()) {
      let records: MainSessionRecord[];
      try {
        records = await ports.sessions(project.projectId);
      } catch (error) {
        // An unreadable project is unknown, never an empty one: keeping the
        // failure lets quota checks refuse instead of counting it as zero.
        failures.push({
          projectId: project.projectId,
          message: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
      const mine = records.filter(
        (record) => record.session.entryKind === "external" && record.session.backendId === ports.backendId
      );
      for (const record of mine) {
        tasks.push({
          taskId: record.session.taskId,
          projectId: project.projectId,
          sessionId: record.session.sessionId,
          kind: record.session.kind
        });
      }
      usage.push({
        ...project,
        regular: mine.filter((record) => record.session.kind === "regular").length,
        continuation: mine.filter((record) => record.session.kind === "continuation").length
      });
    }
    return { tasks, usage, failures };
  }

  /**
   * Re-read the shared sessions into the local index the CLI and worker consult.
   *
   * A partial read merges instead of replacing, so a shared-service outage can
   * never make this backend's own external Tasks look internal to its CLI.
   */
  async function refreshExternalSessions(): Promise<void> {
    const read = await externalSessions();
    if (!read.failures.length) {
      await ledger.setExternalTasks(read.tasks);
      return;
    }
    await ledger.mergeExternalTasks(read.tasks);
    console.error(
      `[cowork] 外部会话索引刷新不完整，已保留已知身份：${read.failures
        .map((failure) => `${failure.projectId}（${failure.message}）`)
        .join("；")}`
    );
  }

  function failureMessage(failures: Array<{ projectId: string; message: string }>): string {
    return failures.map((failure) => `${failure.projectId}（${failure.message}）`).join("；");
  }

  async function slotAlive(
    slot: { taskId: string; runId: string; host: string; pid?: number; startedAt: string },
    ignoreFreshReservations = false
  ): Promise<boolean> {
    // A heartbeat for another Run of the same Task is stale evidence about an
    // earlier process, not proof that this slot has no process.
    const beat = await ports.heartbeat(slot.taskId).catch(() => undefined);
    if (beat && beat.runId === slot.runId && beat.host === host && pidAlive(beat.pid)) return true;
    if (slot.host !== host) return false;
    if (slot.pid !== undefined) return pidAlive(slot.pid);
    // A dispatch reserves its slot before the spawn returns; a concurrent read
    // must not reclaim that claim as stale in the middle of the launch. At
    // startup no launch of this process is in flight, so such a reservation is
    // the leftover of a crashed dispatch.
    if (ignoreFreshReservations) return false;
    const age = Date.now() - Date.parse(slot.startedAt);
    return Number.isFinite(age) && age < DISPATCH_GRACE_MS;
  }

  /**
   * Reconcile this backend's own claims against its records.
   *
   * Only a process this host started may keep a slot: another host's pid is
   * never probed, and nothing is killed here. A dispatch interrupted by a
   * restart either already recorded its Run (do not start it again) or never
   * did (put the accepted demand back in line).
   */
  async function reconcile(ignoreFreshReservations = false): Promise<void> {
    const state = await ledger.state();
    if (state.queue.length || state.slots.length)
      for (const slot of state.slots) {
        if (await slotAlive(slot, ignoreFreshReservations)) continue;
        await ledger.releaseSlot(slot.requestId);
      }
    // Only startup judges an interrupted `starting` entry: during normal
    // operation an in-flight dispatch owns it, and its own failure handler
    // decides between a retry and a permanent drop.
    if (!ignoreFreshReservations) return;
    const after = await ledger.state();
    for (const entry of after.queue) {
      if (entry.state !== "starting") continue;
      if (after.slots.some((slot) => slot.requestId === entry.requestId)) {
        // The dispatch completed before the restart: the demand is running.
        await ledger.completeStart(entry.requestId);
        continue;
      }
      const task = await ports.taskState(entry.taskId).catch(() => undefined);
      if (task?.activeRunId === entry.runId) {
        // A Run was recorded before the interruption: never start it twice.
        await ledger.completeStart(entry.requestId);
        continue;
      }
      // The accepted input never became a Run: keep it and try again.
      await ledger.retryStart(entry.requestId, "启动被中断，等待重试");
    }
  }

  async function dispatch(): Promise<void> {
    if (dispatching) {
      // Called from inside a running dispatch (or while it settles): ask that
      // pass to look again instead of awaiting itself.
      repeat = true;
      return;
    }
    dispatching = (async () => {
      do {
        repeat = false;
        while (!stopping && starter) {
          const next = await ledger.reserveNext();
          if (!next) break;
          try {
            await starter(next);
            await ledger.completeStart(next.requestId);
          } catch (error) {
            log(error);
            if (transientDispatchFailure(error)) {
              // The accepted input outlives the outage; the demand waits with
              // backoff and stays visible instead of being dropped.
              await ledger.retryStart(next.requestId, error instanceof Error ? error.message : String(error));
            } else {
              await ledger.failStart(next.requestId);
            }
          }
        }
      } while (repeat && !stopping);
    })().finally(() => {
      dispatching = undefined;
    });
    return dispatching;
  }

  function assertReductionAllowed(
    next: MainCapacitySettings,
    state: { slots: Array<{ kind: string }> },
    usage: MainCapacityProjectUsage[]
  ) {
    const running = (kind: string) => state.slots.filter((slot) => slot.kind === kind).length;
    if (next.resident < running("regular"))
      throw new ProjectDataConflictError(
        `正在运行 ${running("regular")} 个外部常规 Main，不能把 resident 降到 ${next.resident}`,
        undefined,
        "main_capacity_in_use"
      );
    if (next.continuation < running("continuation"))
      throw new ProjectDataConflictError(
        `正在运行 ${running("continuation")} 个外部接续 Main，不能把 continuation 降到 ${next.continuation}`,
        undefined,
        "main_capacity_in_use"
      );
    const crowded = usage.filter((project) => project.regular > next.resident);
    if (crowded.length)
      throw new ProjectDataConflictError(
        `${crowded
          .map((project) => `项目「${project.projectName}」已有 ${project.regular} 个外部常规会话`)
          .join("；")}，不能把 resident 降到 ${next.resident}；请先显式整理会话`,
        undefined,
        "main_capacity_in_use"
      );
  }

  /**
   * One critical section for saving an external session.
   *
   * The limit is computed from shared session rows, so the check and the create
   * must not interleave with another save of the last free place. This is a
   * local, per-backend lock: another backend has its own quota and its own count.
   */
  function withSessionCreateLock<T>(action: () => Promise<T>): Promise<T> {
    return withFileLock(join(dirname(ports.store.path), "session-create"), action, {
      timeoutMs: 15_000
    });
  }

  /** Settings, running claims and waiting demands as the page and the tool read them. */
  async function describe(): Promise<MainCapacityView> {
    await reconcile();
    const state = await ledger.state();
    // A shared read may fail; the local running and waiting facts stay
    // readable, but the saved-session counts are reported as unknown.
    const read = await externalSessions().catch((error: unknown) => ({
      tasks: [],
      usage: [],
      failures: [
        {
          projectId: "*",
          message: error instanceof Error ? error.message : String(error)
        }
      ]
    }));
    const usage = read.usage;
    const names = new Map(usage.map((project) => [project.projectId, project.projectName]));
    return {
      configured: Boolean(ports.settings()),
      settings: ports.settings() ?? null,
      running: state.slots.map((slot) => ({
        requestId: slot.requestId,
        projectId: slot.projectId,
        ...(names.has(slot.projectId) ? { projectName: names.get(slot.projectId)! } : {}),
        sessionId: slot.sessionId,
        taskId: slot.taskId,
        runId: slot.runId,
        kind: slot.kind,
        ...(slot.requirementId ? { requirementId: slot.requirementId } : {}),
        ...(slot.pid ? { pid: slot.pid } : {}),
        startedAt: slot.startedAt
      })),
      // A demand being dispatched already owns a slot and is listed there; the
      // queue shows the ones still waiting or waiting to be retried.
      queued: state.queue
        .filter((entry) => entry.state !== "starting")
        .map((entry, index) => ({
          requestId: entry.requestId,
          projectId: entry.projectId,
          ...(names.has(entry.projectId) ? { projectName: names.get(entry.projectId)! } : {}),
          sessionId: entry.sessionId,
          taskId: entry.taskId,
          kind: entry.kind,
          ...(entry.requirementId ? { requirementId: entry.requirementId } : {}),
          position: index + 1,
          origin: entry.origin,
          enqueuedAt: entry.enqueuedAt,
          state: entry.state,
          attempts: entry.attempts ?? 0,
          ...(entry.lastError ? { lastError: entry.lastError } : {})
        })),
      projects: usage,
      projectsComplete: read.failures.length === 0,
      ...(read.failures.length ? { projectsError: failureMessage(read.failures) } : {})
    };
  }

  /** Validate and store the external quotas; a reduction below real usage is refused. */
  async function configure(input: { resident?: unknown; continuation?: unknown }): Promise<MainCapacityView> {
    const current = ports.settings();
    const resident = input.resident === undefined ? current?.resident : input.resident;
    const continuation = input.continuation === undefined ? current?.continuation : input.continuation;
    if (resident === undefined) throw new ProjectDataInvalidError("需要 resident 配额");
    if (continuation === undefined) throw new ProjectDataInvalidError("需要 continuation 配额");
    const next: MainCapacitySettings = {
      resident: mainCapacityCount(resident, "常驻配额 resident", 1),
      continuation: mainCapacityCount(continuation, "接续配额 continuation", 0)
    };
    if (next.resident > MAIN_CAPACITY_LIMIT || next.continuation > MAIN_CAPACITY_LIMIT)
      throw new ProjectDataInvalidError(`配额不能超过 ${MAIN_CAPACITY_LIMIT}`);
    if (current?.resident !== next.resident || current?.continuation !== next.continuation) {
      // Serialize with session creation: a newly saved session must count
      // toward the quota this check is about to accept.
      await withSessionCreateLock(async () => {
        const state = await ledger.state();
        if (current) {
          const read = await externalSessions();
          if (read.failures.length)
            throw new ProjectDataConflictError(
              `无法读取全部项目会话，暂不能修改配额：${failureMessage(read.failures)}`,
              undefined,
              "main_capacity_unavailable"
            );
          assertReductionAllowed(next, state, read.usage);
        }
        await ports.persistSettings(next);
      });
    }
    return describe();
  }

  return {
    describe,
    configure,
    settings: () => ports.settings(),

    enabled: () => Boolean(ports.settings()),

    /** Same critical section the quota write uses, for session creation. */
    withCreateLock: withSessionCreateLock,

    async sessionUsage(projectId: string): Promise<MainCapacityProjectUsage | undefined> {
      const read = await externalSessions();
      const failure = read.failures.find((entry) => entry.projectId === projectId);
      // Unknown is not zero: a create must not pass the limit it cannot count.
      if (failure)
        throw new ProjectDataConflictError(
          `无法读取该项目的会话数，暂不能确认外部会话上限：${failure.message}`,
          undefined,
          "main_capacity_unavailable"
        );
      return read.usage.find((project) => project.projectId === projectId);
    },

    /** Record an external session so this host's CLI and worker can find it. */
    async noteSession(record: MainSessionRecord): Promise<void> {
      if (record.session.entryKind !== "external" || record.session.backendId !== ports.backendId) return;
      await ledger.noteExternalTask({
        taskId: record.session.taskId,
        projectId: record.session.projectId,
        sessionId: record.session.sessionId,
        kind: record.session.kind
      });
    },

    admit(request: MainCapacityRequest): Promise<MainCapacityDecision> {
      return ledger.admit(request);
    },

    async release(requestId: string): Promise<void> {
      if (!(await ledger.release(requestId))) return;
      // Never block the caller on the next dispatch: this runs from inside the
      // launch that failed (whose dispatch pass is still in flight) as well as
      // from a process close.
      if (!stopping) void dispatch().catch(log);
    },

    bindProcess(requestId: string, pid: number): Promise<void> {
      return ledger.bindProcess(requestId, pid);
    },

    /** A cancelled Task gives up its place in line as well as any running slot. */
    async cancelTask(taskId: string): Promise<void> {
      if (await ledger.cancelTask(taskId)) await dispatch();
    },

    attachStarter(start: (entry: MainCapacityQueueEntry) => Promise<void>) {
      starter = start;
    },

    /** Reconcile this backend's claims and start what fits; safe to call repeatedly. */
    async recover(): Promise<void> {
      // Startup: a reservation without a process is the leftover of a crashed
      // dispatch, not a launch this process has in flight.
      await reconcile(true);
      await refreshExternalSessions();
      await dispatch();
    },

    /** Put a failed accepted demand back in line and start what fits. */
    async retry(requestId: string): Promise<MainCapacityView> {
      if (!(await ledger.retry(requestId)))
        throw new ProjectDataConflictError(
          "该需求不在可重试状态；草稿或附件如有需要请重新发送",
          undefined,
          "main_capacity_not_retryable"
        );
      if (!stopping) await dispatch();
      return describe();
    },

    async start(): Promise<void> {
      if (started) return;
      started = true;
      await this.recover().catch(log);
      ticker = setInterval(
        () => {
          void (async () => {
            if (stopping) return;
            await reconcile();
            await dispatch();
          })().catch(log);
        },
        ports.tickMs ?? Number(process.env.COWORK_MAIN_CAPACITY_TICK_MS ?? 2_000)
      );
      ticker.unref?.();
    },

    async stop(): Promise<void> {
      stopping = true;
      if (ticker) clearInterval(ticker);
      ticker = undefined;
      await dispatching?.catch(() => {});
    }
  };
}

export type MainCapacityService = ReturnType<typeof createMainCapacityService>;
