import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, readFile, realpath, writeFile, open } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { id, now } from "../domain/types.js";
import type { WakePolicy } from "../domain/watch.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { GoalStore } from "./goal-store.js";
import { WatchProgramStore } from "./watch-program-store.js";
import { ScriptWatcher } from "./script-watcher.js";
import { readSleep, writeSleep } from "./main-sleep.js";
import { withFileLock } from "../storage/file-lock.js";
import { backgroundMonitoringPaused, monitoringPrograms } from "./monitoring-control.js";
import { requireCollectorOwnership } from "./goal-delegation.js";

export const WATCH_TEMPLATES = [
  "job-lifecycle",
  "metric-threshold",
  "resource-version",
  "feed-keyword",
  "entity-state",
  "timer"
] as const;
export interface WatchCreation {
  task: string;
  template: (typeof WATCH_TEMPLATES)[number];
  source?: string;
  config?: Record<string, unknown>;
  cadenceSeconds: number;
  scope?: "session" | "background";
  wake?: WakePolicy;
  eventMode?: "analyze" | "direct";
  maxModelRunsPerDay?: number;
  maxWakeRequestsPerDay?: number;
  expiresAt?: string;
  programId?: string;
}
export class WatchManagement {
  readonly store: WatchProgramStore;
  constructor(
    readonly workspaceRoot: string,
    readonly harnessRoot: string
  ) {
    this.store = new WatchProgramStore(workspaceRoot);
  }

  private async requireRegistrationAllowed(taskId: string, programId?: string, excludeProgramId?: string) {
    if (!taskId) return;
    const workspace = new LocalWorkspaceStore(this.workspaceRoot);
    const task = await workspace.readTask(taskId);
    const programs = (await monitoringPrograms(this.workspaceRoot, taskId)).filter(
      (program) => program.programId !== excludeProgramId
    );
    const parent = programId ? programs.find((program) => program.programId === programId) : undefined;
    if (programId && !parent) throw new Error("unknown watch program");
    if (parent && ["paused", "completed"].includes(parent.status))
      throw new Error("目标已暂停或结束，请由用户显式恢复后再登记采集器");
    if (task.monitoring?.scope === "background" && backgroundMonitoringPaused(programs))
      throw new Error("后台目标已暂停，请由用户显式恢复；不能新建采集器绕过暂停");
  }

  async create(
    taskId: string,
    mainRunId: string | undefined,
    input: WatchCreation,
    actor: "model" | "user" = "model"
  ) {
    if (actor === "model")
      await requireCollectorOwnership(this.workspaceRoot, taskId, mainRunId, input.programId);
    const identity = createHash("sha256")
      .update(JSON.stringify([taskId, canonical(input)]))
      .digest("hex");
    return withFileLock(join(this.workspaceRoot, `.watch-create-${identity}`), async () => {
      await this.requireRegistrationAllowed(taskId, input.programId);
      const workspace = new LocalWorkspaceStore(this.workspaceRoot);
      if (input.programId) {
        const parent = await this.store.readProgram(taskId, input.programId);
        if (["paused", "completed"].includes(parent.status))
          throw new Error("目标已暂停或结束，请先恢复目标");
      }
      const taskIds =
        input.scope === "background" ? (await workspace.listTasks()).map((task) => task.taskId) : [taskId];
      for (const owner of taskIds) {
        for (const program of await this.store.listPrograms(owner)) {
          for (const monitor of await this.store.listVirtualAgents(owner, program.programId)) {
            if (monitor.config?.creationIdentity === identity && monitor.status === "paused")
              throw new Error("采集器已暂停，请显式恢复原实例，不能重复创建");
            if (
              monitor.config?.creationIdentity === identity &&
              monitor.status === "active" &&
              !["completed", "cancelled", "failed"].includes((await workspace.readTask(owner)).status)
            ) {
              await this.requireRegistrationAllowed(owner, program.programId);
              return {
                activated: true,
                taskId: owner,
                scope: program.scope ?? "session",
                programId: program.programId,
                monitorId: monitor.monitorId,
                cadenceSeconds: monitor.cadenceSeconds,
                alreadyActive: true
              };
            }
          }
        }
      }
      return this.createNew(taskId, mainRunId, input, identity, actor);
    });
  }

  private async createNew(
    taskId: string,
    mainRunId: string | undefined,
    input: WatchCreation,
    identity: string,
    actor: "model" | "user"
  ) {
    if (!WATCH_TEMPLATES.includes(input.template)) throw new Error("unknown watcher template");
    validateSettings(input);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 创建参数来自工具入参，模型可能整个省略 task，缺失时必须先给出中文校验错误而不是 TypeError
    if (!input.task?.trim() || input.task.length > 4000) throw new Error("监控目标不能为空，最多 4000 字符");
    if (input.scope && !["session", "background"].includes(input.scope))
      throw new Error("invalid monitor scope");
    const config = input.config ?? {};
    if (
      Array.isArray(config) ||
      typeof config !== "object" ||
      Buffer.byteLength(JSON.stringify(config)) > 8192
    )
      throw new Error("invalid watcher config");
    if (input.template !== "timer" && (!input.source || input.source.length > 512))
      throw new Error("请填写监控来源");
    if (input.template === "feed-keyword" || input.template === "entity-state") {
      const url = new URL(input.source!);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error("来源需为不含凭据的 HTTP 地址");
    }
    const workspace = new LocalWorkspaceStore(this.workspaceRoot);
    const sourceTask = taskId ? await workspace.readTask(taskId) : undefined;
    const parent = input.programId ? await this.store.readProgram(taskId, input.programId) : undefined;
    if (parent && ["paused", "completed"].includes(parent.status))
      throw new Error("目标已暂停或结束，请先恢复目标");
    if (parent && ["completed", "cancelled", "failed"].includes(sourceTask?.status ?? ""))
      throw new Error("会话已结束，请先重新打开会话");
    if (
      input.scope !== "background" &&
      ["completed", "cancelled", "failed"].includes(sourceTask?.status ?? "created")
    )
      throw new Error("请在进行中的会话创建监控，或选择独立后台监控");
    const scope = parent?.scope ?? input.scope ?? "session";
    let owner = parent ? taskId : scope === "background" ? `monitor-task_${identity.slice(0, 24)}` : taskId;
    if (scope === "background" && !parent) {
      // eslint-disable-next-line no-restricted-syntax -- 后台监控会话可能尚未创建，readTask 因目录不存在失败就是“没有既有会话”
      const existing = await workspace.readTask(owner).catch(() => undefined);
      if (existing && ["completed", "cancelled", "failed"].includes(existing.status))
        owner = id("monitor-task");
    }
    const runId = parent
      ? (sourceTask?.activeRunId ?? parent.watchRunId ?? `main-${owner}`)
      : scope === "background"
        ? `main-${owner}`
        : (mainRunId ?? `main-${taskId}`);
    if (scope === "session" && !mainRunId && !parent) {
      await workspace.createRun(owner, runId);
      await workspace.transitionTask(owner, "waiting", { runId, reason: "monitor_created" });
    }
    if (scope === "background" && !parent) {
      await workspace.createTask(owner, {
        goal: `长期监控：${input.task}`,
        completion: { policy: "explicit" }
      });
      await workspace.updateTask(owner, {
        title: input.task.slice(0, 80),
        monitoring: { scope, sourceTaskId: taskId || undefined }
      });
      await workspace.createRun(owner, runId);
      await workspace.transitionTask(owner, "waiting", { runId, reason: "background_monitor_created" });
      await writeFile(
        join(this.workspaceRoot, owner, "agents", "main", "context", "memory.md"),
        `# 持续监控目标\n${input.task}\n\n这是独立后台监控会话。处理 Inbox 中的新事件，按证据判断是否通知用户；目标仍持续且本轮处理完后，调用 sleep_until 等待监控事件。不要在没有变化时反复运行模型。\n`
      );
    }
    const path = join(
      "agents",
      "main",
      "work",
      "virtual-agents",
      `${input.template}-${identity.slice(0, 24)}`
    );
    const directory = join(this.workspaceRoot, owner, path);
    await cp(
      join(this.harnessRoot, ".pi", "skills", "virtual-agent-authoring", "templates", input.template),
      directory,
      { recursive: true }
    );
    const rulePath = join(directory, "watcher", "rule.mjs");
    const source = await readFile(rulePath, "utf8");
    await writeFile(
      rulePath,
      source.replace(
        "export default createWatcher(CONFIG);",
        `export default createWatcher(${JSON.stringify(config)});`
      )
    );
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    manifest.sources = [input.template === "timer" ? "clock" : input.source];
    manifest.events.wake = input.wake ?? "important";
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
    const result = await this.activate(
      owner,
      runId,
      {
        path,
        programId: parent?.programId,
        task: input.task,
        cadenceSeconds: input.cadenceSeconds,
        scope,
        sourceTaskId: parent?.sourceTaskId ?? (taskId || undefined),
        templateId: input.template,
        config: { ...config, creationIdentity: identity },
        eventMode:
          input.eventMode ??
          (["timer", "metric-threshold", "job-lifecycle", "resource-version"].includes(input.template)
            ? "direct"
            : "analyze"),
        maxModelRunsPerDay: input.maxModelRunsPerDay,
        maxWakeRequestsPerDay: input.maxWakeRequestsPerDay,
        expiresAt: input.expiresAt
      },
      actor
    );
    if (!parent && result.activated && "monitorId" in result && (scope === "background" || !mainRunId)) {
      await writeSleep(this.workspaceRoot, owner, {
        runId,
        reason: input.task,
        monitorIds: [result.monitorId],
        parkedAt: now()
      });
    }
    return { ...result, taskId: owner, scope };
  }

  async activate(
    taskId: string,
    mainRunId: string | undefined,
    input: {
      path: string;
      task: string;
      cadenceSeconds: number;
      programId?: string;
      objective?: string;
      scope?: "session" | "background";
      sourceTaskId?: string;
      templateId?: string;
      config?: Record<string, unknown>;
      eventMode?: "direct" | "analyze";
      maxModelRunsPerDay?: number;
      maxWakeRequestsPerDay?: number;
      expiresAt?: string;
    },
    actor: "model" | "user" = "model"
  ) {
    if (actor === "model")
      await requireCollectorOwnership(this.workspaceRoot, taskId, mainRunId, input.programId);
    validateSettings(input);
    await this.requireRegistrationAllowed(taskId, input.programId);
    const taskRoot = await realpath(join(this.workspaceRoot, taskId));
    const requestedDirectory = resolve(taskRoot, input.path);
    if (!requestedDirectory.startsWith(`${taskRoot}${sep}`))
      throw new Error("package path escapes the Task workspace");
    const directory = await realpath(requestedDirectory);
    if (!directory.startsWith(`${taskRoot}${sep}`))
      throw new Error("package path escapes the Task workspace");
    const validator = join(
      this.harnessRoot,
      ".pi",
      "skills",
      "virtual-agent-authoring",
      "scripts",
      "validate_package.mjs"
    );
    const validated = await new Promise<{ ok: boolean; output: string }>((settle) => {
      execFile(
        process.execPath,
        [validator, directory],
        { encoding: "utf8", timeout: 10_000 },
        (error, stdout, stderr) =>
          settle({ ok: !error, output: (stderr || stdout || error?.message || "").trim() })
      );
    });
    if (!validated.ok) return { activated: false, reason: "invalid_package", errors: validated.output };
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    // Retry of the same accepted package resolves to the existing instance.
    return withFileLock(join(taskRoot, ".watch-activation"), async () => {
      const programs = await this.store.listPrograms(taskId);
      let draft: Awaited<ReturnType<WatchProgramStore["findVirtualAgent"]>>;
      for (const program of programs) {
        for (const monitor of await this.store.listVirtualAgents(taskId, program.programId)) {
          if (monitor.config?.packagePath === input.path && monitor.status === "paused")
            throw new Error("采集器已暂停，请显式恢复原实例，不能重新激活包绕过暂停");
          if (monitor.config?.packagePath === input.path && monitor.status === "draft")
            draft = { program, monitor };
          if (monitor.config?.packagePath === input.path && monitor.status === "active") {
            await this.requireRegistrationAllowed(taskId, program.programId);
            return {
              activated: true,
              programId: program.programId,
              monitorId: monitor.monitorId,
              cadenceSeconds: monitor.cadenceSeconds,
              package: { name: manifest.name, version: manifest.version },
              alreadyActive: true
            };
          }
        }
      }
      const program =
        draft?.program ??
        (input.programId
          ? await this.store.readProgram(taskId, input.programId)
          : await this.store.createProgram({
              taskId,
              subject: manifest.name,
              watchRunId: mainRunId,
              objective: input.objective ?? input.task,
              scope: input.scope,
              sourceTaskId: input.sourceTaskId
            }));
      const monitor =
        draft?.monitor ??
        (await this.store.createVirtualAgent({
          programId: program.programId,
          task: input.task,
          profileId: "custom",
          cadenceSeconds: input.cadenceSeconds,
          wake: manifest.events?.wake ?? "important",
          sourcesHint: manifest.sources,
          activate: false,
          templateId: input.templateId,
          config: { ...input.config, packagePath: input.path },
          eventMode: input.eventMode,
          maxModelRunsPerDay: input.maxModelRunsPerDay,
          maxWakeRequestsPerDay: input.maxWakeRequestsPerDay,
          expiresAt: input.expiresAt
        }));
      const monitorDirectory = join(taskRoot, "agents", "subagents", monitor.monitorId);
      await mkdir(join(monitorDirectory, "watcher"), { recursive: true });
      await copyFile(join(directory, manifest.entrypoint), join(monitorDirectory, "watcher", "rule.mjs"));
      await copyFile(join(directory, manifest.handler), join(monitorDirectory, "watcher", "AGENT.md"));
      const probe = new ScriptWatcher({
        watcherId: monitor.monitorId,
        monitor,
        workDirectory: monitorDirectory
      });
      try {
        const events = await probe.poll();
        const accept = async () => {
          await this.store.updateVirtualAgent(taskId, program.programId, monitor.monitorId, {
            status: "active"
          });
          await this.store.updateVirtualAgentState(taskId, program.programId, monitor.monitorId, {
            status: "active",
            lastCheckedAt: now(),
            nextCheckAt: new Date(Date.now() + input.cadenceSeconds * 1000).toISOString()
          });
        };
        // Every program, including legacy monitors, shares this short acceptance
        // lock with pause/resume. Never hold it over a source fetch or a model run.
        await new GoalStore(this.workspaceRoot).withGoal(taskId, program.programId, async (current) => {
          if (["paused", "completed"].includes(current.status))
            throw new Error("目标已暂停或结束，来源保持未启用");
          await this.requireRegistrationAllowed(
            taskId,
            input.programId,
            input.programId ? undefined : program.programId
          );
          if (input.sourceTaskId && input.sourceTaskId !== taskId)
            await this.requireRegistrationAllowed(input.sourceTaskId);
          const latest = await this.store.readVirtualAgent(taskId, program.programId, monitor.monitorId);
          if (["paused", "retired"].includes(latest.status))
            throw new Error("采集器已暂停或结束，来源保持未启用");
          await accept();
        });
        return {
          activated: true,
          programId: program.programId,
          monitorId: monitor.monitorId,
          wake: monitor.wake,
          cadenceSeconds: monitor.cadenceSeconds,
          sources: manifest.sources,
          probe: { events: events.length },
          package: { name: manifest.name, version: manifest.version }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const latest = await this.store.readVirtualAgent(taskId, program.programId, monitor.monitorId);
        await this.store.updateVirtualAgentState(taskId, program.programId, monitor.monitorId, {
          status: ["paused", "retired"].includes(latest.status) ? latest.status : "draft",
          lastSummary: message
        });
        return {
          activated: false,
          reason: "probe_failed",
          programId: program.programId,
          monitorId: monitor.monitorId,
          error: message
        };
      }
    });
  }

  async list(taskId: string) {
    const programs = await this.store.listPrograms(taskId);
    const monitors = [];
    for (const program of programs) {
      for (const monitor of await this.store.listVirtualAgents(taskId, program.programId)) {
        monitors.push({
          ...monitor,
          taskId,
          scope: program.scope ?? "session",
          sourceTaskId: program.sourceTaskId,
          programStatus: program.status,
          state: await this.store.readVirtualAgentState(taskId, program.programId, monitor.monitorId)
        });
      }
    }
    return {
      programs: programs.map((program) => ({
        programId: program.programId,
        status: program.status,
        managed: Boolean(program.goal)
      })),
      monitors,
      sleep: await readSleep(this.workspaceRoot, taskId)
    };
  }
  async control(taskId: string, monitorId: string, action: string, value: Record<string, unknown> = {}) {
    const found = await this.store.findVirtualAgent(taskId, monitorId);
    if (!found) throw new Error("unknown monitor");
    if (!["pause", "resume", "retire", "configure"].includes(action))
      throw new Error("invalid monitor action");
    const task = await new LocalWorkspaceStore(this.workspaceRoot).readTask(taskId);
    if (["completed", "cancelled", "failed"].includes(task.status) && action !== "retire")
      throw new Error("请先重新打开已结束的会话");
    // Pause/retire must not wait behind a network/model run holding the cycle lock.
    if (action === "pause" || action === "retire")
      return new GoalStore(this.workspaceRoot).withGoal(taskId, found.program.programId, async (program) => {
        const monitor = await this.store.updateVirtualAgent(taskId, program.programId, monitorId, {
          status: action === "pause" ? "paused" : "retired"
        });
        const monitors = await this.store.listVirtualAgents(taskId, program.programId);
        if (
          !program.goal &&
          program.status !== "completed" &&
          action === "pause" &&
          !monitors.some((entry) => entry.status === "active")
        )
          await this.store.updateProgram(taskId, program.programId, { status: "paused" });
        return monitor;
      });
    return withFileLock(join(this.workspaceRoot, taskId, `.watch-control-${monitorId}`), async () => {
      return new GoalStore(this.workspaceRoot).withGoal(taskId, found.program.programId, async (program) => {
        if (
          action === "resume" &&
          (program.status === "completed" || (program.goal && program.status === "paused"))
        )
          throw new Error("目标已暂停或结束，请先显式恢复目标");
        const current = await this.store.readVirtualAgent(taskId, found.program.programId, monitorId);
        if (action === "resume" && current.status === "draft")
          throw new Error("探针未通过，请修正规则后重新登记");
        if (action === "resume" && current.status === "retired")
          throw new Error("已结束的监控不能恢复，请新建监控");
        const patch: Parameters<WatchProgramStore["updateVirtualAgent"]>[3] = {};
        if (action === "configure") {
          const cadenceSeconds = value.cadenceSeconds ?? current.cadenceSeconds ?? 60;
          const maxModelRunsPerDay = value.maxModelRunsPerDay ?? current.maxModelRunsPerDay ?? 24;
          const expiresAt = value.expiresAt ?? current.expiresAt;
          validateSettings({ cadenceSeconds, maxModelRunsPerDay, expiresAt });
          patch.cadenceSeconds = cadenceSeconds as number;
          patch.maxModelRunsPerDay = maxModelRunsPerDay as number;
          if (value.maxWakeRequestsPerDay !== undefined) {
            if (
              !Number.isSafeInteger(value.maxWakeRequestsPerDay) ||
              Number(value.maxWakeRequestsPerDay) < 1 ||
              Number(value.maxWakeRequestsPerDay) > 1000
            )
              throw new Error("invalid wake budget");
            patch.maxWakeRequestsPerDay = value.maxWakeRequestsPerDay as number;
          }
          if (typeof expiresAt === "string") patch.expiresAt = expiresAt;
          if (value.task !== undefined) {
            if (typeof value.task !== "string" || !value.task.trim() || value.task.length > 4000)
              throw new Error("invalid monitor task");
            patch.task = value.task;
          }
        } else patch.status = action === "pause" ? "paused" : action === "retire" ? "retired" : "active";
        const monitor = await this.store.updateVirtualAgent(
          taskId,
          found.program.programId,
          monitorId,
          patch
        );
        if (action === "resume" && !program.goal && program.status === "paused")
          await this.store.updateProgram(taskId, program.programId, { status: "monitoring" });
        if (action === "resume" || action === "configure")
          await this.store.updateVirtualAgentState(taskId, found.program.programId, monitorId, {
            retryAt: undefined,
            pollRetryAt: undefined,
            analysisRetryAt: undefined,
            deliveryRetryAt: undefined,
            wakeRetryAt: undefined,
            nextCheckAt: new Date(Date.now() + (monitor.cadenceSeconds ?? 60) * 1000).toISOString()
          });
        return monitor;
      });
    });
  }
  async events(taskId: string, monitorId: string) {
    const found = await this.store.findVirtualAgent(taskId, monitorId);
    if (!found) throw new Error("unknown monitor");
    const path = join(
      this.workspaceRoot,
      taskId,
      "watch",
      "programs",
      found.program.programId,
      "events",
      "events.jsonl"
    );
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - 65_536);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString("utf8").split(/\r?\n/);
      if (start) lines.shift();
      return lines
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
            // eslint-disable-next-line no-restricted-syntax -- 事件流尾部可能有半行未写完的记录，跳过它，前面的完整行照常返回
          } catch {
            return [];
          }
        })
        .filter((event) => event.agentId === monitorId || event.payload?.monitorId === monitorId)
        .slice(-30);
    } finally {
      await handle.close();
    }
  }
}
function validateSettings(value: {
  cadenceSeconds?: unknown;
  maxModelRunsPerDay?: unknown;
  maxWakeRequestsPerDay?: unknown;
  expiresAt?: unknown;
  eventMode?: unknown;
  wake?: unknown;
}) {
  if (
    !Number.isSafeInteger(value.cadenceSeconds) ||
    Number(value.cadenceSeconds) < 60 ||
    Number(value.cadenceSeconds) > 2_592_000
  )
    throw new Error("检查间隔需为 60 秒到 30 天之间的整数");
  if (
    value.maxModelRunsPerDay !== undefined &&
    (!Number.isSafeInteger(value.maxModelRunsPerDay) ||
      Number(value.maxModelRunsPerDay) < 1 ||
      Number(value.maxModelRunsPerDay) > 1000)
  )
    throw new Error("模型日预算需为 1 到 1000 次");
  if (
    value.expiresAt !== undefined &&
    (typeof value.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= Date.now())
  )
    throw new Error("截止时间需为未来的有效时间");
  if (value.eventMode !== undefined && !["analyze", "direct"].includes(String(value.eventMode)))
    throw new Error("invalid event mode");
  if (value.wake !== undefined && !["important", "always", "never"].includes(String(value.wake)))
    throw new Error("invalid wake policy");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)])
    );
  return value;
}
