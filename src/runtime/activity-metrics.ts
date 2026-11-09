import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskRecord } from "../domain/types.js";
import { agentDisplayName } from "./agent-identity.js";

/**
 * What a running Main and its Subagents are doing, sampled on a fixed grid.
 *
 * The samples are derived from logs each agent already writes — the Main Run's
 * runtime output and each Subagent's trace — never from the model request path:
 * a reader on another node can rebuild the same window from disk, and nothing
 * here changes what the agents do. The payload carries counts, byte totals and
 * stage names only: no conversation text, tool arguments or credentials.
 */
export const ACTIVITY_SLICE_MS = 60_000;
/** Retained window; the 5 minute / 30 minute / 2 hour views all read from it. */
export const ACTIVITY_WINDOW_MS = 2 * 60 * 60_000;
/** Silence for this long moves an agent from working to idle. */
const ACTIVITY_IDLE_MS = ACTIVITY_SLICE_MS;
const ACTIVITY_WINDOW_SLICES = ACTIVITY_WINDOW_MS / ACTIVITY_SLICE_MS;
/** Bytes read from one trace per refresh; a large older log catches up across reads. */
const TRACE_READ_BUDGET = 8 * 1024 * 1024;
const TRACE_CACHE_LIMIT = 64;

export type ActivityStage =
  "starting" | "working" | "idle" | "waiting" | "completed" | "failed" | "cancelled" | "timed_out";

/** A durable work item's state, or Main's Task state, normalized for display. */
export type ActivityState =
  "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "timed_out";

export interface ActivitySample {
  /** Tool executions that started in this slice. */
  toolCalls: number;
  /** UTF-8 bytes of assistant text and tool result text recorded in this slice. */
  outputBytes: number;
}

export interface AgentActivityMetrics {
  agentId: string;
  /** Display name, identical to the one the conversation UI uses. */
  name: string;
  role: "main" | "subagent";
  /** Executor or reviewer when the work item was dispatched with a role. */
  workRole?: "executor" | "reviewer";
  /** The durable work item this agent runs; absent for Main. */
  callId?: string;
  state: ActivityState;
  /** What the agent is doing now, or how its work ended. */
  stage: ActivityStage;
  stageChangedAt: string;
  /** The last record this agent wrote; null before it wrote any. */
  lastProgressAt: string | null;
  /** `samples[i]` covers `[from + i*sliceMs, from + (i+1)*sliceMs)`. */
  samples: ActivitySample[];
}

export interface TaskActivityMetrics {
  version: 1;
  sliceMs: number;
  windowMs: number;
  /** Start of `samples[0]`; buckets are aligned to multiples of `sliceMs`. */
  from: string;
  /** True while Main's Run is still executing. */
  active: boolean;
  agents: AgentActivityMetrics[];
}

interface ActivityTaskRecord extends Pick<
  TaskRecord,
  "taskId" | "status" | "createdAt" | "updatedAt" | "completedAt"
> {
  activeRunId?: string;
}

interface WorkItemRecord {
  stepId?: unknown;
  agentId?: unknown;
  status?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  payload?: { delegation?: { role?: unknown } };
}

interface TraceAccumulator {
  identity: string;
  offset: number;
  pending: Buffer;
  skipLine: boolean;
  /** Used for records that carry no time of their own, such as a tool start. */
  fallbackMs: number;
  buckets: Map<number, ActivitySample>;
  /** Start of the activity stretch in progress; a longer pause starts a new one. */
  workingSinceMs?: number;
  lastProgressMs?: number;
  busy?: Promise<void>;
}

const traces = new Map<string, TraceAccumulator>();

const MAIN_STATE: Record<TaskRecord["status"], ActivityState> = {
  created: "queued",
  running: "running",
  waiting: "waiting",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled"
};

const SUBAGENT_STATE: Record<string, ActivityState> = {
  queued: "queued",
  leased: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  timed_out: "timed_out"
};

/** The stage an agent's work ended in; "starting" for work that never began. */
const ENDED_STAGE: Record<ActivityState, ActivityStage> = {
  queued: "starting",
  running: "working",
  waiting: "waiting",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  timed_out: "timed_out"
};

/**
 * Read one Task's activity from its active Run.
 *
 * Returns nothing for a Task that never ran and for one whose Run ended longer
 * ago than the retained window: the metrics are a live view, not a report.
 * Tasks that are not running still return their frozen samples until then, so
 * a lane that just finished keeps its waveform.
 */
export async function readTaskActivity(input: {
  storageRoot: string;
  task: ActivityTaskRecord;
  nowMs?: number;
}): Promise<TaskActivityMetrics | undefined> {
  const runId = input.task.activeRunId;
  if (!runId) return undefined;
  const nowMs = input.nowMs ?? Date.now();
  const live = input.task.status === "running";
  const endedMs = timeOfString(input.task.completedAt) ?? timeOfString(input.task.updatedAt);
  if (!live && endedMs !== undefined && nowMs - endedMs > ACTIVITY_WINDOW_MS) return undefined;

  const taskRoot = join(input.storageRoot, input.task.taskId);
  const runRoot = join(taskRoot, "runs", runId);
  const metadata = await readJson<{ createdAt?: unknown }>(join(runRoot, "run.json"), {});
  const startedMs =
    (typeof metadata.createdAt === "string" ? timeOfString(metadata.createdAt) : undefined) ??
    timeOfString(input.task.createdAt) ??
    nowMs;
  const queue = await readJson<WorkItemRecord[]>(join(runRoot, "queue.json"), []);
  const members: Array<{ agentId: string; path: string; work?: WorkItemRecord }> = [
    { agentId: "main", path: join(runRoot, "runtime-output.log") },
    ...queue
      .filter((item) => typeof item.agentId === "string" && item.agentId !== "main")
      .map((item) => ({
        agentId: item.agentId as string,
        path: join(taskRoot, "sessions", item.agentId as string, `${runId}.jsonl`),
        work: item
      }))
  ];
  const read = await Promise.all(members.map((member) => readTrace(member.path, startedMs)));
  const lastProgressMs = read.reduce<number | undefined>(
    (latest, state) =>
      state.lastProgressMs === undefined ? latest : Math.max(latest ?? 0, state.lastProgressMs),
    undefined
  );

  const endMs = live ? nowMs : Math.max(endedMs ?? 0, startedMs, lastProgressMs ?? 0);
  // Only finished slices are published: the slice in progress would change on
  // every poll and put an event on the stream for each one.
  const endSlice = live ? Math.floor(nowMs / ACTIVITY_SLICE_MS) - 1 : Math.floor(endMs / ACTIVITY_SLICE_MS);
  const startSlice = Math.floor(startedMs / ACTIVITY_SLICE_MS);
  const fromSlice = Math.max(startSlice, endSlice - (ACTIVITY_WINDOW_SLICES - 1));
  const slices = Math.max(0, endSlice - fromSlice + 1);
  const from = new Date(fromSlice * ACTIVITY_SLICE_MS).toISOString();

  const agents = members.map((member, index): AgentActivityMetrics => {
    const state = read[index];
    const work = member.work;
    const agentState =
      work === undefined
        ? MAIN_STATE[input.task.status]
        : (SUBAGENT_STATE[typeof work.status === "string" ? work.status : ""] ?? "queued");
    const endedAt =
      work === undefined
        ? (endedMs ?? lastProgressMs ?? startedMs)
        : (timeOfString(work.updatedAt) ?? lastProgressMs ?? startedMs);
    const stage = agentState === "running" ? liveStage(state, endMs) : ENDED_STAGE[agentState];
    const changedAt =
      agentState === "running"
        ? stageChangedAt(state, endMs, startedMs)
        : work === undefined
          ? (endedMs ?? startedMs)
          : endedAt;
    const role = work?.payload?.delegation?.role;
    const samples: ActivitySample[] = [];
    for (let slice = fromSlice; slice < fromSlice + slices; slice += 1) {
      const sample = state.buckets.get(slice);
      samples.push(
        sample
          ? { toolCalls: sample.toolCalls, outputBytes: sample.outputBytes }
          : { toolCalls: 0, outputBytes: 0 }
      );
    }
    return {
      agentId: member.agentId,
      name: agentDisplayName(member.agentId),
      role: work === undefined ? "main" : "subagent",
      ...(role === "executor" || role === "reviewer" ? { workRole: role } : {}),
      ...(typeof work?.stepId === "string" ? { callId: work.stepId } : {}),
      state: agentState,
      stage,
      stageChangedAt: new Date(changedAt).toISOString(),
      lastProgressAt:
        state.lastProgressMs === undefined ? null : new Date(state.lastProgressMs).toISOString(),
      samples
    };
  });

  return {
    version: 1,
    sliceMs: ACTIVITY_SLICE_MS,
    windowMs: ACTIVITY_WINDOW_MS,
    from,
    active: live,
    agents
  };
}

function liveStage(state: TraceAccumulator, nowMs: number): ActivityStage {
  const last = state.lastProgressMs;
  if (last === undefined) return "starting";
  return nowMs - last > ACTIVITY_IDLE_MS ? "idle" : "working";
}

function stageChangedAt(state: TraceAccumulator, nowMs: number, startedMs: number): number {
  const last = state.lastProgressMs;
  if (last === undefined) return startedMs;
  if (nowMs - last > ACTIVITY_IDLE_MS) return last + ACTIVITY_IDLE_MS;
  return state.workingSinceMs ?? last;
}

/** Read a trace, reusing everything already parsed and only reading new bytes. */
async function readTrace(path: string, fallbackMs: number): Promise<TraceAccumulator> {
  const current = accumulator(path, fallbackMs);
  try {
    current.busy ??= refresh(path, current).finally(() => {
      current.busy = undefined;
    });
    await current.busy;
    // eslint-disable-next-line no-restricted-syntax -- 单个 trace 读不出来（还没创建、被清理或正在轮转）时保留已累计的采样，不能让整个目录快照失败
  } catch {
    /* keep the samples this trace already produced */
  }
  return current;
}

function accumulator(path: string, fallbackMs: number): TraceAccumulator {
  const existing = traces.get(path);
  if (existing) return existing;
  const created: TraceAccumulator = {
    identity: "",
    offset: 0,
    pending: Buffer.alloc(0),
    skipLine: false,
    fallbackMs,
    buckets: new Map()
  };
  traces.set(path, created);
  for (const [key, value] of traces) {
    if (traces.size <= TRACE_CACHE_LIMIT) break;
    if (value.busy) continue;
    traces.delete(key);
  }
  return created;
}

async function refresh(path: string, state: TraceAccumulator): Promise<void> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const identity = `${info.dev}:${info.ino}`;
    if (identity !== state.identity || info.size < state.offset) {
      state.identity = identity;
      state.offset = 0;
      state.pending = Buffer.alloc(0);
      state.skipLine = false;
      state.buckets.clear();
      state.workingSinceMs = undefined;
      state.lastProgressMs = undefined;
    }
    if (state.offset === 0 && info.size > TRACE_READ_BUDGET) {
      // A very large log: start from the tail the retained window needs rather
      // than holding the whole file, and drop the line cut by the offset.
      state.offset = info.size - TRACE_READ_BUDGET;
      state.skipLine = true;
    }
    const length = Math.min(info.size, state.offset + TRACE_READ_BUDGET) - state.offset;
    if (length <= 0) return;
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, state.offset + filled);
      if (!bytesRead) break;
      filled += bytesRead;
    }
    state.offset += filled;
    const data = Buffer.concat([state.pending, buffer.subarray(0, filled)]);
    let start = 0;
    for (let newline = data.indexOf(10, start); newline !== -1; newline = data.indexOf(10, start)) {
      if (state.skipLine) state.skipLine = false;
      else consume(state, data.subarray(start, newline).toString("utf8"));
      start = newline + 1;
    }
    state.pending = Buffer.from(data.subarray(start));
    prune(state);
  } finally {
    await handle.close();
  }
}

/**
 * Forget slices the retained window can no longer reach.
 *
 * The grid has to be rebuilt from disk after a reconnect, so a Run's history
 * lives here only until it falls out of the window; a day-long Run costs the
 * same memory as a minute-long one.
 */
function prune(state: TraceAccumulator): void {
  const newest = state.lastProgressMs;
  if (newest === undefined) return;
  // Two slices of margin: the published grid ends at the last finished slice,
  // which is at most one slice behind the newest record.
  const oldest = Math.floor(newest / ACTIVITY_SLICE_MS) - (ACTIVITY_WINDOW_SLICES + 1);
  for (const slice of state.buckets.keys()) if (slice < oldest) state.buckets.delete(slice);
}

function consume(state: TraceAccumulator, line: string): void {
  if (!line.trim()) return;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
    // eslint-disable-next-line no-restricted-syntax -- 进程被杀可能留下半行，跳过它并继续统计同一文件里的完整记录
  } catch {
    return;
  }
  const wrapped =
    typeof record.type === "string" && (record.type.startsWith("trace.") || record.type === "runtime_event");
  const event =
    wrapped && record.payload && typeof record.payload === "object"
      ? (record.payload as Record<string, unknown>)
      : record;
  const at = recordTime(record) ?? recordTime(event) ?? state.lastProgressMs ?? state.fallbackMs;
  const slice = Math.floor(at / ACTIVITY_SLICE_MS);
  const sample = state.buckets.get(slice) ?? { toolCalls: 0, outputBytes: 0 };
  if (event.type === "tool_execution_start") sample.toolCalls += 1;
  else if (event.type === "message_end") sample.outputBytes += messageBytes(event.message);
  state.buckets.set(slice, sample);
  if (state.lastProgressMs === undefined || at - state.lastProgressMs > ACTIVITY_IDLE_MS)
    state.workingSinceMs = at;
  state.lastProgressMs = Math.max(state.lastProgressMs ?? at, at);
  if (state.buckets.size > ACTIVITY_WINDOW_SLICES * 2) prune(state);
}

/** Epoch milliseconds of a record; Pi messages carry their own, envelopes an ISO time. */
function recordTime(record: Record<string, unknown>): number | undefined {
  const occurred = timeOfString(record.occurredAt);
  if (occurred !== undefined) return occurred;
  if (typeof record.timestamp === "number" && Number.isFinite(record.timestamp)) return record.timestamp;
  const message = record.message;
  if (message && typeof message === "object") {
    const timestamp = (message as Record<string, unknown>).timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
  }
  return undefined;
}

function timeOfString(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Text the agent or its tools produced; usage, args and images are not output. */
function messageBytes(message: unknown): number {
  if (!message || typeof message !== "object") return 0;
  const { role, content } = message as { role?: unknown; content?: unknown };
  if (role !== "assistant" && role !== "toolResult") return 0;
  return textBytes(content);
}

function textBytes(content: unknown): number {
  if (typeof content === "string") return Buffer.byteLength(content, "utf8");
  if (!Array.isArray(content)) return 0;
  let bytes = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const text = (part as { type?: unknown; text?: unknown }).text;
    if (typeof text === "string") bytes += Buffer.byteLength(text, "utf8");
  }
  return bytes;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
    // eslint-disable-next-line no-restricted-syntax -- Run 元数据可能尚未写入或已损坏，缺失用调用方给的默认值表达
  } catch {
    return fallback;
  }
}
