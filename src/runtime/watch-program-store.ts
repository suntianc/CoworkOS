import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../storage/file-lock.js";
import { now } from "../domain/types.js";
import type { NotificationPolicy } from "../domain/watch.js";
import {
  BUILTIN_WATCH_PROFILES,
  initialVirtualAgentState,
  newVirtualAgent,
  newWatchProgram,
  type MonitorStatus,
  type VirtualAgentSpec,
  type VirtualAgentState,
  type WatchProfile,
  type WatchProgram,
  type WatchProgramStatus,
  type WakePolicy
} from "../domain/watch.js";

export interface CreateWatchProgramInput {
  taskId: string;
  subject: string;
  objective: string;
  notificationPolicy?: NotificationPolicy;
  programId?: string;
  watchRunId?: string;
  scope?: "session" | "background";
  sourceTaskId?: string;
}

export interface CreateVirtualAgentInput {
  programId: string;
  task: string;
  profileId?: string;
  cadenceSeconds?: number;
  wake?: WakePolicy;
  sourcesHint?: string[];
  activate?: boolean;
  templateId?: string;
  config?: Record<string, unknown>;
  eventMode?: "analyze" | "direct";
  maxModelRunsPerDay?: number;
  maxWakeRequestsPerDay?: number;
  expiresAt?: string;
}

export interface VirtualAgentControlMessage {
  messageId: string;
  monitorId: string;
  message: string;
  priority: number;
  createdAt: string;
}

/**
 * Durable product projection for long-running monitoring.
 *
 * The store is intentionally model-agnostic: it only persists the small
 * control-plane objects. Adapters and model runs can evolve independently.
 */
export class WatchProgramStore {
  constructor(private readonly workspaceRoot: string) {}

  async createProgram(input: CreateWatchProgramInput): Promise<WatchProgram> {
    const program = newWatchProgram(input);
    if (input.programId) program.programId = safe(input.programId);
    const directory = this.programDirectory(input.taskId, program.programId);
    await this.ensureLayout(input.taskId, program.programId);
    try {
      await writeFile(join(directory, "program.json"), json(program), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return this.readProgram(input.taskId, program.programId);
    }
    await this.appendEvent(input.taskId, program.programId, "watch.program_created", {
      subject: input.subject
    });
    return program;
  }

  async readProgram(taskId: string, programId: string): Promise<WatchProgram> {
    return this.readJson(join(this.programDirectory(taskId, programId), "program.json"));
  }

  async listPrograms(taskId: string): Promise<WatchProgram[]> {
    const directory = join(this.workspaceRoot, safe(taskId), "watch", "programs");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const programs: WatchProgram[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9._-]+$/.test(entry.name)) continue;
      try {
        programs.push(await this.readProgram(taskId, entry.name));
        // eslint-disable-next-line no-restricted-syntax -- 未完成的草稿目录里没有可解析的 program.json，跳过它，其余监控目标照常列出
      } catch {
        /* incomplete draft */
      }
    }
    return programs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async updateProgram(
    taskId: string,
    programId: string,
    patch:
      | Partial<
          Pick<
            WatchProgram,
            "status" | "subject" | "objective" | "notificationPolicy" | "baselineArtifactId" | "goal"
          >
        >
      | ((
          current: WatchProgram
        ) => Partial<
          Pick<
            WatchProgram,
            "status" | "subject" | "objective" | "notificationPolicy" | "baselineArtifactId" | "goal"
          >
        >)
  ): Promise<WatchProgram> {
    const path = join(this.programDirectory(taskId, programId), "program.json");
    return withFileLock(path, async () => {
      const current = await this.readProgram(taskId, programId);
      const changes = typeof patch === "function" ? patch(current) : patch;
      const next: WatchProgram = { ...current, ...changes, revision: current.revision + 1, updatedAt: now() };
      await atomicWrite(path, json(next));
      await this.appendEvent(taskId, programId, "watch.program_updated", {
        fields: Object.keys(changes),
        revision: next.revision
      });
      return next;
    });
  }

  async createVirtualAgent(input: CreateVirtualAgentInput): Promise<VirtualAgentSpec> {
    const program = await this.readProgramById(input.programId);
    if (input.profileId && !this.profile(input.profileId))
      throw new Error(`unknown watch profile: ${input.profileId}`);
    const spec = {
      ...newVirtualAgent(input),
      templateId: input.templateId,
      config: input.config,
      eventMode: input.eventMode ?? "analyze",
      maxModelRunsPerDay: input.maxModelRunsPerDay ?? 24,
      maxWakeRequestsPerDay: input.maxWakeRequestsPerDay ?? 24,
      expiresAt: input.expiresAt
    };
    spec.status = input.activate ? "active" : "draft";
    await this.ensureLayout(program.taskId, program.programId);
    await this.ensureMonitorWorkspace(program.taskId, spec.monitorId);
    const specPath = join(
      this.programDirectory(program.taskId, program.programId),
      "monitors",
      `${spec.monitorId}.json`
    );
    await atomicWrite(specPath, json(spec), true);
    const state = initialVirtualAgentState(spec.monitorId);
    state.status = spec.status;
    await atomicWrite(
      join(
        this.programDirectory(program.taskId, program.programId),
        "monitor-state",
        `${spec.monitorId}.json`
      ),
      json(state),
      true
    );
    await this.addMonitorId(program.taskId, program.programId, spec.monitorId);
    await this.appendEvent(program.taskId, program.programId, "watch.monitor_created", {
      monitorId: spec.monitorId,
      profileId: spec.profileId,
      status: spec.status
    });
    return spec;
  }

  async readVirtualAgent(taskId: string, programId: string, monitorId: string): Promise<VirtualAgentSpec> {
    return this.readJson(
      join(this.programDirectory(taskId, programId), "monitors", `${safe(monitorId)}.json`)
    );
  }

  async findVirtualAgent(
    taskId: string,
    monitorId: string
  ): Promise<{ program: WatchProgram; monitor: VirtualAgentSpec } | undefined> {
    for (const program of await this.listPrograms(taskId)) {
      if (!program.monitorIds.includes(monitorId)) continue;
      for (const monitor of await this.listVirtualAgents(taskId, program.programId)) {
        if (monitor.monitorId === monitorId) return { program, monitor };
      }
    }
    return undefined;
  }

  async updateVirtualAgent(
    taskId: string,
    programId: string,
    monitorId: string,
    patch: Partial<
      Pick<
        VirtualAgentSpec,
        | "task"
        | "profileId"
        | "cadenceSeconds"
        | "wake"
        | "sourcesHint"
        | "status"
        | "config"
        | "maxModelRunsPerDay"
        | "maxWakeRequestsPerDay"
        | "expiresAt"
      >
    >
  ): Promise<VirtualAgentSpec> {
    const path = join(this.programDirectory(taskId, programId), "monitors", `${safe(monitorId)}.json`);
    return withFileLock(path, async () => {
      const current = await this.readJson<VirtualAgentSpec>(path);
      const next: VirtualAgentSpec = { ...current, ...patch, version: current.version + 1, updatedAt: now() };
      await atomicWrite(path, json(next));
      if (patch.status)
        await this.updateVirtualAgentState(taskId, programId, monitorId, { status: patch.status });
      await this.appendEvent(taskId, programId, "watch.monitor_updated", {
        monitorId,
        fields: Object.keys(patch),
        version: next.version
      });
      return next;
    });
  }

  async enqueueControl(
    taskId: string,
    monitorId: string,
    message: string,
    priority = 1
  ): Promise<VirtualAgentControlMessage> {
    const found = await this.findVirtualAgent(taskId, monitorId);
    if (!found) throw new Error(`unknown virtual agent: ${monitorId}`);
    const control: VirtualAgentControlMessage = {
      messageId: `control-${monitorId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      monitorId,
      message,
      priority,
      createdAt: now()
    };
    const path = this.controlPath(taskId, found.program.programId, monitorId);
    return withFileLock(path, async () => {
      const controls = await this.readControls(path);
      controls.push(control);
      await atomicWrite(path, json(controls), true);
      return control;
    });
  }

  async listControls(
    taskId: string,
    programId: string,
    monitorId: string
  ): Promise<VirtualAgentControlMessage[]> {
    return this.readControls(this.controlPath(taskId, programId, monitorId));
  }

  async consumeControls(
    taskId: string,
    programId: string,
    monitorId: string,
    messageIds: string[]
  ): Promise<void> {
    if (messageIds.length === 0) return;
    const path = this.controlPath(taskId, programId, monitorId);
    await withFileLock(path, async () => {
      const consumed = new Set(messageIds);
      const remaining = (await this.readControls(path)).filter((message) => !consumed.has(message.messageId));
      await atomicWrite(path, json(remaining), true);
    });
  }

  async listVirtualAgents(taskId: string, programId: string): Promise<VirtualAgentSpec[]> {
    const directory = join(this.programDirectory(taskId, programId), "monitors");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const result: VirtualAgentSpec[] = [];
    for (const entry of entries)
      if (entry.isFile() && entry.name.endsWith(".json"))
        result.push(await this.readJson(join(directory, entry.name)));
    return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async readVirtualAgentState(
    taskId: string,
    programId: string,
    monitorId: string
  ): Promise<VirtualAgentState> {
    const path = join(this.programDirectory(taskId, programId), "monitor-state", `${safe(monitorId)}.json`);
    try {
      return await this.readJson(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return initialVirtualAgentState(monitorId);
    }
  }

  async updateVirtualAgentState(
    taskId: string,
    programId: string,
    monitorId: string,
    patch:
      | Partial<Omit<VirtualAgentState, "monitorId" | "updatedAt">>
      | ((current: VirtualAgentState) => Partial<Omit<VirtualAgentState, "monitorId" | "updatedAt">>)
  ): Promise<VirtualAgentState> {
    const path = join(this.programDirectory(taskId, programId), "monitor-state", `${safe(monitorId)}.json`);
    return withFileLock(path, async () => {
      const current = await this.readVirtualAgentState(taskId, programId, monitorId);
      const next: VirtualAgentState = {
        ...current,
        ...(typeof patch === "function" ? patch(current) : patch),
        monitorId,
        updatedAt: now()
      };
      await atomicWrite(path, json(next), true);
      return next;
    });
  }

  listProfiles(): WatchProfile[] {
    return BUILTIN_WATCH_PROFILES.map((profile) => ({ ...profile, sourceKinds: [...profile.sourceKinds] }));
  }
  profile(profileId: string): WatchProfile | undefined {
    return BUILTIN_WATCH_PROFILES.find((profile) => profile.profileId === profileId);
  }

  private async readProgramById(programId: string): Promise<WatchProgram> {
    // Program IDs are globally unique, so scan task directories only at the
    // control-plane boundary. Callers normally already know taskId.
    const entries = await readdir(this.workspaceRoot, { withFileTypes: true });
    for (const entry of entries)
      if (entry.isDirectory()) {
        try {
          return await this.readProgram(entry.name, programId);
          // eslint-disable-next-line no-restricted-syntax -- 这个 task 目录里没有该 program 是命中失败的一部分，继续扫描下一个目录
        } catch {
          /* not this task */
        }
      }
    throw new Error(`unknown watch program: ${programId}`);
  }

  private async addMonitorId(taskId: string, programId: string, monitorId: string): Promise<void> {
    const path = join(this.programDirectory(taskId, programId), "program.json");
    await withFileLock(path, async () => {
      const current = await this.readProgram(taskId, programId);
      if (current.monitorIds.includes(monitorId)) return;
      await atomicWrite(
        path,
        json({
          ...current,
          status:
            current.goal || ["paused", "completed"].includes(current.status) ? current.status : "monitoring",
          monitorIds: [...current.monitorIds, monitorId],
          revision: current.revision + 1,
          updatedAt: now()
        })
      );
    });
  }

  private async ensureLayout(taskId: string, programId: string): Promise<void> {
    const root = this.programDirectory(taskId, programId);
    await mkdir(join(root, "monitors"), { recursive: true });
    await mkdir(join(root, "monitor-state"), { recursive: true });
    await mkdir(join(root, "runs"), { recursive: true });
    await mkdir(join(root, "events"), { recursive: true });
    try {
      await writeFile(join(root, "events", "events.jsonl"), "", { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  private async ensureMonitorWorkspace(taskId: string, monitorId: string): Promise<void> {
    const root = join(this.workspaceRoot, safe(taskId), "agents", "subagents", safe(monitorId));
    await mkdir(join(root, "watcher", "versions"), { recursive: true });
    await mkdir(join(root, "runs"), { recursive: true });
    try {
      await writeFile(
        join(root, "watcher", "README.md"),
        "# Virtual Agent watcher\n\nThe persistent Subagent owns this directory. The executable rule is watcher/rule.mjs and must export default async function check(context).\n",
        { flag: "wx" }
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  private controlPath(taskId: string, programId: string, monitorId: string): string {
    return join(this.programDirectory(taskId, programId), "controls", `${safe(monitorId)}.json`);
  }

  private async readControls(path: string): Promise<VirtualAgentControlMessage[]> {
    try {
      return await this.readJson<VirtualAgentControlMessage[]>(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async appendEvent(
    taskId: string,
    programId: string,
    type: string,
    payload: unknown
  ): Promise<void> {
    await appendFile(
      join(this.programDirectory(taskId, programId), "events", "events.jsonl"),
      `${JSON.stringify({ type, taskId, programId, payload, occurredAt: now() })}\n`,
      "utf8"
    );
  }

  private async readJson<T>(path: string): Promise<T> {
    return JSON.parse(await readFile(path, "utf8")) as T;
  }
  private programDirectory(taskId: string, programId: string): string {
    return join(this.workspaceRoot, safe(taskId), "watch", "programs", safe(programId));
  }
}

function safe(value: string): string {
  if ([".", ".."].includes(value) || !/^[a-zA-Z0-9._-]+$/.test(value))
    throw new Error(`unsafe watch segment: ${value}`);
  return value;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function atomicWrite(path: string, content: string, createParent = false): Promise<void> {
  if (createParent) await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}
