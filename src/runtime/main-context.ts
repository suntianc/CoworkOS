import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../storage/file-lock.js";

export interface MainContextState {
  version: 1;
  contextEpoch: number;
  memoryVersion: number;
  memorySha256: string;
  lastClearReason?: string;
  lastClearAt?: string;
  messagesSavedAt?: string;
  runtimeGoal?: string;
  runtimePhase?: "active" | "waiting" | "completed" | "failed";
  runtimePendingDelegations?: number;
  runtimeRouting?: { strategy: string; reason?: string; updatedAt: string };
  runtimeLastEvent?: { type: string; summary?: string; updatedAt: string };
}

export interface MainRuntimeStatePatch {
  runtimeGoal?: string;
  runtimePhase?: MainContextState["runtimePhase"];
  runtimePendingDelegations?: number;
  runtimeRouting?: { strategy: string; reason?: string; updatedAt?: string };
  runtimeLastEvent?: { type: string; summary?: string; updatedAt?: string };
}

export interface MainContextPaths {
  directory: string;
  messages: string;
  memory: string;
  state: string;
}

export function mainContextPaths(workspaceRoot: string, taskId: string): MainContextPaths {
  const directory = join(workspaceRoot, taskId, "agents", "main", "context");
  return {
    directory,
    messages: join(directory, "messages.json"),
    memory: join(directory, "memory.md"),
    state: join(directory, "state.json")
  };
}

export async function ensureMainContext(paths: MainContextPaths): Promise<void> {
  await mkdir(paths.directory, { recursive: true });
  await ensureFile(paths.messages, "[]\n");
  await ensureFile(paths.memory, defaultMemory());
  try {
    if (!(await readFile(paths.memory, "utf8")).trim()) await atomicWrite(paths.memory, defaultMemory());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await ensureFile(paths.state, `${JSON.stringify(emptyMainContextState(), null, 2)}\n`);
}

export function emptyMainContextState(): MainContextState {
  return { version: 1, contextEpoch: 0, memoryVersion: 0, memorySha256: "" };
}

export async function readMainContextState(paths: MainContextPaths): Promise<MainContextState> {
  try {
    const value = JSON.parse(await readFile(paths.state, "utf8")) as Partial<MainContextState>;
    if (value.version !== 1) return emptyMainContextState();
    return {
      version: 1,
      contextEpoch: Number.isFinite(value.contextEpoch) ? Math.max(0, value.contextEpoch as number) : 0,
      memoryVersion: Number.isFinite(value.memoryVersion) ? Math.max(0, value.memoryVersion as number) : 0,
      memorySha256: typeof value.memorySha256 === "string" ? value.memorySha256 : "",
      lastClearReason: typeof value.lastClearReason === "string" ? value.lastClearReason : undefined,
      lastClearAt: typeof value.lastClearAt === "string" ? value.lastClearAt : undefined,
      messagesSavedAt: typeof value.messagesSavedAt === "string" ? value.messagesSavedAt : undefined,
      runtimeGoal: typeof value.runtimeGoal === "string" ? value.runtimeGoal : undefined,
      runtimePhase:
        value.runtimePhase === "active" ||
        value.runtimePhase === "waiting" ||
        value.runtimePhase === "completed" ||
        value.runtimePhase === "failed"
          ? value.runtimePhase
          : undefined,
      runtimePendingDelegations: Number.isFinite(value.runtimePendingDelegations)
        ? Math.max(0, value.runtimePendingDelegations as number)
        : undefined,
      runtimeRouting:
        value.runtimeRouting && typeof value.runtimeRouting === "object" ? value.runtimeRouting : undefined,
      runtimeLastEvent:
        value.runtimeLastEvent && typeof value.runtimeLastEvent === "object"
          ? value.runtimeLastEvent
          : undefined
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyMainContextState();
    throw error;
  }
}

/** Update only small machine-owned Main state without touching memory.md. */
export async function updateMainContextRuntime(
  paths: MainContextPaths,
  patch: MainRuntimeStatePatch
): Promise<MainContextState> {
  await ensureMainContext(paths);
  return withFileLock(paths.state, async () => {
    const current = await readMainContextState(paths);
    const next: MainContextState = {
      ...current,
      runtimeGoal: patch.runtimeGoal ?? current.runtimeGoal,
      runtimePhase: patch.runtimePhase ?? current.runtimePhase,
      runtimePendingDelegations: patch.runtimePendingDelegations ?? current.runtimePendingDelegations,
      runtimeRouting: patch.runtimeRouting
        ? { ...patch.runtimeRouting, updatedAt: patch.runtimeRouting.updatedAt ?? new Date().toISOString() }
        : current.runtimeRouting,
      runtimeLastEvent: patch.runtimeLastEvent
        ? {
            ...patch.runtimeLastEvent,
            updatedAt: patch.runtimeLastEvent.updatedAt ?? new Date().toISOString()
          }
        : current.runtimeLastEvent
    };
    await atomicWrite(paths.state, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export async function readMainMemory(paths: MainContextPaths): Promise<string> {
  try {
    return await readFile(paths.memory, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function persistMainContext(
  paths: MainContextPaths,
  entries: unknown,
  patch: Partial<MainContextState> = {}
): Promise<MainContextState> {
  await ensureMainContext(paths);
  return withFileLock(paths.state, async () => {
    const state = await readMainContextState(paths);
    const memory = await readMainMemory(paths);
    const memorySha256 = createHash("sha256").update(memory).digest("hex");
    const memoryVersion = memorySha256 === state.memorySha256 ? state.memoryVersion : state.memoryVersion + 1;
    const next: MainContextState = {
      ...state,
      ...patch,
      version: 1,
      memoryVersion,
      memorySha256,
      messagesSavedAt: new Date().toISOString()
    };
    await atomicWrite(paths.messages, `${JSON.stringify(entries, null, 2)}\n`);
    await atomicWrite(paths.state, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

async function ensureFile(path: string, initial: string): Promise<void> {
  try {
    await writeFile(path, initial, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function defaultMemory(): string {
  return "# Main Agent Memory\n\n## Goal\n<!-- Keep the durable user goal here. -->\n\n## Completed\n- (none yet)\n\n## Next\n- (initialize after understanding the task)\n\n## Important information/constraints\n- (none yet)\n";
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}
