import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  newVirtualAgentEvent,
  newVirtualAgentProgram,
  type VirtualAgentEvent,
  type VirtualAgentKind,
  type VirtualAgentProgram,
  type VirtualAgentProgramStatus
} from "../domain/virtual-agent.js";
import { now } from "../domain/types.js";
import { withFileLock } from "../storage/file-lock.js";

/**
 * Generic durable projection shared by watchers, experiments and future
 * long-running workers. It records lifecycle and wake events only; Main owns
 * all semantic decisions.
 */
export class VirtualAgentStore {
  constructor(private readonly workspaceRoot: string) {}

  async createProgram(input: {
    taskId: string;
    kind: VirtualAgentKind;
    objective: string;
    sourceId?: string;
    wake?: VirtualAgentProgram["wake"];
    programId?: string;
  }): Promise<VirtualAgentProgram> {
    const program = newVirtualAgentProgram(input);
    const root = this.programDirectory(input.taskId, program.programId);
    await this.ensureLayout(root);
    const path = join(root, "program.json");
    try {
      await writeFile(path, json(program), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return this.readProgram(input.taskId, program.programId);
    }
    await this.appendEvent(input.taskId, program.programId, {
      type: "program.created",
      priority: 1,
      summary: program.objective
    });
    return program;
  }

  async readProgram(taskId: string, programId: string): Promise<VirtualAgentProgram> {
    return this.readJson(join(this.programDirectory(taskId, programId), "program.json"));
  }

  async listPrograms(taskId: string): Promise<VirtualAgentProgram[]> {
    const directory = join(this.workspaceRoot, safe(taskId), "virtual-agents");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const programs: VirtualAgentProgram[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9._-]+$/.test(entry.name)) continue;
      try {
        programs.push(await this.readProgram(taskId, entry.name));
        // eslint-disable-next-line no-restricted-syntax -- 目录里可能有写到一半或损坏的 program.json，跳过这条，其余目标照常列出
      } catch {
        /* ignore incomplete records */
      }
    }
    return programs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async registerAgent(taskId: string, programId: string, agentId: string): Promise<VirtualAgentProgram> {
    const path = join(this.programDirectory(taskId, programId), "program.json");
    return withFileLock(path, async () => {
      const current = await this.readProgram(taskId, programId);
      if (current.agentIds.includes(agentId)) return current;
      const next: VirtualAgentProgram = {
        ...current,
        agentIds: [...current.agentIds, agentId],
        revision: current.revision + 1,
        updatedAt: now()
      };
      await atomicWrite(path, json(next));
      await this.appendEvent(taskId, programId, {
        type: "agent.registered",
        agentId,
        priority: 1,
        summary: agentId
      });
      return next;
    });
  }

  async updateProgram(
    taskId: string,
    programId: string,
    patch: Partial<Pick<VirtualAgentProgram, "status" | "wake">>
  ): Promise<VirtualAgentProgram> {
    const path = join(this.programDirectory(taskId, programId), "program.json");
    return withFileLock(path, async () => {
      const current = await this.readProgram(taskId, programId);
      const next: VirtualAgentProgram = {
        ...current,
        ...patch,
        revision: current.revision + 1,
        updatedAt: now()
      };
      await atomicWrite(path, json(next));
      await this.appendEvent(taskId, programId, {
        type: "program.updated",
        priority: 1,
        summary: patch.status ?? patch.wake
      });
      return next;
    });
  }

  /** Append an event exactly once when dedupeKey is supplied. */
  async appendEvent(
    taskId: string,
    programId: string,
    input: Omit<VirtualAgentEvent, "eventId" | "programId" | "taskId" | "createdAt">
  ): Promise<{ accepted: boolean; event: VirtualAgentEvent }> {
    const path = join(this.programDirectory(taskId, programId), "events.jsonl");
    return withFileLock(path, async () => {
      const existing = await this.readEvents(path);
      if (input.dedupeKey && existing.some((event) => event.dedupeKey === input.dedupeKey))
        return { accepted: false, event: existing.find((event) => event.dedupeKey === input.dedupeKey)! };
      const event = newVirtualAgentEvent({ ...input, programId, taskId });
      await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
      return { accepted: true, event };
    });
  }

  async listEvents(taskId: string, programId: string): Promise<VirtualAgentEvent[]> {
    return this.readEvents(join(this.programDirectory(taskId, programId), "events.jsonl"));
  }

  private async readEvents(path: string): Promise<VirtualAgentEvent[]> {
    try {
      const content = await readFile(path, "utf8");
      return content
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as VirtualAgentEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async ensureLayout(root: string): Promise<void> {
    await mkdir(root, { recursive: true });
    try {
      await writeFile(join(root, "events.jsonl"), "", { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  private programDirectory(taskId: string, programId: string): string {
    return join(this.workspaceRoot, safe(taskId), "virtual-agents", safe(programId));
  }
  private async readJson<T>(path: string): Promise<T> {
    return JSON.parse(await readFile(path, "utf8")) as T;
  }
}

function safe(value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`unsafe virtual agent segment: ${value}`);
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
