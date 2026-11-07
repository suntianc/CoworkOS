import { hostname } from "node:os";
import {
  MAIN_CAPACITY_LIMIT,
  mainCapacityCount,
  type MainCapacityDecision,
  type MainCapacityExternalTask,
  type MainCapacityQueueEntry,
  type MainCapacityRequest,
  type MainCapacitySettings
} from "../domain/main-capacity.js";
import { ProjectDataConflictError, ProjectDataInvalidError } from "../domain/project-ledger.js";
import { createMainCapacityLedger } from "../runtime/main-capacity.js";
import type { MainSessionRecord } from "../workspace/project-data-service.js";
import type { MainCapacityStore } from "../storage/main-capacity-store.js";

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
  host?: string;
  tickMs?: number;
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
  }>;
  projects: MainCapacityProjectUsage[];
}

/** A reservation whose launch has not produced a process yet still owns its slot. */
const DISPATCH_GRACE_MS = 120_000;

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
  const ledger = createMainCapacityLedger({ store: ports.store, host, settings: ports.settings, now });
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
  }> {
    const tasks: MainCapacityExternalTask[] = [];
    const usage: MainCapacityProjectUsage[] = [];
    for (const project of await ports.projects()) {
      let records: MainSessionRecord[];
      try {
        records = await ports.sessions(project.projectId);
      } catch {
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
    return { tasks, usage };
  }

  /** Re-read the shared sessions into the local index the CLI and worker consult. */
  async function refreshExternalSessions(): Promise<void> {
    await ledger.setExternalTasks((await externalSessions()).tasks);
  }

  async function projectUsage(): Promise<MainCapacityProjectUsage[]> {
    return (await externalSessions()).usage;
  }

  async function slotAlive(slot: {
    taskId: string;
    runId: string;
    host: string;
    pid?: number;
    startedAt: string;
  }): Promise<boolean> {
    const beat = await ports.heartbeat(slot.taskId).catch(() => undefined);
    if (beat && beat.runId !== slot.runId) return false;
    if (beat && beat.runId === slot.runId && beat.host === host && pidAlive(beat.pid)) return true;
    if (slot.host !== host) return false;
    if (slot.pid !== undefined) return pidAlive(slot.pid);
    // A dispatch reserves its slot before the spawn returns; a concurrent read
    // must not reclaim that claim as stale in the middle of the launch.
    const age = Date.now() - Date.parse(slot.startedAt);
    return Number.isFinite(age) && age < DISPATCH_GRACE_MS;
  }

  /**
   * Release every claim this backend cannot back with its own process.
   *
   * Only a process this host started may keep a slot: another host's pid is
   * never probed, and nothing is killed here.
   */
  async function reconcile(): Promise<void> {
    const state = await ledger.state();
    for (const slot of state.slots) {
      if (await slotAlive(slot)) continue;
      await ledger.abandon(slot.requestId);
    }
    for (const entry of state.queue) {
      if (entry.state !== "starting") continue;
      if (state.slots.some((slot) => slot.requestId === entry.requestId)) continue;
      // A dispatch interrupted before a process existed: the demand is gone,
      // and starting it again could run the same request twice.
      await ledger.abandon(entry.requestId);
    }
  }

  async function dispatch(): Promise<void> {
    if (dispatching) {
      repeat = true;
      return dispatching;
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
            await ledger.failStart(next.requestId);
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

  /** Settings, running claims and waiting demands as the page and the tool read them. */
  async function describe(): Promise<MainCapacityView> {
    await reconcile();
    const state = await ledger.state();
    const usage = await projectUsage();
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
      queued: state.queue.map((entry, index) => ({
        requestId: entry.requestId,
        projectId: entry.projectId,
        ...(names.has(entry.projectId) ? { projectName: names.get(entry.projectId)! } : {}),
        sessionId: entry.sessionId,
        taskId: entry.taskId,
        kind: entry.kind,
        ...(entry.requirementId ? { requirementId: entry.requirementId } : {}),
        position: index + 1,
        origin: entry.origin,
        enqueuedAt: entry.enqueuedAt
      })),
      projects: usage
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
      const state = await ledger.state();
      if (current) assertReductionAllowed(next, state, await projectUsage());
      await ports.persistSettings(next);
    }
    return describe();
  }

  return {
    describe,
    configure,
    settings: () => ports.settings(),

    enabled: () => Boolean(ports.settings()),

    sessionUsage(projectId: string): Promise<MainCapacityProjectUsage | undefined> {
      return projectUsage().then((usage) => usage.find((project) => project.projectId === projectId));
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
      if (!stopping) await dispatch();
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
      await reconcile();
      await refreshExternalSessions();
      await dispatch();
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
