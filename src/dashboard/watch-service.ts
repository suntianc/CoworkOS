import { WatchManagement, WATCH_TEMPLATES, type WatchCreation } from "../runtime/watch-management.js";
import { WatchSupervisor, type WatchSupervisorOptions } from "../runtime/watch-supervisor.js";
import { MainSupervisor, SUPERVISOR_WAKE_TURN } from "../runtime/main-supervisor.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { now } from "../domain/types.js";

/** One host-owned scheduler covers every known workspace and uses the Dashboard's Main launcher. */
export function createWatchService(ports: {
  harnessRoot: string;
  workspaceRoot: () => string;
  knownWorkspaceRoots: () => Promise<string[]>;
  locateTask: (taskId: string) => Promise<{ workspaceRoot: string; task: { activeRunId?: string } }>;
  runtimeValue: (name: "COWORK_API_BASE" | "COWORK_API_KEY" | "COWORK_MODEL") => string | undefined;
  runtimeOptions?: () => Pick<
    WatchSupervisorOptions,
    | "thinkingLevel"
    | "supportsReasoningEffort"
    | "supportsPromptCacheKey"
    | "runtimeEnv"
    | "commandEnv"
    | "api"
    | "thinkingFormat"
    | "contextWindow"
    | "supportsImages"
    | "visionModel"
    | "web"
  >;
  cancelTask: (taskId: string) => Promise<unknown>;
  startMainRun: (taskId: string, prompt: string, runId?: string, resume?: boolean) => Promise<unknown>;
}) {
  const disabled = process.env.COWORK_DISABLE_WATCH_SUPERVISOR === "1";
  const intervalMs = Math.max(1000, Number(process.env.COWORK_SUPERVISOR_INTERVAL_MS) || 60_000);
  const health: { status: string; intervalMs: number; lastCycleAt?: string; error?: string } = {
    status: disabled ? "disabled" : "starting",
    intervalMs
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let pending: Promise<void> | undefined;
  const tasks = new Map<string, Promise<void>>();
  const controller = new AbortController();
  const management = (root: string) => new WatchManagement(root, ports.harnessRoot);
  async function cycle() {
    if (disabled || stopped) return;
    for (const root of await ports.knownWorkspaceRoots()) {
      if (stopped) break;
      const supervisor = new WatchSupervisor({
        ...ports.runtimeOptions?.(),
        workspaceRoot: root,
        baseUrl: ports.runtimeValue("COWORK_API_BASE") ?? "",
        apiKey: ports.runtimeValue("COWORK_API_KEY") ?? "",
        model: ports.runtimeValue("COWORK_MODEL"),
        signal: controller.signal
      });
      const main = new MainSupervisor({
        workspaceRoot: root,
        launch: async ({ taskId, runId }) => {
          await ports.startMainRun(taskId, SUPERVISOR_WAKE_TURN, runId, true);
        }
      });
      for (const task of await new LocalWorkspaceStore(root).listTasks()) {
        if (["completed", "cancelled", "failed"].includes(task.status)) continue;
        // Model work cannot hold up this Task's cheap source checks, timed
        // wakes, or direct events. Analysis remains serial within each Task.
        for (const phase of ["poll", "analyze"] as const) {
          const key = `${root}\0${task.taskId}\0${phase}`;
          if (tasks.has(key)) continue;
          const job = (async () => {
            if (
              phase === "poll" &&
              ports.runtimeValue("COWORK_API_KEY") &&
              ports.runtimeValue("COWORK_API_BASE")
            )
              await main.runCycle({ taskId: task.taskId });
            await supervisor.runCycle({ taskId: task.taskId, phase });
            if (!stopped && ports.runtimeValue("COWORK_API_KEY") && ports.runtimeValue("COWORK_API_BASE"))
              await main.runCycle({ taskId: task.taskId });
          })()
            .catch((error) => {
              health.status = "failed";
              health.error = error instanceof Error ? error.message : String(error);
            })
            .finally(() => tasks.delete(key));
          tasks.set(key, job);
        }
      }
    }
    health.status = "running";
    health.lastCycleAt = now();
    health.error = undefined;
  }
  function tick() {
    if (pending || disabled || stopped) return;
    pending = cycle()
      .catch((error) => {
        health.status = "failed";
        health.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        pending = undefined;
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  }
  return {
    health: () => ({
      ...health,
      modelConfigured: Boolean(ports.runtimeValue("COWORK_API_BASE") && ports.runtimeValue("COWORK_API_KEY"))
    }),
    templates: () => [...WATCH_TEMPLATES],
    start: tick,
    async stop() {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
      health.status = "stopped";
      await pending;
      await Promise.allSettled([...tasks.values()]);
    },
    async list(taskId: string) {
      const location = await ports.locateTask(taskId);
      const owner = await new LocalWorkspaceStore(location.workspaceRoot).readTask(taskId);
      const detail = await management(location.workspaceRoot).list(taskId);
      return {
        ...detail,
        monitors: detail.monitors.map((monitor) => ({
          ...monitor,
          ownerTitle: owner.title ?? owner.goal ?? owner.taskId,
          taskStatus: owner.status,
          ownerError: Boolean(owner.lastError),
          ownerRecovery: owner.watchRecovery
        })),
        scheduler: this.health()
      };
    },
    async all() {
      const monitors = [];
      for (const root of await ports.knownWorkspaceRoots()) {
        for (const task of await new LocalWorkspaceStore(root).listTasks()) {
          if (task.kind === "workspace") continue;
          const list = await management(root).list(task.taskId);
          monitors.push(
            ...list.monitors.map((monitor) => ({
              ...monitor,
              ownerTitle: task.title ?? task.goal ?? task.taskId,
              taskStatus: task.status,
              ownerError: Boolean(task.lastError),
              ownerRecovery: task.watchRecovery
            }))
          );
        }
      }
      return { monitors, scheduler: this.health(), templates: [...WATCH_TEMPLATES] };
    },
    async createStandalone(input: WatchCreation) {
      return management(ports.workspaceRoot()).create(
        "",
        undefined,
        { ...input, scope: "background" },
        "user"
      );
    },
    async create(taskId: string, input: WatchCreation) {
      const location = await ports.locateTask(taskId);
      return management(location.workspaceRoot).create(taskId, location.task.activeRunId, input, "user");
    },
    async control(taskId: string, monitorId: string, action: string, value: Record<string, unknown>) {
      const location = await ports.locateTask(taskId);
      if (action === "retire") {
        const owner = await new LocalWorkspaceStore(location.workspaceRoot).readTask(taskId);
        const existing = await management(location.workspaceRoot).list(taskId);
        if (
          owner.monitoring?.scope === "background" &&
          existing.monitors.some((monitor) => monitor.monitorId === monitorId) &&
          existing.monitors.every(
            (monitor) => monitor.monitorId === monitorId || monitor.status === "retired"
          )
        )
          await ports.cancelTask(taskId);
      }
      return management(location.workspaceRoot).control(taskId, monitorId, action, value);
    },
    async events(taskId: string, monitorId: string) {
      const location = await ports.locateTask(taskId);
      return management(location.workspaceRoot).events(taskId, monitorId);
    }
  };
}
